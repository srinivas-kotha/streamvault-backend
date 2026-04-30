-- Phase 1: Feature flag system
--
-- Single source of truth for runtime-toggleable behavior. Read by the FE
-- on app boot, cached client-side with a 5s TTL. Kill-switch flips
-- propagate within seconds (no Cache-Control on the endpoint).
--
-- Scope model:
--   global  → applies to every session
--   user    → scope_id = user_id, overrides global for that user
--   device  → scope_id = device_token, overrides global+user
--
-- COALESCE in the UNIQUE expression treats NULL scope_id as '' so global
-- rows have a deterministic uniqueness key.
--
-- Excluded from atomic rollback snapshots (sv_feature_flags is dumped to
-- a sidecar JSON file, not pg_restored on rollback) so a kill-switch flip
-- survives a code revert.

CREATE TABLE IF NOT EXISTS sv_feature_flags (
  id          SERIAL        PRIMARY KEY,
  key         TEXT          NOT NULL,
  scope       TEXT          NOT NULL DEFAULT 'global'
                            CHECK (scope IN ('global', 'user', 'device')),
  scope_id    TEXT,
  value       JSONB         NOT NULL DEFAULT 'false'::jsonb,
  description TEXT,
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by  TEXT          NOT NULL DEFAULT 'system'
);

-- Postgres does NOT allow expression-based UNIQUE inside a table-level
-- constraint, so we use a UNIQUE INDEX instead. The COALESCE expression
-- normalises NULL scope_id to '' so global rows have a deterministic key.
CREATE UNIQUE INDEX IF NOT EXISTS sv_feature_flags_unique_key_scope
  ON sv_feature_flags (key, scope, COALESCE(scope_id, ''));

CREATE INDEX IF NOT EXISTS idx_sv_ff_key_scope ON sv_feature_flags (key, scope);
CREATE INDEX IF NOT EXISTS idx_sv_ff_scope_id  ON sv_feature_flags (scope_id)
  WHERE scope_id IS NOT NULL;

-- Phase 1 seed flags (dotted-key lowercase per master plan A4).
-- Idempotent: existing rows are NOT overwritten.
INSERT INTO sv_feature_flags (key, scope, value, description) VALUES
  ('adaptive.gestures.enabled',  'global', 'false'::jsonb,
   'Master switch for adaptive gesture infrastructure (input-mode aware).'),
  ('adaptive.mobile.enabled',    'global', 'false'::jsonb,
   'Enables mobile responsive layout + touch gesture surfaces.'),
  ('adaptive.desktop.enabled',   'global', 'false'::jsonb,
   'Enables desktop responsive layout + mouse/keyboard gesture surfaces.'),
  ('adaptive.player.tap_toggle', 'global', 'false'::jsonb,
   'Single-tap on mobile player toggles control visibility (Phase 1 only behavior change).')
ON CONFLICT (key, scope, COALESCE(scope_id, '')) DO NOTHING;
