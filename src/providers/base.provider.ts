import { cacheGet, cacheSet } from "../services/cache.service";
import type {
  IStreamProvider,
  ContentType,
  CatalogCategory,
  CatalogItem,
  CatalogItemDetail,
  EPGEntry,
  StreamProxyInfo,
  StreamInfo,
} from "./provider.types";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

export abstract class BaseStreamProvider implements IStreamProvider {
  abstract readonly name: string;

  protected healthy = true;
  protected consecutiveFailures = 0;

  protected getBackoffMs(): number {
    if (this.consecutiveFailures === 0) return 0;
    return Math.min(
      1000 * Math.pow(2, this.consecutiveFailures - 1),
      MAX_BACKOFF_MS,
    );
  }

  protected async fetchJson<T>(
    url: string,
    headers?: Record<string, string>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: headers ?? {},
      });

      if (!res.ok) {
        throw new Error(`${this.name} API returned ${res.status}`);
      }

      const data = (await res.json()) as T;

      // Success — reset health tracking
      this.consecutiveFailures = 0;
      this.healthy = true;

      return data;
    } catch (err) {
      this.consecutiveFailures++;
      this.healthy = false;

      const backoff = this.getBackoffMs();
      console.error(
        `[${this.name}] Request failed (attempt ${this.consecutiveFailures}, next backoff ${backoff}ms):`,
        err instanceof Error ? err.message : err,
      );

      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  protected async cachedFetch<T>(
    cacheKey: string,
    ttl: number,
    url: string,
    headers?: Record<string, string>,
  ): Promise<T> {
    const cached = cacheGet<T>(cacheKey);
    if (cached !== undefined) return cached;

    // Respect backoff before hitting the provider
    const backoff = this.getBackoffMs();
    if (backoff > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }

    const data = await this.fetchJson<T>(url, headers);
    cacheSet(cacheKey, data, ttl);
    return data;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // Abstract methods — each provider implements these
  abstract getCategories(type: ContentType): Promise<CatalogCategory[]>;
  abstract getStreams(
    categoryId: string,
    type: ContentType,
  ): Promise<CatalogItem[]>;
  abstract getVODInfo(vodId: string): Promise<CatalogItemDetail>;
  abstract getSeriesInfo(seriesId: string): Promise<CatalogItemDetail>;
  abstract getEPG(streamId: string): Promise<EPGEntry[]>;
  abstract getFullEPG(): Promise<EPGEntry[]>;
  abstract getSegmentProxyInfo(segmentPath: string): StreamProxyInfo;
  abstract getStreamInfo(
    itemId: string,
    type: ContentType,
    extension?: string,
  ): StreamInfo;
}
