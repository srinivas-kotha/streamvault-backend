/**
 * Phase 0 probe: scan sv_catalog.raw_data to measure IMDB/TMDB/TVDB ID coverage.
 * This is a read-only diagnostic — no writes, no side effects.
 *
 * Run via: docker exec streamvault_api node /app/dist/scripts/probes/probe-provider-external-ids.js
 * Or dev: npm run probe:external-ids
 */

const ID_KEYS: Record<string, "imdb_id" | "tmdb_id" | "tvdb_id"> = {
  imdb_id: "imdb_id",
  imdbid: "imdb_id",
  imdbId: "imdb_id",
  tmdb_id: "tmdb_id",
  tmdbid: "tmdb_id",
  tmdbId: "tmdb_id",
  tvdb_id: "tvdb_id",
  tvdbid: "tvdb_id",
  tvdbId: "tvdb_id",
};

export function extractExternalIds(
  raw: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const norm = ID_KEYS[key];
    if (!norm) continue;
    const v = String(value ?? "").trim();
    if (v) out[norm] = v;
  }
  return out;
}

async function main() {
  // Dynamic import to avoid loading DB pool during unit tests
  const { query, closePool } = await import("../../services/db.service");

  const contentTypes: Array<"live" | "vod" | "series"> = [
    "live",
    "vod",
    "series",
  ];
  const samples: Record<string, number> = { live: 0, vod: 0, series: 0 };
  const hits: Record<string, number> = { live: 0, vod: 0, series: 0 };

  for (const type of contentTypes) {
    const result = await query<{ raw_data: Record<string, unknown> | null }>(
      `SELECT raw_data FROM sv_catalog WHERE item_type = $1 AND raw_data IS NOT NULL`,
      [type],
    );
    samples[type] = result.rowCount ?? 0;
    for (const row of result.rows) {
      const ids = extractExternalIds(row.raw_data ?? {});
      if (Object.keys(ids).length > 0) hits[type]++;
    }
  }

  const rate_live = samples["live"] ? (hits["live"] ?? 0) / samples["live"] : 0;
  const rate_vod = samples["vod"] ? (hits["vod"] ?? 0) / samples["vod"] : 0;
  const rate_series = samples["series"]
    ? (hits["series"] ?? 0) / samples["series"]
    : 0;

  const probe_result = {
    samples,
    hits,
    rate_live,
    rate_vod,
    rate_series,
  };
  console.log(JSON.stringify(probe_result, null, 2));

  // Hard gate advisory: phase 0 passes regardless, but log if no IDs found.
  const total = rate_live + rate_vod + rate_series;
  if (total === 0) {
    console.warn(
      "\nWARN: No external IDs found in provider raw_data. confidence:high tier will never fire.",
    );
    console.warn(
      "      Design still works at confidence:medium — match rate may be lower.",
    );
  }

  await closePool();
}

// Use ESM-compatible main-module detection
const isMain =
  typeof process !== "undefined" &&
  (process.argv[1]?.endsWith("probe-provider-external-ids.ts") ||
    process.argv[1]?.endsWith("probe-provider-external-ids.js"));

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
