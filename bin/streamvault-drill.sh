#!/usr/bin/env bash
# bin/streamvault-drill.sh
# Atomic-rollback drill protocol. Safe to run in production.
#
# Steps:
#   1. Capture HEAD's BE+FE SHAs
#   2. Make a no-op commit on BE (touches a comment in this script's header)
#   3. Trigger a deploy via streamvault-deploy.sh
#   4. After deploy succeeds + manifest is smoke_passed, run streamvault-rollback.sh
#      against the PREVIOUS deploy_id (the smoke_passed one before this one)
#   5. Verify smoke endpoints still pass
#   6. Re-deploy HEAD to get back to current state
#
# Why safe:
#   - The no-op commit changes only a header comment — no runtime behavior change
#   - pg_restore touches only sv_* tables (n8n/Mem0 untouched)
#   - The rollback target is a known-good smoke_passed manifest
#   - If anything fails, we end up rolled-back; running the script again with
#     SKIP_DRILL_DEPLOY=1 redeploys HEAD
#
# Usage:
#   bash bin/streamvault-drill.sh
#
# Env knobs:
#   SKIP_DRILL_DEPLOY=1   skip step 1-3 (just rollback + verify + redeploy)
#   DRY_RUN=1             print steps; do not run anything destructive

set -euo pipefail

# shellcheck source=lib/manifest.sh
source "$(dirname "$0")/lib/manifest.sh"

BE_REPO="${BE_REPO:-/home/crawler/streamvault-backend}"
DRY_RUN="${DRY_RUN:-0}"

dry() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[drill][DRY] $*"
  else
    eval "$@"
  fi
}

echo "[drill] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting"

PREV_SMOKED="$(manifest_latest_smoked || true)"
if [[ -z "$PREV_SMOKED" ]]; then
  echo "[drill] FATAL: no prior smoke_passed deploy on disk. Drill needs a target." >&2
  echo "[drill] Run a successful deploy first via streamvault-deploy.sh" >&2
  exit 1
fi
echo "[drill] rollback target = $PREV_SMOKED"

if [[ "${SKIP_DRILL_DEPLOY:-0}" != "1" ]]; then
  echo "[drill] step 1/6 — make a no-op commit on BE"
  dry "( cd '$BE_REPO' && git checkout main && git pull origin main )"
  dry "echo '# Drill: $(date -u +%Y-%m-%dT%H:%M:%SZ)' >> '$BE_REPO/bin/streamvault-drill.sh'"
  dry "( cd '$BE_REPO' && git add bin/streamvault-drill.sh && git commit -m 'chore(drill): no-op for rollback drill' )"

  echo "[drill] step 2/6 — deploy"
  dry "bash '$(dirname "$0")/streamvault-deploy.sh'"
fi

echo "[drill] step 3/6 — rollback to $PREV_SMOKED"
dry "bash '$(dirname "$0")/streamvault-rollback.sh' '$PREV_SMOKED'"

echo "[drill] step 4/6 — verify smoke after rollback"
sleep 3
HEALTH_BE="${HEALTH_BE:-http://localhost:3001/health}"
HEALTH_FE="${HEALTH_FE:-http://localhost:3006/}"
HEALTH_FLAGS="${HEALTH_FLAGS:-http://localhost:3001/api/config/flags}"

for i in $(seq 1 12); do
  if curl -fsS "$HEALTH_BE" >/dev/null \
    && curl -fsS "$HEALTH_FE" >/dev/null \
    && curl -fsS "$HEALTH_FLAGS" >/dev/null; then
    echo "[drill] smoke OK after rollback (${i}*5s)"
    break
  fi
  sleep 5
  if (( i == 12 )); then
    echo "[drill] FATAL: smoke FAILED after rollback — manual intervention required" >&2
    exit 2
  fi
done

echo "[drill] step 5/6 — redeploy HEAD"
dry "bash '$(dirname "$0")/streamvault-deploy.sh'"

echo "[drill] step 6/6 — DONE"
echo "[drill] log: $SV_SNAPSHOTS/rollback-*.log (latest)"
