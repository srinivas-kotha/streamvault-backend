#!/usr/bin/env bash
# bin/streamvault-preview-down.sh
# Tear down the preview stack and prune build artifacts.

set -euo pipefail

BE_REPO="${BE_REPO:-/home/crawler/streamvault-backend}"

cd "$BE_REPO"
docker compose -f docker-compose.preview.yml down --remove-orphans || true

# Drop preview DB (only if explicitly requested)
if [[ "${DROP_PREVIEW_DB:-0}" == "1" ]]; then
  echo "[preview-down] dropping streamvault_preview database"
  PGUSER="${POSTGRES_USER:?required}" \
  PGPASSWORD="${POSTGRES_PASSWORD:?required}" \
  PGHOST="${DB_HOST:-localhost}" \
  PGPORT="${DB_PORT:-5432}" \
  PGDATABASE=postgres \
  psql -c "DROP DATABASE IF EXISTS streamvault_preview"
fi

# Prune images tagged streamvault-*:preview-*
docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep -E 'streamvault-(api|frontend):preview-' \
  | xargs -r docker rmi -f 2>/dev/null || true

echo "[preview-down] DONE"
