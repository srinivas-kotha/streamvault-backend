# StreamVault Backend

Self-hosted IPTV streaming platform backend. Express + TypeScript + PostgreSQL.

## Quick Start

```bash
npm install
cp .env.example .env  # fill in your provider credentials
npm run dev            # development with hot reload
npm run build          # compile TypeScript
npm start              # production
npm test               # run tests
```

## Architecture

```
src/
├── providers/              # Stream provider abstraction layer
│   ├── provider.types.ts   # IStreamProvider interface + generic domain types
│   ├── base.provider.ts    # BaseStreamProvider (backoff, health, caching)
│   ├── factory.ts          # Provider factory + singleton
│   ├── index.ts            # Barrel export
│   └── xtream/             # Xtream Codes provider implementation
│       ├── xtream.provider.ts
│       └── xtream.types.ts # Raw API response types (internal)
├── routers/                # Express route handlers (provider-agnostic)
├── services/               # Cache, database, storage, downloads
├── middleware/              # Auth, CORS, CSRF, rate limiting, errors
├── types/                  # API and database type definitions
└── utils/                  # JWT, validators, FFmpeg, IP utilities
```

## Provider Pattern

The backend uses a **Strategy Pattern** to abstract the stream provider. All routers interact with a generic `IStreamProvider` interface — they never reference provider-specific types or API details.

### How It Works

1. `IStreamProvider` defines the contract: `getCategories()`, `getStreams()`, `getEPG()`, `getStreamProxyInfo()`, etc.
2. `BaseStreamProvider` provides shared infrastructure: exponential backoff, health tracking, fetch with timeout, cache-aside pattern.
3. `XtreamProvider` implements the interface for Xtream Codes API (`player_api.php`).
4. `factory.ts` creates the correct provider based on `PROVIDER_TYPE` env var.
5. Routers call `getProvider()` to get the singleton instance.

### Adding a New Provider

```bash
# 1. Create provider folder
mkdir src/providers/m3u

# 2. Implement IStreamProvider
# src/providers/m3u/m3u.provider.ts
export class M3UProvider extends BaseStreamProvider {
  readonly name = 'm3u';
  // implement all interface methods...
}

# 3. Register in factory.ts (1 line)
case 'm3u': provider = new M3UProvider(config.m3u); break;

# 4. Add config block in config.ts
m3u: { url: requiredEnv('M3U_URL') },

# 5. Set env var
PROVIDER_TYPE=m3u
```

Zero router changes. Zero frontend changes.

### Key Abstractions

| Type | Purpose |
|------|---------|
| `Category` | Content category (live, VOD, series) |
| `Channel` | Live TV channel |
| `VODItem` | Movie/video on demand |
| `SeriesItem` | TV series |
| `EPGEntry` | Electronic Program Guide entry |
| `StreamProxyInfo` | Everything needed to proxy a stream: URL, headers, SSRF validation, M3U8 rewrite base |

## API Endpoints

| Route | Description |
|-------|-------------|
| `GET /health` | Health check + provider status |
| `POST /api/auth/login` | Username/password login |
| `POST /api/auth/refresh` | Token refresh (rotation) |
| `GET /api/live/categories` | Live TV categories |
| `GET /api/live/streams/:catId` | Channels in category |
| `GET /api/live/featured` | Priority channels |
| `GET /api/live/epg/:streamId` | EPG for channel |
| `GET /api/vod/categories` | VOD categories |
| `GET /api/vod/streams/:catId` | Movies in category |
| `GET /api/vod/info/:vodId` | Movie details |
| `GET /api/series/categories` | Series categories |
| `GET /api/series/list/:catId` | Series in category |
| `GET /api/series/info/:seriesId` | Series details + episodes |
| `GET /api/search?q=` | Search across all content |
| `GET /api/stream/:type/:id` | Stream proxy (FFmpeg transcode for live) |
| `GET /api/favorites` | User favorites |
| `GET /api/history` | Watch history |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROVIDER_TYPE` | No | `xtream` | Stream provider type |
| `XTREAM_HOST` | Yes* | — | Xtream provider hostname |
| `XTREAM_PORT` | No | `80` | Xtream provider port |
| `XTREAM_USERNAME` | Yes* | — | Xtream credentials |
| `XTREAM_PASSWORD` | Yes* | — | Xtream credentials |
| `POSTGRES_HOST` | Yes | — | Database host |
| `POSTGRES_DB` | Yes | — | Database name |
| `POSTGRES_USER` | Yes | — | Database user |
| `POSTGRES_PASSWORD` | Yes | — | Database password |
| `JWT_SECRET` | Yes | — | Access token signing key |
| `JWT_REFRESH_SECRET` | Yes | — | Refresh token signing key |
| `PORT` | No | `3001` | Server port |
| `CORS_ORIGIN` | No | `https://streamvault.srinivaskotha.uk` | Allowed origin |

*Required when `PROVIDER_TYPE=xtream`

## Testing

```bash
npm test              # run all tests
npm run test:watch    # watch mode
npm run type-check    # TypeScript strict check
npm run lint          # ESLint
```

## Security

- JWT auth with httpOnly cookies (15min access, 90d refresh with rotation)
- CSRF protection (double-submit cookie pattern)
- Rate limiting (login: 5/15min, API: 120/min, streams: 600/min)
- SSRF protection on stream proxy (validates upstream URL against configured provider host)
- IP-based auth bypass for trusted LANs
- Helmet CSP headers
