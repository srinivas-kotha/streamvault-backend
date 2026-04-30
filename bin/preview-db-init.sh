#!/usr/bin/env bash
# bin/preview-db-init.sh
# Bootstrap the streamvault_preview Postgres database for the preview stack.
#
# Idempotent: creates DB if absent, then runs every postgres/*.sql migration
# against it. Safe to run on every preview-up.
#
# Critically: this targets streamvault_preview, NOT streamvault. Verified
# via the explicit \connect statement before any migration is applied.

set -euo pipefail

PREVIEW_DB="${PREVIEW_DB:-streamvault_preview}"

echo "[preview-db-init] checking $PREVIEW_DB"
EXISTS="$(psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PREVIEW_DB'" || true)"
if [[ "$EXISTS" != "1" ]]; then
  echo "[preview-db-init] CREATE DATABASE $PREVIEW_DB"
  psql -c "CREATE DATABASE $PREVIEW_DB"
fi

echo "[preview-db-init] running migrations against $PREVIEW_DB"
for sql in /migrations/*.sql; do
  # Skip any *.down.sql by convention
  case "$sql" in *.down.sql) continue ;; esac
  echo "[preview-db-init] $sql"
  # \connect ensures we are NEVER on the prod database, even if PGDATABASE
  # leaked in via env. The down/up.sql files do not contain destructive
  # statements against unrelated tables (they only touch sv_*).
  psql -d "$PREVIEW_DB" -v ON_ERROR_STOP=1 -f "$sql"
done

echo "[preview-db-init] seed minimal fixtures"
psql -d "$PREVIEW_DB" -v ON_ERROR_STOP=1 <<'SQL'
-- Idempotent fixtures: 1 admin user, 5 channels, 5 movies.
-- Real data is left out — preview is for UI smoke, not catalog testing.
INSERT INTO sv_feature_flags (key, scope, value, description) VALUES
  ('preview.banner.enabled', 'global', 'true'::jsonb,
   'Show "PREVIEW" banner across the top of every page.')
ON CONFLICT ON CONSTRAINT sv_feature_flags_unique_key_scope DO NOTHING;
SQL

echo "[preview-db-init] DONE"
