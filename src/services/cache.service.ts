import NodeCache from 'node-cache';

const cache = new NodeCache({
  checkperiod: 120,
  useClones: false,
});

export const CacheTTL = {
  CHANNEL_CATEGORIES: 3600,      // 1 hour
  CHANNEL_LIST: 1800,            // 30 min
  EPG_NOW_NEXT: 900,             // 15 min
  EPG_FULL: 3600,                // 1 hour
  VOD_CATEGORIES: 21600,         // 6 hours
  VOD_LIST: 7200,                // 2 hours
  VOD_INFO: 7200,                // 2 hours
  SERIES_CATEGORIES: 21600,      // 6 hours
  SERIES_LIST: 7200,             // 2 hours
  SERIES_INFO: 7200,             // 2 hours
  SEARCH: 300,                   // 5 min
} as const;

// Cache keys actively monitored by the warmup + pre-refresh scheduler.
// Wired up in warmup.service.ts — see ADR-009.
export const WARMUP_CACHE_KEYS = {
  LIVE_CATEGORIES: 'xtream:categories:live',
  VOD_CATEGORIES: 'xtream:categories:vod',
  SERIES_CATEGORIES: 'xtream:categories:series',
  LIVE_FEATURED: 'xtream:live:featured',
} as const;

export function cacheGet<T>(key: string): T | undefined {
  return cache.get<T>(key);
}

export function cacheSet<T>(key: string, value: T, ttl: number): boolean {
  return cache.set(key, value, ttl);
}

export function cacheDel(key: string): number {
  return cache.del(key);
}

export function cacheFlush(): void {
  cache.flushAll();
}

export function cacheStats(): NodeCache.Stats {
  return cache.getStats();
}

/**
 * Returns the absolute expiry timestamp (epoch ms) for `key`,
 * or `undefined` if the key is not in cache.
 *
 * NodeCache v5 `getTtl` returns:
 *   - a number (epoch ms) for keys with a TTL set
 *   - `0` for keys with no TTL (stored indefinitely)
 *   - `undefined` for unknown keys
 *
 * We return `undefined` for both the missing and no-TTL cases, so callers
 * can treat absence uniformly.
 */
export function cacheGetTtl(key: string): number | undefined {
  const ttl = cache.getTtl(key);
  if (!ttl) return undefined;
  return ttl;
}
