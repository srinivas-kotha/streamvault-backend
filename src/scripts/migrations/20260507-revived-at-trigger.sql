-- Phase 2, Task 2.2: revived_at trigger on sv_watch_history.
--
-- When sv_watch_history.content_uid transitions NULL → non-NULL via UPDATE,
-- set revived_at = now(). Pure DB-level trigger so any code path (backfill
-- script, future ad-hoc UPDATE, manual ops) gets the same behavior.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER pattern.
--
-- Run via: npm run migrate:revived-at-trigger
-- Or in container:
--   docker exec -i postgres psql -U $PG_USER -d $PG_DB \
--     < src/scripts/migrations/20260507-revived-at-trigger.sql

BEGIN;

CREATE OR REPLACE FUNCTION sv_history_set_revived_at() RETURNS trigger AS $$
BEGIN
  IF (OLD.content_uid IS NULL AND NEW.content_uid IS NOT NULL) THEN
    NEW.revived_at = now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sv_history_revived_at ON sv_watch_history;
CREATE TRIGGER sv_history_revived_at
  BEFORE UPDATE ON sv_watch_history
  FOR EACH ROW EXECUTE FUNCTION sv_history_set_revived_at();

COMMIT;
