# BE Architecture — v3 Adaptive Responsive Layer
**Date:** 2026-04-28  
**Stack:** Node.js 20 + Express 4 + TypeScript 5 + pg 8 + Postgres (ankane/pgvector image)  
**Production:** `streamvault_api` Docker container, port 3001, 768 MB RAM limit  

---

## 1. Current State Audit

### Config (`src/config.ts`)
- All secrets via required env vars (`requiredEnv`); no defaults for credentials.
- `CORS_ORIGIN` defaults to `https://streamvault.srinivaskotha.uk` — single-origin only.
- JWT: 15 min access tokens, 60-day sliding refresh (httpOnly cookies).
- `AUTH_BYPASS_IPS` list skips both JWT and CSRF checks — used for LAN auto-login.

### Session / Auth (`src/middleware/auth.ts`, `src/routers/auth.router.ts`)
- httpOnly cookie-based JWT; no `Authorization: Bearer` path exists.
- CSRF: double-submit cookie (`sv_csrf` + `x-csrf-token` header). `sameSite: 'strict'` means the cookie is **not** sent on cross-origin navigation — fine for TV, problematic for mobile PWA if served from a different origin.
- Refresh: DB-tracked `sv_refresh_tokens` with `expires_at`.
- No per-user role column observed in query patterns (`userId: 0, username: 'lan-user'` for bypass; `userId` integer for normal users).

### Middleware order (`src/index.ts`)
- helmet → corsMiddleware → cookieParser → json → csrfMiddleware → streamLimiter → apiLimiter → routers → **eventsRouter catchall LAST** → errorHandler.
- New routers MUST be mounted before `app.use("/api", eventsRouter)`.

### Database
- Postgres data dir: **~937 MB** (shared with n8n, Mem0, Kokilla, ai-ml-quest).
- StreamVault-specific tables:
  - `sv_users`, `sv_refresh_tokens` (auth — schema inferred from query patterns)
  - `sv_catalog`, `sv_catalog_categories`, `sv_epg`, `sv_channel_health` (migration `03-phase3-services.sql`)
  - `sv_stream_audio_tracks` (migration `04-stream-audio-tracks.sql`)
  - `sv_favorites`, `sv_history`, `sv_downloads`, `sv_recordings` (inferred from routers/services)
- Migration files live in `postgres/` directory, numbered `03-` and `04-` (no `01-`/`02-` in the streamvault-backend repo — those belong to `ai-orchestration/postgres/`).

### Deploy pipeline
- GitHub Actions: `validate.yml` (lint + typecheck + test + build + secret-scan) → `deploy.yml` (SSH pull + `docker compose up -d --build streamvault-api`).
- Post-deploy: 18× 5-second health-check loop against `http://localhost:3001/health`; on failure, logs + restart (no true rollback today).
- No pre-deploy snapshot. No deploy ID tracking.

### CORS — current gap
`config.cors.origin` is a single string. A mobile client on a different subdomain (e.g., `m.streamvault.srinivaskotha.uk`) or a native app (`capacitor://localhost`) would be rejected in production.

---

## 2. Feature Flag System

### 2a. Postgres table

```sql
-- Migration: 05-feature-flags.sql
CREATE TABLE IF NOT EXISTS sv_feature_flags (
  id          SERIAL        PRIMARY KEY,
  key         TEXT          NOT NULL,
  scope       TEXT          NOT NULL DEFAULT 'global'
                            CHECK (scope IN ('global', 'user', 'device')),
  -- scope='global'  → value applies to all sessions
  -- scope='user'    → key+scope_id identifies a per-user override
  -- scope='device'  → key+scope_id identifies a per-device-token override
  scope_id    TEXT,         -- NULL for global; user_id or device_token for others
  value       JSONB         NOT NULL DEFAULT 'false'::jsonb,
  description TEXT,
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by  TEXT          NOT NULL DEFAULT 'system',
  UNIQUE (key, scope, COALESCE(scope_id, ''))
);

CREATE INDEX IF NOT EXISTS idx_sv_ff_key_scope ON sv_feature_flags (key, scope);
CREATE INDEX IF NOT EXISTS idx_sv_ff_scope_id  ON sv_feature_flags (scope_id)
  WHERE scope_id IS NOT NULL;

-- Down: DROP TABLE IF EXISTS sv_feature_flags;
```

**Rationale for `COALESCE` in UNIQUE:** Postgres treats two NULLs as distinct in unique indexes; the expression forces `NULL` → `''` so `(key, 'global', '')` is truly unique per key.

### 2b. Phase 1 seed flags

```sql
-- Migration: 05-feature-flags.sql (seed section, idempotent)
INSERT INTO sv_feature_flags (key, scope, value, description)
VALUES
  ('adaptive.mobile.enabled',    'global', 'false'::jsonb, 'Serve mobile-optimised layout hints'),
  ('adaptive.gestures.enabled',  'global', 'false'::jsonb, 'Enable swipe gesture navigation'),
  ('adaptive.pagination.live',   'global', 'false'::jsonb, 'Paginate /api/live/channels on mobile'),
  ('adaptive.pagination.vod',    'global', 'false'::jsonb, 'Paginate /api/vod/streams on mobile'),
  ('adaptive.cors.mobile',       'global', 'false'::jsonb, 'Allow mobile origins in CORS allowlist')
ON CONFLICT (key, scope, COALESCE(scope_id, '')) DO NOTHING;
```

### 2c. New endpoint: `GET /api/config/flags`

**Auth:** Authenticated session required (uses existing `authMiddleware`). Flags are not secret but leaking the flag map to unauthenticated crawlers is unnecessary.

**Response shape:**
```json
{
  "flags": {
    "adaptive.mobile.enabled": false,
    "adaptive.gestures.enabled": false,
    "adaptive.pagination.live": false,
    "adaptive.pagination.vod": false,
    "adaptive.cors.mobile": false
  },
  "scope": "global",
  "fetchedAt": "2026-04-28T12:00:00Z"
}
```

Per-user overrides (scope='user') are merged on top of globals before responding, so FE always gets a flat merged map.

**Cache headers:** `Cache-Control: private, max-age=60` — FE can hold for 60 s; on flag change the next poll picks it up without a deploy. No ETags needed for v1.

**Rate limiter:** Uses existing `apiLimiter` (120 req/min) — no special limiter needed.

**Router file:** `src/routers/config.router.ts`  
**Mount point:** `app.use("/api/config", configRouter)` — add before eventsRouter.

### 2d. New endpoint: `POST /api/config/flags/:key`

**Auth:** `authMiddleware` + admin check (userId === 1 or a future `is_admin` column on `sv_users`). For Phase 1, userId === 1 = admin (single-user system).

**Request body:** `{ "value": <any JSON>, "scope": "global", "scope_id": null }`

**Response:** `204 No Content` on success; `400` on unknown key (validate against enum); `403` on non-admin.

**CSRF:** Already covered — POST mutation goes through double-submit CSRF check.

**Service file:** `src/services/feature-flags.service.ts` — handles DB reads/writes + in-process `node-cache` TTL-30s cache to avoid per-request DB hit.

---

## 3. Atomic Rollback BE Spec

### 3a. Pre-deploy snapshot script

**Location:** `bin/snapshot.sh`

```bash
#!/usr/bin/env bash
# bin/snapshot.sh <deploy-id>
# Called by CI deploy step BEFORE `docker compose up -d --build`
set -euo pipefail
DEPLOY_ID="${1:?deploy-id required}"
SNAP_DIR="/data/streamvault/snapshots"
mkdir -p "$SNAP_DIR"
SNAP_FILE="$SNAP_DIR/sv-${DEPLOY_ID}.sql.gz"

docker exec postgres pg_dump \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --schema-only --data  \
  -t 'sv_*' \
  | gzip -6 > "$SNAP_FILE"

echo "[snapshot] Wrote $SNAP_FILE ($(du -sh "$SNAP_FILE" | cut -f1))"

# Prune: keep last 10 snapshots
ls -t "$SNAP_DIR"/sv-*.sql.gz | tail -n +11 | xargs -r rm -f
```

**Why `sv_*` tables only:** The shared Postgres instance also serves n8n, Mem0, ai-ml-quest, and Kokilla. Dumping all tables is wasteful and risks restoring another service's data. StreamVault owns all `sv_` prefixed tables.

**Estimated duration:** The `sv_*` tables are a small fraction of the 937 MB directory (most is n8n execution data, pgvector embeddings). Expect 1-3 seconds for the dump + gzip.

**Retention:** 10 snapshots kept (≈ last 10 deploys). Each compressed dump ~1-5 MB.

### 3b. Deploy ID scheme

```
deploy-<YYYYMMDDHHmm>-<FE-git-sha7>-<BE-git-sha7>
```
Example: `deploy-202604281435-a3a9c0c-1aacac5`

The deploy ID is generated once at CI start and passed to both `snapshot.sh` and tagged as a Git note / CI artifact. The snapshot filename embeds it, making the join trivial.

**CI integration** (add to `deploy.yml`):

```yaml
- name: Generate deploy ID
  id: deploy_id
  run: echo "id=deploy-$(date -u +%Y%m%d%H%M)-${GITHUB_SHA::7}" >> $GITHUB_OUTPUT

- name: Pre-deploy snapshot
  uses: appleboy/ssh-action@v1
  with:
    script: |
      export POSTGRES_USER=${{ secrets.POSTGRES_USER }}
      export POSTGRES_DB=${{ secrets.POSTGRES_DB }}
      bash ~/streamvault-backend/bin/snapshot.sh "${{ steps.deploy_id.outputs.id }}"
```

### 3c. `bin/rollback.sh <deploy-id>`

```bash
#!/usr/bin/env bash
# bin/rollback.sh <deploy-id>
# Restores sv_* tables from snapshot and restarts the API container.
set -euo pipefail
DEPLOY_ID="${1:?deploy-id required}"
SNAP_FILE="/data/streamvault/snapshots/sv-${DEPLOY_ID}.sql.gz"

[[ -f "$SNAP_FILE" ]] || { echo "Snapshot not found: $SNAP_FILE"; exit 1; }

echo "[rollback] Stopping API..."
cd ~/ai-orchestration && docker compose stop streamvault-api

echo "[rollback] Restoring sv_* tables from $SNAP_FILE..."
gunzip -c "$SNAP_FILE" | docker exec -i postgres psql \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1

echo "[rollback] Checking out BE code at snapshot's git SHA..."
BE_SHA=$(echo "$DEPLOY_ID" | grep -oP '[a-f0-9]{7}$')
cd ~/streamvault-backend && git checkout "$BE_SHA"

echo "[rollback] Rebuilding and restarting API..."
cd ~/ai-orchestration && docker compose up -d --build streamvault-api

echo "[rollback] Waiting for health..."
for i in $(seq 1 18); do
  if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
    echo "[rollback] Healthy after $((i*5))s"
    break
  fi
  sleep 5
done
```

### 3d. Smoke test endpoints after rollback

Run in order; any non-2xx fails the rollback:

1. `GET /health` → 200
2. `GET /api/auth/refresh` (with a valid refresh-token cookie) → 200 or 401 (expected if token expired; not 500)
3. `GET /api/live/categories` (with auth cookie) → 200
4. `GET /api/config/flags` (with auth cookie) → 200 *(after config router ships)*

---

## 4. Mobile API Audit

### 4a. Chunky endpoints needing pagination / shaping

| Endpoint | Issue | Mitigation |
|---|---|---|
| `GET /api/live/channels` (no filter) | Returns ALL live streams across all categories — can be 1,000–5,000 items. Each item has icon URL + inferredLang. | Add optional `?page=<n>&limit=<50>` query params behind `adaptive.pagination.live` flag. Page 1 returns fast; FE loads more on scroll. |
| `GET /api/vod/streams/:catId` | Large VOD categories can be 500+ items. | Same pagination pattern, behind `adaptive.pagination.vod` flag. |
| `GET /api/series/list/:catId` | Series lists are typically smaller (50-200) but can spike. | Lower priority; same pattern available. |
| `GET /api/live/epg/bulk?streamIds=...` | Unbounded `streamIds` list. | Already somewhat bounded by caller; add `MAX_BULK_EPG = 50` server-side guard. |

Pagination shape (backward-compatible — existing clients ignore the envelope and get the same array):

```json
{
  "items": [...],
  "total": 1240,
  "page": 1,
  "limit": 50,
  "hasMore": true
}
```

When `page`/`limit` absent: return legacy flat array (zero breaking change).

### 4b. CORS — current gap + fix

Current config (`src/middleware/cors.ts`): production locks to single `CORS_ORIGIN` string.

Mobile concerns:
- A mobile PWA served from a distinct subdomain (e.g., `m.streamvault.srinivaskotha.uk`) fails CORS.
- A Capacitor/Electron native app uses `capacitor://localhost` or `null` origin — blocked entirely.

**Fix:**

```typescript
// src/middleware/cors.ts — new version
const ALLOWED_ORIGINS: (string | RegExp)[] = [
  config.cors.origin,
  ...(config.cors.mobileOrigins ?? []),
];

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin / no-origin (native)
    const allowed = ALLOWED_ORIGINS.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    callback(allowed ? null : new Error('CORS'), allowed);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-csrf-token'],
});
```

Add to `config.ts`:
```typescript
cors: {
  origin: optionalEnv('CORS_ORIGIN', 'https://streamvault.srinivaskotha.uk'),
  mobileOrigins: (process.env.CORS_MOBILE_ORIGINS || '').split(',').filter(Boolean),
},
```

Behind `adaptive.cors.mobile` flag: the config router can return the current allowlist. CORS is applied at request time so flag changes take effect on next request without a restart.

### 4c. Auth — mobile flow concerns

**CSRF on touch:** Double-submit CSRF requires JS to read `sv_csrf` cookie and send it as `x-csrf-token` header. This works fine in React/mobile web. In a Capacitor native shell, `sameSite: 'strict'` means the cookie IS sent (same app context). No issue.

**Refresh-token UX:** The 60-day sliding refresh window is appropriate for mobile. No change needed.

**`Authorization: Bearer` for native apps:** The current cookie-only auth works if the native shell shares the cookie jar with the WebView (Capacitor does). If a future headless mobile client (React Native with Fetch API, no WebView) is needed, a `Bearer` token path would be required. **Out of scope for v1.**

**Auto-login bypass:** `AUTH_BYPASS_IPS` is LAN-only. Mobile clients on carrier networks never match. This is correct behaviour — no change.

---

## 5. Migration Plan

All migrations are additive (backward-compatible). Each has a reversible DOWN.

| File | Contents | Down |
|---|---|---|
| `postgres/05-feature-flags.sql` | `CREATE TABLE sv_feature_flags` + indexes + Phase 1 seed | `DROP TABLE IF EXISTS sv_feature_flags` |

Run manually on first deploy:
```bash
docker exec -i postgres psql -U $POSTGRES_USER -d $POSTGRES_DB \
  < ~/streamvault-backend/postgres/05-feature-flags.sql
```

No automated migration runner exists yet (migrations have been applied manually). This is acceptable for Phase 1. A future `src/scripts/migrate.ts` that reads `postgres/*.sql` in order and tracks applied migrations in `sv_schema_migrations` table is noted as a future improvement but not in scope here.

---

## 6. Rollout Phases (BE PRs in order)

### PR A — Feature flags foundation
**Files:** `postgres/05-feature-flags.sql`, `src/services/feature-flags.service.ts`, `src/routers/config.router.ts`, `src/index.ts` (mount config router before eventsRouter)  
**Dependency:** None. FE can start reading `/api/config/flags` once this ships.  
**Test:** Unit tests for service (cache hit/miss, merge logic); integration test for GET + POST endpoints.

### PR B — CORS mobile origins support
**Files:** `src/middleware/cors.ts`, `src/config.ts`  
**Dependency:** PR A (behind `adaptive.cors.mobile` flag read from DB).  
**Deploy step:** Add `CORS_MOBILE_ORIGINS` to docker-compose env if mobile subdomain is known.

### PR C — Pagination for live/vod channels
**Files:** `src/routers/live.router.ts` (channels endpoint), `src/routers/vod.router.ts` (streams endpoint)  
**Dependency:** PR A (reads `adaptive.pagination.live` / `adaptive.pagination.vod` flags).  
**Backward compat:** No `page` param → returns legacy flat array. Existing TV FE unaffected.

### PR D — Snapshot + rollback scripts
**Files:** `bin/snapshot.sh`, `bin/rollback.sh`, `.github/workflows/deploy.yml` (add deploy ID + snapshot step)  
**Dependency:** None (pure ops tooling, no API surface).

---

## 7. Risks and Mitigations

### Risk 1 — Shared Postgres snapshot contaminates other services
**Likelihood:** Medium if snapshot script uses `pg_dump` without table filter.  
**Impact:** Restoring a BE-only snapshot would wipe n8n workflow history and Mem0 memories if the full DB is restored.  
**Mitigation:** `snapshot.sh` explicitly passes `-t 'sv_*'` to dump only StreamVault tables. Rollback script drops/recreates only `sv_*` tables. Validated by smoke test #2 (n8n not affected).

### Risk 2 — Feature flag DB round-trip adds latency to every flag read
**Likelihood:** High without caching.  
**Impact:** If every endpoint calls `getFlag()` before processing, p99 latency increases by ~5-10 ms per extra DB query.  
**Mitigation:** `feature-flags.service.ts` uses `node-cache` (already a dependency) with a 30-second TTL. All flag reads hit in-process memory; DB is queried only on cache miss or after TTL expiry. Admin writes call `cache.del()` to force immediate refresh.

### Risk 3 — `adaptive.cors.mobile` flag enables a broader CORS allowlist without restart
**Likelihood:** Low (flag is `false` by default).  
**Impact:** If flag is enabled but `CORS_MOBILE_ORIGINS` env var is not set, the allowlist is still just the primary origin — no security regression.  
**Mitigation:** CORS config reads env vars at startup (not at request time for the base origin). The mobile origins list is additive. Document that `CORS_MOBILE_ORIGINS` must be set in docker-compose env before the flag is toggled.

---

## Appendix — New Files Summary

| Path | Type | Purpose |
|---|---|---|
| `postgres/05-feature-flags.sql` | SQL migration | `sv_feature_flags` table + seed |
| `src/services/feature-flags.service.ts` | TypeScript service | DB reads/writes + node-cache |
| `src/routers/config.router.ts` | Express router | `GET /api/config/flags`, `POST /api/config/flags/:key` |
| `bin/snapshot.sh` | Bash script | Pre-deploy pg_dump of `sv_*` tables |
| `bin/rollback.sh` | Bash script | Stop API → restore snapshot → checkout SHA → rebuild |

No existing file is deleted. All changes are additive.
