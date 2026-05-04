-- Phase 0.4: Content-identity layer schema.
-- Idempotent: uses IF NOT EXISTS / CREATE OR REPLACE where Postgres permits.
-- Tables are EMPTY in Phase 0 — populated by Phase 1 dual-write logic.

BEGIN;

-- ============================================================
-- 1) sv_content_master — canonical content entity
-- ============================================================
CREATE TABLE IF NOT EXISTS sv_content_master (
  content_uid       TEXT PRIMARY KEY,
  content_type      TEXT NOT NULL CHECK (content_type IN ('movie','series','episode','live')),
  normalized_title  TEXT NOT NULL,
  year              INTEGER,
  parent_show_uid   TEXT REFERENCES sv_content_master(content_uid) ON DELETE CASCADE,
  season_num        INTEGER,
  episode_num       INTEGER,
  external_ids      JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (content_type <> 'episode' OR (parent_show_uid IS NOT NULL AND season_num IS NOT NULL AND episode_num IS NOT NULL)),
  CHECK (length(content_uid) = 16)
);

CREATE OR REPLACE FUNCTION sv_content_master_set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sv_content_master_updated_at ON sv_content_master;
CREATE TRIGGER sv_content_master_updated_at BEFORE UPDATE ON sv_content_master
  FOR EACH ROW EXECUTE FUNCTION sv_content_master_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_master_title_year   ON sv_content_master (content_type, normalized_title, year);
CREATE INDEX IF NOT EXISTS idx_master_parent       ON sv_content_master (parent_show_uid) WHERE parent_show_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_imdb         ON sv_content_master ((external_ids->>'imdb_id')) WHERE external_ids ? 'imdb_id';
CREATE INDEX IF NOT EXISTS idx_master_tmdb         ON sv_content_master ((external_ids->>'tmdb_id')) WHERE external_ids ? 'tmdb_id';
CREATE INDEX IF NOT EXISTS idx_master_external_gin ON sv_content_master USING GIN (external_ids);

-- ============================================================
-- 2) sv_content_provider_map — per-provider item_id mapping
-- ============================================================
CREATE TABLE IF NOT EXISTS sv_content_provider_map (
  content_uid   TEXT NOT NULL REFERENCES sv_content_master(content_uid) ON DELETE RESTRICT,
  provider_id   TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  raw_data      JSONB,
  confidence    TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  first_synced  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_uid, provider_id),
  UNIQUE (provider_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_map_provider_item ON sv_content_provider_map (provider_id, item_id);

-- ============================================================
-- 3) sv_content_review_queue — ambiguity / conflict flags
-- ============================================================
CREATE TABLE IF NOT EXISTS sv_content_review_queue (
  id            SERIAL PRIMARY KEY,
  uid_a         TEXT NOT NULL,
  uid_b         TEXT,
  reason        TEXT NOT NULL,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_unresolved ON sv_content_review_queue (detected_at) WHERE resolved_at IS NULL;

-- ============================================================
-- 4) sv_content_merge_audit — immutable merge log
-- ============================================================
CREATE TABLE IF NOT EXISTS sv_content_merge_audit (
  id                 SERIAL PRIMARY KEY,
  keep_uid           TEXT NOT NULL,
  drop_uid           TEXT NOT NULL,
  reason             TEXT NOT NULL,
  operator           TEXT NOT NULL DEFAULT current_user,
  affected_favorites INTEGER NOT NULL DEFAULT 0,
  affected_history   INTEGER NOT NULL DEFAULT 0,
  affected_epg       INTEGER NOT NULL DEFAULT 0,
  merged_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 5) ALTER existing tables — additive nullable columns only
--    Backend continues reading/writing legacy columns unchanged.
-- ============================================================

-- sv_favorites: add nullable content_uid FK
ALTER TABLE sv_favorites
  ADD COLUMN IF NOT EXISTS content_uid TEXT REFERENCES sv_content_master(content_uid);
CREATE INDEX IF NOT EXISTS idx_favorites_content_uid ON sv_favorites(content_uid) WHERE content_uid IS NOT NULL;

-- sv_watch_history: add nullable content_uid FK + revived_at
ALTER TABLE sv_watch_history
  ADD COLUMN IF NOT EXISTS content_uid TEXT REFERENCES sv_content_master(content_uid),
  ADD COLUMN IF NOT EXISTS revived_at  TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_history_content_uid ON sv_watch_history(content_uid) WHERE content_uid IS NOT NULL;

-- sv_epg: add nullable content_uid FK
-- Note: sv_epg has NO stream_id column (verified via \d sv_epg 2026-05-04).
--       Phase 4 plan that references stream_id drop can be skipped.
ALTER TABLE sv_epg
  ADD COLUMN IF NOT EXISTS content_uid TEXT REFERENCES sv_content_master(content_uid);
CREATE INDEX IF NOT EXISTS idx_epg_content_uid ON sv_epg(content_uid) WHERE content_uid IS NOT NULL;

COMMIT;
