// --- Content Type ---

export type ContentType = "live" | "vod" | "series";

// --- Generic Domain Types ---

export interface Category {
  category_id: string;
  category_name: string;
  parent_id: number;
}

export interface Channel {
  num: number;
  name: string;
  stream_type: string;
  stream_id: number;
  stream_icon: string;
  epg_channel_id: string;
  added: string;
  is_adult: string;
  category_id: string;
  category_ids: number[];
  custom_sid: string;
  tv_archive: number;
  direct_source: string;
  tv_archive_duration: number;
}

export interface VODItem {
  num: number;
  name: string;
  stream_type: string;
  stream_id: number;
  stream_icon: string;
  rating: string;
  rating_5based: number;
  added: string;
  is_adult: string;
  category_id: string;
  category_ids: number[];
  container_extension: string;
  custom_sid: string;
  direct_source: string;
}

export interface VODInfo {
  info: {
    movie_image: string;
    tmdb_id: string;
    name: string;
    o_name: string;
    plot: string;
    cast: string;
    director: string;
    genre: string;
    releaseDate: string;
    duration: string;
    duration_secs: number;
    rating: string;
  };
  movie_data: {
    stream_id: number;
    name: string;
    added: string;
    category_id: string;
    container_extension: string;
    custom_sid: string;
    direct_source: string;
  };
}

export interface SeriesItem {
  num: number;
  name: string;
  series_id: number;
  cover: string;
  plot: string;
  cast: string;
  director: string;
  genre: string;
  releaseDate: string;
  last_modified: string;
  rating: string;
  rating_5based: number;
  backdrop_path: string[];
  category_id: string;
  category_ids: number[];
}

export interface SeriesInfo {
  seasons: Array<{
    air_date: string;
    episode_count: number;
    id: number;
    name: string;
    overview: string;
    season_number: number;
    cover: string;
  }>;
  info: {
    name: string;
    cover: string;
    plot: string;
    cast: string;
    director: string;
    genre: string;
    releaseDate: string;
    rating: string;
    backdrop_path: string[];
  };
  episodes: Record<
    string,
    Array<{
      id: string;
      episode_num: number;
      title: string;
      container_extension: string;
      info: {
        duration_secs: number;
        duration: string;
        plot: string;
        movie_image: string;
      };
      season: number;
      direct_source: string;
    }>
  >;
}

export interface EPGEntry {
  id: string;
  epg_id: string;
  title: string;
  lang: string;
  start: string;
  end: string;
  description: string;
  channel_id: string;
  start_timestamp: string;
  stop_timestamp: string;
}

export interface StreamURL {
  url: string;
  format: string;
}

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

export interface AuthResponse {
  user_info: {
    username: string;
    password: string;
    message: string;
    auth: number;
    status: string;
    exp_date: string;
    is_trial: string;
    active_cons: string;
    created_at: string;
    max_connections: string;
    allowed_output_formats: string[];
  };
  server_info: {
    url: string;
    port: string;
    https_port: string;
    server_protocol: string;
    rtmp_port: string;
    timezone: string;
    timestamp_now: number;
    time_now: string;
  };
}

// === Phase 2: Provider-Agnostic Types ===

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

// Normalized EPG entry (will replace old EPGEntry in PR 2)
export interface NormalizedEPGEntry {
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
  getEPG(streamId: string): Promise<NormalizedEPGEntry[]>;
  getFullEPG(): Promise<NormalizedEPGEntry[]>;

  // Streaming
  getStreamURL(streamId: string, type: "live" | "vod"): string;
  getStreamProxyInfo(streamId: string, type: ContentType): StreamProxyInfo;
  getSegmentProxyInfo(segmentPath: string): StreamProxyInfo;
  getStreamInfo(
    itemId: string,
    type: ContentType,
    extension?: string,
  ): StreamInfo;

  // Health
  isHealthy(): boolean;

  // Auth (optional — not all providers need it)
  authenticate?(): Promise<AuthResponse>;
}
