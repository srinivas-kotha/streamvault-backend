#!/usr/bin/env bash
# bin/streamvault-deploy.sh
# Deploy wrapper. Snapshot-then-deploy-then-smoke. Auto-rollback on smoke fail.
#
# Usage:
#   bash bin/streamvault-deploy.sh
#
# Required env (or defaults):
#   FE_SHA   (default: HEAD of /home/crawler/streamvault-v3-frontend)
#   BE_SHA   (default: HEAD of /home/crawler/streamvault-backend)
#   COMPOSE_DIR  (default: /home/crawler/ai-orchestration)

set -euo pipefail

# shellcheck source=lib/manifest.sh
source "$(dirname "$0")/lib/manifest.sh"

FE_REPO="${FE_REPO:-/home/crawler/streamvault-v3-frontend}"
BE_REPO="${BE_REPO:-/home/crawler/streamvault-backend}"
COMPOSE_DIR="${COMPOSE_DIR:-/home/crawler/ai-orchestration}"
FE_SERVICE="${FE_SERVICE:-streamvault-frontend}"
BE_SERVICE="${BE_SERVICE:-streamvault-api}"
HEALTH_BE="${HEALTH_BE:-http://localhost:3001/health}"
HEALTH_FE="${HEALTH_FE:-http://localhost:3006/}"
HEALTH_FLAGS="${HEALTH_FLAGS:-http://localhost:3001/api/config/flags}"

FE_SHA="${FE_SHA:-$(cd "$FE_REPO" && git rev-parse HEAD)}"
BE_SHA="${BE_SHA:-$(cd "$BE_REPO" && git rev-parse HEAD)}"
FE_SHA7="${FE_SHA:0:7}"
BE_SHA7="${BE_SHA:0:7}"

DEPLOY_ID="$(manifest_make_deploy_id "$FE_SHA7" "$BE_SHA7")"
echo "[deploy] generating deploy_id=$DEPLOY_ID"

# Capture snapshot of CURRENT running stack (so we can roll back to it).
PREV_SMOKED="$(manifest_latest_smoked || true)"
echo "[deploy] previous smoke-passed deploy: ${PREV_SMOKED:-<none>}"

bash "$(dirname "$0")/streamvault-snapshot.sh" "$DEPLOY_ID"

# Bring up new build
echo "[deploy] docker compose up --build $FE_SERVICE $BE_SERVICE"
( cd "$COMPOSE_DIR" && docker compose up -d --build "$FE_SERVICE" "$BE_SERVICE" )

# Smoke
echo "[deploy] smoke health endpoints"
sleep 3
ok=0
for i in $(seq 1 18); do
  if curl -fsS "$HEALTH_BE" >/dev/null \
    && curl -fsS "$HEALTH_FE" >/dev/null \
    && curl -fsS "$HEALTH_FLAGS" >/dev/null; then
    ok=1
    break
  fi
  sleep 5
done

if (( ok == 0 )); then
  echo "[deploy] SMOKE FAIL — auto-rollback to ${PREV_SMOKED:-N/A}" >&2
  if [[ -n "$PREV_SMOKED" ]]; then
    bash "$(dirname "$0")/streamvault-rollback.sh" "$PREV_SMOKED"
    echo "[deploy] rolled back to $PREV_SMOKED" >&2
    exit 1
  fi
  echo "[deploy] no prior smoke-passed deploy to roll back to" >&2
  exit 1
fi

# Mark smoked
manifest_mark_smoked "$DEPLOY_ID"
echo "[deploy] DONE — $DEPLOY_ID smoke_passed=true"
