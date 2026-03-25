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
    ├── xtream.types.ts         # Raw Xtream API response types (internal)
    └── xtream.adapters.ts      # Pure adapter functions: raw → normalized types
```

**Key principle:** Routers never import provider-specific code. They call `getProvider()` and use generic types (`CatalogCategory`, `CatalogItem`, `CatalogItemDetail`, `EPGEntry`, etc.).

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
import { BaseStreamProvider } from "../base.provider";
import type {
  ContentType,
  CatalogCategory,
  CatalogItem,
  CatalogItemDetail,
  EPGEntry,
  StreamProxyInfo,
  StreamInfo,
} from "../provider.types";

interface M3UConfig {
  url: string; // URL to the M3U playlist
  epgUrl?: string; // Optional XMLTV EPG URL
}

export class M3UProvider extends BaseStreamProvider {
  readonly name = "m3u";
  private readonly playlistUrl: string;
  private readonly epgUrl: string | undefined;

  constructor(config: M3UConfig) {
    super();
    this.playlistUrl = config.url;
    this.epgUrl = config.epgUrl;
  }

  // --- Required: Content Browsing ---

  async getCategories(type: ContentType): Promise<CatalogCategory[]> {
    // Parse M3U playlist, extract unique group-title values
    // Map each group to a CatalogCategory { id, name, parentId, type }
    // Use this.cachedFetch() for caching
    throw new Error("Not implemented");
  }

  async getStreams(
    categoryId: string,
    type: ContentType,
  ): Promise<CatalogItem[]> {
    // Filter parsed M3U entries by group-title matching categoryId
    // Map each entry to CatalogItem { id, name, type, categoryId, icon, added, isAdult }
    throw new Error("Not implemented");
  }

  async getVODInfo(vodId: string): Promise<CatalogItemDetail> {
    // M3U doesn't have detailed VOD info — return minimal CatalogItemDetail
    // or fetch from TMDB if you have an API key
    throw new Error("Not implemented");
  }

  async getSeriesInfo(seriesId: string): Promise<CatalogItemDetail> {
    // M3U doesn't natively support series — return minimal info
    throw new Error("Not implemented");
  }

  // --- Required: EPG ---

  async getEPG(streamId: string): Promise<EPGEntry[]> {
    // Parse XMLTV from this.epgUrl, filter by channel ID
    // Map to EPGEntry { id, channelId, title, start, end, description }
    throw new Error("Not implemented");
  }

  async getFullEPG(): Promise<EPGEntry[]> {
    // Parse full XMLTV, return all entries
    throw new Error("Not implemented");
  }

  // --- Required: Streaming ---

  getSegmentProxyInfo(segmentPath: string): StreamProxyInfo {
    // For HLS segment proxying — build full segment URL from base + segmentPath
    throw new Error("Not implemented");
  }

  getStreamInfo(
    itemId: string,
    type: ContentType,
    extension?: string,
  ): StreamInfo {
    // Return StreamInfo for the stream router to proxy
    // { url, format, headers, allowedHosts }
    const url = this.getStreamUrlForItem(itemId, type, extension);
    const parsed = new URL(url);

    return {
      url,
      format: (extension ??
        (type === "live" ? "ts" : "mp4")) as StreamInfo["format"],
      headers: {},
      allowedHosts: [
        {
          hostname: parsed.hostname,
          port: parsed.port || "80",
        },
      ],
    };
  }

  private getStreamUrlForItem(
    itemId: string,
    type: ContentType,
    ext?: string,
  ): string {
    // Look up the stream URL from parsed M3U entries
    throw new Error("Not implemented");
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
  providerType: optionalEnv("PROVIDER_TYPE", "xtream") as "xtream" | "m3u",

  // ... existing xtream block ...

  m3u: {
    url: optionalEnv("M3U_URL", ""),
    epgUrl: optionalEnv("M3U_EPG_URL", ""),
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
describe("M3UProvider", () => {
  it('has name "m3u"', () => {
    const provider = new M3UProvider({ url: "http://test.com/playlist.m3u" });
    expect(provider.name).toBe("m3u");
  });

  it("starts healthy", () => {
    const provider = new M3UProvider({ url: "http://test.com/playlist.m3u" });
    expect(provider.isHealthy()).toBe(true);
  });

  // Test getStreamInfo, getSegmentProxyInfo, etc.
});
```

### 8. Verify

```bash
# Type check
npm run build

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

| Method                          | Returns                      | Purpose                                      |
| ------------------------------- | ---------------------------- | -------------------------------------------- |
| `getCategories(type)`           | `Promise<CatalogCategory[]>` | List categories for live/vod/series          |
| `getStreams(catId, type)`       | `Promise<CatalogItem[]>`     | List content in a category                   |
| `getVODInfo(vodId)`             | `Promise<CatalogItemDetail>` | Movie details (poster, plot, cast)           |
| `getSeriesInfo(seriesId)`       | `Promise<CatalogItemDetail>` | Series details + season/episode list         |
| `getEPG(streamId)`              | `Promise<EPGEntry[]>`        | Now/next EPG for a channel                   |
| `getFullEPG()`                  | `Promise<EPGEntry[]>`        | Full EPG for all channels                    |
| `getSegmentProxyInfo(path)`     | `StreamProxyInfo`            | HLS segment proxy info                       |
| `getStreamInfo(id, type, ext?)` | `StreamInfo`                 | Stream URL + format + SSRF allowlist         |
| `isHealthy()`                   | `boolean`                    | Provider health status (inherited from base) |
| `authenticate?()`               | `Promise<AccountInfo>`       | Optional — not all providers need auth       |

## Generic Domain Types

These are the types routers use. Your provider must map its raw API responses to these shapes:

```typescript
// Category list
CatalogCategory  { id, name, parentId, type }

// Content list items (live channels, VOD movies, series)
CatalogItem      { id, name, type, categoryId, icon, added, isAdult, rating?, genre?, year? }

// Detailed content info (VOD movie detail, series with episodes)
CatalogItemDetail extends CatalogItem {
  plot?, cast?, director?, duration?, durationSecs?,
  containerExtension?, backdropUrl?, tmdbId?,
  seasons?, episodes?
}

// EPG programme entry
EPGEntry         { id, channelId, title, description, start, end, category?, icon? }

// Stream info for proxying
StreamInfo       { url, format, headers, allowedHosts, qualities? }

// Auth / account info (optional)
AccountInfo      { username?, maxConnections?, activeConnections?, expiryDate?, isTrial?, status?, allowedFormats? }
```

Full type definitions: `src/providers/provider.types.ts`

## StreamProxyInfo — HLS Segment Proxy Abstraction

Used exclusively by the HLS segment proxy (`GET /api/stream/live/segment/*`):

```typescript
interface StreamProxyInfo {
  url: string; // Full upstream segment URL to fetch
  format: string; // 'ts' or 'm3u8'
  headers: Record<string, string>; // Headers to send upstream (auth, user-agent)
  baseUrl: string; // For M3U8 rewriting (strip this prefix from absolute URLs)
  allowedHost: { hostname; port }; // SSRF protection (only allow this host)
}
```

For regular stream playback (live/VOD/series), implement `getStreamInfo()` which returns `StreamInfo` with `allowedHosts` (array, for SSRF protection).

## BaseStreamProvider — What You Get for Free

By extending `BaseStreamProvider`, your provider inherits:

| Feature                 | Method                                    | Behavior                                   |
| ----------------------- | ----------------------------------------- | ------------------------------------------ |
| **Fetch with timeout**  | `fetchJson<T>(url, headers?)`             | 10s timeout via AbortController            |
| **Health tracking**     | `isHealthy()`                             | Auto-tracks consecutive failures           |
| **Exponential backoff** | `getBackoffMs()`                          | 0ms → 1s → 2s → 4s → ... → 60s max         |
| **Cache-aside**         | `cachedFetch<T>(key, ttl, url, headers?)` | Check cache → wait backoff → fetch → cache |

You don't need to implement health tracking or caching yourself — just call `this.cachedFetch()` or `this.fetchJson()` in your methods.

## Provider Examples by Type

| Provider Type      | Auth Method              | Stream Format             | EPG Source     | Complexity |
| ------------------ | ------------------------ | ------------------------- | -------------- | ---------- |
| **Xtream Codes**   | Username/password in URL | MPEG-TS (live), MP4 (VOD) | Built-in API   | Medium     |
| **M3U/M3U8**       | URL or header token      | Varies (HLS, TS, MP4)     | Separate XMLTV | Low-Medium |
| **Plex**           | X-Plex-Token header      | HLS                       | Plex EPG API   | Medium     |
| **Emby**           | API key header           | HLS, MP4                  | Emby guide API | Medium     |
| **Stalker Portal** | MAC address + token      | MPEG-TS                   | Portal EPG     | High       |

## Checklist

- [ ] Created `src/providers/<name>/` folder
- [ ] Provider class extends `BaseStreamProvider`
- [ ] All `IStreamProvider` methods implemented
- [ ] `getStreamInfo()` returns correct SSRF validation data (`allowedHosts`)
- [ ] `getSegmentProxyInfo()` returns correct `allowedHost` for segment proxy
- [ ] Registered in `src/providers/factory.ts`
- [ ] Config block added to `src/config.ts`
- [ ] Environment variables documented in `.env.example`
- [ ] Tests written and passing
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] Manual E2E test: categories → streams → stream playback
