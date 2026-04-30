import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db.service", () => ({
  query: vi.fn(),
}));

import { query } from "./db.service";
import {
  isValidFlagKey,
  getGlobalFlags,
  getUserFlags,
  getMergedFlags,
  upsertFlag,
} from "./feature-flags.service";

const mockQuery = vi.mocked(query);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isValidFlagKey", () => {
  it("accepts well-formed dotted keys", () => {
    expect(isValidFlagKey("adaptive.player.tap_toggle")).toBe(true);
    expect(isValidFlagKey("a.b")).toBe(true);
    expect(isValidFlagKey("adaptive.mobile.enabled")).toBe(true);
  });

  it("rejects single-segment keys", () => {
    expect(isValidFlagKey("flag")).toBe(false);
  });

  it("rejects camelCase or uppercase", () => {
    expect(isValidFlagKey("Adaptive.Mobile.Enabled")).toBe(false);
    expect(isValidFlagKey("adaptive.MobilEnabled")).toBe(false);
  });

  it("rejects leading/trailing dot or empty segments", () => {
    expect(isValidFlagKey(".adaptive.foo")).toBe(false);
    expect(isValidFlagKey("adaptive.foo.")).toBe(false);
    expect(isValidFlagKey("adaptive..foo")).toBe(false);
  });

  it("rejects keys longer than 128 chars", () => {
    const long = "a." + "x".repeat(130);
    expect(isValidFlagKey(long)).toBe(false);
  });
});

describe("getGlobalFlags", () => {
  it("queries scope=global with NULL scope_id and returns key→value map", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { key: "adaptive.mobile.enabled", value: false },
        { key: "adaptive.player.tap_toggle", value: true },
      ],
      rowCount: 2,
    } as never);

    const flags = await getGlobalFlags();

    expect(flags).toEqual({
      "adaptive.mobile.enabled": false,
      "adaptive.player.tap_toggle": true,
    });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("scope = 'global'");
    expect(sql).toContain("scope_id IS NULL");
  });

  it("returns empty object when no rows", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const flags = await getGlobalFlags();
    expect(flags).toEqual({});
  });
});

describe("getUserFlags", () => {
  it("returns empty for invalid userIds", async () => {
    expect(await getUserFlags(0)).toEqual({});
    expect(await getUserFlags(-1)).toEqual({});
    expect(await getUserFlags(NaN)).toEqual({});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("queries scope=user for valid userId", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ key: "adaptive.player.tap_toggle", value: true }],
      rowCount: 1,
    } as never);

    const flags = await getUserFlags(42);

    expect(flags).toEqual({ "adaptive.player.tap_toggle": true });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("scope = 'user'");
    expect(params).toEqual(["42"]);
  });
});

describe("getMergedFlags", () => {
  it("returns globals when no userId provided", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ key: "adaptive.mobile.enabled", value: false }],
      rowCount: 1,
    } as never);

    const flags = await getMergedFlags();

    expect(flags).toEqual({ "adaptive.mobile.enabled": false });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("merges user overrides on top of globals", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { key: "adaptive.mobile.enabled", value: false },
          { key: "adaptive.player.tap_toggle", value: false },
        ],
        rowCount: 2,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ key: "adaptive.player.tap_toggle", value: true }],
        rowCount: 1,
      } as never);

    const flags = await getMergedFlags(7);

    expect(flags).toEqual({
      "adaptive.mobile.enabled": false,
      "adaptive.player.tap_toggle": true, // overridden
    });
  });
});

describe("upsertFlag", () => {
  it("rejects invalid keys", async () => {
    await expect(
      upsertFlag({ key: "INVALID", value: true, updated_by: "test" }),
    ).rejects.toThrow(/Invalid flag key/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("inserts a new global flag", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await upsertFlag({
      key: "adaptive.player.tap_toggle",
      value: true,
      updated_by: "userId:1",
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO sv_feature_flags");
    expect(sql).toContain("ON CONFLICT (key, scope, COALESCE(scope_id, ''))");
    expect(params?.[0]).toBe("adaptive.player.tap_toggle");
    expect(params?.[1]).toBe("global");
    expect(params?.[2]).toBeNull();
    expect(params?.[3]).toBe("true");
    expect(params?.[4]).toBe("userId:1");
  });

  it("supports user-scope upsert", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await upsertFlag({
      key: "adaptive.player.tap_toggle",
      value: false,
      scope: "user",
      scope_id: "42",
      updated_by: "userId:1",
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params?.[1]).toBe("user");
    expect(params?.[2]).toBe("42");
    expect(params?.[3]).toBe("false");
  });

  it("propagates DB errors", async () => {
    mockQuery.mockRejectedValueOnce(new Error("constraint violation") as never);

    await expect(
      upsertFlag({
        key: "adaptive.player.tap_toggle",
        value: true,
        updated_by: "test",
      }),
    ).rejects.toThrow(/constraint violation/);
  });
});
