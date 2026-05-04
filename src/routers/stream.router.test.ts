import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isOfflinePlaceholder, isContentUid } from "./stream.router";
import request from "supertest";
import express from "express";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks for content_uid routing tests
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../services/playback.service", () => ({
  resolveStreamUrl: vi.fn(),
  ContentNotFound: class ContentNotFound extends Error {
    constructor(uid: string) {
      super(`content_uid not in master: ${uid}`);
      this.name = "ContentNotFound";
    }
  },
  ContentDormant: class ContentDormant extends Error {
    uid: string;
    lastSeenProviderId?: string;
    constructor(uid: string, lastSeenProviderId?: string) {
      super(`content not on active provider: ${uid}`);
      this.name = "ContentDormant";
      this.uid = uid;
      this.lastSeenProviderId = lastSeenProviderId;
    }
  },
}));

vi.mock("../services/db.service", () => ({
  query: vi.fn(),
}));

vi.mock("../config", () => ({
  ACTIVE_PROVIDER_ID: "xtream:8027e2a2",
  config: {
    xtream: { host: "localhost", port: 80, username: "test", password: "test" },
  },
}));

vi.mock("../middleware/auth", () => ({
  authMiddleware: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../providers", () => ({
  getProvider: () => ({
    getStreamInfo: vi.fn().mockReturnValue({
      url: "http://provider.example/live/u/p/1234.ts",
      format: "ts",
      headers: {},
      allowedHosts: [{ hostname: "provider.example", port: "80" }],
    }),
  }),
}));

vi.mock("../services/vod-flight.service", () => ({
  getOrFetchVodRange: vi.fn(),
  releaseVodRange: vi.fn(),
}));

// Import the router and mocked modules AFTER vi.mock declarations
import streamRouter from "./stream.router";
import { resolveStreamUrl } from "../services/playback.service";
import { query as dbQuery } from "../services/db.service";

const mockResolveStreamUrl = vi.mocked(resolveStreamUrl);
vi.mocked(dbQuery); // imported for mock side-effect; not directly used in assertions

function fakeResponse({
  url = "http://edge.example/live/u/p/1.ts",
  contentType = "video/mp2t",
  contentLength,
}: {
  url?: string;
  contentType?: string;
  contentLength?: string;
} = {}): globalThis.Response {
  const headers: Record<string, string> = { "content-type": contentType };
  if (contentLength) headers["content-length"] = contentLength;
  return {
    url,
    headers: {
      get: (name: string) =>
        headers[name.toLowerCase()] ?? headers[name] ?? null,
    },
  } as unknown as globalThis.Response;
}

describe("isOfflinePlaceholder", () => {
  // ── Signals that fire for every stream type ──────────────────────────────
  describe("URL host pattern (any stream type)", () => {
    it("flags the cloudflarestorage offline bucket URL", () => {
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            url: "https://abc.r2.cloudflarestorage.com/slappy/john_off.ts?X-Amz-Signature=foo",
            contentType: "text/vnd.trolltech.linguist; charset=utf-8",
            contentLength: "6148352",
          }),
          true,
        ),
      ).toBe(true);
    });

    it("flags 162.249.127.* placeholder host (live)", () => {
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            url: "http://162.249.127.41/live/U/P/8.ts?token=foo",
            contentType: "video/mp2t",
            contentLength: "12878432",
          }),
          true,
        ),
      ).toBe(true);
    });

    it("flags Cloudflare IPv6 placeholder host on a series episode", () => {
      // Observed 2026-04-28: Jagadhatri/5468 episode 633480 redirected here
      // and was streaming an FFmpeg-Service splash file as the "episode".
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            url: "http://[2606:4700:2ff9::1]/series/U/P/633480.mp4?token=bar",
            contentType: "video/mp4",
            contentLength: "6148352",
          }),
          false, // series, not live
        ),
      ).toBe(true);
    });

    it("flags Cloudflare IPv6 placeholder host on VOD", () => {
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            url: "http://[2606:4700:2ff9::1]/movie/U/P/385215.mp4",
            contentType: "video/mp4",
            contentLength: "6148352",
          }),
          false,
        ),
      ).toBe(true);
    });
  });

  describe("Content-Type signal (any stream type)", () => {
    it("flags trolltech.linguist content-type alone (live)", () => {
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            url: "http://edge.example/live/U/P/1.ts",
            contentType: "text/vnd.trolltech.linguist; charset=utf-8",
          }),
          true,
        ),
      ).toBe(true);
    });

    it("flags trolltech.linguist content-type on a series episode", () => {
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            url: "http://random-edge.example/series/U/P/123.mp4",
            contentType: "text/vnd.trolltech.linguist",
          }),
          false,
        ),
      ).toBe(true);
    });
  });

  describe("Live-only signal: any Content-Length", () => {
    it("flags exact 6148352 content-length (legacy R2 placeholder)", () => {
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            url: "http://edge.example/live/U/P/1.ts",
            contentType: "application/octet-stream",
            contentLength: "6148352",
          }),
          true,
        ),
      ).toBe(true);
    });

    it("flags any other finite content-length on a live response", () => {
      // Real live is always chunked; any size is a placeholder variant.
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            contentType: "video/mp2t",
            contentLength: "9781248",
          }),
          true,
        ),
      ).toBe(true);
    });

    it("does NOT flag a content-length on a VOD or series response", () => {
      // Real VOD and series legitimately have Content-Length set; the
      // live-only heuristic must not false-positive on them.
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            url: "http://172.110.220.245/series/U/P/193083.mp4?token=abc",
            contentType: "video/mp4",
            contentLength: "524288000", // 500 MB episode
          }),
          false,
        ),
      ).toBe(false);

      expect(
        isOfflinePlaceholder(
          fakeResponse({
            url: "http://172.110.220.245/movie/U/P/385215.mp4?token=abc",
            contentType: "video/mp4",
            contentLength: "2147483648", // 2 GB movie
          }),
          false,
        ),
      ).toBe(false);
    });
  });

  describe("Negative cases", () => {
    it("does not flag a healthy MPEG-TS stream (chunked, no content-length)", () => {
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            url: "http://181.233.124.167/live/U/P/380447.ts?token=abc",
            contentType: "video/mp2t",
          }),
          true,
        ),
      ).toBe(false);
    });

    it("does not flag a healthy series episode (real CDN host, valid CT)", () => {
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            url: "http://172.110.220.98/series/U/P/197222.mp4?token=abc",
            contentType: "video/mp4",
            contentLength: "419430400",
          }),
          false,
        ),
      ).toBe(false);
    });

    it("does not flag healthy live with chunked encoding (no content-length)", () => {
      expect(
        isOfflinePlaceholder(
          fakeResponse({ url: "http://edge.example/live/U/P/1.ts" }),
          true,
        ),
      ).toBe(false);
    });

    it("does not flag empty-string content-length (treats as absent)", () => {
      expect(
        isOfflinePlaceholder(
          fakeResponse({
            contentType: "video/mp2t",
            contentLength: "",
          }),
          true,
        ),
      ).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isContentUid discriminator
// ─────────────────────────────────────────────────────────────────────────────

describe("isContentUid", () => {
  it("returns true for a 16-char lowercase hex string", () => {
    expect(isContentUid("abcd1234abcd1234")).toBe(true);
    expect(isContentUid("0000000000000000")).toBe(true);
    expect(isContentUid("ffffffffffffffff")).toBe(true);
  });

  it("returns false for numeric stream IDs", () => {
    expect(isContentUid("12345")).toBe(false);
    expect(isContentUid("99999999")).toBe(false);
  });

  it("returns false for uppercase hex (content_uids are lowercase)", () => {
    expect(isContentUid("ABCD1234ABCD1234")).toBe(false);
  });

  it("returns false for strings shorter or longer than 16 chars", () => {
    expect(isContentUid("abcd1234abcd123")).toBe(false); // 15 chars
    expect(isContentUid("abcd1234abcd12345")).toBe(false); // 17 chars
  });

  it("returns false for empty string", () => {
    expect(isContentUid("")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream router — content_uid routing with feature flag
// ─────────────────────────────────────────────────────────────────────────────

function makeStreamApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/stream", streamRouter);
  return app;
}

describe("stream router — content_uid routing", () => {
  const app = makeStreamApp();

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SV_USE_CONTENT_UID;
  });

  afterEach(() => {
    delete process.env.SV_USE_CONTENT_UID;
  });

  it("routes to resolveStreamUrl when id matches isContentUid pattern", async () => {
    const fakeStream = {
      url: "http://provider.example/live/u/p/1.ts",
      format: "ts",
      headers: {},
      allowedHosts: [{ hostname: "provider.example", port: "80" }],
    };
    mockResolveStreamUrl.mockResolvedValueOnce(fakeStream);

    // Mock fetch to avoid network call in test — return a minimal response
    const fakeUpstreamResponse = {
      ok: true,
      status: 200,
      url: "http://provider.example/live/u/p/1.ts",
      headers: { get: () => null },
      body: null,
    };
    global.fetch = vi.fn().mockResolvedValueOnce(fakeUpstreamResponse);

    await request(app).get("/api/stream/live/abcd1234abcd1234");

    // resolveStreamUrl was called (not legacy provider.getStreamInfo)
    expect(mockResolveStreamUrl).toHaveBeenCalledWith(
      "abcd1234abcd1234",
      undefined,
    );
  });

  it("returns 410 with DORMANT error when ContentDormant is thrown", async () => {
    const { ContentDormant } = await import("../services/playback.service");
    mockResolveStreamUrl.mockRejectedValueOnce(
      new ContentDormant("abcd1234abcd1234", "xtream:old"),
    );

    const res = await request(app).get("/api/stream/live/abcd1234abcd1234");

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("DORMANT");
    expect(res.body.content_uid).toBe("abcd1234abcd1234");
    expect(res.body.message).toBeTruthy();
  });

  it("returns 404 with NOT_FOUND error when ContentNotFound is thrown", async () => {
    const { ContentNotFound } = await import("../services/playback.service");
    mockResolveStreamUrl.mockRejectedValueOnce(
      new ContentNotFound("deadbeef00000000"),
    );

    const res = await request(app).get("/api/stream/live/deadbeef00000000");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });

  it("uses legacy path for numeric id when SV_USE_CONTENT_UID is off", async () => {
    // Numeric id — should NOT call resolveStreamUrl
    const fakeUpstreamResponse = {
      ok: true,
      status: 200,
      url: "http://provider.example/live/u/p/12345.ts",
      headers: { get: () => null },
      body: null,
    };
    global.fetch = vi.fn().mockResolvedValueOnce(fakeUpstreamResponse);

    // flag is off (default)
    await request(app).get("/api/stream/live/12345");

    // resolveStreamUrl NOT called
    expect(mockResolveStreamUrl).not.toHaveBeenCalled();
  });
});
