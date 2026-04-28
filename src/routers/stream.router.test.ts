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
  it("flags the cloudflarestorage offline bucket URL", () => {
    expect(
      isOfflinePlaceholder(
        fakeResponse({
          url: "https://abc.r2.cloudflarestorage.com/slappy/john_off.ts?X-Amz-Signature=foo",
          contentType: "text/vnd.trolltech.linguist; charset=utf-8",
          contentLength: "6148352",
        }),
      ),
    ).toBe(true);
  });

  it("flags trolltech.linguist content-type alone", () => {
    expect(
      isOfflinePlaceholder(
        fakeResponse({
          url: "http://edge.example/live/U/P/1.ts",
          contentType: "text/vnd.trolltech.linguist; charset=utf-8",
        }),
      ),
    ).toBe(true);
  });

  it("flags exact 6148352 content-length (legacy R2 placeholder)", () => {
    expect(
      isOfflinePlaceholder(
        fakeResponse({
          url: "http://edge.example/live/U/P/1.ts",
          contentType: "application/octet-stream",
          contentLength: "6148352",
        }),
      ),
    ).toBe(true);
  });

  it("flags 12878432 content-length (162.x nginx placeholder, observed 2026-04-28)", () => {
    expect(
      isOfflinePlaceholder(
        fakeResponse({
          url: "http://162.249.127.41/live/U/P/8.ts?token=foo",
          contentType: "video/mp2t",
          contentLength: "12878432",
        }),
      ),
    ).toBe(true);
  });

  it("flags any other finite content-length on a live response", () => {
    // Caller already gates on isLive; real live is always chunked, so any
    // length is a placeholder of some variant.
    expect(
      isOfflinePlaceholder(
        fakeResponse({
          contentType: "video/mp2t",
          contentLength: "9781248",
        }),
      ),
    ).toBe(true);
  });

  it("does not flag a healthy MPEG-TS stream (chunked, no content-length)", () => {
    expect(
      isOfflinePlaceholder(
        fakeResponse({
          url: "http://181.233.124.167/live/U/P/380447.ts?token=abc",
          contentType: "video/mp2t",
        }),
      ),
    ).toBe(false);
  });

  it("does not flag healthy stream just because it has chunked encoding (no content-length)", () => {
    expect(
      isOfflinePlaceholder(
        fakeResponse({ url: "http://edge.example/live/U/P/1.ts" }),
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
      ),
    ).toBe(false);
  });
});
