import { Router, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { authMiddleware } from '../middleware/auth';
import { config } from '../config';

const router = Router();

const VALID_TYPES = ['live', 'vod', 'series'] as const;
type StreamType = (typeof VALID_TYPES)[number];

const UPSTREAM_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
const USER_AGENT = 'IPTV Smarters Pro/2.2.2.1';
const CONNECT_TIMEOUT_MS = 30_000;

function getXtreamBase(): string {
  const { host, port, username, password } = config.xtream;
  return `http://${host}:${port}/live/${username}/${password}/`;
}

function buildXtreamUrl(type: StreamType, id: string, extOverride?: string): string {
  const { host, port, username, password } = config.xtream;

  const formatMap: Record<StreamType, { path: string; ext: string }> = {
    live: { path: 'live', ext: 'm3u8' },
    vod: { path: 'movie', ext: 'mp4' },
    series: { path: 'series', ext: 'mp4' },
  };

  const { path, ext } = formatMap[type];
  return `http://${host}:${port}/${path}/${username}/${password}/${id}.${extOverride || ext}`;
}

/** Validate that an assembled URL targets the configured Xtream host (SSRF protection). */
function isAllowedUpstreamUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === config.xtream.host && parsed.port === String(config.xtream.port);
  } catch {
    return false;
  }
}

/** Rewrite M3U8 playlist URLs to route through our segment proxy. */
function rewriteM3u8(text: string, xtreamBase: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      // Absolute URL from Xtream — strip base to get segment path
      if (trimmed.startsWith('http')) {
        if (trimmed.startsWith(xtreamBase)) {
          const segmentPath = trimmed.slice(xtreamBase.length);
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

  const { host, port, username, password } = config.xtream;
  const url = `http://${host}:${port}/live/${username}/${password}/${segmentPath}`;

  // SSRF protection: verify assembled URL targets our configured Xtream host
  if (!isAllowedUpstreamUrl(url)) {
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
    const upstream = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
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
      const rewritten = rewriteM3u8(text, getXtreamBase());
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
  const url = buildXtreamUrl(streamType, id);
  const isLive = streamType === 'live';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  req.on('close', () => controller.abort());

  try {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    let upstream = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // If M3U8 fails for live streams, fall back to raw .ts format
    let isTsFallback = false;
    if (!upstream.ok && isLive) {
      const tsUrl = buildXtreamUrl(streamType, id, 'ts');
      const tsController = new AbortController();
      const tsTimeout = setTimeout(() => tsController.abort(), CONNECT_TIMEOUT_MS);
      req.on('close', () => tsController.abort());

      upstream = await fetch(tsUrl, {
        headers,
        signal: tsController.signal,
      });
      clearTimeout(tsTimeout);
      isTsFallback = upstream.ok;

      if (!upstream.ok) {
        res.status(upstream.status).json({
          error: 'Upstream Error',
          message: `Stream source returned ${upstream.status}`,
        });
        return;
      }
    } else if (!upstream.ok) {
      res.status(upstream.status).json({
        error: 'Upstream Error',
        message: `Stream source returned ${upstream.status}`,
      });
      return;
    }

    if (isTsFallback) {
      // Raw TS stream — pipe directly
      res.setHeader('X-Stream-Format', 'ts');
      pipeUpstream(upstream, req, res, controller, UPSTREAM_HEADERS);
    } else if (isLive) {
      // Check content-type to determine stream format
      const contentType = upstream.headers.get('content-type') || '';
      const isM3u8ByType = contentType.includes('mpegurl');

      if (isM3u8ByType) {
        // HLS playlist (detected by content-type) — rewrite URLs
        const text = await upstream.text();
        const rewritten = rewriteM3u8(text, getXtreamBase());
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('X-Stream-Format', 'm3u8');
        res.send(rewritten);
      } else if (contentType.includes('text/') || contentType.includes('octet-stream') || !contentType) {
        // Ambiguous content-type — sniff first bytes to detect M3U8 vs binary
        const arrayBuf = await upstream.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        const prefix = buf.subarray(0, 7).toString('utf-8');

        if (prefix === '#EXTM3U') {
          const text = buf.toString('utf-8');
          const rewritten = rewriteM3u8(text, getXtreamBase());
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.setHeader('X-Stream-Format', 'm3u8');
          res.send(rewritten);
        } else {
          // Binary data with ambiguous content-type — pipe as TS
          res.setHeader('X-Stream-Format', 'ts');
          res.setHeader('Content-Type', 'video/mp2t');
          res.send(buf);
        }
      } else {
        // TS or other binary stream — pipe directly
        res.setHeader('X-Stream-Format', 'ts');
        pipeUpstream(upstream, req, res, controller, UPSTREAM_HEADERS);
      }
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

// HEAD /api/stream/:type/:id — Format probe (returns X-Stream-Format without body)
router.head('/:type/:id', authMiddleware, async (req: Request, res: Response) => {
  const { type, id } = req.params;

  if (!VALID_TYPES.includes(type as StreamType)) {
    res.status(400).end();
    return;
  }

  if (!id || !/^\d+$/.test(id)) {
    res.status(400).end();
    return;
  }

  const streamType = type as StreamType;

  if (streamType !== 'live') {
    res.setHeader('X-Stream-Format', 'mp4');
    res.status(200).end();
    return;
  }

  // Probe M3U8 first, fall back to TS
  // Use GET (not HEAD) — some Xtream servers reject HEAD with 405
  // Abort immediately after getting status to avoid downloading the stream
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  try {
    const url = buildXtreamUrl(streamType, id);
    const upstream = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    controller.abort(); // Kill the stream — we only needed the status

    if (upstream.ok) {
      res.setHeader('X-Stream-Format', 'm3u8');
      res.status(200).end();
      return;
    }

    // M3U8 failed — try TS
    const tsController = new AbortController();
    const tsTimeout = setTimeout(() => tsController.abort(), CONNECT_TIMEOUT_MS);

    const tsUpstream = await fetch(buildXtreamUrl(streamType, id, 'ts'), {
      headers: { 'User-Agent': USER_AGENT },
      signal: tsController.signal,
    });
    clearTimeout(tsTimeout);
    tsController.abort(); // Kill the stream

    if (tsUpstream.ok) {
      res.setHeader('X-Stream-Format', 'ts');
      res.status(200).end();
    } else {
      res.status(tsUpstream.status).end();
    }
  } catch {
    if (!res.headersSent) {
      res.status(502).end();
    }
  }
});

export default router;
