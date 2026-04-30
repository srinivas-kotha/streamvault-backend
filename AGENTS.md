# AGENTS.md — streamvault-backend

StreamVault API server. Express + TypeScript, serving a Fire TV IPTV client.

## Stack

- **Runtime**: Node.js 20 + TypeScript (strict)
- **Framework**: Express 4
- **Database**: PostgreSQL 15 + pgvector (Docker, port 5432)
- **Auth**: JWT (access + refresh tokens, jti to prevent hash collision)
- **Test**: Vitest (284 tests)
- **Deploy**: Docker (`streamvault_api`, port 3001), manual `docker compose up -d --build streamvault-api`
- **CI**: GitHub Actions — broken since 2026-03-14, manual deploy is the documented fallback

## Key paths

| Path                   | Purpose                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| `src/routes/`          | Express routers — live, vod, series, auth, account, audio-tracks, alerts          |
| `src/routes/events.ts` | SSE catchall — **must be mounted LAST** (router.all('\*') 404s anything after it) |
| `src/lib/xtream.ts`    | Xtream provider client + 60s TTL cache                                            |
| `src/lib/fts.ts`       | Full-text search with prefix-match (`:*`)                                         |
| `postgres/`            | SQL migration files                                                               |
| `.env`                 | Secrets — never committed                                                         |

## Hard rules

1. **events router mounts last** — `app.use("/api", eventsRouter)` has a `router.all('*')` catchall; any router mounted after it silently 404s (root cause of a multi-month latent prod bug, PR #54)
2. **jti on every JWT** — `crypto.randomUUID()` as `jti` prevents hash collision on refresh within same second (PR #38)
3. **Parameterised SQL only** — never string-concatenate queries
4. **No secrets in code** — all credentials via environment variables
5. **No direct main commits** — branch + PR always

## Active status (2026-04-30)

- Prod: `streamvault_api` container, port 3001, behind Nginx Proxy Manager
- Last PRs: #53 (audio-tracks cache) · #54 (events catchall hotfix) · #55/#56 (offline detection)
- Tests: 284 vitest green
- CI: broken since 2026-03-14 — use `docker compose up -d --build streamvault-api` for prod deploys

## Known constraints

- `streamUrl` field may be absent on `/api/series/list` — resolve before Phase 6 of v3 plan
- `capLevelToPlayerSize` wiring deferred to Phase 5b
- Audio-tracks cache (PR #53) is Option B PR 1/3 — frontend integration pending
