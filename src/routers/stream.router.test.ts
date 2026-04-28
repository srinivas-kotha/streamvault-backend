import { describe, it, expect } from "vitest";
import { isOfflinePlaceholder } from "./stream.router";

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
        headers[name.toLowerCase()] ??
        headers[name] ??
        null,
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
