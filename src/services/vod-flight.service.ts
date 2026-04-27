/**
 * VOD-flight service — single-flight deduplication for VOD/series Range fetches.
 *
 * Symptom this fixes: Fire TV ExoPlayer fires 2-4 overlapping Range requests
 * during a single seek event. Each previously hit `stream.router.ts` and
 * opened a fresh upstream `fetch()` to Xtream, so a 5-second seek could
 * spawn 6 simultaneous TCP connections. Xtream rate-limits per-session,
 * which presents as the user-visible stutter.
 *
 * Strategy: dedup in-flight upstream requests keyed by `url|range`. When two
 * or more requests arrive with identical url+range, only one upstream
 * `fetch()` is issued; subsequent requesters share the response via
 * `Response.clone()` (undici tee). When the last subscriber disconnects,
 * the upstream `AbortController` is triggered.
 *
 * Live streams must NEVER go through this path — they are infinite chunked
 * streams, sharing them via tee would corrupt the FFmpeg pipeline. The
 * caller (`stream.router.ts`) gates on `isLive` before delegating here.
 */
import { Mutex } from "async-mutex";

interface FlightEntry {
  promise: Promise<globalThis.Response>;
  controller: AbortController;
  refs: number;
}

const inFlight = new Map<string, FlightEntry>();
const mapMutex = new Mutex();

function makeKey(url: string, range: string | undefined): string {
  return `${url}|${range ?? "full"}`;
}

/**
 * Fetch a URL with single-flight dedup. Concurrent calls with the same
 * (url, range) share a single upstream fetch. Each caller receives an
 * independent `Response` clone they can pipe to their own response
 * stream.
 *
 * The caller MUST attach a `req.on("close", () => releaseVodRange(key))`
 * for cleanup, and pass the returned `key` back so we can decrement the
 * subscriber count.
 */
export async function getOrFetchVodRange(
  url: string,
  upstreamHeaders: Record<string, string>,
  range: string | undefined,
): Promise<{ response: globalThis.Response; key: string }> {
  const key = makeKey(url, range);

  return mapMutex.runExclusive(async () => {
    const existing = inFlight.get(key);
    if (existing) {
      existing.refs += 1;
      const original = await existing.promise;
      return { response: original.clone(), key };
    }

    const controller = new AbortController();
    const headers: Record<string, string> = { ...upstreamHeaders };
    if (range) headers["Range"] = range;

    const promise = fetch(url, {
      headers,
      signal: controller.signal,
    });

    const entry: FlightEntry = { promise, controller, refs: 1 };
    inFlight.set(key, entry);

    // Auto-evict the entry once the promise settles + a small grace
    // window in case a follow-up duplicate request arrives mid-fetch.
    // Without this, a long-lived VOD fetch leaks until the LAST
    // subscriber disconnects, which is correct — but if all subscribers
    // already detached BEFORE the fetch resolved, we want to clean up.
    // The trailing .catch() swallows any rejection on this chain so it
    // never surfaces as an unhandled-rejection (the real consumer below
    // already handles the rejection on its own awaited copy).
    void promise
      .finally(() => {
        setTimeout(() => {
          const cur = inFlight.get(key);
          if (cur && cur.refs <= 0) inFlight.delete(key);
        }, 100);
      })
      .catch(() => {
        /* handled by the awaiting caller */
      });

    try {
      const original = await promise;
      return { response: original.clone(), key };
    } catch (err) {
      // Fetch threw — make sure the entry is gone before propagating.
      inFlight.delete(key);
      throw err;
    }
  });
}

/**
 * Decrement the subscriber count for an in-flight key. When it reaches
 * zero, abort the upstream fetch and remove the entry.
 *
 * Safe to call on a key that has already been evicted — silently no-ops.
 */
export function releaseVodRange(key: string): void {
  const entry = inFlight.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    entry.controller.abort();
    inFlight.delete(key);
  }
}

/** Test-only helper: read the current map size. */
export function __vodFlightSizeForTest(): number {
  return inFlight.size;
}

/** Test-only helper: clear the map between tests. */
export function __vodFlightResetForTest(): void {
  for (const entry of inFlight.values()) {
    entry.controller.abort();
  }
  inFlight.clear();
}
