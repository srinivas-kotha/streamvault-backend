#!/usr/bin/env bash
# bin/streamvault-preview-up.sh
# Bring up the preview stack for a given PR.
#
# Required env:
#   PR_NUMBER  GitHub PR number (used as build tag)
#   FE_SHA     Frontend git SHA to build (defaults to FE repo HEAD)
#   BE_SHA     Backend git SHA to build (defaults to BE repo HEAD)
#
# Optional env (or .env.preview):
#   POSTGRES_USER  POSTGRES_PASSWORD  DB_HOST  DB_PORT
#
# Idempotent: re-running is safe.

set -euo pipefail

PR_NUMBER="${PR_NUMBER:?PR_NUMBER required}"
FE_REPO="${FE_REPO:-/home/crawler/streamvault-v3-frontend}"
BE_REPO="${BE_REPO:-/home/crawler/streamvault-backend}"
FE_SHA="${FE_SHA:-$(cd "$FE_REPO" && git rev-parse HEAD)}"
BE_SHA="${BE_SHA:-$(cd "$BE_REPO" && git rev-parse HEAD)}"

BUILD_TAG="pr-$PR_NUMBER-${BE_SHA:0:7}"
export BUILD_TAG

echo "[preview] building images BUILD_TAG=$BUILD_TAG"

# Build BE
( cd "$BE_REPO" && git fetch origin && git checkout "$BE_SHA" ) || true
docker build -t "streamvault-api:preview-$BUILD_TAG" "$BE_REPO"

# Build FE
( cd "$FE_REPO" && git fetch origin && git checkout "$FE_SHA" ) || true
docker build -t "streamvault-frontend:preview-$BUILD_TAG" "$FE_REPO"

# Bring up the preview compose stack
echo "[preview] docker compose up"
cd "$BE_REPO"
docker compose -f docker-compose.preview.yml up -d --build

# Health check
echo "[preview] waiting for health"
for i in $(seq 1 12); do
  if curl -fsS http://localhost:3011/health >/dev/null \
    && curl -fsS http://localhost:3016/ >/dev/null; then
    echo "[preview] healthy after ${i}*5s"
    echo "[preview] URL: https://preview.streamvault.srinivaskotha.uk"
    echo "[preview] BUILD_TAG=$BUILD_TAG"
    exit 0
  fi
  sleep 5
done

echo "[preview] FATAL: preview stack did not become healthy" >&2
docker compose -f docker-compose.preview.yml logs --tail 50
exit 1
