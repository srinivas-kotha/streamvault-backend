#!/usr/bin/env bash
# bin/streamvault-snapshot.sh
# Capture a coordinated snapshot of the running stack so it can be restored
# atomically by streamvault-rollback.sh.
#
# What's captured:
#   1. pg_dump of sv_* tables EXCLUDING sv_feature_flags (per master plan A5)
#   2. sv_feature_flags dumped to a separate JSON sidecar (NOT restored on rollback)
#   3. FE built dist directory (cp from running container)
#   4. Manifest JSON joining: deploy_id + FE git SHA + BE git SHA + image tags +
#      snapshot path + sha256 + flags sidecar path
#
# Usage:
#   bash bin/streamvault-snapshot.sh <deploy-id>
#
# Required env:
#   POSTGRES_USER  POSTGRES_DB  POSTGRES_CONTAINER  (defaults: postgres / postgres / postgres)
#   FE_REPO        (default: /home/crawler/streamvault-v3-frontend)
#   BE_REPO        (default: /home/crawler/streamvault-backend)
#   FE_IMAGE       (default: streamvault-frontend)
#   BE_IMAGE       (default: streamvault-api)
#   SV_SNAPSHOTS   (default: /home/crawler/snapshots)
#
# Disk-fill watchdog: aborts loudly if /home/crawler/snapshots has < 5GB free.

set -euo pipefail

# shellcheck source=lib/manifest.sh
source "$(dirname "$0")/lib/manifest.sh"

DEPLOY_ID="${1:?deploy-id required (format: deploy-YYYYMMDDHHmmss-fe-sha-be-sha)}"

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-postgres}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-streamvault}"
FE_REPO="${FE_REPO:-/home/crawler/streamvault-v3-frontend}"
BE_REPO="${BE_REPO:-/home/crawler/streamvault-backend}"
FE_IMAGE="${FE_IMAGE:-streamvault-frontend}"
BE_IMAGE="${BE_IMAGE:-streamvault-api}"

mkdir -p "$SV_SNAPSHOTS"

# Disk watchdog (R5 / master plan §5 PR-OPS-1)
free_kb="$(df --output=avail "$SV_SNAPSHOTS" | tail -1)"
if (( free_kb < 5 * 1024 * 1024 )); then
  echo "[snapshot] FATAL: < 5GB free in $SV_SNAPSHOTS — aborting deploy" >&2
  df -h "$SV_SNAPSHOTS" >&2
  exit 1
fi

DUMP_FILE="$SV_SNAPSHOTS/$DEPLOY_ID.dump.gz"
FLAGS_FILE="$SV_SNAPSHOTS/$DEPLOY_ID.flags.json"
MANIFEST="$SV_SNAPSHOTS/$DEPLOY_ID.manifest.json"

# 1. pg_dump sv_* tables excluding sv_feature_flags
echo "[snapshot] pg_dump sv_* (excl. sv_feature_flags) → $DUMP_FILE"
docker exec "$POSTGRES_CONTAINER" pg_dump \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --table='sv_*' \
  --exclude-table='sv_feature_flags' \
  --exclude-table='sv_feature_flags_id_seq' \
  --format=custom -Z 9 \
  | tee "$DUMP_FILE.tmp" > /dev/null
mv "$DUMP_FILE.tmp" "$DUMP_FILE"

DUMP_SIZE="$(du -h "$DUMP_FILE" | cut -f1)"
DUMP_SHA="$(sha256sum "$DUMP_FILE" | awk '{print $1}')"
echo "[snapshot] dump.gz size=$DUMP_SIZE sha256=$DUMP_SHA"

# 2. Flags sidecar (NOT restored on rollback)
echo "[snapshot] flags sidecar → $FLAGS_FILE"
docker exec "$POSTGRES_CONTAINER" psql \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -t -c \
  "SELECT json_agg(row_to_json(t)) FROM sv_feature_flags t" \
  > "$FLAGS_FILE.tmp"
mv "$FLAGS_FILE.tmp" "$FLAGS_FILE"

# 3. FE dist (cp from running container if it exists, else skip)
FE_DIST_DIR="$SV_SNAPSHOTS/$DEPLOY_ID-fe-dist"
if docker inspect "$FE_IMAGE" >/dev/null 2>&1; then
  echo "[snapshot] FE dist → $FE_DIST_DIR"
  mkdir -p "$FE_DIST_DIR"
  # Copy from a fresh container of the image (safe — no running-state coupling)
  CID="$(docker create "$FE_IMAGE")"
  docker cp "$CID:/usr/share/nginx/html" "$FE_DIST_DIR/" 2>/dev/null \
    || docker cp "$CID:/app/dist" "$FE_DIST_DIR/" 2>/dev/null \
    || echo "[snapshot] WARN: could not extract FE dist from $FE_IMAGE"
  docker rm "$CID" >/dev/null
else
  echo "[snapshot] WARN: FE image $FE_IMAGE not found — dist skipped"
fi

# 4. Manifest
echo "[snapshot] reading git SHAs"
FE_SHA="$(cd "$FE_REPO" && git rev-parse HEAD 2>/dev/null)" || { echo "[snapshot] WARN: could not read FE SHA from $FE_REPO"; FE_SHA="unknown"; }
BE_SHA="$(cd "$BE_REPO" && git rev-parse HEAD 2>/dev/null)" || { echo "[snapshot] WARN: could not read BE SHA from $BE_REPO"; BE_SHA="unknown"; }
FE_IMAGE_ID="$(docker image inspect "$FE_IMAGE" --format='{{.Id}}' 2>/dev/null | tr -d '[:space:]')" || true
FE_IMAGE_ID="${FE_IMAGE_ID:-absent}"
BE_IMAGE_ID="$(docker image inspect "$BE_IMAGE" --format='{{.Id}}' 2>/dev/null | tr -d '[:space:]')" || true
BE_IMAGE_ID="${BE_IMAGE_ID:-absent}"

cat > "$MANIFEST.tmp" <<JSON
{
  "deploy_id": "$DEPLOY_ID",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "fe": {
    "git_sha": "$FE_SHA",
    "image_tag": "$FE_IMAGE",
    "image_id": "$FE_IMAGE_ID",
    "dist_path": "$FE_DIST_DIR"
  },
  "be": {
    "git_sha": "$BE_SHA",
    "image_tag": "$BE_IMAGE",
    "image_id": "$BE_IMAGE_ID"
  },
  "db": {
    "snapshot_path": "$DUMP_FILE",
    "sha256": "$DUMP_SHA",
    "size": "$DUMP_SIZE"
  },
  "flags_path": "$FLAGS_FILE",
  "smoke_passed": false
}
JSON
mv "$MANIFEST.tmp" "$MANIFEST"

# Tag protected images (skipped by `docker system prune` if respect labels)
docker tag "$FE_IMAGE_ID" "streamvault-frontend:$DEPLOY_ID" 2>/dev/null || true
docker tag "$BE_IMAGE_ID" "streamvault-api:$DEPLOY_ID" 2>/dev/null || true

# Retention: 14 days OR last 5 smoke_passed (whichever is longer).
# Apply only AFTER the new manifest is written.
echo "[snapshot] applying retention policy"
keep_smoked_count=0
keep_smoked_max=5
for mf in $(ls -t "$SV_SNAPSHOTS"/*.manifest.json 2>/dev/null); do
  # Skip manifests that are not valid JSON (e.g. from a previously-aborted deploy).
  id="$(jq -r '.deploy_id' "$mf" 2>/dev/null)" || { echo "[snapshot] WARN: purging invalid manifest $mf"; rm -f "$mf"; continue; }
  smoked="$(jq -r '.smoke_passed' "$mf" 2>/dev/null || echo 'false')"
  age_days="$(( ( $(date -u +%s) - $(date -u -d "$(jq -r '.created_at' "$mf" 2>/dev/null || echo '1970-01-01T00:00:00Z')" +%s 2>/dev/null || echo 0) ) / 86400 ))"

  # Always keep < 14 days
  if (( age_days < 14 )); then continue; fi

  # Keep last 5 smoke_passed
  if [[ "$smoked" == "true" && $keep_smoked_count -lt $keep_smoked_max ]]; then
    keep_smoked_count=$(( keep_smoked_count + 1 ))
    continue
  fi

  echo "[snapshot] purging $id (age=${age_days}d smoke_passed=$smoked)"
  rm -f "$SV_SNAPSHOTS/$id.dump.gz" "$SV_SNAPSHOTS/$id.flags.json" "$mf"
  rm -rf "$SV_SNAPSHOTS/$id-fe-dist"
done

echo "[snapshot] DONE — manifest at $MANIFEST"
