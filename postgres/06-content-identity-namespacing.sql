-- Phase 0.3: Rename existing 'xtream' provider_id to namespaced form.
-- This is parametric — the destination ID is computed from config and
-- substituted by the TS runner, NOT hardcoded here.
-- Runner: src/scripts/migrations/apply-provider-id-namespacing.ts
-- npm script: migrate:provider-id-namespacing

BEGIN;
-- Verified by runner before applying; this file serves as documentation.
UPDATE sv_catalog
   SET provider_id = $1
 WHERE provider_id = 'xtream';
COMMIT;
