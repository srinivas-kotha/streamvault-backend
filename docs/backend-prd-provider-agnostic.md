# StreamVault Backend PRD: Provider-Agnostic IPTV Platform

> **Type**: Backend Architecture PRD
> **Status**: Draft
> **Author**: Claude Code (Opus)
> **Target**: streamvault-backend repository

---

## 1. Context & Motivation

StreamVault backend is a TypeScript/Express IPTV proxy wrapping Xtream Codes `player_api.php`. While functional (35+ endpoints, JWT auth, caching, FFmpeg transcode, stream proxy), the current implementation has **6 architectural anti-patterns** that block feature growth and provider switching:

| Anti-Pattern                                                                 | Impact                                                     | Severity |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- | -------- |
| Domain types are Xtream-shaped (`stream_id`, `tv_archive`, `direct_source`)  | M3U/Stalker provider would need to fabricate Xtream fields | HIGH     |
| Factory is singleton — only one provider can be active                       | No failover, no multi-provider                             | MEDIUM   |
| No capability discovery — caller can't know if provider supports catchup/EPG | Frontend shows broken UI for unsupported features          | HIGH     |
| `getStreamURL()` returns raw URL with credentials in path                    | Security leak: Xtream URLs contain user/pass               | HIGH     |
| Search is O(n) in-memory — fetches ALL streams, filters client-side          | 10K+ channels = slow, wastes upstream bandwidth            | HIGH     |
| EPG coupled to provider — can't use external XMLTV with M3U provider         | Limits EPG sources to provider's built-in data             | MEDIUM   |

**Goal**: Refactor to a provider-agnostic architecture where switching from Xtream to M3U (or any provider) requires ZERO frontend changes, ZERO database migrations, and graceful degradation for unsupported features.

---

## 2. Architecture Overview

### 2.1 Layered Architecture

```
┌─────────────────────────────────────────────────────┐
│                    API Layer (Express Routers)        │
│  live.router / vod.router / series.router / etc.     │
├─────────────────────────────────────────────────────┤
│                   Service Layer                       │
│  CatalogService / EPGService / StreamService /        │
│  SearchService / HealthService / AccountService       │
├─────────────────────────────────────────────────────┤
│                  Provider Manager                     │
│  Primary + Fallback providers, failover routing       │
├──────────────┬──────────────┬───────────────────────┤
│ XtreamProvider│ M3UProvider  │ Future providers...    │
│ (implements  │ (implements  │                        │
│  IStreamProv)│  IStreamProv)│                        │
├──────────────┴──────────────┴───────────────────────┤
│              Persistence Layer                        │
│  sv_catalog (FTS) / sv_epg / sv_channel_health /     │
│  node-cache (hot) / PostgreSQL (warm)                │
└─────────────────────────────────────────────────────┘
```

### 2.2 Key Design Decisions

| Decision            | Choice                                                         | Why                                                                                                                                  | Alternative Rejected                                                       |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Domain types        | Single `CatalogItem` replaces `Channel`/`VODItem`/`SeriesItem` | M3U has no concept of VOD vs live — just URLs with group tags. Generic type with `ContentType` discriminator works for all providers | Keep separate types per content type (forces providers to implement all 3) |
| EPG ownership       | Separate `EPGService` (not part of provider)                   | EPG sources vary independently of stream provider. External XMLTV URLs, provider API, or no EPG at all                               | EPG as provider method (couples EPG to stream provider)                    |
| Catalog persistence | PostgreSQL with write-through cache                            | Enables FTS search, offline resilience, startup speed. node-cache as hot layer, DB as warm layer                                     | Pure in-memory cache (loses data on restart, can't do FTS)                 |
| Stream URLs         | `StreamInfo` object (never raw URL)                            | Credentials stay server-side. Includes format, headers, allowed hosts for SSRF protection                                            | Return raw URL string (leaks Xtream credentials in path)                   |
| Provider management | `ProviderManager` with failover                                | Supports single provider (current), multi-provider, and zero-downtime migration                                                      | Singleton factory (no failover)                                            |
| Capability model    | Static `capabilities` object + optional methods                | Frontend checks capabilities before showing UI. Provider returns empty/null for unsupported features, never errors                   | No capability discovery (frontend guesses, shows broken UI)                |

---

## 3. Provider Interface

### 3.1 Capability Flags

```typescript
interface ProviderCapabilities {
  catchup: boolean; // Timeshift/rewind live TV
  epg: boolean; // Has EPG data (built-in or via XMLTV)
  fullEpg: boolean; // Can fetch EPG for ALL channels at once
  hlsStreams: boolean; // Serves .m3u8 HLS streams
  accountInfo: boolean; // Exposes max connections, expiry, etc.
  adultFilter: boolean; // Native is_adult content flags
  seriesGrouping: boolean; // Groups episodes into series/seasons
  vodInfo: boolean; // Detailed VOD metadata (plot, cast, etc.)
  nativeSearch: boolean; // Server-side search (vs platform FTS)
  multiQuality: boolean; // Multiple bitrate/quality variants
}
```

### 3.2 Generic Domain Types

Replace all Xtream-shaped types with provider-neutral models:

```typescript
type ContentType = "live" | "vod" | "series";

interface CatalogCategory {
  id: string;
  name: string;
  parentId: string | null;
  type: ContentType;
  count?: number;
}

interface CatalogItem {
  id: string; // Provider-specific ID (opaque)
  name: string;
  type: ContentType;
  categoryId: string;
  icon: string | null;
  added: string | null; // ISO timestamp
  isAdult: boolean;
  rating?: string;
  genre?: string;
  year?: string;
}

interface CatalogItemDetail extends CatalogItem {
  plot?: string;
  cast?: string;
  director?: string;
  duration?: string;
  durationSecs?: number;
  containerExtension?: string;
  backdropUrl?: string;
  tmdbId?: string;
  // Series-specific
  seasons?: SeasonInfo[];
  episodes?: Record<string, EpisodeInfo[]>;
}

interface EPGEntry {
  id: string;
  channelId: string;
  title: string;
  description: string;
  start: string; // ISO 8601
  end: string;
  category?: string;
  icon?: string;
}

interface StreamInfo {
  url: string;
  format: "ts" | "mp4" | "m3u8" | "rtmp" | "unknown";
  headers: Record<string, string>;
  allowedHosts: Array<{ hostname: string; port: string }>;
  qualities?: Array<{ label: string; url: string; bandwidth?: number }>;
}

interface AccountInfo {
  maxConnections?: number;
  activeConnections?: number;
  expiryDate?: string;
  isTrial?: boolean;
  status?: "active" | "expired" | "banned" | "disabled";
  allowedFormats?: string[];
}

interface CatchupInfo {
  streamId: string;
  available: boolean;
  maxDays: number;
}
```

### 3.3 Core Provider Interface

```typescript
interface IStreamProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  // REQUIRED — every provider implements these
  getCategories(type: ContentType): Promise<CatalogCategory[]>;
  getItems(categoryId: string, type: ContentType): Promise<CatalogItem[]>;
  getStreamInfo(itemId: string, type: ContentType): Promise<StreamInfo>;
  isHealthy(): boolean;
  healthCheck(): Promise<{
    healthy: boolean;
    latencyMs: number;
    message?: string;
  }>;

  // OPTIONAL — implement based on capabilities
  getItemDetail?(itemId: string, type: ContentType): Promise<CatalogItemDetail>;
  getEPG?(channelId: string, limit?: number): Promise<EPGEntry[]>;
  getFullEPG?(): Promise<EPGEntry[]>;
  getCatchupInfo?(channelId: string): Promise<CatchupInfo>;
  getCatchupStreamInfo?(
    channelId: string,
    start: string,
    durationMins: number,
  ): Promise<StreamInfo>;
  getAccountInfo?(): Promise<AccountInfo>;
  searchNative?(query: string, type?: ContentType): Promise<CatalogItem[]>;
}
```

### 3.4 Xtream Provider Capabilities

```typescript
// XtreamProvider.capabilities
{
  catchup: true,           // /timeshift/ URLs
  epg: true,               // get_short_epg
  fullEpg: true,           // get_simple_data_table + xmltv.php
  hlsStreams: true,         // .m3u8 extension
  accountInfo: true,        // user_info in auth response
  adultFilter: true,        // is_adult field
  seriesGrouping: true,     // get_series_info with seasons
  vodInfo: true,            // get_vod_info with metadata
  nativeSearch: false,      // No server-side search
  multiQuality: false       // No bitrate variants exposed
}
```

---

## 4. Service Layer

### 4.1 CatalogService (Persistent Catalog + FTS Search)

**Purpose**: Sync provider catalog to PostgreSQL, provide fast search and browse.

**Database schema**:

```sql
CREATE TABLE sv_catalog (
  id SERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('live', 'vod', 'series')),
  name TEXT NOT NULL,
  category_id TEXT,
  icon TEXT,
  is_adult BOOLEAN DEFAULT false,
  rating TEXT,
  genre TEXT,
  year TEXT,
  added_at TIMESTAMPTZ,
  raw_data JSONB,
  last_synced TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider_id, item_id, item_type)
);

ALTER TABLE sv_catalog ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(genre, '')), 'B')
  ) STORED;

CREATE INDEX idx_sv_catalog_search ON sv_catalog USING GIN (search_vector);
CREATE INDEX idx_sv_catalog_type_cat ON sv_catalog (item_type, category_id);
CREATE INDEX idx_sv_catalog_provider ON sv_catalog (provider_id);

CREATE TABLE sv_catalog_categories (
  id SERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  category_type TEXT NOT NULL CHECK (category_type IN ('live', 'vod', 'series')),
  name TEXT NOT NULL,
  parent_id TEXT,
  item_count INT,
  last_synced TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider_id, category_id, category_type)
);
```

**Sync flow**:

1. Startup: load catalog from DB into node-cache (fast boot, no provider dependency)
2. Background: sync from provider every 2hrs (live), 6hrs (vod/series)
3. Upsert into `sv_catalog`, update node-cache
4. Search: always hits PostgreSQL FTS (not in-memory)
5. Browse: uses node-cache (hot path), DB as fallback

**Search query** (replaces O(n) filter):

```sql
SELECT item_id, name, item_type, icon, rating, genre
FROM sv_catalog
WHERE search_vector @@ plainto_tsquery('english', $1)
  AND ($2::text IS NULL OR item_type = $2)
  AND ($3::boolean IS NULL OR is_adult = false)
ORDER BY ts_rank(search_vector, plainto_tsquery('english', $1)) DESC
LIMIT 50;
```

### 4.2 EPGService (Decoupled from Provider)

**Purpose**: Aggregate EPG from multiple sources, store in PostgreSQL, serve fast queries.

**EPG Sources** (pluggable):

```typescript
interface IEPGSource {
  readonly name: string;
  fetchEPG(channelIds?: string[]): Promise<EPGEntry[]>;
  fetchFullEPG(): Promise<EPGEntry[]>;
}

class ProviderEPGSource implements IEPGSource {
  /* delegates to active provider */
}
class XMLTVEPGSource implements IEPGSource {
  /* fetches + parses XMLTV URL */
}
```

**Database schema**:

```sql
CREATE TABLE sv_epg (
  id SERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  category TEXT,
  icon TEXT,
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (channel_id, start_time, end_time)
);

CREATE INDEX idx_sv_epg_channel_time ON sv_epg (channel_id, start_time DESC);
CREATE INDEX idx_sv_epg_now ON sv_epg (channel_id)
  WHERE end_time > NOW();
```

**Key queries**:

```sql
-- Now playing + next 3
SELECT * FROM sv_epg
WHERE channel_id = $1 AND end_time > NOW()
ORDER BY start_time LIMIT 4;

-- EPG grid: multiple channels, time window
SELECT * FROM sv_epg
WHERE channel_id = ANY($1::text[])
  AND start_time < $2 AND end_time > $3
ORDER BY channel_id, start_time;

-- Bulk now-playing for channel list
SELECT DISTINCT ON (channel_id) *
FROM sv_epg
WHERE channel_id = ANY($1::text[])
  AND start_time <= NOW() AND end_time > NOW()
ORDER BY channel_id, start_time;
```

**Refresh**: Background task every 6 hours. SAX-based XMLTV parsing (`ektotv/xmltv`) for constant memory. Provider EPG API as secondary source.

**XMLTV parser library**: `ektotv/xmltv` (TypeScript, fastest benchmarks) or `xmltv-stream` (event-driven, lower memory for huge files).

**Important**: EPG `title` and `description` fields from Xtream are often **base64-encoded** — must detect and decode.

### 4.3 StreamService

**Purpose**: Construct stream URLs, manage proxy logic, enforce format-aware proxying.

**Format-aware proxy routing**:

| Format              | Proxy Strategy                                                    | FFmpeg?          |
| ------------------- | ----------------------------------------------------------------- | ---------------- |
| `.m3u8` (HLS)       | Fetch manifest, rewrite segment URLs to proxy paths, pass through | No               |
| `.ts` (MPEG-TS)     | Binary proxy with optional audio transcode (AC-3 → AAC)           | Yes (audio only) |
| `.mp4` (VOD/Series) | Binary proxy with Range header support                            | No               |
| `rtmp`              | Not proxyable via HTTP — return 406 with explanation              | No               |

**Catchup URL construction** (Xtream):

```
GET /api/live/catchup/:streamId?start=<unix_ts>&duration=<hours>
→ backend builds: http://host:port/timeshift/user/pass/{duration}/{start}/{stream_id}.ts
→ proxied to client (credentials never exposed)
```

**Container extension awareness**: Use `containerExtension` from provider response for correct VOD/Series URLs (`.mkv`, `.avi`, `.mp4`) instead of hardcoded `.mp4`.

### 4.4 ProviderManager (Multi-Provider + Failover)

**Purpose**: Replace singleton factory. Support primary/fallback providers.

```typescript
class ProviderManager {
  private providers: Map<string, IStreamProvider>;
  private primaryName: string;

  getPrimary(): IStreamProvider;
  get(name: string): IStreamProvider | undefined;
  getAll(): IStreamProvider[];

  async withFailover<T>(fn: (p: IStreamProvider) => Promise<T>): Promise<T> {
    // Try primary → try each fallback in order → throw if all fail
  }
}
```

**Config**:

```env
PROVIDER_TYPE=xtream            # Primary
FALLBACK_PROVIDER_TYPE=m3u      # Optional fallback
M3U_URL=http://backup/list.m3u  # M3U-specific config
XMLTV_URL=http://epg/xmltv.xml  # External EPG source (optional)
```

**Zero-downtime provider migration**:

1. Add new provider as fallback (env var change + restart)
2. Run catalog sync from both providers (different `provider_id` in DB)
3. Verify content parity (compare counts)
4. Swap `PROVIDER_TYPE` to new provider
5. Restart (Docker rolling restart = zero downtime)
6. Remove old provider config after confirmation

### 4.5 HealthService

**Channel health monitoring**:

```sql
CREATE TABLE sv_channel_health (
  channel_id TEXT PRIMARY KEY,
  is_online BOOLEAN DEFAULT true,
  last_checked TIMESTAMPTZ,
  last_error TEXT,
  check_count INT DEFAULT 0,
  fail_count INT DEFAULT 0
);
```

- Probe 10 random live channels every 5 minutes (HEAD request, 10s timeout)
- Track availability score per channel
- Expose `GET /api/live/health/:channelId`
- Event bus emission on status change

### 4.6 AccountService

**Purpose**: Expose provider account limits to frontend.

```
GET /api/account/info → { maxConnections, activeConnections, expiryDate, status }
```

- Track active streams per user (increment on proxy start, decrement on disconnect)
- Warn when approaching `maxConnections` limit
- Return `{ supported: false }` if provider lacks `accountInfo` capability

---

## 5. Performance Improvements

### 5.1 Quick Wins (implement in same sprint)

| #   | Improvement                                                                 | Impact                              | Effort | File               |
| --- | --------------------------------------------------------------------------- | ----------------------------------- | ------ | ------------------ |
| 1   | **HTTP Keep-Alive** — `agentkeepalive` for persistent connections to Xtream | ~50% throughput gain                | 30min  | `base.provider.ts` |
| 2   | **Response compression** — `compression` middleware (gzip)                  | 7-10x JSON reduction                | 15min  | `index.ts`         |
| 3   | **Request deduplication** — coalesce identical in-flight requests           | Eliminates duplicate upstream calls | 2hr    | `base.provider.ts` |
| 4   | **Cache warm-up on startup** — prefetch top categories on boot              | No cold-cache penalty               | 1hr    | `index.ts`         |
| 5   | **Log sanitization** — mask username/password in all logged URLs            | Security                            | 1hr    | `base.provider.ts` |

**HTTP Keep-Alive implementation**:

```typescript
import Agent from "agentkeepalive";
const keepAliveAgent = new Agent({
  keepAlive: true,
  maxSockets: 40,
  maxFreeSockets: 10,
  timeout: 60000,
  freeSocketTimeout: 30000,
});
```

**Request deduplication**:

```typescript
const inflight = new Map<string, Promise<any>>();
async function deduplicatedFetch(key: string, fetcher: () => Promise<any>) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = fetcher().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
```

### 5.2 Cache Strategy

**Stale-while-revalidate** (replaces hard TTL):

- Return stale data immediately on cache miss
- Trigger background refresh
- Keeps UI responsive even during provider slowness

**Recommended TTLs** (tuned from current):

| Data              | Current | Recommended | Stale Grace | Rationale                     |
| ----------------- | ------- | ----------- | ----------- | ----------------------------- |
| Live categories   | 1hr     | 2hr         | +4hr        | Rarely change                 |
| Live streams      | 30min   | 30min       | +1hr        | Channels do change            |
| EPG short         | 15min   | 5min        | +30min      | Schedule changes matter       |
| VOD categories    | 6hr     | 12hr        | +24hr       | Barely change                 |
| VOD streams       | 2hr     | 4hr         | +8hr        | Batched additions             |
| VOD info          | 2hr     | 24hr        | +48hr       | Metadata is static            |
| Series categories | 6hr     | 12hr        | +24hr       | Barely change                 |
| Series info       | 2hr     | 12hr        | +24hr       | Episodes stable after release |
| Search results    | 5min    | 10min       | +30min      | Reduce upstream pressure      |

### 5.3 Circuit Breaker (replaces simple backoff)

```
CLOSED → (3 failures) → OPEN → (60s cooldown) → HALF-OPEN → (1 test)
  ↑ success                                        ↓ success → CLOSED
                                                   ↓ failure → OPEN
```

Library: `cockatiel` or `opossum` (Node.js circuit breaker).

---

## 6. New Features

### 6.1 Catchup / Timeshift

- **Detection**: Read `tv_archive` (boolean) and `tv_archive_duration` (days) from live stream responses
- **API**: `GET /api/live/catchup/:streamId?start=<unix_ts>&duration=<hours>`
- **Frontend**: Show "Rewind" button on channels where `catchupInfo.available === true`
- **Degradation**: Return `{ supported: false }` for providers without `capabilities.catchup`

### 6.2 Full XMLTV EPG

- **Pipeline**: Cron fetch `/xmltv.php` → SAX parse → upsert `sv_epg` → clear cache
- **External XMLTV**: Configure `XMLTV_URL` env var for M3U providers or supplementary EPG
- **Timeline grid API**: `GET /api/epg/grid?channels=1,2,3&from=<ts>&to=<ts>`
- **Now playing API**: `GET /api/epg/now?channels=1,2,3` (bulk)

### 6.3 HLS Adaptive Streams

- Use `.m3u8` URLs from Xtream instead of `.ts` where `capabilities.hlsStreams` is true
- Rewrite master playlist to proxy all segment URLs
- No FFmpeg needed for HLS (browser plays natively via HLS.js)
- Falls back to `.ts` + FFmpeg audio transcode for providers without HLS

### 6.4 Parental Controls

- Read `isAdult` from provider (Xtream's `is_adult` field)
- Store user preference in DB: `sv_users.adult_filter_enabled`
- Filter `isAdult: true` items from all responses when filter is on
- Future: PIN-based unlock per session

### 6.5 Account Limits

- Read `maxConnections`, `expiryDate` from provider auth response
- Track active streams in memory (increment on proxy start, decrement on `req.close`)
- API: `GET /api/account/info`
- Frontend: show connection count, warn near limit, show expiry date

### 6.6 Container Extension Awareness

- Use `containerExtension` field from VOD/Series responses
- Construct URLs as `/movie/user/pass/{id}.{ext}` instead of hardcoded `.mp4`
- Fixes playback for `.mkv`, `.avi`, `.flv` content

### 6.7 Channel Health Monitoring

- Background probe: 10 random channels every 5 minutes
- Track in `sv_channel_health` table
- Expose per-channel health score to frontend
- Event emission on channel offline/online transition

---

## 7. Security Improvements

| Improvement                      | Current Gap                                              | Fix                                                           |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| **Stream URL isolation**         | `getStreamURL()` returns raw Xtream URL with credentials | Replace with `StreamInfo` object, proxy all streams           |
| **Log sanitization**             | Unknown if credentials appear in error logs              | `sanitizeUrl()` strips username/password from all logged URLs |
| **Adult content filtering**      | `is_adult` field ignored                                 | Filter from responses based on user preference                |
| **Stream token rotation**        | Proxy URLs are static                                    | Add short-lived JWT tokens to proxy URLs (5min expiry)        |
| **Connection limit enforcement** | No tracking                                              | Track active streams, reject when at `maxConnections`         |

---

## 8. Grilled: Stress-Test Analysis

### Q1: What breaks if the Xtream provider goes down for 2 hours?

**Before (current)**: All API endpoints return 502. Cache expires. Users see empty UI.
**After (this PRD)**: Catalog served from PostgreSQL `sv_catalog`. EPG served from `sv_epg`. Browse and search work. Only live streaming fails. Health endpoint reports provider unhealthy. Stale-while-revalidate returns last-known data with freshness warning.

### Q2: What happens when Provider A supports catchup but Provider B doesn't?

**Capability discovery**: `GET /api/provider/capabilities` returns `{ catchup: false }`. Frontend hides the rewind button. API returns `{ supported: false }` instead of 500. No code changes needed on provider switch — the capability flag drives the UX.

### Q3: How does zero-downtime migration work?

1. Add new provider as fallback (env change + restart, <5s downtime with Docker)
2. Both providers sync to `sv_catalog` (different `provider_id` column — no collision)
3. Compare item counts, spot-check specific channels
4. Swap `PROVIDER_TYPE` → restart
5. Frontend sees same generic types, same endpoints — zero changes
6. Old provider data stays in DB until cleanup

### Q4: What if XMLTV file is 200MB?

`ektotv/xmltv` uses SAX/streaming parser — constant memory regardless of file size. Parse events emitted per-programme, upserted in batches of 500 to PostgreSQL. No full-file buffering.

### Q5: Can search handle 50K+ items?

PostgreSQL GIN index on tsvector handles millions of rows efficiently. FTS query with `ts_rank` returns top-50 results in <10ms for 100K rows. Current O(n) in-memory approach fails at ~5K items.

### Q6: What about the 2-core, 7.8GB VPS constraint?

- Node-cache (hot) + PostgreSQL (warm) uses ~200MB total for 50K catalog items
- XMLTV parsing: streaming, constant ~50MB memory
- Background sync: runs every 2-6 hours, takes ~30s per content type
- Channel health probe: 10 HEAD requests every 5 min = negligible
- Circuit breaker: zero overhead when healthy
- No Redis needed — PostgreSQL + node-cache sufficient for single-instance

### Q7: What if EPG channel IDs don't match provider stream IDs?

`sv_epg.channel_id` maps to `CatalogItem.id`, but XMLTV uses different IDs (`epg_channel_id` in Xtream). Solution: maintain a mapping table or use `epg_channel_id` field from live stream responses to join. EPGService handles the mapping internally.

### Q8: How does the event bus scale?

Node.js `EventEmitter` — zero overhead, in-process only. No external dependencies. If we ever need cross-process events (multiple replicas), upgrade to PostgreSQL LISTEN/NOTIFY (already have Postgres). Not needed now.

---

## 9. Implementation Phases

### Phase 1: Foundation (Non-Breaking)

**Scope**: Performance quick wins + database tables + capabilities endpoint

1. Add `compression` middleware to `index.ts`
2. Add `agentkeepalive` to `base.provider.ts`
3. Add request deduplication to `base.provider.ts`
4. Add `ProviderCapabilities` interface and `capabilities` property to `IStreamProvider`
5. Add `GET /api/provider/capabilities` endpoint
6. Create DB migration: `sv_catalog`, `sv_catalog_categories`, `sv_epg`, `sv_channel_health` tables
7. Add log sanitization utility
8. Add cache warm-up on startup

**Files**: `base.provider.ts`, `provider.types.ts`, `index.ts`, `cache.service.ts`, new `capabilities.router.ts`, new DB migration

### Phase 2: Type Normalization

**Scope**: Replace Xtream-shaped types with generic domain types

9. Define `CatalogItem`, `CatalogItemDetail`, `EPGEntry`, `StreamInfo`, `AccountInfo`, `CatchupInfo` types
10. Create adapter functions in Xtream provider (Xtream raw → CatalogItem)
11. Update all routers to use new types
12. Replace `getStreamURL()` with `getStreamInfo()` returning `StreamInfo`
13. Update stream proxy to be format-aware (HLS vs TS vs MP4)
14. Add `containerExtension` to VOD/Series URL construction
15. Add `isAdult` filtering to all list endpoints

**Files**: `provider.types.ts`, `xtream.provider.ts`, `xtream.types.ts`, all routers, `stream.router.ts`

### Phase 3: Services

**Scope**: Build service layer, persistent catalog, EPG

16. Build `CatalogService` with background sync + write-through cache
17. Replace in-memory search with PostgreSQL FTS
18. Build `EPGService` with `ProviderEPGSource` + `XMLTVEPGSource`
19. Add XMLTV fetch + parse pipeline (background task)
20. Add EPG grid endpoint: `GET /api/epg/grid`
21. Add bulk now-playing endpoint: `GET /api/epg/now`
22. Build `AccountService` with connection tracking
23. Add `GET /api/account/info` endpoint

**Files**: new `services/catalog.service.ts`, `services/epg.service.ts`, `services/account.service.ts`, `search.router.ts`, `live.router.ts`, new `account.router.ts`

### Phase 4: New Features

**Scope**: Catchup, health monitoring, circuit breaker, stale-while-revalidate

24. Add catchup/timeshift methods to `IStreamProvider`, implement for Xtream
25. Add `GET /api/live/catchup/:streamId` endpoint
26. Build `ChannelHealthMonitor` with background probing
27. Replace exponential backoff with circuit breaker (`cockatiel`)
28. Implement stale-while-revalidate cache pattern
29. Add event bus (`EventEmitter`) for provider events

**Files**: `xtream.provider.ts`, `live.router.ts`, new `services/health.service.ts`, `base.provider.ts`, `cache.service.ts`

### Phase 5: Multi-Provider

**Scope**: Provider manager, failover, M3U reference implementation

30. Replace singleton factory with `ProviderManager`
31. Add failover routing (`withFailover()`)
32. Build `M3UProvider` as reference second implementation
33. Add `XMLTVEPGSource` for external EPG URLs
34. Zero-downtime migration testing

**Files**: `factory.ts` → `provider-manager.ts`, new `providers/m3u/m3u.provider.ts`, `services/epg.service.ts`

---

## 10. Key Files to Modify

| File                                      | Phase | Changes                                                                            |
| ----------------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| `src/providers/provider.types.ts`         | P1-P2 | New generic types, ProviderCapabilities, StreamInfo, CatalogItem                   |
| `src/providers/base.provider.ts`          | P1,P4 | Keep-alive, dedup, circuit breaker, stale-while-revalidate, log sanitization       |
| `src/providers/xtream/xtream.provider.ts` | P2-P4 | Capabilities, adapter functions, catchup, XMLTV, containerExt, isAdult             |
| `src/providers/xtream/xtream.types.ts`    | P2    | Add missing fields: tv_archive, tv_archive_duration, is_adult, container_extension |
| `src/providers/factory.ts`                | P5    | Replace with ProviderManager                                                       |
| `src/index.ts`                            | P1    | Compression, cache warm-up                                                         |
| `src/services/cache.service.ts`           | P1,P4 | TTL tuning, stale-while-revalidate                                                 |
| `src/routers/stream.router.ts`            | P2    | Format-aware proxy, StreamInfo-based, HLS support                                  |
| `src/routers/search.router.ts`            | P3    | PostgreSQL FTS instead of O(n) filter                                              |
| `src/routers/live.router.ts`              | P3-P4 | EPG grid, bulk now-playing, catchup                                                |
| `src/routers/vod.router.ts`               | P2    | Container extension in URLs                                                        |
| `src/routers/series.router.ts`            | P2    | Container extension in URLs                                                        |
| NEW `src/services/catalog.service.ts`     | P3    | Catalog sync, write-through cache, FTS                                             |
| NEW `src/services/epg.service.ts`         | P3    | EPG aggregation, XMLTV parsing                                                     |
| NEW `src/services/health.service.ts`      | P4    | Channel health monitor                                                             |
| NEW `src/services/account.service.ts`     | P3    | Account info, connection tracking                                                  |
| NEW `src/routers/capabilities.router.ts`  | P1    | Provider capabilities endpoint                                                     |
| NEW `src/routers/account.router.ts`       | P3    | Account info endpoint                                                              |
| NEW `src/providers/m3u/m3u.provider.ts`   | P5    | Reference M3U provider                                                             |
| NEW `src/providers/provider-manager.ts`   | P5    | Multi-provider management                                                          |
| NEW DB migration                          | P1    | sv_catalog, sv_epg, sv_channel_health tables                                       |

---

## 11. Dependencies

| Package                         | Purpose                 | Phase |
| ------------------------------- | ----------------------- | ----- |
| `agentkeepalive`                | HTTP connection pooling | P1    |
| `compression`                   | Response gzip           | P1    |
| `cockatiel`                     | Circuit breaker         | P4    |
| `@iptv/xmltv` or `ektotv/xmltv` | XMLTV EPG parser        | P3    |

---

## 12. Verification

### Per-Phase Testing

**P1 (Quick Wins)**:

- `autocannon -c 50 -d 30 http://localhost:3001/api/live/categories` — measure RPS before/after
- Verify `Content-Encoding: gzip` in response headers
- Verify cache warm-up logs on startup
- Verify `GET /api/provider/capabilities` returns correct flags

**P2 (Type Normalization)**:

- All existing frontend functionality works unchanged (regression test)
- VOD URLs use correct container extension (not hardcoded .mp4)
- `isAdult` channels filtered when flag is set
- Stream proxy works for HLS (.m3u8) live streams

**P3 (Services)**:

- Search returns results in <50ms for 10K+ items
- EPG grid loads 30 channels x 4-hour window in <200ms
- Bulk now-playing returns in <100ms for 50 channels
- Catalog survives provider restart (served from DB)

**P4 (New Features)**:

- Catchup playback works for `tv_archive: 1` channels
- Channel health probe runs every 5 minutes
- Circuit breaker opens after 3 failures, closes after 60s
- Stale data returned when provider is slow

**P5 (Multi-Provider)**:

- M3U provider passes all required interface methods
- Failover triggers when primary provider goes down
- Provider switch with zero frontend changes

### End-to-End Smoke Test

1. Boot with Xtream provider → verify all endpoints
2. Check capabilities endpoint → all expected flags true
3. Search for a channel → result from PostgreSQL FTS
4. Load EPG grid → data from sv_epg table
5. Play a live stream (HLS) → quality selector works
6. Play a VOD → correct container extension
7. Check account info → max connections shown
8. Try catchup on archive-enabled channel → timeshift plays
9. Kill Xtream provider → catalog still browsable from DB
10. Switch to M3U provider → frontend works without changes
