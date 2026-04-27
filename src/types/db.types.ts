export interface DbUser {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DbRefreshToken {
  id: number;
  user_id: number;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
  revoked: boolean;
}

export interface DbFavorite {
  id: number;
  user_id: number;
  content_type: 'channel' | 'vod' | 'series';
  content_id: number;
  content_name: string | null;
  content_icon: string | null;
  category_name: string | null;
  sort_order: number;
  added_at: Date;
}

export interface DbWatchHistory {
  id: number;
  user_id: number;
  content_type: 'channel' | 'vod' | 'series';
  content_id: number;
  content_name: string | null;
  content_icon: string | null;
  progress_seconds: number;
  duration_seconds: number;
  watched_at: Date;
}

export interface DbDownload {
  id: number;
  user_id: number;
  vod_id: number;
  vod_name: string;
  file_path: string | null;
  file_size_bytes: number;
  status: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  progress_percent: number;
  error_message: string | null;
  queued_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface DbRecording {
  id: number;
  user_id: number;
  channel_id: number;
  channel_name: string;
  scheduled_start: Date;
  duration_minutes: number;
  file_path: string | null;
  file_size_bytes: number;
  status: 'scheduled' | 'recording' | 'completed' | 'failed' | 'cancelled';
  error_message: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface DbSetting {
  id: number;
  user_id: number;
  key: string;
  value: Record<string, unknown>;
}

export interface DbStreamAudioTrack {
  id: number;
  provider_id: string;
  stream_id: string;
  content_type: 'vod' | 'series-episode';
  track_index: number;
  language_code: string | null;
  label: string | null;
  codec: string | null;
  channel_count: number | null;
  bitrate_bps: number | null;
  source: 'player' | 'ingest' | 'manual';
  reporter_user_id: number | null;
  report_count: number;
  first_reported_at: Date;
  last_reported_at: Date;
}
