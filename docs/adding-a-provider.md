# Adding a New Stream Provider

This guide walks through adding a new IPTV provider to StreamVault. The provider abstraction layer uses the **Strategy Pattern** — each provider implements the `IStreamProvider` interface, and the factory selects the active one based on the `PROVIDER_TYPE` env var.

## Architecture Overview

```
src/providers/
├── provider.types.ts           # IStreamProvider interface + generic domain types
├── base.provider.ts            # BaseStreamProvider (backoff, health, caching)
├── factory.ts                  # createProvider() factory + singleton
├── index.ts                    # Barrel export
├── provider.test.ts            # Tests
└── xtream/                     # Reference implementation
    ├── xtream.provider.ts      # XtreamProvider extends BaseStreamProvider
    └── xtream.types.ts         # Raw Xtream API response types (internal)
```

**Key principle:** Routers never import provider-specific code. They call `getProvider()` and use generic types (`Category`, `Channel`, `VODItem`, etc.).

---

## Step-by-Step: Adding an M3U Provider (Example)

### 1. Create the Provider Folder

```bash
mkdir src/providers/m3u
```

### 2. Define Raw API Types (Optional)

If your provider has a typed API, create `src/providers/m3u/m3u.types.ts`:

```typescript
// Raw types from M3U parsing — internal to this provider only.
// These are NOT exported to routers.

export interface M3UEntry {
  extinf: string;
  groupTitle: string;
  tvgName: string;
  tvgLogo: string;
  tvgId: string;
  url: string;
}
```

For providers with simple responses (like M3U playlists), you might not need a separate types file — parse directly in the provider.

### 3. Create the Provider Class

Create `src/providers/m3u/m3u.provider.ts`:

```typescript
import { BaseStreamProvider } from '../base.provider';
import type {
  ContentType,
  Category,
  Channel,
  VODItem,
  SeriesItem,
  SeriesInfo,
  VODInfo,
  EPGEntry,
  StreamProxyInfo,
} from '../provider.types';

interface M3UConfig {
  url: string;           // URL to the M3U playlist
  epgUrl?: string;       // Optional XMLTV EPG URL
}

export class M3UProvider extends BaseStreamProvider {
  readonly name = 'm3u';
  private readonly playlistUrl: string;
  private readonly epgUrl: string | undefined;

  constructor(config: M3UConfig) {
    super();
    this.playlistUrl = config.url;
    this.epgUrl = config.epgUrl;
  }

  // --- Required: Content Browsing ---

  async getCategories(type: ContentType): Promise<Category[]> {
    // Parse M3U playlist, extract unique group-title values
    // Map each group to a Category { category_id, category_name, parent_id }
    // Use this.cachedFetch() for caching
    throw new Error('Not implemented');
  }

  async getStreams(categoryId: string, type: ContentType): Promise<(Channel | VODItem | SeriesItem)[]> {
    // Filter parsed M3U entries by group-title matching categoryId
    // Map each entry to Channel/VODItem/SeriesItem
    throw new Error('Not implemented');
  }

  async getVODInfo(vodId: string): Promise<VODInfo> {
    // M3U doesn't have detailed VOD info — return minimal info
    // or fetch from TMDB if you have an API key
    throw new Error('Not implemented');
  }

  async getSeriesInfo(seriesId: string): Promise<SeriesInfo> {
    // M3U doesn't natively support series — return minimal info
    throw new Error('Not implemented');
  }

  // --- Required: EPG ---

  async getEPG(streamId: string): Promise<EPGEntry[]> {
    // Parse XMLTV from this.epgUrl, filter by channel ID
    // Map to EPGEntry { id, epg_id, title, start, end, description, ... }
    throw new Error('Not implemented');
  }

  async getFullEPG(): Promise<EPGEntry[]> {
    // Parse full XMLTV, return all entries
    throw new Error('Not implemented');
  }

  // --- Required: Streaming ---

  getStreamURL(streamId: string, type: 'live' | 'vod'): string {
    // Return the direct stream URL from parsed M3U entries
    // Look up by streamId in your parsed data
    throw new Error('Not implemented');
  }

  getStreamProxyInfo(streamId: string, type: ContentType): StreamProxyInfo {
    // This is what stream.router.ts uses to proxy the stream
    const url = this.getStreamURL(streamId, type === 'series' ? 'vod' : type);
    const parsed = new URL(url);

    return {
      url,
      format: type === 'live' ? 'ts' : 'mp4',
      headers: {},                              // Add any auth headers your provider needs
      baseUrl: `${parsed.origin}/`,             // For M3U8 rewriting
      allowedHost: {                            // For SSRF protection
        hostname: parsed.hostname,
        port: parsed.port || '80',
      },
    };
  }

  getSegmentProxyInfo(segmentPath: string): StreamProxyInfo {
    // For HLS segment proxying
    // Build the full segment URL from the base + segmentPath
    throw new Error('Not implemented');
  }
}
```

### 4. Register in the Factory

Edit `src/providers/factory.ts` — add one `case`:

```typescript
import { M3UProvider } from './m3u/m3u.provider';

// Inside the switch:
case 'm3u':
  provider = new M3UProvider(config.m3u);
  break;
```

### 5. Add Config Block

Edit `src/config.ts` — add the provider's config:

```typescript
export const config = {
  providerType: optionalEnv('PROVIDER_TYPE', 'xtream') as 'xtream' | 'm3u',

  // ... existing xtream block ...

  m3u: {
    url: optionalEnv('M3U_URL', ''),
    epgUrl: optionalEnv('M3U_EPG_URL', ''),
  },
};
```

### 6. Set Environment Variable

In your `.env`:

```bash
PROVIDER_TYPE=m3u
M3U_URL=http://your-provider.com/playlist.m3u
M3U_EPG_URL=http://your-provider.com/epg.xml
```

### 7. Write Tests

Add tests to `src/providers/provider.test.ts` or create `src/providers/m3u/m3u.test.ts`:

```typescript
describe('M3UProvider', () => {
  it('has name "m3u"', () => {
    const provider = new M3UProvider({ url: 'http://test.com/playlist.m3u' });
    expect(provider.name).toBe('m3u');
  });

  it('starts healthy', () => {
    const provider = new M3UProvider({ url: 'http://test.com/playlist.m3u' });
    expect(provider.isHealthy()).toBe(true);
  });

  // Test getStreamProxyInfo, getSegmentProxyInfo, etc.
});
```

### 8. Verify

```bash
# Type check
npm run type-check

# Run tests
npm test

# Start dev server
PROVIDER_TYPE=m3u M3U_URL=http://... npm run dev

# Test endpoints
curl http://localhost:3001/health
curl http://localhost:3001/api/live/categories
```

---

## IStreamProvider Interface Reference

Every provider must implement these methods:

| Method | Returns | Purpose |
|--------|---------|---------|
| `getCategories(type)` | `Promise<Category[]>` | List categories for live/vod/series |
| `getStreams(catId, type)` | `Promise<(Channel\|VODItem\|SeriesItem)[]>` | List content in a category |
| `getVODInfo(vodId)` | `Promise<VODInfo>` | Movie details (poster, plot, cast) |
| `getSeriesInfo(seriesId)` | `Promise<SeriesInfo>` | Series details + season/episode list |
| `getEPG(streamId)` | `Promise<EPGEntry[]>` | Now/next EPG for a channel |
| `getFullEPG()` | `Promise<EPGEntry[]>` | Full EPG for all channels |
| `getStreamURL(id, type)` | `string` | Direct stream URL |
| `getStreamProxyInfo(id, type)` | `StreamProxyInfo` | Everything needed to proxy a stream |
| `getSegmentProxyInfo(path)` | `StreamProxyInfo` | HLS segment proxy info |
| `isHealthy()` | `boolean` | Provider health status (inherited from base) |
| `authenticate?()` | `Promise<AuthResponse>` | Optional — not all providers need auth |

## Generic Domain Types

These are the types routers use. Your provider must map its raw API responses to these shapes:

```typescript
Category    { category_id, category_name, parent_id }
Channel     { stream_id, name, stream_icon, epg_channel_id, category_id, ... }
VODItem     { stream_id, name, stream_icon, rating, category_id, container_extension, ... }
SeriesItem  { series_id, name, cover, plot, cast, genre, category_id, ... }
VODInfo     { info: { movie_image, name, plot, cast, ... }, movie_data: { stream_id, ... } }
SeriesInfo  { seasons: [...], info: {...}, episodes: { "1": [...], "2": [...] } }
EPGEntry    { id, epg_id, title, start, end, description, channel_id, ... }
```

Full type definitions: `src/providers/provider.types.ts`

## StreamProxyInfo — The Key Abstraction

This is what makes stream proxying provider-agnostic:

```typescript
interface StreamProxyInfo {
  url: string;                              // Full upstream URL to fetch
  format: string;                           // 'ts', 'mp4', 'm3u8'
  headers: Record<string, string>;          // Headers to send upstream (auth, user-agent)
  baseUrl: string;                          // For M3U8 rewriting (strip this prefix)
  allowedHost: { hostname, port };          // SSRF protection (only allow this host)
}
```

The stream router uses this to:
1. Fetch the upstream URL with the provided headers
2. Validate the URL against `allowedHost` (SSRF protection)
3. Rewrite M3U8 playlists using `baseUrl` as the prefix to strip
4. Determine stream format for FFmpeg transcoding vs binary passthrough

## BaseStreamProvider — What You Get for Free

By extending `BaseStreamProvider`, your provider inherits:

| Feature | Method | Behavior |
|---------|--------|----------|
| **Fetch with timeout** | `fetchJson<T>(url, headers?)` | 10s timeout via AbortController |
| **Health tracking** | `isHealthy()` | Auto-tracks consecutive failures |
| **Exponential backoff** | `getBackoffMs()` | 0ms → 1s → 2s → 4s → ... → 60s max |
| **Cache-aside** | `cachedFetch<T>(key, ttl, url, headers?)` | Check cache → wait backoff → fetch → cache |

You don't need to implement health tracking or caching yourself — just call `this.cachedFetch()` or `this.fetchJson()` in your methods.

## Provider Examples by Type

| Provider Type | Auth Method | Stream Format | EPG Source | Complexity |
|---------------|-------------|---------------|------------|------------|
| **Xtream Codes** | Username/password in URL | MPEG-TS (live), MP4 (VOD) | Built-in API | Medium |
| **M3U/M3U8** | URL or header token | Varies (HLS, TS, MP4) | Separate XMLTV | Low-Medium |
| **Plex** | X-Plex-Token header | HLS | Plex EPG API | Medium |
| **Emby** | API key header | HLS, MP4 | Emby guide API | Medium |
| **Stalker Portal** | MAC address + token | MPEG-TS | Portal EPG | High |

## Checklist

- [ ] Created `src/providers/<name>/` folder
- [ ] Provider class extends `BaseStreamProvider`
- [ ] All `IStreamProvider` methods implemented
- [ ] `getStreamProxyInfo()` returns correct SSRF validation data
- [ ] Registered in `src/providers/factory.ts`
- [ ] Config block added to `src/config.ts`
- [ ] Environment variables documented in `.env.example`
- [ ] Tests written and passing
- [ ] `npm run type-check` passes
- [ ] `npm test` passes
- [ ] Manual E2E test: categories → streams → stream playback
