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

  // ── Type mapping: master.content_type → provider ContentType ──────────────

  it("maps master.content_type 'movie' to provider type 'vod' (regression: 'movie' would default to undefined ext)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ item_id: "389052" }] })
      .mockResolvedValueOnce({ rows: [{ content_type: "movie" }] });
    mockGetStreamInfo.mockReturnValue(FAKE_STREAM_INFO);

    await resolveStreamUrl("f5cdcbb17723aae0");

    expect(mockGetStreamInfo).toHaveBeenCalledWith("389052", "vod", undefined);
  });

  it("maps master.content_type 'episode' to provider type 'series'", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ item_id: "12345" }] })
      .mockResolvedValueOnce({ rows: [{ content_type: "episode" }] });
    mockGetStreamInfo.mockReturnValue(FAKE_STREAM_INFO);

    await resolveStreamUrl("abcd1234abcd1234");

    expect(mockGetStreamInfo).toHaveBeenCalledWith(
      "12345",
      "series",
      undefined,
    );
  });

  it("passes 'live' through unchanged", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ item_id: "55" }] })
      .mockResolvedValueOnce({ rows: [{ content_type: "live" }] });
    mockGetStreamInfo.mockReturnValue(FAKE_STREAM_INFO);

    await resolveStreamUrl("aaaa1111bbbb2222");

    expect(mockGetStreamInfo).toHaveBeenCalledWith("55", "live", undefined);
  });

  it("falls back to 'vod' when master row is missing content_type (defensive)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ item_id: "777" }] })
      .mockResolvedValueOnce({ rows: [] }); // master row vanished between queries
    mockGetStreamInfo.mockReturnValue(FAKE_STREAM_INFO);

    await resolveStreamUrl("aaaa1111bbbb2222");

    // default "movie" → mapped to "vod"
    expect(mockGetStreamInfo).toHaveBeenCalledWith("777", "vod", undefined);
  });

  // ── container_extension from provider_map.raw_data ────────────────────────

  it("uses container_extension from provider_map raw_data when caller provides no ext (regression: 42% mkv movies were 0-byte under .mp4 default)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ item_id: "741309", container_extension: "mkv" }],
      })
      .mockResolvedValueOnce({ rows: [{ content_type: "movie" }] });
    mockGetStreamInfo.mockReturnValue(FAKE_STREAM_INFO);

    await resolveStreamUrl("e158cd61b78b25c6");

    expect(mockGetStreamInfo).toHaveBeenCalledWith("741309", "vod", "mkv");
  });

  it("caller-provided ext beats container_extension from raw_data", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ item_id: "100", container_extension: "mkv" }],
      })
      .mockResolvedValueOnce({ rows: [{ content_type: "movie" }] });
    mockGetStreamInfo.mockReturnValue(FAKE_STREAM_INFO);

    await resolveStreamUrl("aaaa1111bbbb2222", "mp4");

    expect(mockGetStreamInfo).toHaveBeenCalledWith("100", "vod", "mp4");
  });

  it("falls back to undefined ext when container_extension is null", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ item_id: "200", container_extension: null }],
      })
      .mockResolvedValueOnce({ rows: [{ content_type: "movie" }] });
    mockGetStreamInfo.mockReturnValue(FAKE_STREAM_INFO);

    await resolveStreamUrl("bbbb2222cccc3333");

    expect(mockGetStreamInfo).toHaveBeenCalledWith("200", "vod", undefined);
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
