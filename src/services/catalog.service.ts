/**
 * CatalogService — Persistent catalog with write-through cache + PostgreSQL FTS search.
 *
 * Responsibilities:
 *  - Background sync from provider → sv_catalog (every 2hrs live, 6hrs vod/series)
 *  - Write-through: on sync upsert into DB and update node-cache
 *  - Browse: node-cache hot path, DB fallback
 *  - Search: PostgreSQL FTS (replaces O(n) in-memory filter)
 */

import { query, getClient } from "./db.service";
import { cacheGet, cacheSet, CacheTTL } from "./cache.service";
import { inferLanguage } from "./language-inference.service";
import { ACTIVE_PROVIDER_ID } from "../config";
import type { IStreamProvider, CatalogItem, ContentType } from "../providers";
import {
  normalize,
  resolveOrCreateContentUid,
  findNearDuplicates,
} from "./content-identity.service";
import {
  recordSyncDurationSeconds,
  recordItemsProcessed,
  recordResolutionConfidence,
  recordConflict,
  recordNearDuplicate,
  recordReviewQueueDepth,
} from "../telemetry/content-identity";

// Advisory lock key — content master write ('CMWT' as hex)
const ADVISORY_LOCK_KEY = 0x434d5754;

// Sync intervals (ms)
const SYNC_INTERVAL_LIVE_MS = 2 * 60 * 60 * 1000; // 2 hours
const SYNC_INTERVAL_VOD_MS = 6 * 60 * 60 * 1000; // 6 hours
const SYNC_INTERVAL_SERIES_MS = 6 * 60 * 60 * 1000; // 6 hours

// In-memory sync state — prevents overlapping sync runs
const syncState = {
  live: { running: false, lastRun: 0 },
  vod: { running: false, lastRun: 0 },
  series: { running: false, lastRun: 0 },
};

// TTL map for cache keys (seconds)
const CACHE_TTL_MAP: Record<ContentType, number> = {
  live: CacheTTL.CHANNEL_LIST,
  vod: CacheTTL.VOD_LIST,
  series: CacheTTL.SERIES_LIST,
};

// Sync interval map (ms)
const SYNC_INTERVAL_MAP: Record<ContentType, number> = {
  live: SYNC_INTERVAL_LIVE_MS,
  vod: SYNC_INTERVAL_VOD_MS,
  series: SYNC_INTERVAL_SERIES_MS,
};

// ─────────────────────────────────────────────
// Sync: provider → sv_catalog
// ─────────────────────────────────────────────

/**
 * Upsert a batch of CatalogItems into sv_catalog.
 * Uses parameterized queries — no string concatenation.
 */
async function upsertCatalogItems(
  providerId: string,
  items: CatalogItem[],
): Promise<void> {
  if (items.length === 0) return;

  // Batch upsert in chunks of 500 to stay under parameter limits
  const CHUNK = 500;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let col = 1;

    for (const item of chunk) {
      placeholders.push(
        `($${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}::jsonb, NOW())`,
      );
      values.push(
        providerId,
        item.id,
        item.type,
        item.name,
        item.categoryId,
        item.icon ?? null,
        item.isAdult,
        item.rating ?? null,
        item.genre ?? null,
        item.year ?? null,
        item.rawData ? JSON.stringify(item.rawData) : null,
      );
    }

    await query(
      `INSERT INTO sv_catalog
         (provider_id, item_id, item_type, name, category_id, icon, is_adult, rating, genre, year, raw_data, last_synced)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (provider_id, item_id, item_type) DO UPDATE SET
         name = EXCLUDED.name,
         category_id = EXCLUDED.category_id,
         icon = EXCLUDED.icon,
         is_adult = EXCLUDED.is_adult,
         rating = EXCLUDED.rating,
         genre = EXCLUDED.genre,
         year = EXCLUDED.year,
         raw_data = EXCLUDED.raw_data,
         last_synced = NOW()`,
      values,
    );
  }
}

/**
 * Sync one content type from the provider into the catalog.
 * Skips if a sync is already running or it ran recently.
 */
export async function syncCatalog(
  provider: IStreamProvider,
  type: ContentType,
): Promise<void> {
  const state = syncState[type];
  const now = Date.now();

  if (state.running) {
    console.log(`[catalog] Sync for ${type} already running — skipping`);
    return;
  }

  if (now - state.lastRun < SYNC_INTERVAL_MAP[type]) {
    return; // Too recent — let the scheduled timer handle it
  }

  state.running = true;

  try {
    console.log(`[catalog] Starting sync for ${type}...`);

    // Use category_id "0" to get all streams across categories
    const items = await provider.getStreams("0", type);

    if (!Array.isArray(items) || items.length === 0) {
      console.log(`[catalog] No items returned for ${type} — skipping upsert`);
      return;
    }

    await upsertCatalogItems(ACTIVE_PROVIDER_ID, items);

    // Write-through: update cache with the full list
    const cacheKey = `catalog:${provider.name}:${type}:all`;
    cacheSet(cacheKey, items, CACHE_TTL_MAP[type]);

    state.lastRun = now;
    console.log(`[catalog] Sync complete for ${type}: ${items.length} items`);
  } catch (err) {
    console.error(
      `[catalog] Sync failed for ${type}:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    state.running = false;
  }
}

// ─────────────────────────────────────────────
// Phase 1 dual-write: provider → sv_content_master + sv_content_provider_map
// ─────────────────────────────────────────────

/**
 * Sync one content type and dual-write to sv_content_master + sv_content_provider_map.
 * Uses a session-level advisory lock to serialise against manual merge operations.
 * Batches in chunks of 500 with per-chunk transactions.
 *
 * @param provider The active stream provider
 * @param type Content type: "live" | "vod" | "series"
 *             Note: provider uses "vod" internally; master stores it as "movie"
 */
async function syncContentType(
  provider: IStreamProvider,
  type: ContentType,
): Promise<void> {
  // Map provider type to master content_type (vod → movie)
  const masterType = type === "vod" ? "movie" : type;

  const items = await provider.getStreams("0", type);
  if (!Array.isArray(items) || items.length === 0) return;

  const syncStart = Date.now();
  const client = await getClient();

  try {
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [ADVISORY_LOCK_KEY],
    );
    if (!lock.rows[0]?.acquired) {
      console.warn(
        `[catalog] advisory lock busy — skipping ${type} dual-write this cycle`,
      );
      return;
    }

    const newMasterRows: Array<{
      content_uid: string;
      normalized_title: string;
      content_type: string;
    }> = [];

    let processed = 0;
    const confidenceCounts: Record<string, number> = {
      high: 0,
      medium: 0,
      low: 0,
    };
    let conflictCount = 0;

    // Batch in chunks of 500
    for (let i = 0; i < items.length; i += 500) {
      const chunk = items.slice(i, i + 500);
      await client.query("BEGIN");
      try {
        for (const item of chunk) {
          const rawData = (item.rawData ?? {}) as Record<string, unknown>;
          const yearNum = item.year ? parseInt(item.year, 10) : null;

          const resolved = await resolveOrCreateContentUid({
            type:
              masterType === "movie"
                ? "movie"
                : masterType === "series"
                  ? "series"
                  : "live",
            title: item.name,
            year: yearNum && !isNaN(yearNum) ? yearNum : null,
            raw_data: rawData,
          });
          if (!resolved) continue;

          // Upsert master row — merge external_ids via jsonb concatenation
          await client.query(
            `INSERT INTO sv_content_master
              (content_uid, content_type, normalized_title, year, external_ids)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (content_uid) DO UPDATE SET
               external_ids = sv_content_master.external_ids || EXCLUDED.external_ids,
               updated_at = now()`,
            [
              resolved.content_uid,
              masterType,
              normalize(
                item.name,
                masterType === "movie"
                  ? "movie"
                  : masterType === "series"
                    ? "series"
                    : "live",
              ),
              yearNum && !isNaN(yearNum) ? yearNum : null,
              JSON.stringify(resolved.external_ids),
            ],
          );

          // Upsert provider mapping
          await client.query(
            `INSERT INTO sv_content_provider_map
              (content_uid, provider_id, item_id, raw_data, confidence)
             VALUES ($1, $2, $3, $4::jsonb, $5)
             ON CONFLICT (content_uid, provider_id) DO UPDATE SET
               item_id = EXCLUDED.item_id,
               raw_data = EXCLUDED.raw_data,
               confidence = EXCLUDED.confidence,
               last_synced = now()`,
            [
              resolved.content_uid,
              ACTIVE_PROVIDER_ID,
              String(item.id),
              JSON.stringify(rawData),
              resolved.confidence,
            ],
          );

          processed++;
          confidenceCounts[resolved.confidence] =
            (confidenceCounts[resolved.confidence] ?? 0) + 1;

          if (resolved.isNew) {
            newMasterRows.push({
              content_uid: resolved.content_uid,
              normalized_title: normalize(
                item.name,
                masterType === "movie"
                  ? "movie"
                  : masterType === "series"
                    ? "series"
                    : "live",
              ),
              content_type: masterType,
            });
          }

          // Log conflict to review queue
          if (resolved.conflict) {
            conflictCount++;
            await client.query(
              `INSERT INTO sv_content_review_queue (uid_a, uid_b, reason)
               VALUES ($1, $2, 'external_id_conflict')
               ON CONFLICT DO NOTHING`,
              [resolved.conflict.external_id_uid, resolved.conflict.title_uid],
            );
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    // Near-duplicate detection on new rows only (expensive O(n²) — keep scope small)
    if (newMasterRows.length > 0) {
      const nearDups = await findNearDuplicates(newMasterRows);
      for (const pair of nearDups) {
        await client.query(
          `INSERT INTO sv_content_review_queue (uid_a, uid_b, reason)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [pair.uid_a, pair.uid_b, pair.reason],
        );
        recordNearDuplicate(type);
      }
    }

    // Emit telemetry
    const durationSeconds = (Date.now() - syncStart) / 1000;
    recordSyncDurationSeconds(type, durationSeconds);
    recordItemsProcessed(type, processed);
    for (const [conf, count] of Object.entries(confidenceCounts)) {
      if (count > 0)
        recordResolutionConfidence(
          type,
          conf as "high" | "medium" | "low",
          count,
        );
    }
    if (conflictCount > 0) recordConflict(type, conflictCount);

    // Snapshot review queue depth
    const depthResult = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sv_content_review_queue WHERE resolved_at IS NULL`,
    );
    recordReviewQueueDepth(parseInt(depthResult.rows[0]?.count ?? "0", 10));

    console.log(
      `[catalog] content-identity dual-write for ${type}: ${processed} items, ` +
        `${newMasterRows.length} new, ` +
        `${durationSeconds.toFixed(2)}s`,
    );
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    client.release();
  }
}

/**
 * Sync episode metadata.
 * ORDERING INVARIANT: must run AFTER syncContentType("series") so parent show
 * rows exist in sv_content_master.
 *
 * The Xtream Codes provider exposes episodes via getSeriesInfo(seriesId), not
 * a top-level getEpisodes() call. Graceful degradation: if series info isn't
 * available, log and skip — episodes are optional in Phase 1.
 */
async function syncEpisodes(provider: IStreamProvider): Promise<void> {
  // Fetch all series entries from provider_map so we have content_uid + item_id
  const seriesRows = await query<{ content_uid: string; item_id: string }>(
    `SELECT content_uid, item_id
     FROM sv_content_provider_map pm
     JOIN sv_content_master m USING (content_uid)
     WHERE pm.provider_id = $1 AND m.content_type = 'series'`,
    [ACTIVE_PROVIDER_ID],
  );

  if (seriesRows.rows.length === 0) {
    console.log("[catalog] syncEpisodes: no series rows found — skipping");
    return;
  }

  let episodeCount = 0;

  for (const row of seriesRows.rows) {
    try {
      const detail = await provider.getSeriesInfo(row.item_id);
      if (!detail.episodes) continue;

      const client = await getClient();
      try {
        const lock = await client.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock($1) AS acquired`,
          [ADVISORY_LOCK_KEY],
        );
        if (!lock.rows[0]?.acquired) continue;

        // Flatten episodes from season map
        const allEpisodes: Array<{
          season_num: number;
          episode_num: number;
        }> = [];
        for (const [season, eps] of Object.entries(detail.episodes)) {
          const seasonNum = parseInt(season, 10);
          if (isNaN(seasonNum)) continue;
          for (const ep of eps) {
            allEpisodes.push({
              season_num: seasonNum,
              episode_num: ep.episodeNumber,
            });
          }
        }

        for (let i = 0; i < allEpisodes.length; i += 500) {
          const chunk = allEpisodes.slice(i, i + 500);
          await client.query("BEGIN");
          try {
            for (const ep of chunk) {
              const resolved = await resolveOrCreateContentUid({
                type: "episode",
                title: null,
                raw_data: {},
                parent_show_uid: row.content_uid,
                season_num: ep.season_num,
                episode_num: ep.episode_num,
              });
              if (!resolved) continue;

              await client.query(
                `INSERT INTO sv_content_master
                  (content_uid, content_type, normalized_title, parent_show_uid, season_num, episode_num, external_ids)
                 VALUES ($1, 'episode', '', $2, $3, $4, '{}'::jsonb)
                 ON CONFLICT (content_uid) DO UPDATE SET
                   updated_at = now()`,
                [
                  resolved.content_uid,
                  row.content_uid,
                  ep.season_num,
                  ep.episode_num,
                ],
              );

              await client.query(
                `INSERT INTO sv_content_provider_map
                  (content_uid, provider_id, item_id, raw_data, confidence)
                 VALUES ($1, $2, $3, '{}'::jsonb, $4)
                 ON CONFLICT (content_uid, provider_id) DO UPDATE SET
                   last_synced = now()`,
                [
                  resolved.content_uid,
                  ACTIVE_PROVIDER_ID,
                  `${row.item_id}:S${ep.season_num}E${ep.episode_num}`,
                  resolved.confidence,
                ],
              );

              episodeCount++;
            }
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          }
        }
      } finally {
        await client.query(`SELECT pg_advisory_unlock($1)`, [
          ADVISORY_LOCK_KEY,
        ]);
        client.release();
      }
    } catch (err) {
      // Graceful degradation: episode sync failure is non-fatal
      console.warn(
        `[catalog] syncEpisodes: skipping series ${row.item_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `[catalog] syncEpisodes complete: ${episodeCount} episodes processed`,
  );
}

/**
 * Full dual-write sync: all content types + episodes.
 * Exported for direct invocation (e.g. from tests or admin endpoints).
 */
export async function syncProviderCatalog(
  provider: IStreamProvider,
): Promise<void> {
  await syncContentType(provider, "live");
  await syncContentType(provider, "vod");
  await syncContentType(provider, "series");
  await syncEpisodes(provider);
}

/**
 * Start background sync timers for all content types.
 * Called once at server startup.
 */
export function startCatalogSync(provider: IStreamProvider): void {
  const run = async (type: ContentType) => {
    await syncCatalog(provider, type);
  };

  // Run immediately then schedule
  run("live");
  run("vod");
  run("series");

  setInterval(() => run("live"), SYNC_INTERVAL_LIVE_MS);
  setInterval(() => run("vod"), SYNC_INTERVAL_VOD_MS);
  setInterval(() => run("series"), SYNC_INTERVAL_SERIES_MS);

  console.log("[catalog] Background sync started");
}

// ─────────────────────────────────────────────
// Browse: cache hot path → DB fallback
// ─────────────────────────────────────────────

/**
 * Get all items of a content type for a given provider.
 * Hot path: node-cache. Warm path: DB. Cold path: provider.
 */
export async function getCatalogItems(
  provider: IStreamProvider,
  type: ContentType,
): Promise<CatalogItem[]> {
  const cacheKey = `catalog:${provider.name}:${type}:all`;
  const cached = cacheGet<CatalogItem[]>(cacheKey);
  if (cached) return cached;

  // Try DB warm path
  try {
    const result = await query<{
      item_id: string;
      name: string;
      item_type: string;
      category_id: string;
      icon: string | null;
      is_adult: boolean;
      rating: string | null;
      genre: string | null;
      year: string | null;
      added_at: string | null;
    }>(
      `SELECT item_id, name, item_type, category_id, icon, is_adult, rating, genre, year, added_at
       FROM sv_catalog
       WHERE provider_id = $1 AND item_type = $2
       ORDER BY name`,
      [ACTIVE_PROVIDER_ID, type],
    );

    if (result.rows.length > 0) {
      const items: CatalogItem[] = result.rows.map((row) => ({
        id: row.item_id,
        name: row.name,
        type: row.item_type as ContentType,
        categoryId: row.category_id,
        icon: row.icon,
        added: row.added_at,
        isAdult: row.is_adult,
        rating: row.rating ?? undefined,
        genre: row.genre ?? undefined,
        year: row.year ?? undefined,
      }));

      cacheSet(cacheKey, items, CACHE_TTL_MAP[type]);
      return items;
    }
  } catch (err) {
    console.error(
      `[catalog] DB browse failed for ${type}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Cold path: fetch from provider directly
  const items = await provider.getStreams("0", type);
  cacheSet(cacheKey, items, CACHE_TTL_MAP[type]);
  return items;
}

// ─────────────────────────────────────────────
// Search: PostgreSQL FTS
// ─────────────────────────────────────────────

export interface SearchResults {
  live: CatalogItem[];
  vod: CatalogItem[];
  series: CatalogItem[];
}

/**
 * Build a `tsquery` expression with prefix-match per token.
 *
 * "vikram 2022" → "vikram:* & 2022:*"
 *
 * Each token is sanitized to alphanumerics + underscore — strips Postgres
 * tsquery operators (`& | ! ( ) :`) so a malformed query can't construct
 * a custom expression. Empty/all-symbol queries return null and the caller
 * falls back to substring search.
 */
export function buildPrefixTsQuery(input: string): string | null {
  const tokens = input
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}\p{M}_]/gu, ""))
    .filter((t) => t.length > 0)
    .slice(0, 8); // cap — typical search is 1-3 tokens
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}:*`).join(" & ");
}

/**
 * Search catalog using PostgreSQL full-text search.
 * Falls back to in-memory if DB is unavailable.
 */
export async function searchCatalog(
  provider: IStreamProvider,
  query_text: string,
  type?: ContentType,
  hideAdult = true,
): Promise<SearchResults> {
  const cacheKey = `catalog:search:${provider.name}:${query_text.toLowerCase().trim()}:${type ?? "all"}:${hideAdult}`;
  const cached = cacheGet<SearchResults>(cacheKey);
  if (cached) return cached;

  const tsq = buildPrefixTsQuery(query_text);
  if (tsq === null) {
    return fallbackSearch(provider, query_text, type, hideAdult);
  }

  try {
    const result = await query<{
      item_id: string;
      name: string;
      item_type: string;
      category_id: string;
      category_name: string | null;
      icon: string | null;
      is_adult: boolean;
      rating: string | null;
      genre: string | null;
      year: string | null;
      added_at: string | null;
    }>(
      `SELECT c.item_id, c.name, c.item_type, c.category_id,
              cc.name AS category_name,
              c.icon, c.is_adult, c.rating, c.genre, c.year, c.added_at
         FROM sv_catalog c
    LEFT JOIN sv_catalog_categories cc
           ON cc.provider_id = c.provider_id
          AND cc.category_id = c.category_id
          AND cc.category_type = c.item_type
        WHERE c.provider_id = $1
          AND c.search_vector @@ to_tsquery('english', $2)
          AND ($3::text IS NULL OR c.item_type = $3)
          AND ($4::boolean IS FALSE OR c.is_adult = false)
     ORDER BY ts_rank(c.search_vector, to_tsquery('english', $2)) DESC
        LIMIT 150`,
      [ACTIVE_PROVIDER_ID, tsq, type ?? null, hideAdult],
    );

    const empty: SearchResults = { live: [], vod: [], series: [] };
    const MAX = 50;

    for (const row of result.rows) {
      const item: CatalogItem = {
        id: row.item_id,
        name: row.name,
        type: row.item_type as ContentType,
        categoryId: row.category_id,
        icon: row.icon,
        added: row.added_at,
        isAdult: row.is_adult,
        rating: row.rating ?? undefined,
        genre: row.genre ?? undefined,
        year: row.year ?? undefined,
        inferredLang: row.category_name
          ? inferLanguage(row.category_name)
          : null,
      };

      const bucket = row.item_type as ContentType;
      if (empty[bucket].length < MAX) {
        empty[bucket].push(item);
      }
    }

    cacheSet(cacheKey, empty, CacheTTL.SEARCH);
    return empty;
  } catch (err) {
    // DB unavailable — fall back to in-memory search on cached data
    console.error(
      "[catalog] FTS search failed, falling back to in-memory:",
      err instanceof Error ? err.message : err,
    );
    return fallbackSearch(provider, query_text, type, hideAdult);
  }
}

/**
 * In-memory fallback search when the DB is unavailable.
 * Uses cached data; does not hit the provider.
 */
async function fallbackSearch(
  provider: IStreamProvider,
  queryText: string,
  type: ContentType | undefined,
  hideAdult: boolean,
): Promise<SearchResults> {
  const lower = queryText.toLowerCase();
  const MAX = 50;

  const filterItems = (items: CatalogItem[]): CatalogItem[] =>
    items
      .filter((s) => s.name.toLowerCase().includes(lower))
      .filter((s) => !hideAdult || !s.isAdult)
      .slice(0, MAX);

  const types: ContentType[] = type ? [type] : ["live", "vod", "series"];
  const results: SearchResults = { live: [], vod: [], series: [] };

  for (const t of types) {
    const cacheKey = `catalog:${provider.name}:${t}:all`;
    const cached = cacheGet<CatalogItem[]>(cacheKey);
    if (cached) {
      results[t] = filterItems(cached);
    }
  }

  return results;
}
