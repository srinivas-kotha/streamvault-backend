/**
 * WarmupService — On-start cache warmup + background TTL pre-refresh.
 *
 * See ADR-009 (docs/DECISIONS.md) and Task 4.2 design doc.
 *
 * Responsibilities:
 *  1. On server start, populate the four high-latency Xtream cache keys
 *     sequentially, in a failure-isolated, non-blocking pass.
 *  2. Every POLL_INTERVAL_MS, inspect each monitored key's TTL and trigger a
 *     background refresh when the remaining TTL is inside the pre-refresh
 *     window — so end-user requests never hit the cold Xtream path at
 *     TTL expiry.
 *
 * Follows the existing setInterval pattern used by catalog.service.ts and
 * epg.service.ts — no node-cron, no BullMQ.
 */
import {
  cacheGet,
  cacheSet,
  cacheGetTtl,
  CacheTTL,
  WARMUP_CACHE_KEYS,
} from "./cache.service";
import type { IStreamProvider, CatalogItem, CatalogCategory } from "../providers";

// Windows in seconds.
// Chosen so that a worst-case ~60s VOD refresh completes before NodeCache's
// own checkperiod (120s) evicts the stale entry. See design §5 G4.
const PRE_REFRESH_WINDOW_S = 120;
const POLL_INTERVAL_MS = 60_000;

// Delay warmup start to give catalog.service's own boot-time Xtream fetches a
// head start (design §5 G3 — avoid 4+ simultaneous Xtream requests at boot).
const WARMUP_START_DELAY_MS = 2_000;

// Priority channel patterns — kept in sync with live.router.ts. See design
// §2b (Option B — duplicate logic locally to avoid touching the route file
// that is in-flight for Task 4.3).
const PRIORITY_PATTERNS = [
  "etv telugu", "etv hd", "etv", "maa tv", "maa hd", "star maa",
  "maa gold", "maa movies", "gemini tv", "gemini hd", "gemini movies",
  "gemini", "zee telugu", "zee telugu hd",
];
const TELUGU_CATEGORY_PATTERNS = ["telugu", "india entertainment", "indian", "india"];

function matchesPriority(name: string): number {
  const lower = name.toLowerCase().trim();
  for (let i = 0; i < PRIORITY_PATTERNS.length; i++) {
    if (lower === PRIORITY_PATTERNS[i] || lower.includes(PRIORITY_PATTERNS[i]!)) {
      return i;
    }
  }
  return -1;
}

function isTeluguCategory(catName: string): boolean {
  const lower = catName.toLowerCase();
  return TELUGU_CATEGORY_PATTERNS.some((p) => lower.includes(p));
}

// Module-level state surfaced for future /health integration (design §5 G6).
export let warmupComplete = false;
export let warmupDurationMs: number | null = null;

// Guard against concurrent refresh of the same key (design §2c).
const refreshingKeys = new Set<string>();

/**
 * Execute the full /api/live/featured logic against `provider`, writing the
 * result into the shared `xtream:live:featured` cache key. Mirrors the route
 * handler in live.router.ts — kept in sync manually until Task 4.X extracts
 * a shared featured.service.ts.
 */
async function populateFeatured(provider: IStreamProvider): Promise<void> {
  const categories: CatalogCategory[] = await provider.getCategories("live");
  const teluguCats = categories.filter((c) => isTeluguCategory(c.name));

  const streamResults = await Promise.allSettled(
    teluguCats.map((c) => provider.getStreams(c.id, "live")),
  );

  const seen = new Set<string>();
  const allStreams: CatalogItem[] = [];
  for (const r of streamResults) {
    if (r.status === "fulfilled") {
      for (const s of r.value) {
        if (!seen.has(s.id)) {
          seen.add(s.id);
          allStreams.push(s);
        }
      }
    }
  }

  const featured = allStreams
    .map((s) => ({ stream: s, rank: matchesPriority(s.name) }))
    .filter((e) => e.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((e) => e.stream)
    .slice(0, 20);

  cacheSet(WARMUP_CACHE_KEYS.LIVE_FEATURED, featured, CacheTTL.CHANNEL_LIST);
}

interface WarmupStep {
  key: string;
  label: string;
  run: (provider: IStreamProvider) => Promise<void>;
}

/**
 * Ordered warmup steps — design §5 G5 revised order.
 * live/categories (~200ms) → live/featured (~4s) → vod/categories (~60s)
 * → series/categories (~30–90s). Featured is prioritized ahead of VOD/series
 * since it drives the v3 home screen and categories warm fast.
 */
const WARMUP_STEPS: WarmupStep[] = [
  {
    key: WARMUP_CACHE_KEYS.LIVE_CATEGORIES,
    label: "live/categories",
    run: async (p) => {
      await p.getCategories("live"); // XtreamProvider caches internally
    },
  },
  {
    key: WARMUP_CACHE_KEYS.LIVE_FEATURED,
    label: "live/featured",
    run: (p) => populateFeatured(p),
  },
  {
    key: WARMUP_CACHE_KEYS.VOD_CATEGORIES,
    label: "vod/categories",
    run: async (p) => {
      await p.getCategories("vod");
    },
  },
  {
    key: WARMUP_CACHE_KEYS.SERIES_CATEGORIES,
    label: "series/categories",
    run: async (p) => {
      await p.getCategories("series");
    },
  },
];

/**
 * Execute a single warmup step with failure isolation + backoff reset.
 *
 * Warmup-specific failures must NOT add exponential backoff to the next real
 * user request (design §5 G2). We call `provider.resetFailureState()` after
 * a caught error so the BaseStreamProvider's consecutiveFailures returns to 0.
 */
async function runWarmupStep(
  step: WarmupStep,
  provider: IStreamProvider,
): Promise<boolean> {
  const start = Date.now();
  try {
    await step.run(provider);
    console.log(
      `[warmup] ${step.label} populated in ${Date.now() - start}ms`,
    );
    return true;
  } catch (err) {
    console.error(
      `[warmup] ${step.label} failed:`,
      err instanceof Error ? err.message : err,
    );
    provider.resetFailureState();
    return false;
  }
}

/**
 * Pre-refresh a single monitored key. Re-uses the same `run` function from
 * the warmup step definitions — this keeps the refresh path and the warmup
 * path identical.
 */
async function preRefresh(
  step: WarmupStep,
  provider: IStreamProvider,
): Promise<void> {
  if (refreshingKeys.has(step.key)) return;
  refreshingKeys.add(step.key);
  try {
    await runWarmupStep(step, provider);
  } finally {
    refreshingKeys.delete(step.key);
  }
}

/**
 * Exported for unit testing. Inspects each monitored key and triggers a
 * pre-refresh for any key whose remaining TTL is inside PRE_REFRESH_WINDOW_S.
 * Keys that are entirely absent from the cache are left alone (warmup owns
 * cold-start population — see design §2c edge case).
 */
export function checkAndPreRefresh(provider: IStreamProvider): void {
  const now = Date.now();
  for (const step of WARMUP_STEPS) {
    const expiryMs = cacheGetTtl(step.key);
    if (!expiryMs) continue; // absent key — warmup territory, not refresh
    const remainingS = (expiryMs - now) / 1000;
    if (remainingS < PRE_REFRESH_WINDOW_S) {
      void preRefresh(step, provider);
    }
  }
}

/**
 * Run the warmup pass sequentially (see design §2a). Each step is isolated;
 * one failure does not abort the rest. Side-effects: logs, sets
 * `warmupComplete` + `warmupDurationMs` module state when done.
 */
export async function runWarmup(provider: IStreamProvider): Promise<void> {
  const start = Date.now();
  console.log("[warmup] Starting cache warmup...");
  for (const step of WARMUP_STEPS) {
    // Skip steps whose key is already populated (e.g. catalog.service's
    // boot-time fetch already filled an adjacent cache). We check by key
    // presence, not TTL remaining.
    if (cacheGet(step.key) !== undefined) {
      console.log(`[warmup] ${step.label} already warm — skipping`);
      continue;
    }
    await runWarmupStep(step, provider);
  }
  warmupDurationMs = Date.now() - start;
  warmupComplete = true;
  console.log(`[warmup] Warmup pass complete in ${warmupDurationMs}ms`);
}

/**
 * Start cache warmup + background TTL pre-refresh.
 *
 * Wired into src/index.ts inside app.listen() after startCatalogSync +
 * startEPGRefresh. Non-blocking — the server is already accepting connections
 * when this kicks off.
 *
 * Returns the NodeJS.Timeout of the pre-refresh interval (for test cleanup).
 */
export function startCacheWarmup(provider: IStreamProvider): NodeJS.Timeout {
  setTimeout(() => {
    void runWarmup(provider);
  }, WARMUP_START_DELAY_MS);

  const interval = setInterval(() => {
    checkAndPreRefresh(provider);
  }, POLL_INTERVAL_MS);

  console.log("[warmup] Cache warmup + pre-refresh scheduler started");
  return interval;
}

// Test-only reset to clear module state between tests.
export function __resetWarmupStateForTests(): void {
  warmupComplete = false;
  warmupDurationMs = null;
  refreshingKeys.clear();
}
