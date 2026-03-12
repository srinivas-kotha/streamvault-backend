import { config } from '../config';
import { cacheGet, cacheSet, CacheTTL } from './cache.service';
import type {
  XtreamAuthResponse,
  XtreamCategory,
  XtreamLiveStream,
  XtreamVODStream,
  XtreamVODInfo,
  XtreamSeriesItem,
  XtreamSeriesInfo,
  XtreamEPGItem,
} from '../types/xtream.types';

const { host, port, username, password } = config.xtream;
const BASE_URL = `http://${host}:${port}`;
const API_URL = `${BASE_URL}/player_api.php`;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

let providerHealthy = true;
let consecutiveFailures = 0;

function getBackoffMs(): number {
  if (consecutiveFailures === 0) return 0;
  return Math.min(1000 * Math.pow(2, consecutiveFailures - 1), MAX_BACKOFF_MS);
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`Xtream API returned ${res.status}`);
    }

    const data = (await res.json()) as T;

    // Success — reset health tracking
    consecutiveFailures = 0;
    providerHealthy = true;

    return data;
  } catch (err) {
    consecutiveFailures++;
    providerHealthy = false;

    const backoff = getBackoffMs();
    console.error(
      `[xtream] Request failed (attempt ${consecutiveFailures}, next backoff ${backoff}ms):`,
      err instanceof Error ? err.message : err,
    );

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(action: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({
    username,
    password,
    action,
    ...extra,
  });
  return `${API_URL}?${params.toString()}`;
}

async function cachedFetch<T>(cacheKey: string, ttl: number, url: string): Promise<T> {
  const cached = cacheGet<T>(cacheKey);
  if (cached !== undefined) return cached;

  // Respect backoff before hitting the provider
  const backoff = getBackoffMs();
  if (backoff > 0) {
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }

  const data = await fetchJson<T>(url);
  cacheSet(cacheKey, data, ttl);
  return data;
}

// --- Public API ---

async function authenticate(): Promise<XtreamAuthResponse> {
  const url = `${API_URL}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  return fetchJson<XtreamAuthResponse>(url);
}

async function getCategories(type: 'live' | 'vod' | 'series'): Promise<XtreamCategory[]> {
  const actionMap = {
    live: 'get_live_categories',
    vod: 'get_vod_categories',
    series: 'get_series_categories',
  } as const;

  const ttlMap = {
    live: CacheTTL.CHANNEL_CATEGORIES,
    vod: CacheTTL.VOD_CATEGORIES,
    series: CacheTTL.SERIES_CATEGORIES,
  } as const;

  const cacheKey = `xtream:categories:${type}`;
  const url = buildUrl(actionMap[type]);
  return cachedFetch<XtreamCategory[]>(cacheKey, ttlMap[type], url);
}

async function getStreams(catId: string, type: 'live' | 'vod' | 'series'): Promise<(XtreamLiveStream | XtreamVODStream | XtreamSeriesItem)[]> {
  const actionMap = {
    live: 'get_live_streams',
    vod: 'get_vod_streams',
    series: 'get_series',
  } as const;

  const ttlMap = {
    live: CacheTTL.CHANNEL_LIST,
    vod: CacheTTL.VOD_LIST,
    series: CacheTTL.SERIES_LIST,
  } as const;

  const cacheKey = `xtream:streams:${type}:${catId}`;
  const url = buildUrl(actionMap[type], { category_id: catId });
  return cachedFetch<(XtreamLiveStream | XtreamVODStream | XtreamSeriesItem)[]>(cacheKey, ttlMap[type], url);
}

function getStreamURL(streamId: string, type: 'live' | 'vod'): string {
  const ext = type === 'live' ? 'ts' : 'mp4';
  return `${BASE_URL}/${type}/${username}/${password}/${streamId}.${ext}`;
}

async function getSeriesInfo(seriesId: string): Promise<XtreamSeriesInfo> {
  const cacheKey = `xtream:series_info:${seriesId}`;
  const url = buildUrl('get_series_info', { series_id: seriesId });
  return cachedFetch<XtreamSeriesInfo>(cacheKey, CacheTTL.SERIES_INFO, url);
}

async function getVODInfo(vodId: string): Promise<XtreamVODInfo> {
  const cacheKey = `xtream:vod_info:${vodId}`;
  const url = buildUrl('get_vod_info', { vod_id: vodId });
  return cachedFetch<XtreamVODInfo>(cacheKey, CacheTTL.VOD_INFO, url);
}

async function getEPG(streamId: string): Promise<XtreamEPGItem[]> {
  const cacheKey = `xtream:epg:${streamId}`;
  const url = buildUrl('get_short_epg', { stream_id: streamId });

  const cached = cacheGet<{ epg_listings: XtreamEPGItem[] }>(cacheKey);
  if (cached !== undefined) return cached.epg_listings;

  const backoff = getBackoffMs();
  if (backoff > 0) {
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }

  const data = await fetchJson<{ epg_listings: XtreamEPGItem[] }>(url);
  cacheSet(cacheKey, data, CacheTTL.EPG_NOW_NEXT);
  return data.epg_listings;
}

async function getFullEPG(): Promise<XtreamEPGItem[]> {
  const cacheKey = 'xtream:epg:full';
  const url = buildUrl('get_simple_data_table', { stream_id: '' });

  const cached = cacheGet<{ epg_listings: XtreamEPGItem[] }>(cacheKey);
  if (cached !== undefined) return cached.epg_listings;

  const backoff = getBackoffMs();
  if (backoff > 0) {
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }

  const data = await fetchJson<{ epg_listings: XtreamEPGItem[] }>(url);
  cacheSet(cacheKey, data, CacheTTL.EPG_FULL);
  return data.epg_listings;
}

export function isProviderHealthy(): boolean {
  return providerHealthy;
}

export const xtreamService = {
  authenticate,
  getCategories,
  getStreams,
  getStreamURL,
  getSeriesInfo,
  getVODInfo,
  getEPG,
  getFullEPG,
};
