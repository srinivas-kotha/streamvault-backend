import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getOrFetchVodRange,
  releaseVodRange,
  __vodFlightSizeForTest,
  __vodFlightResetForTest,
} from "./vod-flight.service";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFakeResponse(body = "ok"): globalThis.Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("vod-flight.service", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __vodFlightResetForTest();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    __vodFlightResetForTest();
  });

  describe("dedup", () => {
    it("dedupes concurrent requests with the same url+range to a single fetch", async () => {
      const url = "https://upstream.example/vod/42.mp4";
      const range = "bytes=0-1023";
      let resolveFetch: (r: globalThis.Response) => void = () => {};
      fetchSpy.mockReturnValue(
        new Promise<globalThis.Response>((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const p1 = getOrFetchVodRange(url, {}, range);
      const p2 = getOrFetchVodRange(url, {}, range);
      const p3 = getOrFetchVodRange(url, {}, range);

      // Let the fetch resolve once — all three callers should pick it up.
      resolveFetch(makeFakeResponse("dedup-payload"));

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // Each caller gets its own clone; reading one doesn't drain another.
      expect(await r1.response.text()).toBe("dedup-payload");
      expect(await r2.response.text()).toBe("dedup-payload");
      expect(await r3.response.text()).toBe("dedup-payload");
    });

    it("different ranges trigger separate fetches", async () => {
      const url = "https://upstream.example/vod/42.mp4";
      fetchSpy.mockResolvedValue(makeFakeResponse());

      await Promise.all([
        getOrFetchVodRange(url, {}, "bytes=0-1023"),
        getOrFetchVodRange(url, {}, "bytes=1024-2047"),
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("different URLs trigger separate fetches", async () => {
      fetchSpy.mockResolvedValue(makeFakeResponse());

      await Promise.all([
        getOrFetchVodRange("https://upstream.example/vod/1.mp4", {}, undefined),
        getOrFetchVodRange("https://upstream.example/vod/2.mp4", {}, undefined),
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("undefined range is its own flight key (full-content fetch)", async () => {
      const url = "https://upstream.example/vod/42.mp4";
      fetchSpy.mockResolvedValue(makeFakeResponse());

      await Promise.all([
        getOrFetchVodRange(url, {}, undefined),
        getOrFetchVodRange(url, {}, undefined),
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Range header propagation", () => {
    it("passes the Range header through to upstream fetch", async () => {
      fetchSpy.mockResolvedValue(makeFakeResponse());
      await getOrFetchVodRange(
        "https://upstream.example/vod/42.mp4",
        { "User-Agent": "stream-test" },
        "bytes=512-1023",
      );
      const call = fetchSpy.mock.calls[0]!;
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Range"]).toBe("bytes=512-1023");
      expect(headers["User-Agent"]).toBe("stream-test");
    });

    it("does not set Range when caller passed undefined", async () => {
      fetchSpy.mockResolvedValue(makeFakeResponse());
      await getOrFetchVodRange("https://upstream.example/vod/42.mp4", {}, undefined);
      const call = fetchSpy.mock.calls[0]!;
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Range"]).toBeUndefined();
    });
  });

  describe("releaseVodRange", () => {
    it("evicts the entry when the last subscriber detaches", async () => {
      const url = "https://upstream.example/vod/42.mp4";
      fetchSpy.mockResolvedValue(makeFakeResponse());

      const f1 = await getOrFetchVodRange(url, {}, "bytes=0-100");
      const f2 = await getOrFetchVodRange(url, {}, "bytes=0-100");
      expect(__vodFlightSizeForTest()).toBe(1);

      releaseVodRange(f1.key);
      expect(__vodFlightSizeForTest()).toBe(1); // one subscriber still attached

      releaseVodRange(f2.key);
      expect(__vodFlightSizeForTest()).toBe(0); // last out — entry gone
    });

    it("releasing an unknown key is a no-op", () => {
      expect(() => releaseVodRange("does-not-exist|bytes=0-100")).not.toThrow();
    });
  });

  describe("error propagation", () => {
    it("propagates upstream fetch rejection to all concurrent callers", async () => {
      const url = "https://upstream.example/vod/42.mp4";
      fetchSpy.mockRejectedValue(new Error("upstream bombed"));

      const p1 = getOrFetchVodRange(url, {}, "bytes=0-100");
      const p2 = getOrFetchVodRange(url, {}, "bytes=0-100");

      await expect(p1).rejects.toThrow("upstream bombed");
      await expect(p2).rejects.toThrow("upstream bombed");
      // Map should be cleaned up after rejection.
      expect(__vodFlightSizeForTest()).toBe(0);
    });
  });
});
