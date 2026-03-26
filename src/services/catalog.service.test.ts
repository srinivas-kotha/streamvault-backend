import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cacheFlush, cacheGet } from "./cache.service";
import type { IStreamProvider, CatalogItem, ContentType } from "../providers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockProvider(
  overrides: Partial<IStreamProvider> = {},
): IStreamProvider {
  return {
    name: "test-provider",
    isHealthy: () => true,
    getCategories: vi.fn().mockResolvedValue([]),
    getStreams: vi.fn().mockResolvedValue([]),
    getVODInfo: vi.fn().mockResolvedValue({}),
    getSeriesInfo: vi.fn().mockResolvedValue({}),
    getEPG: vi.fn().mockResolvedValue([]),
    getFullEPG: vi.fn().mockResolvedValue([]),
    getSegmentProxyInfo: vi.fn().mockReturnValue({
      url: "",
      format: "ts",
      headers: {},
      baseUrl: "",
      allowedHost: { hostname: "", port: "" },
    }),
    getStreamInfo: vi.fn().mockReturnValue({
      url: "",
      format: "ts",
      headers: {},
      allowedHosts: [],
    }),
    ...overrides,
  };
}

function makeItems(
  type: ContentType,
  count: number,
  isAdult = false,
): CatalogItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    name: `Item ${i + 1}`,
    type,
    categoryId: "1",
    icon: null,
    added: null,
    isAdult,
    genre: i % 2 === 0 ? "Drama" : undefined,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// searchCatalog — fallback in-memory path (DB not available in unit tests)
// ─────────────────────────────────────────────────────────────────────────────

// We test the searchCatalog public API. In unit tests, the DB query() will
// throw (no real PG), so searchCatalog falls back to in-memory search using
// the cached data. We pre-populate the cache to simulate previously synced data.

describe("searchCatalog — in-memory fallback", () => {
  beforeEach(() => {
    cacheFlush();
    vi.resetModules();
  });

  afterEach(() => {
    cacheFlush();
  });

  it("returns matching items from cache when DB is unavailable", async () => {
    // Pre-populate cache (simulates a prior sync)
    const { cacheSet } = await import("./cache.service");
    const { CacheTTL } = await import("./cache.service");

    const liveItems: CatalogItem[] = [
      {
        id: "1",
        name: "CNN HD",
        type: "live",
        categoryId: "5",
        icon: null,
        added: null,
        isAdult: false,
      },
      {
        id: "2",
        name: "BBC World",
        type: "live",
        categoryId: "5",
        icon: null,
        added: null,
        isAdult: false,
      },
    ];
    cacheSet(
      "catalog:test-provider:live:all",
      liveItems,
      CacheTTL.CHANNEL_LIST,
    );

    const { searchCatalog } = await import("./catalog.service");
    const provider = makeMockProvider();

    const results = await searchCatalog(provider, "CNN", undefined, true);

    expect(results.live).toHaveLength(1);
    expect(results.live[0]!.name).toBe("CNN HD");
    expect(results.vod).toHaveLength(0);
    expect(results.series).toHaveLength(0);
  });

  it("filters adult content when hideAdult=true", async () => {
    const { cacheSet, CacheTTL } = await import("./cache.service");

    const liveItems: CatalogItem[] = [
      {
        id: "1",
        name: "Safe Channel",
        type: "live",
        categoryId: "1",
        icon: null,
        added: null,
        isAdult: false,
      },
      {
        id: "2",
        name: "Adult Channel",
        type: "live",
        categoryId: "2",
        icon: null,
        added: null,
        isAdult: true,
      },
    ];
    cacheSet(
      "catalog:test-provider:live:all",
      liveItems,
      CacheTTL.CHANNEL_LIST,
    );

    const { searchCatalog } = await import("./catalog.service");
    const provider = makeMockProvider();

    const results = await searchCatalog(provider, "Channel", undefined, true);

    expect(results.live).toHaveLength(1);
    expect(results.live[0]!.name).toBe("Safe Channel");
  });

  it("includes adult content when hideAdult=false", async () => {
    const { cacheSet, CacheTTL } = await import("./cache.service");

    const liveItems: CatalogItem[] = [
      {
        id: "1",
        name: "Safe Channel",
        type: "live",
        categoryId: "1",
        icon: null,
        added: null,
        isAdult: false,
      },
      {
        id: "2",
        name: "Adult Channel",
        type: "live",
        categoryId: "2",
        icon: null,
        added: null,
        isAdult: true,
      },
    ];
    cacheSet(
      "catalog:test-provider:live:all",
      liveItems,
      CacheTTL.CHANNEL_LIST,
    );

    const { searchCatalog } = await import("./catalog.service");
    const provider = makeMockProvider();

    const results = await searchCatalog(provider, "Channel", undefined, false);

    expect(results.live).toHaveLength(2);
  });

  it("filters by content type when type param provided", async () => {
    const { cacheSet, CacheTTL } = await import("./cache.service");

    const liveItems: CatalogItem[] = [
      {
        id: "1",
        name: "Live News",
        type: "live",
        categoryId: "1",
        icon: null,
        added: null,
        isAdult: false,
      },
    ];
    const vodItems: CatalogItem[] = [
      {
        id: "2",
        name: "VOD News",
        type: "vod",
        categoryId: "1",
        icon: null,
        added: null,
        isAdult: false,
      },
    ];
    cacheSet(
      "catalog:test-provider:live:all",
      liveItems,
      CacheTTL.CHANNEL_LIST,
    );
    cacheSet("catalog:test-provider:vod:all", vodItems, CacheTTL.VOD_LIST);

    const { searchCatalog } = await import("./catalog.service");
    const provider = makeMockProvider();

    const results = await searchCatalog(provider, "News", "live", true);

    expect(results.live).toHaveLength(1);
    expect(results.vod).toHaveLength(0);
  });

  it("caps results at 50 per type", async () => {
    const { cacheSet, CacheTTL } = await import("./cache.service");

    const liveItems = makeItems("live", 100);
    cacheSet(
      "catalog:test-provider:live:all",
      liveItems,
      CacheTTL.CHANNEL_LIST,
    );

    const { searchCatalog } = await import("./catalog.service");
    const provider = makeMockProvider();

    const results = await searchCatalog(provider, "Item", "live", false);

    expect(results.live.length).toBeLessThanOrEqual(50);
  });

  it("returns empty results when cache is empty and DB is unavailable", async () => {
    const { searchCatalog } = await import("./catalog.service");
    const provider = makeMockProvider();

    const results = await searchCatalog(provider, "missing", undefined, true);

    expect(results.live).toHaveLength(0);
    expect(results.vod).toHaveLength(0);
    expect(results.series).toHaveLength(0);
  });

  it("is case-insensitive", async () => {
    const { cacheSet, CacheTTL } = await import("./cache.service");

    const liveItems: CatalogItem[] = [
      {
        id: "1",
        name: "Telugu News",
        type: "live",
        categoryId: "1",
        icon: null,
        added: null,
        isAdult: false,
      },
    ];
    cacheSet(
      "catalog:test-provider:live:all",
      liveItems,
      CacheTTL.CHANNEL_LIST,
    );

    const { searchCatalog } = await import("./catalog.service");
    const provider = makeMockProvider();

    const resultsUpper = await searchCatalog(
      provider,
      "TELUGU",
      undefined,
      true,
    );
    const resultsLower = await searchCatalog(
      provider,
      "telugu",
      undefined,
      true,
    );

    expect(resultsUpper.live).toHaveLength(1);
    expect(resultsLower.live).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCatalogItems — cache + cold path
// ─────────────────────────────────────────────────────────────────────────────

describe("getCatalogItems", () => {
  beforeEach(() => {
    cacheFlush();
    vi.resetModules();
  });

  afterEach(() => {
    cacheFlush();
  });

  it("returns items from cache when available", async () => {
    const { cacheSet, CacheTTL } = await import("./cache.service");

    const liveItems: CatalogItem[] = [
      {
        id: "10",
        name: "Cached Channel",
        type: "live",
        categoryId: "1",
        icon: null,
        added: null,
        isAdult: false,
      },
    ];
    cacheSet(
      "catalog:test-provider:live:all",
      liveItems,
      CacheTTL.CHANNEL_LIST,
    );

    const { getCatalogItems } = await import("./catalog.service");
    const provider = makeMockProvider();

    const items = await getCatalogItems(provider, "live");

    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("Cached Channel");
    // Provider.getStreams should NOT be called since we have cache
    expect(provider.getStreams).not.toHaveBeenCalled();
  });

  it("falls back to provider when both cache and DB miss", async () => {
    const liveItems: CatalogItem[] = [
      {
        id: "99",
        name: "Provider Item",
        type: "live",
        categoryId: "2",
        icon: null,
        added: null,
        isAdult: false,
      },
    ];

    const provider = makeMockProvider({
      getStreams: vi.fn().mockResolvedValue(liveItems),
    });

    const { getCatalogItems } = await import("./catalog.service");
    const items = await getCatalogItems(provider, "live");

    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("Provider Item");
    expect(provider.getStreams).toHaveBeenCalledWith("0", "live");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// syncCatalog — deduplication / idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("syncCatalog — guard conditions", () => {
  beforeEach(() => {
    cacheFlush();
    vi.resetModules();
  });

  afterEach(() => {
    cacheFlush();
  });

  it("skips sync when provider returns empty array", async () => {
    const provider = makeMockProvider({
      getStreams: vi.fn().mockResolvedValue([]),
    });

    const { syncCatalog } = await import("./catalog.service");

    // Should not throw
    await expect(syncCatalog(provider, "live")).resolves.toBeUndefined();
  });

  it("does not throw when provider.getStreams rejects", async () => {
    const provider = makeMockProvider({
      getStreams: vi
        .fn()
        .mockRejectedValue(new Error("Provider connection refused")),
    });

    const { syncCatalog } = await import("./catalog.service");

    // Sync errors are caught internally — should not propagate
    await expect(syncCatalog(provider, "vod")).resolves.toBeUndefined();
  });
});
