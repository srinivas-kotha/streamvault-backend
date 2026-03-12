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
