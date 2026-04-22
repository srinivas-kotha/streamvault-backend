import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  incrementConnections,
  decrementConnections,
  getActiveConnections,
  getAccountStatus,
  canStartStream,
} from "./account.service";
import { cacheFlush } from "./cache.service";
import type { IStreamProvider, AccountInfo } from "../providers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
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

// Reset module-level state between tests
// We do this by clearing the cache (account status is cached) and reloading.
// The connection counters are module-level — we reset them via the exported functions.

function resetConnectionState(): void {
  // Drain all tracked connections by calling decrement for each possible key
  // In a real test environment we'd mock the module, but here we use the
  // incrementally-testable exported functions.
  const count = getActiveConnections();
  for (let i = 0; i < count; i++) {
    // Brute-force cleanup: decrement without a key (won't match, so safe)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection counter tests
// ─────────────────────────────────────────────────────────────────────────────

describe("incrementConnections / decrementConnections", () => {
  const KEY_A = "user1:stream100";
  const KEY_B = "user1:stream200";
  const KEY_C = "user2:stream100";

  // Each test group is isolated by using unique keys
  it("increments count when a new key is added", () => {
    const before = getActiveConnections();
    const after = incrementConnections(KEY_A + "-inc-test-1");
    expect(after).toBe(before + 1);
    // cleanup
    decrementConnections(KEY_A + "-inc-test-1");
  });

  it("does NOT double-count the same key", () => {
    const uniqueKey = "dedup-test-key-unique";
    const before = getActiveConnections();

    incrementConnections(uniqueKey);
    incrementConnections(uniqueKey); // same key again

    expect(getActiveConnections()).toBe(before + 1);
    // cleanup
    decrementConnections(uniqueKey);
  });

  it("decrements count correctly", () => {
    const uniqueKey = "decrement-test-unique";
    const before = getActiveConnections();

    incrementConnections(uniqueKey);
    expect(getActiveConnections()).toBe(before + 1);

    decrementConnections(uniqueKey);
    expect(getActiveConnections()).toBe(before);
  });

  it("is safe to decrement a key that was never incremented", () => {
    const before = getActiveConnections();
    decrementConnections("nonexistent-key-xyz");
    expect(getActiveConnections()).toBe(before); // no change
  });

  it("is safe to decrement the same key twice", () => {
    const uniqueKey = "double-dec-test";
    const before = getActiveConnections();

    incrementConnections(uniqueKey);
    decrementConnections(uniqueKey);
    decrementConnections(uniqueKey); // second call — should not go below 0

    expect(getActiveConnections()).toBeGreaterThanOrEqual(before);
  });

  it("tracks multiple independent keys", () => {
    const k1 = "multi-key-1";
    const k2 = "multi-key-2";
    const k3 = "multi-key-3";
    const before = getActiveConnections();

    incrementConnections(k1);
    incrementConnections(k2);
    incrementConnections(k3);

    expect(getActiveConnections()).toBe(before + 3);

    decrementConnections(k1);
    expect(getActiveConnections()).toBe(before + 2);

    decrementConnections(k2);
    decrementConnections(k3);
    expect(getActiveConnections()).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAccountStatus tests
// ─────────────────────────────────────────────────────────────────────────────

describe("getAccountStatus", () => {
  beforeEach(() => {
    cacheFlush();
  });

  it("returns { supported: false } when provider has no authenticate method", async () => {
    const provider = makeMockProvider(); // no authenticate

    const status = await getAccountStatus(provider);

    expect(status.supported).toBe(false);
    expect(status.trackedActiveConnections).toBeGreaterThanOrEqual(0);
  });

  it("returns account info from provider.authenticate when available", async () => {
    const mockAccountInfo: AccountInfo = {
      maxConnections: 3,
      activeConnections: 1,
      expiryDate: "2027-01-01",
      status: "active",
      isTrial: false,
    };

    const provider = makeMockProvider({
      authenticate: vi.fn().mockResolvedValue(mockAccountInfo),
    });

    const status = await getAccountStatus(provider);

    expect(status.supported).toBe(true);
    expect(status.maxConnections).toBe(3);
    expect(status.expiryDate).toBe("2027-01-01");
    expect(status.status).toBe("active");
    expect(typeof status.trackedActiveConnections).toBe("number");
  });

  it("returns { supported: true } even when authenticate throws", async () => {
    const provider = makeMockProvider({
      authenticate: vi.fn().mockRejectedValue(new Error("Provider API error")),
    });

    const status = await getAccountStatus(provider);

    expect(status.supported).toBe(true);
    expect(status.status).toBeUndefined();
  });

  it("uses cache on second call — authenticate called only once", async () => {
    const mockAccountInfo: AccountInfo = {
      maxConnections: 2,
      status: "active",
    };
    const authenticateFn = vi.fn().mockResolvedValue(mockAccountInfo);

    const provider = makeMockProvider({ authenticate: authenticateFn });

    await getAccountStatus(provider);
    await getAccountStatus(provider);

    expect(authenticateFn).toHaveBeenCalledOnce();
  });

  it("always returns fresh trackedActiveConnections (not cached value)", async () => {
    const mockAccountInfo: AccountInfo = {
      maxConnections: 10,
      status: "active",
    };
    const provider = makeMockProvider({
      authenticate: vi.fn().mockResolvedValue(mockAccountInfo),
    });

    // First call
    await getAccountStatus(provider);

    // Increment connections after first call
    const streamKey = "fresh-count-test-key";
    incrementConnections(streamKey);

    // Second call — should reflect the new active connections
    const status2 = await getAccountStatus(provider);
    expect(status2.trackedActiveConnections).toBeGreaterThan(0);

    // cleanup
    decrementConnections(streamKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// canStartStream tests
// ─────────────────────────────────────────────────────────────────────────────

describe("canStartStream", () => {
  beforeEach(() => {
    cacheFlush();
  });

  it("allows stream when provider has no authenticate method", async () => {
    const provider = makeMockProvider();

    const result = await canStartStream(provider);

    expect(result.allowed).toBe(true);
  });

  it("allows stream when maxConnections is not set", async () => {
    const provider = makeMockProvider({
      authenticate: vi.fn().mockResolvedValue({
        status: "active",
        // maxConnections not set
      } satisfies AccountInfo),
    });

    const result = await canStartStream(provider);

    expect(result.allowed).toBe(true);
  });

  it("allows stream when under the connection limit", async () => {
    const provider = makeMockProvider({
      authenticate: vi.fn().mockResolvedValue({
        maxConnections: 5,
        activeConnections: 1,
        status: "active",
      } satisfies AccountInfo),
    });

    const result = await canStartStream(provider);

    expect(result.allowed).toBe(true);
  });

  it("blocks stream when at the connection limit", async () => {
    const provider = makeMockProvider({
      authenticate: vi.fn().mockResolvedValue({
        maxConnections: 2,
        activeConnections: 2,
        status: "active",
      } satisfies AccountInfo),
    });

    const result = await canStartStream(provider);

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/connection limit/i);
    expect(result.reason).toContain("2/2");
  });

  it("uses tracked connections when higher than provider-reported", async () => {
    // Provider reports 0 active, but we have 5 tracked locally
    const trackKeys = Array.from(
      { length: 5 },
      (_, i) => `can-start-test-key-${i}`,
    );
    trackKeys.forEach(incrementConnections);

    const provider = makeMockProvider({
      authenticate: vi.fn().mockResolvedValue({
        maxConnections: 3,
        activeConnections: 0, // provider says 0
        status: "active",
      } satisfies AccountInfo),
    });

    const result = await canStartStream(provider);

    // Our tracked count (5) exceeds max (3) — should be blocked
    expect(result.allowed).toBe(false);

    // cleanup
    trackKeys.forEach(decrementConnections);
  });
});
