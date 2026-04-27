-- Phase 4: Player-reported audio track cache
-- Stores multi-audio metadata surfaced by the player's video element
-- so the frontend can render "Available in: English, Telugu, Hindi" badges
-- without each user starting playback.
--
-- Provider-agnostic: keyed by (provider_id, stream_id, content_type), no FK
-- to sv_catalog so rows survive catalog churn / re-syncs.

CREATE TABLE IF NOT EXISTS sv_stream_audio_tracks (
  id               SERIAL PRIMARY KEY,

  provider_id      TEXT        NOT NULL,
  stream_id        TEXT        NOT NULL,
  content_type     TEXT        NOT NULL
                   CHECK (content_type IN ('vod', 'series-episode')),
                   -- Live streams excluded — provider TS streams have no
                   -- stable multi-audio and FFmpeg collapses them to AAC
                   -- stereo anyway. Track caching adds zero value there.

  track_index      SMALLINT    NOT NULL,
  language_code    TEXT,
  label            TEXT,
  codec            TEXT,
  channel_count    SMALLINT,
  bitrate_bps      INTEGER,

  source           TEXT        NOT NULL
                   CHECK (source IN ('player', 'ingest', 'manual')),

  reporter_user_id INTEGER,
  report_count     SMALLINT    NOT NULL DEFAULT 1,
  first_reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_reported_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (provider_id, stream_id, content_type, track_index)
);

-- Primary read path: bulk-fetch all tracks for a list of streams (badge query).
CREATE INDEX IF NOT EXISTS idx_sv_sat_stream
  ON sv_stream_audio_tracks (provider_id, stream_id, content_type);

-- Admin: tracks reported by a specific user.
CREATE INDEX IF NOT EXISTS idx_sv_sat_reporter
  ON sv_stream_audio_tracks (reporter_user_id)
  WHERE reporter_user_id IS NOT NULL;

-- Confidence-filtered queries: high-report-count tracks first.
CREATE INDEX IF NOT EXISTS idx_sv_sat_confidence
  ON sv_stream_audio_tracks (provider_id, stream_id, content_type, report_count DESC);
