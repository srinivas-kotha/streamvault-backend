# Architecture Decision Records

This file tracks significant architecture and engineering decisions for the
StreamVault backend. Each entry follows the standard ADR structure:
Context → Decision → Consequences → Rejected Alternatives.

New ADRs should be appended at the bottom of the file in numerical order.

---

## ADR-009: M4 Latency Gate — Client Fan-out vs Unified Search Endpoint

**Date:** 2026-04-21
**Status:** Accepted
**Deciders:** Srinivas Kotha (StreamVault v3 design)

### Context

The StreamVault v3 redesign (SRI-17 to SRI-54) requires the home screen to
load live channels, VOD categories, and series categories simultaneously. The
M4 milestone decision gate asks: can the frontend use **client-side parallel
fan-out** (three simultaneous HTTP requests) or does cold-cache latency make
that unacceptable — requiring a server-side **`/api/search/unified`**
aggregation endpoint?

Branch C measurement protocol was executed: 10 curl samples per endpoint
against the live production backend, capturing warm-cache and cold-cache
(Xtream passthrough) latency separately.

### Measurements (2026-04-21)

Endpoints tested: `/api/live/featured`, `/api/live/categories`,
`/api/vod/categories`, `/api/series/categories`

**Warm-cache performance (NodeCache hit, no Xtream call):**

| Endpoint | p50 | p95 | p99 | mean |
|---|---|---|---|---|
| /api/live/categories | 4.2ms | 5.0ms | 5.0ms | 4.5ms |
| /api/live/featured | 3.6ms | 5.5ms | 5.5ms | 3.8ms |
| /api/vod/categories | 4.1ms | 6.2ms | 6.2ms | 4.2ms |
| /api/series/categories | 8.2ms | 30.1ms | 30.1ms | 33.3ms |

**Cold-cache performance (NodeCache miss → Xtream passthrough):**

| Endpoint | Cold latency | Cache TTL |
|---|---|---|
| /api/live/featured | **3,701ms** | 30 min (streams) / 1 hr (categories) |
| /api/vod/categories | **60,259ms** | 6 hours |
| /api/series/categories | ~224ms (semi-warm, not true cold) | 6 hours |
| /api/live/categories | Not captured (was warm) | 1 hour |

**Measurement caveats:**

- No admin cache-flush endpoint exists; cold hits captured opportunistically
  from first-ever fetch after server restart
- Single Xtream provider; results are provider-specific
- All measurements are loopback (localhost); warm values represent pure
  backend processing time
- Series/categories cold latency not directly measured; estimated 30–90s
  based on VOD pattern

### Decision

**M4 verdict: PIVOT — client-side parallel fan-out is insufficient on its
own. Mitigated via cache warmup + background TTL pre-refresh.**

Warm-cache performance is excellent (all endpoints ≤ 30ms p95) and validates
the NodeCache architecture. However, cold-cache Xtream passthrough latency
is unacceptable for user-facing home screen load:

- `/api/vod/categories`: 60 seconds cold — would cause home screen timeout
  on any cold hit
- `/api/live/featured`: 3.7 seconds cold — exceeds 500ms UX threshold

Cold hits will occur at TTL expiry (every 6h for VOD/series, every 30min for
featured streams) and on every server restart. This is not theoretical: it
was observed in production during this measurement run.

Client-side fan-out is acceptable **only if** the cache is guaranteed warm.
We achieve that via a server-side warmup + pre-refresh scheduler rather than
introducing a `/api/search/unified` aggregation endpoint.

### Consequences

1. **Implement cache warmup on server start** — call `getCategories('live')`,
   `getCategories('vod')`, `getCategories('series')`, and replicate the
   `/api/live/featured` logic at startup (best-effort, non-blocking). This
   converts the 60-second first-user penalty into a background task at boot
   time. Implemented in `src/services/warmup.service.ts`.

2. **Implement background TTL pre-refresh** — refresh cache when the
   remaining TTL drops inside a 120s pre-refresh window, so user requests
   never hit cold Xtream at TTL expiry. Uses `NodeCache.getTtl()` polled
   every 60 seconds via `setInterval`. Co-located in
   `warmup.service.ts`.

3. **Defer `/api/search/unified`** — the unified endpoint is not needed if
   (1) and (2) are implemented, since warm-cache fan-out performance is
   ≤ 30ms p95 across all endpoints. Re-evaluate if cache warmup proves
   unreliable in production.

4. **Admin cache-flush endpoint (deferred)** — needed for future latency
   testing, production cache invalidation after provider catalog updates,
   and operational tooling. Should be gated behind `authMiddleware` + admin
   role check. Priority: **low** (operational tooling, not blocking v3).

5. **Backoff counter isolation** — warmup/pre-refresh failures MUST NOT add
   exponential backoff delay to subsequent real-user requests. This is
   implemented via `BaseStreamProvider.resetFailureState()`, called after
   any caught warmup step failure.

6. **Frontend guidance:** Use client-side parallel fan-out (`Promise.all`)
   for home screen initial load. Rely on backend cache warmup to ensure
   warm hits. Add a loading skeleton with generous timeout (10s+) as a
   cold-hit safety net for the rare server-restart scenario.

### Rejected Alternatives

- **`/api/search/unified` as primary fix:** Solves the client-side
  round-trip count but does not fix the underlying cold Xtream latency
  problem. A unified endpoint would still block for 60s on a cold VOD
  categories hit. Deferred.
- **Reduce VOD/series cache TTL:** Would increase cold-hit frequency,
  making the problem worse. Rejected.
- **Client-side caching (localStorage/IndexedDB):** Can complement server
  cache warmup but doesn't help first-ever page load or new browsers.
  Not a substitute for server-side fix.
- **node-cron / BullMQ for the pre-refresh scheduler:** Would introduce a
  second scheduler system alongside the existing `setInterval` pattern used
  by `catalog.service.ts` and `epg.service.ts`. Rejected for consistency.

### Related

- StreamVault v3 redesign: Paperclip SRI-17 to SRI-54
- Task 4.2 raw measurements:
  `~/.claude/projects/-home-crawler/memory/task-4.2-measurements.md`
- Task 4.2 design doc:
  `~/.claude/projects/-home-crawler/memory/task-4.2-cache-warmup-design.md`
- Cache configuration: `src/services/cache.service.ts`
- Warmup scheduler: `src/services/warmup.service.ts`
- Live featured endpoint: `src/routers/live.router.ts`
