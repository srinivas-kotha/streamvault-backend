/**
 * CatalogService — Persistent catalog with write-through cache + PostgreSQL FTS search.
 *
 * Responsibilities:
 *  - Background sync from provider → sv_catalog (every 2hrs live, 6hrs vod/series)
 *  - Write-through: on sync upsert into DB and update node-cache
 *  - Browse: node-cache hot path, DB fallback
 *  - Search: PostgreSQL FTS (replaces O(n) in-memory filter)
 */

import { query } from "./db.service";
import { cacheGet, cacheSet, CacheTTL } from "./cache.service";
import type { IStreamProvider, CatalogItem, ContentType } from "../providers";

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
        `($${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}, $${col++}, NOW())`,
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
      );
    }

    await query(
      `INSERT INTO sv_catalog
         (provider_id, item_id, item_type, name, category_id, icon, is_adult, rating, genre, year, last_synced)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (provider_id, item_id, item_type) DO UPDATE SET
         name = EXCLUDED.name,
         category_id = EXCLUDED.category_id,
         icon = EXCLUDED.icon,
         is_adult = EXCLUDED.is_adult,
         rating = EXCLUDED.rating,
         genre = EXCLUDED.genre,
         year = EXCLUDED.year,
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

    await upsertCatalogItems(provider.name, items);

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
      [provider.name, type],
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
       WHERE provider_id = $1
         AND search_vector @@ plainto_tsquery('english', $2)
         AND ($3::text IS NULL OR item_type = $3)
         AND ($4::boolean IS FALSE OR is_adult = false)
       ORDER BY ts_rank(search_vector, plainto_tsquery('english', $2)) DESC
       LIMIT 150`,
      [provider.name, query_text, type ?? null, hideAdult],
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
