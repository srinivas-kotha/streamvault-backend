import { BaseStreamProvider } from "../base.provider";
import { CacheTTL, cacheGet, cacheSet } from "../../services/cache.service";
import type {
  ContentType,
  CatalogCategory,
  CatalogItem,
  CatalogItemDetail,
  NormalizedEPGEntry,
  StreamProxyInfo,
  StreamInfo,
  AuthResponse,
} from "../provider.types";
import type {
  XtreamCategory,
  XtreamLiveStream,
  XtreamVODStream,
  XtreamVODInfo,
  XtreamSeriesItem,
  XtreamSeriesInfo,
  XtreamEPGItem,
  XtreamAuthResponse,
} from "./xtream.types";
import {
  adaptLiveStream,
  adaptVODStream,
  adaptSeriesItem,
  adaptVODInfo,
  adaptSeriesInfo,
  adaptEPGItem,
  adaptCategory,
} from "./xtream.adapters";

interface XtreamConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

const USER_AGENT = "IPTV Smarters Pro/2.2.2.1";

export class XtreamProvider extends BaseStreamProvider {
  readonly name = "xtream";
  private readonly baseUrl: string;
  private readonly apiUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly host: string;
  private readonly port: number;

  constructor(xtreamConfig: XtreamConfig) {
    super();
    this.host = xtreamConfig.host;
    this.port = xtreamConfig.port;
    this.username = xtreamConfig.username;
    this.password = xtreamConfig.password;
    this.baseUrl = `http://${this.host}:${this.port}`;
    this.apiUrl = `${this.baseUrl}/player_api.php`;
  }

  private buildApiUrl(action: string, extra?: Record<string, string>): string {
    const params = new URLSearchParams({
      username: this.username,
      password: this.password,
      action,
      ...extra,
    });
    return `${this.apiUrl}?${params.toString()}`;
  }

  private defaultHeaders(): Record<string, string> {
    return { "User-Agent": USER_AGENT };
  }

  async authenticate(): Promise<AuthResponse> {
    const url = `${this.apiUrl}?username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
    return this.fetchJson<XtreamAuthResponse>(
      url,
      this.defaultHeaders(),
    ) as Promise<AuthResponse>;
  }

  async getCategories(type: ContentType): Promise<CatalogCategory[]> {
    const actionMap = {
      live: "get_live_categories",
      vod: "get_vod_categories",
      series: "get_series_categories",
    } as const;

    const ttlMap = {
      live: CacheTTL.CHANNEL_CATEGORIES,
      vod: CacheTTL.VOD_CATEGORIES,
      series: CacheTTL.SERIES_CATEGORIES,
    } as const;

    const cacheKey = `${this.name}:categories:${type}`;
    const url = this.buildApiUrl(actionMap[type]);
    const rawCategories = await this.cachedFetch<XtreamCategory[]>(
      cacheKey,
      ttlMap[type],
      url,
      this.defaultHeaders(),
    );
    return rawCategories.map((c) => adaptCategory(c, type));
  }

  async getStreams(
    categoryId: string,
    type: ContentType,
  ): Promise<CatalogItem[]> {
    const actionMap = {
      live: "get_live_streams",
      vod: "get_vod_streams",
      series: "get_series",
    } as const;

    const ttlMap = {
      live: CacheTTL.CHANNEL_LIST,
      vod: CacheTTL.VOD_LIST,
      series: CacheTTL.SERIES_LIST,
    } as const;

    const cacheKey = `${this.name}:streams:${type}:${categoryId}`;
    const url = this.buildApiUrl(actionMap[type], { category_id: categoryId });

    if (type === "live") {
      const raw = await this.cachedFetch<XtreamLiveStream[]>(
        cacheKey,
        ttlMap[type],
        url,
        this.defaultHeaders(),
      );
      return raw.map(adaptLiveStream);
    } else if (type === "vod") {
      const raw = await this.cachedFetch<XtreamVODStream[]>(
        cacheKey,
        ttlMap[type],
        url,
        this.defaultHeaders(),
      );
      return raw.map(adaptVODStream);
    } else {
      const raw = await this.cachedFetch<XtreamSeriesItem[]>(
        cacheKey,
        ttlMap[type],
        url,
        this.defaultHeaders(),
      );
      return raw.map(adaptSeriesItem);
    }
  }

  getStreamURL(streamId: string, type: "live" | "vod"): string {
    const ext = type === "live" ? "ts" : "mp4";
    return `${this.baseUrl}/${type}/${this.username}/${this.password}/${streamId}.${ext}`;
  }

  async getSeriesInfo(seriesId: string): Promise<CatalogItemDetail> {
    const cacheKey = `${this.name}:series_info:${seriesId}`;
    const url = this.buildApiUrl("get_series_info", { series_id: seriesId });
    const raw = await this.cachedFetch<XtreamSeriesInfo>(
      cacheKey,
      CacheTTL.SERIES_INFO,
      url,
      this.defaultHeaders(),
    );
    return adaptSeriesInfo(raw, seriesId);
  }

  async getVODInfo(vodId: string): Promise<CatalogItemDetail> {
    const cacheKey = `${this.name}:vod_info:${vodId}`;
    const url = this.buildApiUrl("get_vod_info", { vod_id: vodId });
    const raw = await this.cachedFetch<XtreamVODInfo>(
      cacheKey,
      CacheTTL.VOD_INFO,
      url,
      this.defaultHeaders(),
    );
    return adaptVODInfo(raw);
  }

  async getEPG(streamId: string): Promise<NormalizedEPGEntry[]> {
    const cacheKey = `${this.name}:epg:${streamId}`;

    const cached = cacheGet<{ epg_listings: XtreamEPGItem[] }>(cacheKey);
    if (cached !== undefined) return cached.epg_listings.map(adaptEPGItem);

    const backoff = this.getBackoffMs();
    if (backoff > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }

    const url = this.buildApiUrl("get_short_epg", { stream_id: streamId });
    const data = await this.fetchJson<{ epg_listings: XtreamEPGItem[] }>(
      url,
      this.defaultHeaders(),
    );
    cacheSet(cacheKey, data, CacheTTL.EPG_NOW_NEXT);
    return data.epg_listings.map(adaptEPGItem);
  }

  async getFullEPG(): Promise<NormalizedEPGEntry[]> {
    const cacheKey = `${this.name}:epg:full`;

    const cached = cacheGet<{ epg_listings: XtreamEPGItem[] }>(cacheKey);
    if (cached !== undefined) return cached.epg_listings.map(adaptEPGItem);

    const backoff = this.getBackoffMs();
    if (backoff > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }

    const url = this.buildApiUrl("get_simple_data_table", { stream_id: "" });
    const data = await this.fetchJson<{ epg_listings: XtreamEPGItem[] }>(
      url,
      this.defaultHeaders(),
    );
    cacheSet(cacheKey, data, CacheTTL.EPG_FULL);
    return data.epg_listings.map(adaptEPGItem);
  }

  getStreamProxyInfo(streamId: string, type: ContentType): StreamProxyInfo {
    const formatMap: Record<ContentType, { path: string; ext: string }> = {
      live: { path: "live", ext: "ts" },
      vod: { path: "movie", ext: "mp4" },
      series: { path: "series", ext: "mp4" },
    };

    const { path, ext } = formatMap[type];
    const url = `${this.baseUrl}/${path}/${this.username}/${this.password}/${streamId}.${ext}`;

    return {
      url,
      format: ext,
      headers: this.defaultHeaders(),
      baseUrl: `${this.baseUrl}/live/${this.username}/${this.password}/`,
      allowedHost: { hostname: this.host, port: String(this.port) },
    };
  }

  getSegmentProxyInfo(segmentPath: string): StreamProxyInfo {
    return {
      url: `${this.baseUrl}/live/${this.username}/${this.password}/${segmentPath}`,
      format: segmentPath.endsWith(".m3u8") ? "m3u8" : "ts",
      headers: this.defaultHeaders(),
      baseUrl: `${this.baseUrl}/live/${this.username}/${this.password}/`,
      allowedHost: { hostname: this.host, port: String(this.port) },
    };
  }

  getStreamInfo(
    itemId: string,
    type: ContentType,
    extension?: string,
  ): StreamInfo {
    const ext = extension ?? this.getDefaultExtension(type);
    const typePath =
      type === "live" ? "live" : type === "series" ? "series" : "movie";
    const url = `${this.baseUrl}/${typePath}/${this.username}/${this.password}/${itemId}.${ext}`;

    return {
      url,
      format: this.mapExtToFormat(ext),
      headers: this.defaultHeaders(),
      allowedHosts: [{ hostname: this.host, port: String(this.port) }],
    };
  }

  private getDefaultExtension(type: ContentType): string {
    switch (type) {
      case "live":
        return "ts";
      case "vod":
        return "mp4";
      case "series":
        return "mp4";
    }
  }

  private mapExtToFormat(ext: string): StreamInfo["format"] {
    switch (ext) {
      case "ts":
        return "ts";
      case "mp4":
        return "mp4";
      case "m3u8":
        return "m3u8";
      case "rtmp":
        return "rtmp";
      default:
        return "unknown";
    }
  }
}
