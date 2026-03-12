export interface LoginRequest {
  username: string;
  password: string;
}

export interface TokenPayload {
  userId: number;
  username: string;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptime: number;
  providerHealthy: boolean;
  timestamp: string;
}

export interface FavoriteRequest {
  content_type: 'channel' | 'vod' | 'series';
  content_name?: string;
  content_icon?: string;
  category_name?: string;
}

export interface HistoryUpdateRequest {
  content_type: 'channel' | 'vod' | 'series';
  content_name?: string;
  content_icon?: string;
  progress_seconds: number;
  duration_seconds: number;
}

export interface DownloadQueueRequest {
  vod_id: number;
  vod_name: string;
}

export interface RecordingScheduleRequest {
  channel_id: number;
  channel_name: string;
  scheduled_start: string;
  duration_minutes: number;
}
