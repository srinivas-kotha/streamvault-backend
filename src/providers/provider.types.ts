// --- Content Type ---

export type ContentType = "live" | "vod" | "series";

/** Language tag inferred from category name. Used for client-side language filtering. */
export type InferredLang = "telugu" | "hindi" | "english" | "sports";

export interface StreamProxyInfo {
  /** Full upstream URL to fetch */
  url: string;
  /** Stream format: 'ts' | 'mp4' | 'm3u8' */
  format: string;
  /** Headers to send to upstream */
  headers: Record<string, string>;
  /** For M3U8 rewriting: base URL to strip from absolute URLs */
  baseUrl: string;
  /** SSRF check: hostname + port the URL must match */
  allowedHost: { hostname: string; port: string };
}

// === Provider-Agnostic Types ===

export interface CatalogCategory {
  id: string;
  name: string;
  parentId: string | null;
  type: ContentType;
  count?: number;
}

export interface CatalogItem {
  id: string;
  name: string;
  type: ContentType;
  categoryId: string;
  icon: string | null;
  added: string | null;
  isAdult: boolean;
  rating?: string;
  genre?: string;
  year?: string;
  /**
   * Language inferred from the item's category name via server-side regex.
   * Null when no pattern matches (e.g. "News", "Kids", "Action").
   * Populated by the router layer where both category names and items are
   * available. Replaces the client-side LANGUAGE_PATTERNS duplicate logic
   * that was in LiveRoute / MoviesRoute / SeriesRoute (frontend issue #52).
   */
  inferredLang?: InferredLang | null;
}

export interface SeasonInfo {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  icon?: string;
}

export interface EpisodeInfo {
  id: string;
  episodeNumber: number;
  title: string;
  containerExtension?: string;
  duration?: number;
  plot?: string;
  rating?: string;
  icon?: string;
  added?: string;
}

export interface CatalogItemDetail extends CatalogItem {
  plot?: string;
  cast?: string;
  director?: string;
  duration?: string;
  durationSecs?: number;
  containerExtension?: string;
  backdropUrl?: string;
  tmdbId?: string;
  seasons?: SeasonInfo[];
  episodes?: Record<string, EpisodeInfo[]>;
}

export interface StreamInfo {
  url: string;
  format: "ts" | "mp4" | "m3u8" | "rtmp" | "unknown";
  headers: Record<string, string>;
  allowedHosts: Array<{ hostname: string; port: string }>;
  qualities?: Array<{ label: string; url: string; bandwidth?: number }>;
}

export interface EPGEntry {
  id: string;
  channelId: string;
  title: string;
  description: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  category?: string;
  icon?: string;
}

export interface AccountInfo {
  username?: string;
  maxConnections?: number;
  activeConnections?: number;
  expiryDate?: string;
  isTrial?: boolean;
  status?: "active" | "expired" | "banned" | "disabled";
  allowedFormats?: string[];
}

export interface CatchupInfo {
  streamId: string;
  available: boolean;
  maxDays: number;
}

// --- Provider Interface ---

export interface IStreamProvider {
  readonly name: string;

  // Content browsing
  getCategories(type: ContentType): Promise<CatalogCategory[]>;
  getStreams(categoryId: string, type: ContentType): Promise<CatalogItem[]>;
  getVODInfo(vodId: string): Promise<CatalogItemDetail>;
  getSeriesInfo(seriesId: string): Promise<CatalogItemDetail>;

  // EPG
  getEPG(streamId: string): Promise<EPGEntry[]>;
  getFullEPG(): Promise<EPGEntry[]>;

  // Streaming
  getSegmentProxyInfo(segmentPath: string): StreamProxyInfo;
  getStreamInfo(
    itemId: string,
    type: ContentType,
    extension?: string,
  ): StreamInfo;

  // Health
  isHealthy(): boolean;

  /**
   * Reset the backoff counter and mark the provider healthy.
   * Intended for background warmup/pre-refresh callers that should not
   * poison real-user request backoff state when an opportunistic refresh
   * fails. See warmup.service.ts.
   */
  resetFailureState(): void;

  // Auth (optional — not all providers need it)
  authenticate?(): Promise<AccountInfo>;
}
