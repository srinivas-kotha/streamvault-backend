/**
 * backfill-content-uid.ts — two-pass idempotent backfill for content_uid columns.
 *
 * Phase 2, Task 2.1.
 *
 * Pass 1 (episode-aware):
 *   For sv_watch_history rows where content_type = 'series' and
 *   content_name matches S\d+E\d+: parse show_title + S/E, look up
 *   parent show in master, compute episode uid, set if found in master
 *   else log to review_queue + leave NULL.
 *
 * Pass 2 (movies + series-as-show):
 *   For remaining NULL content_uid rows across all three tables:
 *   resolve via normalized title → master lookup (read-only).
 *   Unique match → set. Ambiguous → review_queue. No match → leave NULL.
 *
 * Usage:
 *   node dist/scripts/backfill-content-uid.js --dry-run
 *   node dist/scripts/backfill-content-uid.js --apply
 *   node dist/scripts/backfill-content-uid.js --apply --limit 500
 */

import { query, getClient, closePool } from "../services/db.service";
import {
  normalize,
  computeContentUid,
} from "../services/content-identity.service";
import { ACTIVE_PROVIDER_ID } from "../config";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TableSummary {
  total: number;
  matched: number;
  ambiguous: number;
  noMatch: number;
  reviewQueued: number;
  skipped: number; // rows with content_name = null
}

export interface BackfillSummary {
  history: TableSummary;
  favorites: TableSummary;
  epg: TableSummary;
  dryRun: boolean;
}

export interface BackfillOptions {
  dryRun: boolean;
  limit: number | null;
}

// ─── Episode parsing ─────────────────────────────────────────────────────────

const EPISODE_RE = /\bS(\d+)E(\d+)\b/i;

interface ParsedEpisode {
  showTitle: string;
  seasonNum: number;
  episodeNum: number;
}

function parseEpisodePattern(name: string): ParsedEpisode | null {
  const m = EPISODE_RE.exec(name);
  if (!m) return null;
  const seasonNum = parseInt(m[1]!, 10);
  const episodeNum = parseInt(m[2]!, 10);
  // Extract show title as text before the S\d+E\d+ match
  const showTitle = name.slice(0, m.index).trim();
  if (!showTitle) return null;
  return { showTitle, seasonNum, episodeNum };
}

// ─── Master lookup helpers ────────────────────────────────────────────────────

interface MasterRow {
  content_uid: string;
  normalized_title: string;
  content_type: string;
  year: number | null;
}

/**
 * Look up master rows by normalized title + content type.
 * Returns all matches (caller decides unique vs ambiguous).
 */
async function lookupMaster(
  normalizedTitle: string,
  contentType: string,
): Promise<MasterRow[]> {
  const r = await query<MasterRow>(
    `SELECT content_uid, normalized_title, content_type, year
     FROM sv_content_master
     WHERE normalized_title = $1 AND content_type = $2`,
    [normalizedTitle, contentType],
  );
  return r.rows;
}

/**
 * Check if a given content_uid exists in master (used for episode uid verification).
 */
async function masterUidExists(uid: string): Promise<boolean> {
  const r = await query<{ content_uid: string }>(
    `SELECT content_uid FROM sv_content_master WHERE content_uid = $1`,
    [uid],
  );
  return r.rows.length > 0;
}

// ─── DB row types for the three tables ──────────────────────────────────────

interface HistoryRow {
  id: number;
  content_name: string | null;
  content_type: string; // 'series' | 'vod' | 'live'
  content_uid: string | null;
}

interface FavoriteRow {
  id: number;
  content_name: string | null;
  content_type: string;
  content_uid: string | null;
}

// content_type in these tables uses legacy names — map to canonical
const CONTENT_TYPE_MAP: Record<string, string> = {
  vod: "movie",
  movie: "movie",
  series: "series",
  live: "live",
  channel: "live",
};

// ─── Core resolution logic ───────────────────────────────────────────────────

type ResolveOutcome =
  | { kind: "matched"; uid: string }
  | { kind: "ambiguous" }
  | { kind: "no_match" }
  // Episode pattern detected but parent show not found OR episode uid not in
  // master. Per plan §Phase 2 Pass 1: "Else → leave NULL + log to review queue."
  | { kind: "episode_orphan"; reason: string }
  | { kind: "skipped" }; // null/empty name

/**
 * Pass 1: episode-aware resolution for series rows with S\d+E\d+ pattern.
 * Returns null if the row is not an episode pattern (fallthrough to Pass 2).
 */
async function resolveEpisode(
  name: string | null,
  contentType: string,
): Promise<ResolveOutcome | null> {
  // Only applies to series content type
  if (!name || contentType !== "series") return null;

  const parsed = parseEpisodePattern(name);
  if (!parsed) return null; // not an episode pattern

  const { showTitle, seasonNum, episodeNum } = parsed;
  const normalizedShow = normalize(showTitle, "series");
  if (!normalizedShow) return null;

  // Look up parent show in master
  const parentMatches = await lookupMaster(normalizedShow, "series");
  if (parentMatches.length === 0) {
    return {
      kind: "episode_orphan",
      reason: "backfill_episode_parent_missing",
    };
  }
  if (parentMatches.length > 1) return { kind: "ambiguous" };

  const parentShowUid = parentMatches[0]!.content_uid;
  const episodeUid = computeContentUid({
    type: "episode",
    parentShowUid,
    seasonNum,
    episodeNum,
  });
  if (!episodeUid) {
    return {
      kind: "episode_orphan",
      reason: "backfill_episode_uid_compute_failed",
    };
  }

  // Episode uid must exist in master (we do NOT create rows in backfill)
  const exists = await masterUidExists(episodeUid);
  if (!exists) {
    return { kind: "episode_orphan", reason: "backfill_episode_not_in_master" };
  }

  return { kind: "matched", uid: episodeUid };
}

/**
 * Pass 2: normalized title → master lookup.
 * For movies, map legacy 'vod' → 'movie'.
 * Does NOT create master rows.
 */
async function resolveByTitle(
  name: string | null,
  contentType: string,
): Promise<ResolveOutcome> {
  if (!name || !name.trim()) return { kind: "skipped" };

  const canonicalType = CONTENT_TYPE_MAP[contentType] ?? contentType;
  const normalized = normalize(
    name,
    canonicalType as Parameters<typeof normalize>[1],
  );
  if (!normalized) return { kind: "skipped" };

  const matches = await lookupMaster(normalized, canonicalType);
  if (matches.length === 0) return { kind: "no_match" };
  if (matches.length > 1) return { kind: "ambiguous" };

  return { kind: "matched", uid: matches[0]!.content_uid };
}

// ─── Per-table backfill logic ─────────────────────────────────────────────────

interface ClientLike {
  query: <T = unknown>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number }>;
  release: () => void;
}

// uid_a encodes the source row reference (e.g. "history:42", "favorites:7"); the
// actual schema has no source_table/source_row_id columns. uid_b is left NULL —
// backfill rows are not near-dup pairs.
async function insertReviewQueue(
  client: ClientLike,
  uid_a: string,
  reason: string,
): Promise<void> {
  await client.query(
    `INSERT INTO sv_content_review_queue (uid_a, reason)
     VALUES ($1, $2)`,
    [uid_a, reason],
  );
}

async function processHistoryRows(
  rows: HistoryRow[],
  client: ClientLike,
  dryRun: boolean,
): Promise<TableSummary> {
  const summary: TableSummary = {
    total: rows.length,
    matched: 0,
    ambiguous: 0,
    noMatch: 0,
    reviewQueued: 0,
    skipped: 0,
  };

  for (const row of rows) {
    if (!row.content_name) {
      summary.skipped++;
      continue;
    }

    // Pass 1: try episode-aware resolution
    let outcome = await resolveEpisode(row.content_name, row.content_type);

    // Pass 2: fallthrough to title-based resolution
    if (outcome === null) {
      outcome = await resolveByTitle(row.content_name, row.content_type);
    }

    switch (outcome.kind) {
      case "matched":
        summary.matched++;
        if (!dryRun) {
          await client.query(
            `UPDATE sv_watch_history SET content_uid = $1 WHERE id = $2`,
            [outcome.uid, row.id],
          );
        }
        break;
      case "ambiguous":
        summary.ambiguous++;
        summary.reviewQueued++;
        if (!dryRun) {
          await insertReviewQueue(
            client,
            `history:${row.id}`,
            "backfill_ambiguous",
          );
        }
        break;
      case "episode_orphan":
        // Episode pattern detected but parent show or episode uid missing in master.
        // Per plan: leave NULL, log to review queue.
        summary.noMatch++;
        summary.reviewQueued++;
        if (!dryRun) {
          await insertReviewQueue(client, `history:${row.id}`, outcome.reason);
        }
        break;
      case "no_match":
        summary.noMatch++;
        // Don't log review queue for no-match — would be too noisy (84/90 rows are orphaned)
        break;
      case "skipped":
        summary.skipped++;
        break;
    }
  }

  return summary;
}

async function processFavoritesRows(
  rows: FavoriteRow[],
  client: ClientLike,
  dryRun: boolean,
): Promise<TableSummary> {
  const summary: TableSummary = {
    total: rows.length,
    matched: 0,
    ambiguous: 0,
    noMatch: 0,
    reviewQueued: 0,
    skipped: 0,
  };

  for (const row of rows) {
    if (!row.content_name) {
      summary.skipped++;
      continue;
    }

    // Pass 1: episode-aware (favorites can be series episodes too)
    let outcome = await resolveEpisode(row.content_name, row.content_type);
    if (outcome === null) {
      outcome = await resolveByTitle(row.content_name, row.content_type);
    }

    switch (outcome.kind) {
      case "matched":
        summary.matched++;
        if (!dryRun) {
          await client.query(
            `UPDATE sv_favorites SET content_uid = $1 WHERE id = $2`,
            [outcome.uid, row.id],
          );
        }
        break;
      case "ambiguous":
        summary.ambiguous++;
        summary.reviewQueued++;
        if (!dryRun) {
          await insertReviewQueue(
            client,
            `favorites:${row.id}`,
            "backfill_ambiguous",
          );
        }
        break;
      case "episode_orphan":
        summary.noMatch++;
        summary.reviewQueued++;
        if (!dryRun) {
          await insertReviewQueue(
            client,
            `favorites:${row.id}`,
            outcome.reason,
          );
        }
        break;
      case "no_match":
        summary.noMatch++;
        break;
      case "skipped":
        summary.skipped++;
        break;
    }
  }

  return summary;
}

// EPG backfill is a single set-based UPDATE join with sv_content_provider_map
// on channel_id (sv_epg has no content_type column — verified Phase 0 Task 0.5a).
// Mirrors fillEpgContentUid() in epg.service.ts.
async function processEpgSetBased(
  client: ClientLike,
  dryRun: boolean,
  limit: number | null,
): Promise<TableSummary> {
  const summary: TableSummary = {
    total: 0,
    matched: 0,
    ambiguous: 0,
    noMatch: 0,
    reviewQueued: 0,
    skipped: 0,
  };

  // Snapshot total NULL rows up-front for the summary (limit-respecting).
  const limitClause = limit !== null ? `LIMIT ${limit}` : "";
  const totalRes = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM (
       SELECT 1 FROM sv_epg WHERE content_uid IS NULL ${limitClause}
     ) sub`,
  );
  summary.total = parseInt(totalRes.rows[0]?.count ?? "0", 10);
  if (summary.total === 0) return summary;

  // Set-based join. provider_id namespaced (xtream:8027e2a2 in prod).
  const limitFilter =
    limit !== null
      ? `AND e.id IN (SELECT id FROM sv_epg WHERE content_uid IS NULL LIMIT ${limit})`
      : "";

  if (dryRun) {
    // Count how many rows WOULD update (preview only).
    const r = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM sv_epg e
         JOIN sv_content_provider_map pm
           ON pm.provider_id = $1 AND pm.item_id = e.channel_id
        WHERE e.content_uid IS NULL ${limitFilter}`,
      [ACTIVE_PROVIDER_ID],
    );
    summary.matched = parseInt(r.rows[0]?.count ?? "0", 10);
    summary.noMatch = summary.total - summary.matched;
  } else {
    const r = await client.query<{ id: number }>(
      `WITH updated AS (
         UPDATE sv_epg e
            SET content_uid = pm.content_uid
           FROM sv_content_provider_map pm
          WHERE pm.provider_id = $1
            AND pm.item_id     = e.channel_id
            AND e.content_uid IS NULL
            ${limitFilter}
        RETURNING e.id
       )
       SELECT id FROM updated`,
      [ACTIVE_PROVIDER_ID],
    );
    summary.matched = r.rowCount ?? 0;
    summary.noMatch = summary.total - summary.matched;
  }

  return summary;
}

// ─── Fetch rows (idempotent: only fetch WHERE content_uid IS NULL) ────────────

async function fetchHistoryRows(limit: number | null): Promise<HistoryRow[]> {
  const limitClause = limit !== null ? `LIMIT ${limit}` : "";
  const r = await query<HistoryRow>(
    `SELECT id, content_name, content_type, content_uid
     FROM sv_watch_history
     WHERE content_uid IS NULL
     ${limitClause}`,
  );
  return r.rows;
}

async function fetchFavoritesRows(
  limit: number | null,
): Promise<FavoriteRow[]> {
  const limitClause = limit !== null ? `LIMIT ${limit}` : "";
  const r = await query<FavoriteRow>(
    `SELECT id, content_name, content_type, content_uid
     FROM sv_favorites
     WHERE content_uid IS NULL
     ${limitClause}`,
  );
  return r.rows;
}

// ─── Main backfill runner (exported for tests + CLI) ─────────────────────────

export async function runBackfill(
  options: BackfillOptions,
): Promise<BackfillSummary> {
  const { dryRun, limit } = options;

  // Fetch row-based unresolved rows up-front (idempotent: WHERE content_uid IS NULL).
  // EPG is handled set-based inside the transaction below.
  const [historyRows, favoritesRows] = await Promise.all([
    fetchHistoryRows(limit),
    fetchFavoritesRows(limit),
  ]);

  // Acquire a transaction client
  const client = await getClient();
  let historySummary: TableSummary;
  let favoritesSummary: TableSummary;
  let epgSummary: TableSummary;

  try {
    await client.query("BEGIN");

    historySummary = await processHistoryRows(historyRows, client, dryRun);
    favoritesSummary = await processFavoritesRows(
      favoritesRows,
      client,
      dryRun,
    );
    epgSummary = await processEpgSetBased(client, dryRun, limit);

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return {
    history: historySummary!,
    favorites: favoritesSummary!,
    epg: epgSummary!,
    dryRun,
  };
}

// ─── Summary printer ─────────────────────────────────────────────────────────

function printSummary(summary: BackfillSummary): void {
  const mode = summary.dryRun ? "DRY-RUN" : "APPLIED";
  console.log(`\n=== backfill-content-uid [${mode}] ===\n`);

  const tables: Array<[string, TableSummary]> = [
    ["sv_watch_history", summary.history],
    ["sv_favorites", summary.favorites],
    ["sv_epg", summary.epg],
  ];

  for (const [tableName, s] of tables) {
    console.log(`  ${tableName}`);
    console.log(`    total scanned : ${s.total}`);
    console.log(`    matched       : ${s.matched}`);
    console.log(`    ambiguous     : ${s.ambiguous}`);
    console.log(`    no match      : ${s.noMatch}`);
    console.log(`    skipped (null): ${s.skipped}`);
    console.log(`    review_queue  : ${s.reviewQueued}`);
    console.log("");
  }

  if (summary.dryRun) {
    console.log(
      "  [dry-run] no writes performed. Re-run with --apply to write.",
    );
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isApply = args.includes("--apply");
  const limitIdx = args.indexOf("--limit");
  const limit =
    limitIdx !== -1 && args[limitIdx + 1]
      ? parseInt(args[limitIdx + 1]!, 10)
      : null;

  if (!isDryRun && !isApply) {
    console.error(
      "Usage: backfill-content-uid --dry-run | --apply [--limit N]",
    );
    process.exit(1);
  }

  const dryRun = isDryRun;

  try {
    const summary = await runBackfill({ dryRun, limit });
    printSummary(summary);
  } finally {
    await closePool();
  }
}

// Only run when executed directly (not when imported by tests)
const isMain = typeof require !== "undefined" && require.main === module;

if (isMain) {
  main().catch((err) => {
    console.error("[backfill] fatal:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
