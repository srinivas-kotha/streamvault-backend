#!/usr/bin/env bash
# bin/streamvault-rollback.sh
# Atomic FE+BE+DB rollback to a known-good prior deploy.
#
# Order of operations (fail-fast at each step):
#   1. Verify manifest sha256
#   2. Stop FE + BE containers
#   3. Restore DB sv_* tables in a single transaction (sv_feature_flags is
#      preserved — kill-switch flips survive code reverts, per A5)
#   4. Re-tag Docker images to the rollback target (or rebuild from snapshot if pruned)
#   5. Restart FE + BE
#   6. Smoke health endpoints
#   7. Log to /home/crawler/snapshots/rollback-{ts}.log
#
# On any step failure: stop, print recovery instructions, exit non-zero. Does
# NOT leave the system half-rolled-back.
#
# Usage:
#   bash bin/streamvault-rollback.sh <deploy-id>

set -euo pipefail

# shellcheck source=lib/manifest.sh
source "$(dirname "$0")/lib/manifest.sh"

DEPLOY_ID="${1:?deploy-id required}"
TS="$(date -u +%Y%m%d%H%M%S)"
LOG="$SV_SNAPSHOTS/rollback-$TS.log"

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-postgres}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-streamvault}"
FE_REPO="${FE_REPO:-/home/crawler/streamvault-v3-frontend}"
BE_REPO="${BE_REPO:-/home/crawler/streamvault-backend}"
COMPOSE_DIR="${COMPOSE_DIR:-/home/crawler/ai-orchestration}"
FE_SERVICE="${FE_SERVICE:-streamvault-frontend}"
BE_SERVICE="${BE_SERVICE:-streamvault-api}"
HEALTH_BE="${HEALTH_BE:-http://localhost:3001/health}"
HEALTH_FE="${HEALTH_FE:-http://localhost:3006/}"
HEALTH_FLAGS="${HEALTH_FLAGS:-http://localhost:3001/api/config/flags}"

exec > >(tee -a "$LOG") 2>&1
echo "[rollback] $(date -u +%Y-%m-%dT%H:%M:%SZ) target=$DEPLOY_ID"

fail() {
  echo "[rollback] FAILED: $1" >&2
  echo "[rollback] Recovery: state may be partial. Inspect $LOG and consider:" >&2
  echo "[rollback]   1. docker ps -a (check container states)" >&2
  echo "[rollback]   2. docker inspect $POSTGRES_CONTAINER (verify DB up)" >&2
  echo "[rollback]   3. Review manifest at $SV_SNAPSHOTS/$DEPLOY_ID.manifest.json" >&2
  echo "[rollback]   4. Try: bash bin/streamvault-rollback.sh $DEPLOY_ID  (script is idempotent)" >&2
  exit 1
}

# Step 1: verify manifest
echo "[rollback] step 1/7 — verify manifest"
manifest_verify "$DEPLOY_ID" || fail "manifest verification failed"

FE_SHA="$(manifest_get "$DEPLOY_ID" '.fe.git_sha')"
BE_SHA="$(manifest_get "$DEPLOY_ID" '.be.git_sha')"
DUMP_FILE="$(manifest_get "$DEPLOY_ID" '.db.snapshot_path')"
FE_IMAGE_TAGGED="streamvault-frontend:$DEPLOY_ID"
BE_IMAGE_TAGGED="streamvault-api:$DEPLOY_ID"

# Step 2: stop services
echo "[rollback] step 2/7 — stop services"
( cd "$COMPOSE_DIR" && docker compose stop "$FE_SERVICE" "$BE_SERVICE" ) || fail "stop services"

# Step 3: restore DB in a single transaction
# IMPORTANT: sv_feature_flags is INTENTIONALLY NOT in the dump. We do NOT
# touch the flags table on rollback — kill-switch flips survive.
# NOTE: dump is in pg_dump --format=custom format (not plain gzip). pg_restore
# handles the custom format + internal compression directly — no gunzip needed.
echo "[rollback] step 3/7 — restore DB (transactional)"
docker cp "$DUMP_FILE" "$POSTGRES_CONTAINER:/tmp/restore.dump" || fail "docker cp dump"

docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL' || fail "drop sv_* tables"
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'sv\_%' ESCAPE '\'
      AND tablename <> 'sv_feature_flags'
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;
END $$;
SQL

docker exec "$POSTGRES_CONTAINER" pg_restore \
  --single-transaction --exit-on-error --no-owner \
  --clean --if-exists \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  /tmp/restore.dump || fail "pg_restore"

docker exec "$POSTGRES_CONTAINER" rm -f /tmp/restore.dump

# Step 4: re-tag Docker images (or rebuild from git SHA fallback)
echo "[rollback] step 4/7 — re-tag images"
if docker image inspect "$FE_IMAGE_TAGGED" >/dev/null 2>&1; then
  docker tag "$FE_IMAGE_TAGGED" streamvault-frontend:latest || fail "tag FE"
else
  echo "[rollback] FE image $FE_IMAGE_TAGGED not found — rebuilding from $FE_SHA"
  ( cd "$FE_REPO" && git fetch && git checkout "$FE_SHA" ) || fail "FE git checkout"
  ( cd "$COMPOSE_DIR" && docker compose build "$FE_SERVICE" ) || fail "FE rebuild"
fi

if docker image inspect "$BE_IMAGE_TAGGED" >/dev/null 2>&1; then
  docker tag "$BE_IMAGE_TAGGED" streamvault-api:latest || fail "tag BE"
else
  echo "[rollback] BE image $BE_IMAGE_TAGGED not found — rebuilding from $BE_SHA"
  ( cd "$BE_REPO" && git fetch && git checkout "$BE_SHA" ) || fail "BE git checkout"
  ( cd "$COMPOSE_DIR" && docker compose build "$BE_SERVICE" ) || fail "BE rebuild"
fi

# Step 5: restart services
echo "[rollback] step 5/7 — restart services"
( cd "$COMPOSE_DIR" && docker compose up -d "$FE_SERVICE" "$BE_SERVICE" ) || fail "restart"

# Step 6: smoke
echo "[rollback] step 6/7 — smoke health endpoints"
sleep 3
for i in $(seq 1 18); do
  if curl -fsS "$HEALTH_BE" >/dev/null \
    && curl -fsS "$HEALTH_FE" >/dev/null \
    && curl -fsS "$HEALTH_FLAGS" >/dev/null; then
    echo "[rollback] smoke OK (after ${i}*5s)"
    break
  fi
  sleep 5
  if (( i == 18 )); then
    fail "smoke endpoints did not return 200 within 90s"
  fi
done

# Step 7: log
echo "[rollback] step 7/7 — DONE @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[rollback] log: $LOG"
