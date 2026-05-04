/**
 * ContentIdentityService — canonical content fingerprinting layer.
 *
 * Phase 1: normalisation, UID computation, fingerprint chain, near-duplicate detection.
 *
 * Responsibilities:
 *  - normalize()                   — NFKC + unidecode + strip tags/year/episode codes
 *  - computeContentUid()           — deterministic SHA-1[:16] per content type
 *  - resolveOrCreateContentUid()   — two-tier (external_id → title+year) with conflict resolution
 *  - findNearDuplicates()          — bounded Levenshtein bucketed by type + length window
 */

import unidecode from "unidecode";
import { createHash } from "node:crypto";
import { query } from "./db.service";
import { extractExternalIds } from "../scripts/probes/probe-provider-external-ids";

// ─────────────────────────────────────────────────────────────────────────────
// normalize()
// ─────────────────────────────────────────────────────────────────────────────

const LANGUAGE_TAGS = [
  "Hindi",
  "Telugu",
  "English",
  "Tamil",
  "Kannada",
  "Malayalam",
  "CAM",
  "HD",
  "4K",
  "SD",
  "Dub",
  "Subbed",
];
const LANG_TAG_RE = new RegExp(`\\((?:${LANGUAGE_TAGS.join("|")})\\)`, "gi");
const YEAR_RE = /[([]\s*(?:19|20)\d{2}\s*[)\]]/g;
const EPISODE_CODE_RE = /\bS\d+E\d+\b|\bSeason\s+\d+\s+Episode\s+\d+\b/gi;
// eslint-disable-next-line no-useless-escape
const PUNCT_RE = /[·\-()\[\]:.,;'"''""–—]/g;
// Non-printable: zero-width space U+200B, zero-width no-break U+FEFF, NBSP U+00A0 etc.
// eslint-disable-next-line no-misleading-character-class, no-irregular-whitespace
const NON_PRINTABLE_RE = /[ ​‌‍﻿]/g;
const WHITESPACE_RE = /\s+/g;

// Live channel prefix patterns: "XX:", "[XX]", "XX || "
const LIVE_PREFIX_RE =
  /^(?:[A-Z]{2,3}\s*:\s*|\[[A-Z]{2,3}\]\s*|[A-Z]{2,3}\s*\|\|\s*)/;

export type NormalizeContentType = "movie" | "series" | "episode" | "live";

export function normalize(
  input: string | null | undefined,
  type: NormalizeContentType,
): string {
  if (input == null) return "";
  let s = String(input);
  // 1. NFKC normalisation
  s = s.normalize("NFKC");
  // 2. Strip language tags before punctuation (needs parens intact): (Hindi) etc.
  s = s.replace(LANG_TAG_RE, "");
  // 3. Strip surrounding (year)/[year] before punctuation (needs parens/brackets intact)
  s = s.replace(YEAR_RE, "");
  // 4. Strip episode codes
  s = s.replace(EPISODE_CODE_RE, "");
  // 5. Strip channel prefix (live only) — do before case-folding; regex is uppercase
  if (type === "live") {
    const upper = s.toUpperCase();
    const stripped = upper.replace(LIVE_PREFIX_RE, "");
    s = stripped;
  }
  // 6. Lowercase
  s = s.toLocaleLowerCase("und");
  // 7. Strip punctuation BEFORE unidecode — chars like middle-dot U+00B7 map to
  //    '*' via unidecode if not removed first.
  s = s.replace(PUNCT_RE, " ");
  // 8. Accent strip via unidecode (handles accented chars: é→e, ñ→n etc.)
  s = unidecode(s);
  // 9. Strip non-printable / zero-width characters
  s = s.replace(NON_PRINTABLE_RE, "");
  // 10. Collapse whitespace + trim
  s = s.replace(WHITESPACE_RE, " ").trim();
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// computeContentUid()
// ─────────────────────────────────────────────────────────────────────────────

export type ComputeUidInput =
  | { type: "movie"; title: string; year?: number | null }
  | { type: "series"; title: string; year?: number | null }
  | {
      type: "episode";
      parentShowUid: string;
      seasonNum: number;
      episodeNum: number;
    }
  | { type: "live"; title: string };

export function computeContentUid(input: ComputeUidInput): string {
  let canonical: string;
  switch (input.type) {
    case "movie": {
      const norm = normalize(input.title, "movie");
      if (!norm) return "";
      canonical = `movie|${norm}|${input.year ?? ""}`;
      break;
    }
    case "series": {
      const norm = normalize(input.title, "series");
      if (!norm) return "";
      canonical = `series|${norm}|${input.year ?? ""}`;
      break;
    }
    case "episode":
      if (!input.parentShowUid) return "";
      canonical = `episode|${input.parentShowUid}|S${input.seasonNum}E${input.episodeNum}`;
      break;
    case "live": {
      const norm = normalize(input.title, "live");
      if (!norm) return "";
      canonical = `live|${norm}`;
      break;
    }
  }
  return createHash("sha1").update(canonical).digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveOrCreateContentUid() — two-tier fingerprint chain
// ─────────────────────────────────────────────────────────────────────────────

export interface RawCatalogItem {
  type: NormalizeContentType;
  title: string | null;
  year?: number | null;
  parent_show_uid?: string;
  season_num?: number;
  episode_num?: number;
  raw_data: Record<string, unknown>;
}

export interface ResolveResult {
  content_uid: string;
  confidence: "high" | "medium" | "low";
  external_ids: Record<string, string>;
  isNew: boolean;
  conflict?: { external_id_uid: string; title_uid: string };
}

export async function resolveOrCreateContentUid(
  item: RawCatalogItem,
): Promise<ResolveResult | null> {
  const externalIds = extractExternalIds(item.raw_data);

  // Tier 1: external_id match (confidence:high)
  let externalUid: string | null = null;
  const contentTypeForDb = item.type === "episode" ? "episode" : item.type;

  if (externalIds.imdb_id) {
    const r = await query<{ content_uid: string }>(
      `SELECT content_uid FROM sv_content_master WHERE external_ids->>'imdb_id' = $1 AND content_type = $2 LIMIT 1`,
      [externalIds.imdb_id, contentTypeForDb],
    );
    if (r.rows[0]) externalUid = r.rows[0].content_uid;
  }
  if (!externalUid && externalIds.tmdb_id) {
    const r = await query<{ content_uid: string }>(
      `SELECT content_uid FROM sv_content_master WHERE external_ids->>'tmdb_id' = $1 AND content_type = $2 LIMIT 1`,
      [externalIds.tmdb_id, contentTypeForDb],
    );
    if (r.rows[0]) externalUid = r.rows[0].content_uid;
  }
  if (!externalUid && externalIds.tvdb_id) {
    const r = await query<{ content_uid: string }>(
      `SELECT content_uid FROM sv_content_master WHERE external_ids->>'tvdb_id' = $1 AND content_type = $2 LIMIT 1`,
      [externalIds.tvdb_id, contentTypeForDb],
    );
    if (r.rows[0]) externalUid = r.rows[0].content_uid;
  }

  // Tier 2: compute UID by title + year (confidence:medium/low)
  let titleUid = "";
  if (item.type === "episode") {
    if (
      !item.parent_show_uid ||
      item.season_num == null ||
      item.episode_num == null
    )
      return null;
    titleUid = computeContentUid({
      type: "episode",
      parentShowUid: item.parent_show_uid,
      seasonNum: item.season_num,
      episodeNum: item.episode_num,
    });
  } else if (item.type === "live") {
    if (!item.title) return null;
    titleUid = computeContentUid({ type: "live", title: item.title });
  } else {
    if (!item.title) return null;
    titleUid = computeContentUid({
      type: item.type,
      title: item.title,
      year: item.year ?? null,
    });
  }
  if (!titleUid) return null;

  // Conflict resolution: external_id points to a different uid than title hash
  if (externalUid && externalUid !== titleUid) {
    return {
      content_uid: externalUid,
      confidence: "high",
      external_ids: externalIds,
      isNew: false,
      conflict: { external_id_uid: externalUid, title_uid: titleUid },
    };
  }

  // Tier selection
  const confidence: "high" | "medium" | "low" =
    Object.keys(externalIds).length > 0 ? "high" : item.year ? "medium" : "low";

  // Existence check in master table
  const existing = await query<{ content_uid: string }>(
    `SELECT content_uid FROM sv_content_master WHERE content_uid = $1`,
    [titleUid],
  );

  return {
    content_uid: externalUid ?? titleUid,
    confidence,
    external_ids: externalIds,
    isNew: existing.rows.length === 0,
  };
}

// Re-export from probe to keep one source of truth
export { extractExternalIds };

// ─────────────────────────────────────────────────────────────────────────────
// findNearDuplicates() — bounded Levenshtein with bucketing
// ─────────────────────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1; // early-exit
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return prev[n]!;
}

interface MasterRow {
  content_uid: string;
  normalized_title: string;
  content_type: string;
}

const LENGTH_WINDOW = 3;
const LEV_MAX = 2;

export async function findNearDuplicates(
  rows: MasterRow[],
): Promise<Array<{ uid_a: string; uid_b: string; reason: string }>> {
  // Bucket by (content_type, length-window floor)
  const buckets = new Map<string, MasterRow[]>();

  for (const r of rows) {
    const bucket = Math.floor(r.normalized_title.length / LENGTH_WINDOW);
    // Add to own bucket and adjacent bucket above (to catch cross-boundary pairs)
    for (const b of [bucket, bucket + 1]) {
      const key = `${r.content_type}:${b}`;
      const list = buckets.get(key) ?? [];
      list.push(r);
      buckets.set(key, list);
    }
  }

  const pairs: Array<{ uid_a: string; uid_b: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.content_type !== b.content_type) continue;
        if (
          Math.abs(a.normalized_title.length - b.normalized_title.length) >
          LEV_MAX
        )
          continue;
        const dedupeKey =
          a.content_uid < b.content_uid
            ? `${a.content_uid}:${b.content_uid}`
            : `${b.content_uid}:${a.content_uid}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        if (
          levenshtein(a.normalized_title, b.normalized_title, LEV_MAX) <=
          LEV_MAX
        ) {
          pairs.push({
            uid_a: a.content_uid,
            uid_b: b.content_uid,
            reason: "near_duplicate",
          });
        }
      }
    }
  }

  return pairs;
}
