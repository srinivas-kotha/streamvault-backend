import { Router, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { authMiddleware } from '../middleware/auth';
import { getProvider } from '../providers';

const router = Router();

const VALID_TYPES = ['live', 'vod', 'series'] as const;
type StreamType = (typeof VALID_TYPES)[number];

const UPSTREAM_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
const CONNECT_TIMEOUT_MS = 30_000;

/** Validate that an assembled URL targets the provider's allowed host (SSRF protection). */
function isAllowedUpstreamUrl(url: string, allowedHost: { hostname: string; port: string }): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === allowedHost.hostname && parsed.port === allowedHost.port;
  } catch {
    return false;
  }
}

/** Rewrite M3U8 playlist URLs to route through our segment proxy. */
function rewriteM3u8(text: string, baseUrl: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      // Absolute URL — strip base to get segment path
      if (trimmed.startsWith('http')) {
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
    .join('\n');
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
    const readable = Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>);
    req.on('close', () => {
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
router.get('/live/segment/*', authMiddleware, async (req: Request, res: Response) => {
  const segmentPath = req.params[0];

  // Path traversal + empty path protection
  if (!segmentPath || segmentPath.includes('..') || segmentPath.startsWith('/')) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid segment path',
    });
    return;
  }

  const provider = getProvider();
  const proxyInfo = provider.getSegmentProxyInfo(segmentPath);

  // SSRF protection: verify assembled URL targets our configured provider host
  if (!isAllowedUpstreamUrl(proxyInfo.url, proxyInfo.allowedHost)) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid segment path',
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  req.on('close', () => controller.abort());

  try {
    const upstream = await fetch(proxyInfo.url, {
      headers: proxyInfo.headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      res.status(upstream.status).json({
        error: 'Upstream Error',
        message: `Segment source returned ${upstream.status}`,
      });
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist = contentType.includes('mpegurl') || segmentPath.endsWith('.m3u8');

    if (isPlaylist) {
      const text = await upstream.text();
      const rewritten = rewriteM3u8(text, proxyInfo.baseUrl);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewritten);
    } else {
      pipeUpstream(upstream, req, res, controller, ['content-type', 'content-length']);
    }
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (!res.headersSent) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (!req.closed) {
          res.status(504).json({ error: 'Segment source timed out' });
        }
      } else {
        res.status(502).json({ error: 'Stream source unavailable' });
      }
    }
  }
});

// GET /api/stream/:type/:id — Server-side stream proxy (CORS-safe)
router.get('/:type/:id', authMiddleware, async (req: Request, res: Response) => {
  const { type, id } = req.params;

  if (!VALID_TYPES.includes(type as StreamType)) {
    res.status(400).json({
      error: 'Bad Request',
      message: `Invalid stream type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`,
    });
    return;
  }

  if (!id || !/^\d+$/.test(id)) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Stream ID must be a numeric value',
    });
    return;
  }

  const streamType = type as StreamType;
  const provider = getProvider();
  const proxyInfo = provider.getStreamProxyInfo(id, streamType);
  const isLive = streamType === 'live';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  req.on('close', () => controller.abort());

  try {
    const headers: Record<string, string> = { ...proxyInfo.headers };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const upstream = await fetch(proxyInfo.url, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      res.status(upstream.status).json({
        error: 'Upstream Error',
        message: `Stream source returned ${upstream.status}`,
      });
      return;
    }

    if (isLive) {
      // Live streams: transcode audio to AAC via FFmpeg (Chrome MSE doesn't support AC-3/MP2).
      // Video is passed through untouched — only audio is re-encoded.
      res.setHeader('X-Stream-Format', 'ts');
      res.setHeader('Content-Type', 'video/mp2t');

      const ffmpeg: ChildProcess = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',           // Read from stdin
        '-c:v', 'copy',           // Video passthrough (no re-encode)
        '-c:a', 'aac',            // Transcode audio to AAC
        '-b:a', '128k',           // Audio bitrate
        '-ac', '2',               // Stereo
        '-f', 'mpegts',           // Output as MPEG-TS
        'pipe:1',                 // Write to stdout
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      // Pipe upstream TS → FFmpeg stdin
      const upstreamReadable = Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>);
      upstreamReadable.pipe(ffmpeg.stdin!);

      // Handle stdin errors (e.g., FFmpeg exits before all input consumed)
      ffmpeg.stdin!.on('error', () => { /* expected when FFmpeg exits early */ });

      // Pipe FFmpeg stdout → client response
      ffmpeg.stdout!.pipe(res);

      // Log FFmpeg errors (don't crash)
      ffmpeg.stderr!.on('data', () => { /* suppress ffmpeg log spam */ });

      // Cleanup on client disconnect
      req.on('close', () => {
        controller.abort();
        upstreamReadable.destroy();
        ffmpeg.kill('SIGTERM');
      });

      // Cleanup if FFmpeg exits unexpectedly
      ffmpeg.on('close', () => {
        if (!res.writableEnded) res.end();
      });

      // Handle upstream read errors
      upstreamReadable.on('error', () => {
        ffmpeg.kill('SIGTERM');
        if (!res.writableEnded) res.end();
      });
    } else {
      // VOD/Series — pipe binary stream
      pipeUpstream(upstream, req, res, controller, UPSTREAM_HEADERS);
    }
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (!res.headersSent) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (!req.closed) {
          res.status(504).json({ error: 'Stream source timed out' });
        }
      } else {
        res.status(502).json({ error: 'Stream source unavailable' });
      }
    }
  }
});

export default router;
