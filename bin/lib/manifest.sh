#!/usr/bin/env bash
# bin/lib/manifest.sh
# Helpers for the deploy/rollback manifest format.
#
# A manifest is a JSON file at $SNAP_DIR/{deploy-id}.manifest.json that joins:
#   - frontend git SHA + image tag
#   - backend git SHA + image tag
#   - DB snapshot path + sha256
#   - feature-flags sidecar path (NOT restored on rollback — see master plan A5)
#   - smoke_passed flag (set true after post-deploy health checks pass)
#
# Source this from other scripts via:  source "$(dirname "$0")/lib/manifest.sh"

set -euo pipefail

# Default snapshot directory; override via SV_SNAPSHOTS env.
SV_SNAPSHOTS="${SV_SNAPSHOTS:-/home/crawler/snapshots}"

# Generate a deploy-id with second resolution + both repo SHAs.
# Format: deploy-YYYYMMDDHHmmss-{fe-sha7}-{be-sha7}
manifest_make_deploy_id() {
  local fe_sha="${1:?fe-sha7 required}"
  local be_sha="${2:?be-sha7 required}"
  local ts
  ts="$(date -u +%Y%m%d%H%M%S)"
  printf 'deploy-%s-%s-%s\n' "$ts" "$fe_sha" "$be_sha"
}

# Verify a manifest exists and the snapshot SHA matches.
# Usage: manifest_verify <deploy-id>
# Exits non-zero with a clear message on failure.
manifest_verify() {
  local id="${1:?deploy-id required}"
  local mf="$SV_SNAPSHOTS/$id.manifest.json"

  [[ -f "$mf" ]] || { echo "[manifest] Missing: $mf" >&2; return 1; }

  local snapshot_path snapshot_sha actual_sha
  snapshot_path="$(jq -r '.db.snapshot_path' "$mf")"
  snapshot_sha="$(jq -r '.db.sha256' "$mf")"

  [[ -f "$snapshot_path" ]] || { echo "[manifest] Snapshot file missing: $snapshot_path" >&2; return 1; }

  actual_sha="$(sha256sum "$snapshot_path" | awk '{print $1}')"
  if [[ "$actual_sha" != "$snapshot_sha" ]]; then
    echo "[manifest] sha256 mismatch on $snapshot_path" >&2
    echo "[manifest] expected: $snapshot_sha" >&2
    echo "[manifest] actual:   $actual_sha" >&2
    return 1
  fi

  echo "[manifest] Verified $id (sha256 ok)"
}

# Read a field from manifest.
# Usage: manifest_get <deploy-id> <jq-path>
manifest_get() {
  local id="${1:?deploy-id required}"
  local path="${2:?jq path required}"
  local mf="$SV_SNAPSHOTS/$id.manifest.json"
  jq -r "$path" "$mf"
}

# Find the latest smoke_passed deploy id (excluding the given one).
# Usage: manifest_latest_smoked [exclude-id]
manifest_latest_smoked() {
  local exclude="${1:-}"
  local mf
  for mf in $(ls -t "$SV_SNAPSHOTS"/*.manifest.json 2>/dev/null); do
    local id
    id="$(jq -r '.deploy_id' "$mf")"
    [[ "$id" == "$exclude" ]] && continue
    if [[ "$(jq -r '.smoke_passed' "$mf")" == "true" ]]; then
      echo "$id"
      return 0
    fi
  done
  return 1
}

# List manifests on disk (newest first).
manifest_list() {
  ls -t "$SV_SNAPSHOTS"/*.manifest.json 2>/dev/null | while read -r mf; do
    local id smoked
    id="$(jq -r '.deploy_id' "$mf")"
    smoked="$(jq -r '.smoke_passed' "$mf")"
    printf '%s\tsmoke_passed=%s\n' "$id" "$smoked"
  done
}

# Mark a manifest's smoke_passed=true (called after post-deploy health pass).
# Usage: manifest_mark_smoked <deploy-id>
manifest_mark_smoked() {
  local id="${1:?deploy-id required}"
  local mf="$SV_SNAPSHOTS/$id.manifest.json"
  local tmp="$mf.tmp.$$"
  jq '.smoke_passed = true' "$mf" >"$tmp" && mv "$tmp" "$mf"
}
