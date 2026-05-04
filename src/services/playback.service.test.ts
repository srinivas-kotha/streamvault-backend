/**
 * playback.service.test.ts — TDD tests for resolveStreamUrl
 *
 * Phase 3 — content-identity read-side cutover.
 * Tests written BEFORE implementation per TDD red-green-refactor.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamInfo } from "../providers/provider.types";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

// Mock db.service so tests don't need a real Postgres connection.
const mockQuery = vi.fn();
vi.mock("../services/db.service", () => ({
  query: mockQuery,
}));

// Mock config so ACTIVE_PROVIDER_ID is deterministic.
vi.mock("../config", () => ({
  ACTIVE_PROVIDER_ID: "xtream:8027e2a2",
  config: {
    xtream: { host: "localhost", port: 80, username: "test", password: "test" },
  },
}));

// Mock provider factory — we just need getStreamInfo to return a StreamInfo.
const mockGetStreamInfo = vi.fn();
vi.mock("../providers", () => ({
  getProvider: () => ({
    getStreamInfo: mockGetStreamInfo,
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Import after mocks are set up
// ─────────────────────────────────────────────────────────────────────────────

const { resolveStreamUrl, ContentNotFound, ContentDormant } =
  await import("./playback.service");

const FAKE_STREAM_INFO: StreamInfo = {
  url: "http://provider.example/live/u/p/1234.ts",
  format: "ts",
  headers: { "User-Agent": "StreamVault/1.0" },
  allowedHosts: [{ hostname: "provider.example", port: "80" }],
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveStreamUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Path 1: happy path — master found + provider_map found ─────────────────

  it("returns StreamInfo when master row and provider_map row both exist", async () => {
    // First query: sv_content_provider_map lookup
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ item_id: "9876", content_type: "live" }],
      })
      // Second query: sv_content_master lookup for content_type
      .mockResolvedValueOnce({
        rows: [{ content_type: "live" }],
      });

    mockGetStreamInfo.mockReturnValue(FAKE_STREAM_INFO);

    const result = await resolveStreamUrl("abcd1234abcd1234");

    expect(result).toEqual(FAKE_STREAM_INFO);
    expect(mockGetStreamInfo).toHaveBeenCalledWith("9876", "live", undefined);
  });

  // ── Path 2: master exists, no provider_map row → ContentDormant ───────────

  it("throws ContentDormant when master exists but no provider_map row for active provider", async () => {
    // provider_map query returns empty
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      // master query returns a row
      .mockResolvedValueOnce({ rows: [{ content_type: "vod" }] })
      // lastSeenProviderId query — no other map rows
      .mockResolvedValueOnce({ rows: [] });

    await expect(resolveStreamUrl("abcd1234abcd1234")).rejects.toBeInstanceOf(
      ContentDormant,
    );
  });

  it("ContentDormant includes lastSeenProviderId when another provider_map row exists", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no active provider row
      .mockResolvedValueOnce({ rows: [{ content_type: "vod" }] }) // master exists
      .mockResolvedValueOnce({
        rows: [{ provider_id: "xtream:olddead00" }],
      }); // another map row

    try {
      await resolveStreamUrl("abcd1234abcd1234");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContentDormant);
      const e = err as InstanceType<typeof ContentDormant>;
      expect(e.uid).toBe("abcd1234abcd1234");
      expect(e.lastSeenProviderId).toBe("xtream:olddead00");
    }
  });

  // ── Path 3: no master row → ContentNotFound ───────────────────────────────

  it("throws ContentNotFound when content_uid is not in sv_content_master", async () => {
    // provider_map empty (triggers master check path)
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no provider_map row
      .mockResolvedValueOnce({ rows: [] }); // no master row

    await expect(resolveStreamUrl("deadbeef00000000")).rejects.toBeInstanceOf(
      ContentNotFound,
    );
  });

  // ── Error class shapes ────────────────────────────────────────────────────

  it("ContentNotFound has the uid in the message", () => {
    const err = new ContentNotFound("abc123abc123abc1");
    expect(err.message).toContain("abc123abc123abc1");
    expect(err).toBeInstanceOf(Error);
  });

  it("ContentDormant exposes uid and optional lastSeenProviderId", () => {
    const err1 = new ContentDormant("abc123abc123abc1");
    expect(err1.uid).toBe("abc123abc123abc1");
    expect(err1.lastSeenProviderId).toBeUndefined();

    const err2 = new ContentDormant("abc123abc123abc1", "xtream:old");
    expect(err2.lastSeenProviderId).toBe("xtream:old");
  });
});
