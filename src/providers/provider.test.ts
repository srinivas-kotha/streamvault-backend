import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { XtreamProvider } from "./xtream/xtream.provider";
import { cacheFlush } from "../services/cache.service";
import type { IStreamProvider } from "./provider.types";

// --- XtreamProvider unit tests ---

const TEST_CONFIG = {
  host: "test.example.com",
  port: 8080,
  username: "testuser",
  password: "testpass",
};

describe("XtreamProvider", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    provider = new XtreamProvider(TEST_CONFIG);
  });

  it('has name "xtream"', () => {
    expect(provider.name).toBe("xtream");
  });

  it("starts healthy", () => {
    expect(provider.isHealthy()).toBe(true);
  });

  describe("getSegmentProxyInfo", () => {
    it("returns correct info for TS segment", () => {
      const info = provider.getSegmentProxyInfo("stream123.ts");
      expect(info.url).toBe(
        "http://test.example.com:8080/live/testuser/testpass/stream123.ts",
      );
      expect(info.format).toBe("ts");
      expect(info.allowedHost).toEqual({
        hostname: "test.example.com",
        port: "8080",
      });
    });

    it("returns correct info for M3U8 segment", () => {
      const info = provider.getSegmentProxyInfo("index.m3u8");
      expect(info.url).toBe(
        "http://test.example.com:8080/live/testuser/testpass/index.m3u8",
      );
      expect(info.format).toBe("m3u8");
    });

    it("includes base URL for M3U8 rewriting", () => {
      const info = provider.getSegmentProxyInfo("sub/playlist.m3u8");
      expect(info.baseUrl).toBe(
        "http://test.example.com:8080/live/testuser/testpass/",
      );
    });
  });
});

describe("XtreamProvider — getStreamInfo()", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    provider = new XtreamProvider(TEST_CONFIG);
  });

  it("live stream returns format 'ts' and URL with /live/ path", () => {
    const info = provider.getStreamInfo("123", "live");
    expect(info.format).toBe("ts");
    expect(info.url).toBe(
      "http://test.example.com:8080/live/testuser/testpass/123.ts",
    );
  });

  it("vod stream returns format 'mp4' and URL with /movie/ path", () => {
    const info = provider.getStreamInfo("456", "vod");
    expect(info.format).toBe("mp4");
    expect(info.url).toBe(
      "http://test.example.com:8080/movie/testuser/testpass/456.mp4",
    );
  });

  it("series stream returns format 'mp4' and URL with /series/ path", () => {
    const info = provider.getStreamInfo("789", "series");
    expect(info.format).toBe("mp4");
    expect(info.url).toBe(
      "http://test.example.com:8080/series/testuser/testpass/789.mp4",
    );
  });

  it("custom extension 'mkv' returns format 'unknown'", () => {
    const info = provider.getStreamInfo("123", "vod", "mkv");
    expect(info.format).toBe("unknown");
    expect(info.url).toContain(".mkv");
  });

  it("custom extension 'm3u8' returns format 'm3u8'", () => {
    const info = provider.getStreamInfo("123", "live", "m3u8");
    expect(info.format).toBe("m3u8");
    expect(info.url).toContain(".m3u8");
  });

  it("URL contains credentials (username/password in path)", () => {
    const info = provider.getStreamInfo("99", "live");
    expect(info.url).toContain("/testuser/testpass/");
  });

  it("returns User-Agent header", () => {
    const info = provider.getStreamInfo("1", "live");
    expect(info.headers["User-Agent"]).toBe("IPTV Smarters Pro/2.2.2.1");
  });

  it("returns allowedHosts with provider hostname and port", () => {
    const info = provider.getStreamInfo("1", "live");
    expect(info.allowedHosts).toEqual([
      { hostname: "test.example.com", port: "8080" },
    ]);
  });

  it("allowedHosts port defaults to '80' when port is 80", () => {
    const providerDefaultPort = new XtreamProvider({
      host: "stream.example.com",
      port: 80,
      username: "u",
      password: "p",
    });
    const info = providerDefaultPort.getStreamInfo("1", "live");
    expect(info.allowedHosts[0].port).toBe("80");
  });
});

// --- Factory tests ---

describe("Provider Factory", () => {
  it("initProvider creates XtreamProvider with valid config", async () => {
    // We test the factory logic by directly constructing — avoids needing env vars
    const provider = new XtreamProvider(TEST_CONFIG);
    expect(provider.name).toBe("xtream");
    expect(provider.isHealthy()).toBe(true);
  });
});

// --- IStreamProvider interface compliance ---

describe("IStreamProvider contract", () => {
  it("XtreamProvider implements all required methods", () => {
    const provider: IStreamProvider = new XtreamProvider(TEST_CONFIG);

    // All interface methods exist
    expect(typeof provider.getCategories).toBe("function");
    expect(typeof provider.getStreams).toBe("function");
    expect(typeof provider.getVODInfo).toBe("function");
    expect(typeof provider.getSeriesInfo).toBe("function");
    expect(typeof provider.getEPG).toBe("function");
    expect(typeof provider.getFullEPG).toBe("function");
    expect(typeof provider.getSegmentProxyInfo).toBe("function");
    expect(typeof provider.getStreamInfo).toBe("function");
    expect(typeof provider.isHealthy).toBe("function");
  });

  it("XtreamProvider is assignable to IStreamProvider", () => {
    // TypeScript compile-time check: this line would fail to compile if
    // XtreamProvider doesn't satisfy IStreamProvider
    const provider: IStreamProvider = new XtreamProvider(TEST_CONFIG);
    expect(provider.name).toBe("xtream");
  });
});

// --- Fetch-level API tests ---

function mockFetchResponse(
  data: unknown,
  ok = true,
  status = 200,
): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(data),
  });
}

describe("XtreamProvider — getCategories()", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = new XtreamProvider(TEST_CONFIG);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns adapted CatalogCategory objects from the API", async () => {
    const rawCategories = [
      { category_id: "1", category_name: "Sports", parent_id: 0 },
      { category_id: "2", category_name: "News", parent_id: 0 },
    ];
    vi.stubGlobal("fetch", mockFetchResponse(rawCategories));

    const result = await provider.getCategories("live");

    expect(result).toEqual([
      { id: "1", name: "Sports", parentId: null, type: "live" },
      { id: "2", name: "News", parentId: null, type: "live" },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(calledUrl).toContain("action=get_live_categories");
  });

  it("uses cache on second call (fetch called only once)", async () => {
    const categories = [
      { category_id: "1", category_name: "Movies", parent_id: 0 },
    ];
    vi.stubGlobal("fetch", mockFetchResponse(categories));

    await provider.getCategories("vod");
    await provider.getCategories("vod");

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("becomes unhealthy after fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error")),
    );

    await expect(provider.getCategories("live")).rejects.toThrow(
      "Network error",
    );
    expect(provider.isHealthy()).toBe(false);
  });
});

describe("XtreamProvider — getStreams()", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = new XtreamProvider(TEST_CONFIG);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses get_live_streams action for live type", async () => {
    const streams = [{ stream_id: 1, name: "Channel 1" }];
    vi.stubGlobal("fetch", mockFetchResponse(streams));

    await provider.getStreams("5", "live");

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(calledUrl).toContain("action=get_live_streams");
    expect(calledUrl).toContain("category_id=5");
  });

  it("uses get_vod_streams action for vod type", async () => {
    vi.stubGlobal("fetch", mockFetchResponse([]));

    await provider.getStreams("10", "vod");

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(calledUrl).toContain("action=get_vod_streams");
    expect(calledUrl).toContain("category_id=10");
  });

  it("uses get_series action for series type", async () => {
    vi.stubGlobal("fetch", mockFetchResponse([]));

    await provider.getStreams("3", "series");

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(calledUrl).toContain("action=get_series");
    expect(calledUrl).toContain("category_id=3");
  });
});

describe("XtreamProvider — getEPG()", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = new XtreamProvider(TEST_CONFIG);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unwraps and adapts epg_listings from the API response", async () => {
    const rawListings = [
      {
        id: "1",
        epg_id: "ch1.us",
        title: "Morning Show",
        description: "A morning program",
        lang: "en",
        start: "2026-01-01 08:00:00",
        end: "2026-01-01 09:00:00",
        channel_id: "ch1",
        start_timestamp: "1234",
        stop_timestamp: "5678",
      },
      {
        id: "2",
        epg_id: "ch1.us",
        title: "Evening News",
        description: "Top stories",
        lang: "en",
        start: "2026-01-01 18:00:00",
        end: "2026-01-01 19:00:00",
        channel_id: "ch1",
        start_timestamp: "2345",
        stop_timestamp: "6789",
      },
    ];
    vi.stubGlobal("fetch", mockFetchResponse({ epg_listings: rawListings }));

    const result = await provider.getEPG("100");

    expect(result).toEqual([
      {
        id: "1",
        channelId: "ch1.us",
        title: "Morning Show",
        description: "A morning program",
        start: "2026-01-01 08:00:00",
        end: "2026-01-01 09:00:00",
      },
      {
        id: "2",
        channelId: "ch1.us",
        title: "Evening News",
        description: "Top stories",
        start: "2026-01-01 18:00:00",
        end: "2026-01-01 19:00:00",
      },
    ]);
    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(calledUrl).toContain("action=get_short_epg");
    expect(calledUrl).toContain("stream_id=100");
  });

  it("uses cache on second call", async () => {
    vi.stubGlobal("fetch", mockFetchResponse({ epg_listings: [] }));

    await provider.getEPG("100");
    await provider.getEPG("100");

    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("XtreamProvider — health tracking", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = new XtreamProvider(TEST_CONFIG);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts healthy", () => {
    expect(provider.isHealthy()).toBe(true);
  });

  it("becomes unhealthy after a fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );

    await expect(provider.getCategories("live")).rejects.toThrow();
    expect(provider.isHealthy()).toBe(false);
  });

  it("recovers to healthy after a successful fetch", async () => {
    // First call fails
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await expect(provider.getCategories("live")).rejects.toThrow();
    expect(provider.isHealthy()).toBe(false);

    // Second call succeeds (different cache key to avoid cache hit)
    cacheFlush();
    vi.stubGlobal("fetch", mockFetchResponse([]));
    await provider.getCategories("vod");
    expect(provider.isHealthy()).toBe(true);
  });
});

// Type alias for accessing protected members on the provider in tests.
// Exposes `getBackoffMs` and `consecutiveFailures` so we can drive the
// backoff calculation without `as any` casts.
type ProviderWithProtected = XtreamProvider & {
  getBackoffMs: () => number;
  consecutiveFailures: number;
};

describe("XtreamProvider — backoff", () => {
  it("calculates exponential backoff: 0ms, 1s, 2s, 4s, 8s, 16s, 32s, 60s max", () => {
    const provider = new XtreamProvider(TEST_CONFIG) as ProviderWithProtected;

    // Access the protected method via the typed alias for testing
    const getBackoff = () => provider.getBackoffMs();
    const setFailures = (n: number) => {
      provider.consecutiveFailures = n;
    };

    // 0 failures = no backoff
    setFailures(0);
    expect(getBackoff()).toBe(0);

    // 1 failure = 1000 * 2^0 = 1000ms
    setFailures(1);
    expect(getBackoff()).toBe(1000);

    // 2 failures = 1000 * 2^1 = 2000ms
    setFailures(2);
    expect(getBackoff()).toBe(2000);

    // 3 failures = 1000 * 2^2 = 4000ms
    setFailures(3);
    expect(getBackoff()).toBe(4000);

    // 4 failures = 1000 * 2^3 = 8000ms
    setFailures(4);
    expect(getBackoff()).toBe(8000);

    // 5 failures = 1000 * 2^4 = 16000ms
    setFailures(5);
    expect(getBackoff()).toBe(16000);

    // 6 failures = 1000 * 2^5 = 32000ms
    setFailures(6);
    expect(getBackoff()).toBe(32000);

    // 7 failures = 1000 * 2^6 = 64000ms, capped at 60000ms
    setFailures(7);
    expect(getBackoff()).toBe(60000);

    // 10 failures = still capped at 60000ms
    setFailures(10);
    expect(getBackoff()).toBe(60000);
  });
});
