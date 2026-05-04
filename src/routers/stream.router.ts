import { Router, Request, Response } from "express";
import { Readable } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { authMiddleware } from "../middleware/auth";
import { getProvider } from "../providers";
import {
  getOrFetchVodRange,
  releaseVodRange,
} from "../services/vod-flight.service";
import {
  resolveStreamUrl,
  ContentDormant,
  ContentNotFound,
} from "../services/playback.service";
import { query } from "../services/db.service";
import { ACTIVE_PROVIDER_ID } from "../config";
import type { StreamInfo } from "../providers/provider.types";

/**
 * Discriminates a content_uid from a legacy numeric item_id.
 * content_uid is always exactly 16 lowercase hex characters (CHAR(16), sha1[:16]).
 */
export const isContentUid = (id: string): boolean => /^[a-f0-9]{16}$/.test(id);

const router = Router();

const VALID_TYPES = ["live", "vod", "series"] as const;
type StreamType = (typeof VALID_TYPES)[number];

const UPSTREAM_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
];
const CONNECT_TIMEOUT_MS = 30_000;

const CONTENT_TYPE_MAP: Record<string, string> = {
  ts: "video/mp2t",
  mp4: "video/mp4",
  m3u8: "application/vnd.apple.mpegurl",
  rtmp: "video/x-flv",
  unknown: "application/octet-stream",
};

/**
 * Detect Xtream's "channel/episode offline" placeholder.
 *
 * When a stream is unavailable upstream, the provider 302-redirects the
 * `.ts`/`.mp4` request to a static file that loops an "FFmpeg Service"
 * splash. Because fetch() follows redirects transparently, the backend would
 * otherwise stream those placeholder bytes through FFmpeg/the pipe as if
 * the stream were healthy — the player shows the splash for a few seconds,
 * then the connection closes and playback stalls. From the user's
 * perspective, the spinner spins forever.
 *
 * 2026-04-28 sweep confirmed the same placeholder pattern hits VOD and
 * series episodes — not just live channels (sample: Jagadhatri series 5468
 * had 2/10 random episodes redirected to the Cloudflare IPv6 placeholder).
 * So this check now applies to every stream type. The set of signals is
 * tailored per-type — the content-length one is live-only because real VOD
 * legitimately has Content-Length.
 *
 * Signals:
 *  - URL host (any stream type): three known placeholder hosts spotted in
 *    prod traffic. Real CDN edges (172.110.220.x, 195.211.191.x,
 *    103.161.34.x, 181.233.124.x) are NOT in this list.
 *      • cloudflarestorage.com + slappy/john_off — legacy R2 bucket
 *      • 162.249.127.* — nginx placeholder edge for live channels
 *      • [2606:4700:2ff9:* — Cloudflare IPv6 placeholder (live + series)
 *  - Content-Type `text/vnd.trolltech.linguist` (any stream type) — the
 *    placeholder file's distinctive misconfigured CT.
 *  - LIVE only: any Content-Length header is offline by elimination —
 *    real upstream live is always chunked. Real VOD/series legitimately
 *    have Content-Length set, so we don't apply this to them.
 *
 * Returning early with 503 lets the frontend render a clear "offline"
 * overlay instead of buffering on a placeholder loop.
 */
export function isOfflinePlaceholder(
  upstream: globalThis.Response,
  isLive: boolean,
): boolean {
  const finalUrl = upstream.url || "";
  if (
    finalUrl.includes("cloudflarestorage.com") &&
    finalUrl.includes("slappy/john_off")
  ) {
    return true;
  }
  if (finalUrl.includes("162.249.127.")) {
    return true;
  }
  if (finalUrl.includes("[2606:4700:2ff9:")) {
    return true;
  }
  const ct = upstream.headers.get("content-type") || "";
  if (ct.toLowerCase().includes("trolltech.linguist")) {
    return true;
  }
  if (isLive) {
    const cl = upstream.headers.get("content-length");
    if (cl !== null && cl !== "") {
      return true;
    }
  }
  return false;
}

/** Validate that an assembled URL targets one of the provider's allowed hosts (SSRF protection). */
function isAllowedUpstreamUrl(
  url: string,
  allowedHosts: Array<{ hostname: string; port: string }>,
): boolean {
  try {
    const parsed = new URL(url);
    // new URL().port returns "" for default ports (80/443) — normalize
    const effectivePort =
      parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return allowedHosts.some(
      (h) => parsed.hostname === h.hostname && effectivePort === h.port,
    );
  } catch {
    return false;
  }
}

/** Validate that an assembled URL targets a single allowed host (used by segment proxy). */
function isAllowedUpstreamUrlSingle(
  url: string,
  allowedHost: { hostname: string; port: string },
): boolean {
  return isAllowedUpstreamUrl(url, [allowedHost]);
}

/** Rewrite M3U8 playlist URLs to route through our segment proxy. */
function rewriteM3u8(text: string, baseUrl: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;

      // Absolute URL — strip base to get segment path
      if (trimmed.startsWith("http")) {
        if (trimmed.startsWith(baseUrl)) {
          const segmentPath = trimmed.slice(baseUrl.length);
          return `/api/stream/live/segment/${segmentPath}`;
        }
        // Non-matching absolute URL (CDN, different host) — skip rewriting, leave as-is
        // HLS.js will fetch it directly; this is intentional for CDN-backed providers
        return line;
      }

      // Relative URL — prefix with segment proxy
      return `/api/stream/live/segment/${trimmed}`;
    })
    .join("\n");
}

/** Pipe upstream body to response, with cleanup on client disconnect. */
function pipeUpstream(
  upstream: globalThis.Response,
  req: Request,
  res: Response,
  controller: AbortController,
  headersToForward: string[],
): void {
  res.status(upstream.status);
  for (const header of headersToForward) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }

  if (upstream.body) {
    const readable = Readable.fromWeb(
      upstream.body as ReadableStream<Uint8Array>,
    );
    req.on("close", () => {
      controller.abort();
      readable.destroy();
    });
    readable.pipe(res);
  } else {
    res.end();
  }
}

// IMPORTANT: Segment route MUST be registered before /:type/:id to avoid being caught by the wildcard
// GET /api/stream/live/segment/* — HLS segment proxy
router.get(
  "/live/segment/*",
  authMiddleware,
  async (req: Request, res: Response) => {
    const segmentPath = req.params[0];

    // Path traversal + empty path protection
    if (
      !segmentPath ||
      segmentPath.includes("..") ||
      segmentPath.startsWith("/")
    ) {
      res.status(400).json({
        error: "Bad Request",
        message: "Invalid segment path",
      });
      return;
    }

    const provider = getProvider();
    const proxyInfo = provider.getSegmentProxyInfo(segmentPath);

    // SSRF protection: verify assembled URL targets our configured provider host
    if (!isAllowedUpstreamUrlSingle(proxyInfo.url, proxyInfo.allowedHost)) {
      res.status(400).json({
        error: "Bad Request",
        message: "Invalid segment path",
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

    req.on("close", () => controller.abort());

    try {
      const upstream = await fetch(proxyInfo.url, {
        headers: proxyInfo.headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!upstream.ok) {
        res.status(upstream.status).json({
          error: "Upstream Error",
          message: `Segment source returned ${upstream.status}`,
        });
        return;
      }

      const contentType = upstream.headers.get("content-type") || "";
      const isPlaylist =
        contentType.includes("mpegurl") || segmentPath.endsWith(".m3u8");

      if (isPlaylist) {
        const text = await upstream.text();
        const rewritten = rewriteM3u8(text, proxyInfo.baseUrl);
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.send(rewritten);
      } else {
        pipeUpstream(upstream, req, res, controller, [
          "content-type",
          "content-length",
        ]);
      }
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (!res.headersSent) {
        if (err instanceof Error && err.name === "AbortError") {
          if (!req.closed) {
            res.status(504).json({ error: "Segment source timed out" });
          }
        } else {
          res.status(502).json({ error: "Stream source unavailable" });
        }
      }
    }
  },
);

// GET /api/stream/:type/:id — Server-side stream proxy (CORS-safe)
router.get(
  "/:type/:id",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { type, id } = req.params;

    if (!VALID_TYPES.includes(type as StreamType)) {
      res.status(400).json({
        error: "Bad Request",
        message: `Invalid stream type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`,
      });
      return;
    }

    // Accept both content_uid (16-char hex) and legacy numeric IDs
    if (!id || (!isContentUid(id) && !/^\d+$/.test(id))) {
      res.status(400).json({
        error: "Bad Request",
        message: "Stream ID must be a numeric value or a 16-char content_uid",
      });
      return;
    }

    const streamType = type as StreamType;
    // Sanitize ext to prevent path traversal / query injection on upstream URL
    const ALLOWED_EXTENSIONS = new Set([
      "ts",
      "mp4",
      "m3u8",
      "mkv",
      "avi",
      "flv",
    ]);
    const rawExt =
      typeof req.query.ext === "string" ? req.query.ext : undefined;
    const ext = rawExt && ALLOWED_EXTENSIONS.has(rawExt) ? rawExt : undefined;

    // ── Phase 3: content_uid dispatch ────────────────────────────────────────
    // Resolve StreamInfo via the content-identity layer when:
    //   (a) id is a content_uid — always use new path regardless of flag
    //   (b) SV_USE_CONTENT_UID=1 and id is numeric — translate via provider_map
    // Otherwise fall through to the legacy provider.getStreamInfo() path.
    let streamInfo: StreamInfo;
    try {
      if (isContentUid(id)) {
        streamInfo = await resolveStreamUrl(id, ext);
      } else if (process.env.SV_USE_CONTENT_UID === "1") {
        // Translate legacy numeric item_id → content_uid via provider_map
        const mapRow = await query<{ content_uid: string }>(
          `SELECT content_uid
             FROM sv_content_provider_map
            WHERE provider_id = $1
              AND item_id = $2`,
          [ACTIVE_PROVIDER_ID, id],
        );
        if (!mapRow.rows[0]) {
          throw new ContentNotFound(id);
        }
        streamInfo = await resolveStreamUrl(mapRow.rows[0].content_uid, ext);
      } else {
        // Legacy path (unchanged) — direct provider call
        const provider = getProvider();
        streamInfo = provider.getStreamInfo(id, streamType, ext);
      }
    } catch (e) {
      if (e instanceof ContentDormant) {
        res.status(410).json({
          error: "DORMANT",
          content_uid: e.uid,
          message: "Title not on current provider",
        });
        return;
      }
      if (e instanceof ContentNotFound) {
        res.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      throw e;
    }

    const isLive = streamType === "live";

    // SSRF protection: verify the assembled URL targets the provider's allowed hosts
    if (!isAllowedUpstreamUrl(streamInfo.url, streamInfo.allowedHosts)) {
      res.status(400).json({
        error: "Bad Request",
        message: "Invalid stream target",
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

    req.on("close", () => controller.abort());

    try {
      const headers: Record<string, string> = { ...streamInfo.headers };
      if (req.headers.range) {
        headers["Range"] = req.headers.range;
      }

      // VOD/series go through single-flight dedup (vod-flight.service).
      // Live MUST stay on the bare fetch path — sharing live streams via
      // Response.clone() would corrupt the FFmpeg pipeline. See vod-flight.
      let upstream: globalThis.Response;
      if (isLive) {
        upstream = await fetch(streamInfo.url, {
          headers,
          signal: controller.signal,
        });
      } else {
        const range =
          typeof req.headers.range === "string" ? req.headers.range : undefined;
        const flight = await getOrFetchVodRange(
          streamInfo.url,
          streamInfo.headers,
          range,
        );
        upstream = flight.response;
        // Release on disconnect — refs drop to zero only when every
        // subscriber has detached, then the upstream fetch is aborted.
        req.on("close", () => releaseVodRange(flight.key));
      }
      clearTimeout(timeout);

      if (!upstream.ok) {
        res.status(upstream.status).json({
          error: "Upstream Error",
          message: `Stream source returned ${upstream.status}`,
        });
        return;
      }

      // Offline guard. Provider redirects unavailable streams to an "FFmpeg
      // Service" splash file regardless of stream type. Originally enforced
      // for live only; 2026-04-28 traffic sample confirmed VOD/series episodes
      // (e.g. Jagadhatri/5468) hit the same placeholder via Cloudflare IPv6,
      // so the gate now applies to every type. 503 + X-Stream-Status lets the
      // frontend show a clear "offline" overlay instead of spinning forever
      // on a doomed pipe.
      if (isOfflinePlaceholder(upstream, isLive)) {
        res.setHeader("X-Stream-Status", "offline");
        res.status(503).json({
          error: isLive ? "Channel Offline" : "Stream Offline",
          message: isLive
            ? "This channel is offline upstream. Try a different channel."
            : "This title is offline upstream. Try another episode or title.",
        });
        return;
      }

      if (isLive) {
        // Live streams: transcode audio to AAC via FFmpeg (Chrome MSE doesn't support AC-3/MP2).
        // Video is passed through untouched — only audio is re-encoded.
        const liveContentType =
          CONTENT_TYPE_MAP[streamInfo.format] ?? CONTENT_TYPE_MAP["unknown"];
        res.setHeader("X-Stream-Format", streamInfo.format);
        res.setHeader("Content-Type", liveContentType);

        const ffmpeg: ChildProcess = spawn(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0", // Read from stdin
            "-c:v",
            "copy", // Video passthrough (no re-encode)
            "-c:a",
            "aac", // Transcode audio to AAC
            "-b:a",
            "128k", // Audio bitrate
            "-ac",
            "2", // Stereo
            "-f",
            "mpegts", // Output as MPEG-TS
            "pipe:1", // Write to stdout
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );

        // Pipe upstream TS → FFmpeg stdin
        const upstreamReadable = Readable.fromWeb(
          upstream.body as ReadableStream<Uint8Array>,
        );
        upstreamReadable.pipe(ffmpeg.stdin!);

        // Handle stdin errors (e.g., FFmpeg exits before all input consumed)
        ffmpeg.stdin!.on("error", () => {
          /* expected when FFmpeg exits early */
        });

        // Pipe FFmpeg stdout → client response
        ffmpeg.stdout!.pipe(res);

        // Log FFmpeg errors (don't crash)
        ffmpeg.stderr!.on("data", () => {
          /* suppress ffmpeg log spam */
        });

        // Cleanup on client disconnect
        req.on("close", () => {
          controller.abort();
          upstreamReadable.destroy();
          ffmpeg.kill("SIGTERM");
        });

        // Cleanup if FFmpeg exits unexpectedly
        ffmpeg.on("close", () => {
          if (!res.writableEnded) res.end();
        });

        // Handle upstream read errors
        upstreamReadable.on("error", () => {
          ffmpeg.kill("SIGTERM");
          if (!res.writableEnded) res.end();
        });
      } else {
        // VOD/Series — pipe binary stream
        pipeUpstream(upstream, req, res, controller, UPSTREAM_HEADERS);
      }
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (!res.headersSent) {
        if (err instanceof Error && err.name === "AbortError") {
          if (!req.closed) {
            res.status(504).json({ error: "Stream source timed out" });
          }
        } else {
          res.status(502).json({ error: "Stream source unavailable" });
        }
      }
    }
  },
);

export default router;
