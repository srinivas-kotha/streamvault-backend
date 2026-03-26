-- Phase 3: Service Layer Tables
-- Creates sv_catalog, sv_catalog_categories, sv_epg, sv_channel_health

-- ============================================================
-- Catalog persistence (browse + FTS search)
-- ============================================================

CREATE TABLE IF NOT EXISTS sv_catalog (
  id SERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('live', 'vod', 'series')),
  name TEXT NOT NULL,
  category_id TEXT,
  icon TEXT,
  is_adult BOOLEAN DEFAULT false,
  rating TEXT,
  genre TEXT,
  year TEXT,
  added_at TIMESTAMPTZ,
  raw_data JSONB,
  last_synced TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider_id, item_id, item_type)
);

ALTER TABLE sv_catalog
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(genre, '')), 'B')
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_sv_catalog_search ON sv_catalog USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_sv_catalog_type_cat ON sv_catalog (item_type, category_id);
CREATE INDEX IF NOT EXISTS idx_sv_catalog_provider ON sv_catalog (provider_id);

CREATE TABLE IF NOT EXISTS sv_catalog_categories (
  id SERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  category_type TEXT NOT NULL CHECK (category_type IN ('live', 'vod', 'series')),
  name TEXT NOT NULL,
  parent_id TEXT,
  item_count INT,
  last_synced TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider_id, category_id, category_type)
);

CREATE INDEX IF NOT EXISTS idx_sv_catalog_cat_provider ON sv_catalog_categories (provider_id, category_type);

-- ============================================================
-- EPG storage
-- ============================================================

CREATE TABLE IF NOT EXISTS sv_epg (
  id SERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  category TEXT,
  icon TEXT,
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (channel_id, start_time, end_time)
);

CREATE INDEX IF NOT EXISTS idx_sv_epg_channel_time ON sv_epg (channel_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_sv_epg_now ON sv_epg (channel_id)
  WHERE end_time > NOW();

-- ============================================================
-- Channel health monitoring
-- ============================================================

CREATE TABLE IF NOT EXISTS sv_channel_health (
  channel_id TEXT PRIMARY KEY,
  is_online BOOLEAN DEFAULT true,
  last_checked TIMESTAMPTZ,
  last_error TEXT,
  check_count INT DEFAULT 0,
  fail_count INT DEFAULT 0
);
