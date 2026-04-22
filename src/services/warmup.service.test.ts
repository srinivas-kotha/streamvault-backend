import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { cacheFlush, cacheSet, CacheTTL, WARMUP_CACHE_KEYS } from "./cache.service";
import {
  runWarmup,
  checkAndPreRefresh,
  startCacheWarmup,
  __resetWarmupStateForTests,
} from "./warmup.service";
import type { IStreamProvider } from "../providers";

// ─────────────────────────────────────────────────────────────────────────────
// Mock provider helper
// ─────────────────────────────────────────────────────────────────────────────

function makeMockProvider(
  overrides: Partial<IStreamProvider> = {},
): IStreamProvider {
  return {
    name: "test-provider",
    isHealthy: () => true,
    resetFailureState: vi.fn(),
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

// ─────────────────────────────────────────────────────────────────────────────
// runWarmup — sequential execution + failure isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("runWarmup", () => {
  beforeEach(() => {
    cacheFlush();
    __resetWarmupStateForTests();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cacheFlush();
    __resetWarmupStateForTests();
  });

  it("calls getCategories for each content type in order", async () => {
    const provider = makeMockProvider();
    await runWarmup(provider);

    expect(provider.getCategories).toHaveBeenCalledWith("live");
    expect(provider.getCategories).toHaveBeenCalledWith("vod");
    expect(provider.getCategories).toHaveBeenCalledWith("series");
  });

  it("continues executing remaining steps when one step throws", async () => {
    const getCategories = vi
      .fn()
      .mockImplementation((type: string) => {
        if (type === "vod") {
          return Promise.reject(new Error("Xtream 503"));
        }
        return Promise.resolve([]);
      });

    const provider = makeMockProvider({ getCategories });

    await runWarmup(provider);

    // All four types attempted even though vod threw
    expect(getCategories).toHaveBeenCalledWith("live");
    expect(getCategories).toHaveBeenCalledWith("vod");
    expect(getCategories).toHaveBeenCalledWith("series");
  });

  it("resets provider failure state on step failure (no backoff poisoning)", async () => {
    const getCategories = vi
      .fn()
      .mockImplementation((type: string) => {
        if (type === "vod") {
          return Promise.reject(new Error("boom"));
        }
        return Promise.resolve([]);
      });
    const resetFailureState = vi.fn();

    const provider = makeMockProvider({ getCategories, resetFailureState });

    await runWarmup(provider);

    expect(resetFailureState).toHaveBeenCalled();
  });

  it("skips steps whose cache key is already populated", async () => {
    cacheSet(
      WARMUP_CACHE_KEYS.LIVE_CATEGORIES,
      [{ id: "1" }],
      CacheTTL.CHANNEL_CATEGORIES,
    );
    const provider = makeMockProvider();

    await runWarmup(provider);

    const liveCalls = (provider.getCategories as ReturnType<typeof vi.fn>).mock
      .calls.filter((c) => c[0] === "live");
    // getCategories('live') should NOT have been called for the skipped step.
    // (Featured step also calls getCategories('live'), but that only runs if
    // featured itself is cold — it is cold here, so one call is expected.)
    expect(liveCalls.length).toBe(1);
  });

  it("populates the featured cache key", async () => {
    const teluguCat = {
      id: "10",
      name: "India - Telugu",
      parentId: null,
      type: "live" as const,
    };
    const featured = {
      id: "100",
      name: "ETV Telugu",
      type: "live" as const,
      categoryId: "10",
      icon: null,
      added: null,
      isAdult: false,
    };

    const provider = makeMockProvider({
      getCategories: vi.fn().mockResolvedValue([teluguCat]),
      getStreams: vi.fn().mockResolvedValue([featured]),
    });

    await runWarmup(provider);

    const { cacheGet } = await import("./cache.service");
    const cached = cacheGet<typeof featured[]>(WARMUP_CACHE_KEYS.LIVE_FEATURED);
    expect(cached).toBeDefined();
    expect(cached!.some((s) => s.id === "100")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkAndPreRefresh — TTL-driven refresh triggering
// ─────────────────────────────────────────────────────────────────────────────

describe("checkAndPreRefresh", () => {
  beforeEach(() => {
    cacheFlush();
    __resetWarmupStateForTests();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cacheFlush();
    __resetWarmupStateForTests();
  });

  it("does not refresh when TTL remaining exceeds window", async () => {
    // TTL far in the future (well beyond the 120s refresh window)
    cacheSet(WARMUP_CACHE_KEYS.VOD_CATEGORIES, ["x"], 3600);

    const provider = makeMockProvider();
    checkAndPreRefresh(provider);

    // No refresh should be kicked off — let the event loop settle first.
    await new Promise((r) => setImmediate(r));

    expect(provider.getCategories).not.toHaveBeenCalled();
  });

  it("triggers refresh when TTL remaining is inside window", async () => {
    // TTL = 60s → inside the 120s pre-refresh window
    cacheSet(WARMUP_CACHE_KEYS.VOD_CATEGORIES, ["x"], 60);

    const provider = makeMockProvider();
    checkAndPreRefresh(provider);

    // Let the fire-and-forget refresh run
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(provider.getCategories).toHaveBeenCalledWith("vod");
  });

  it("does not refresh when key is absent from cache", async () => {
    // No cacheSet — key is cold, warmup's job, not refresh's
    const provider = makeMockProvider();

    checkAndPreRefresh(provider);
    await new Promise((r) => setImmediate(r));

    expect(provider.getCategories).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// startCacheWarmup — scheduler wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("startCacheWarmup", () => {
  beforeEach(() => {
    cacheFlush();
    __resetWarmupStateForTests();
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cacheFlush();
    __resetWarmupStateForTests();
  });

  it("returns an interval timer that can be cleared", () => {
    const provider = makeMockProvider();
    const interval = startCacheWarmup(provider);

    expect(interval).toBeDefined();
    clearInterval(interval);
  });

  it("delays initial warmup run (does not fire synchronously)", () => {
    const provider = makeMockProvider();
    const interval = startCacheWarmup(provider);

    // Before the startup delay elapses, warmup should not have called in.
    expect(provider.getCategories).not.toHaveBeenCalled();

    clearInterval(interval);
  });
});
