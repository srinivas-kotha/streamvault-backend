import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { config } from '../config';

const router = Router();

const VALID_TYPES = ['live', 'vod', 'series'] as const;
type StreamType = (typeof VALID_TYPES)[number];

// GET /api/stream/url/:type/:id — construct stream URL for the frontend player
router.get('/url/:type/:id', authMiddleware, (req: Request, res: Response) => {
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

  const { host, port, username, password } = config.xtream;

  const formatMap: Record<StreamType, { path: string; ext: string; isLive: boolean }> = {
    live: { path: 'live', ext: 'm3u8', isLive: true },
    vod: { path: 'movie', ext: 'mp4', isLive: false },
    series: { path: 'series', ext: 'mp4', isLive: false },
  };

  const { path, ext, isLive } = formatMap[type as StreamType];
  const url = `http://${host}:${port}/${path}/${username}/${password}/${id}.${ext}`;

  res.json({ url, format: ext, isLive });
});

// Placeholder routes for future features
router.all('*', (_req: Request, res: Response) => {
  res.status(501).json({
    error: 'Not Implemented',
    message: 'Not implemented yet — coming in Phase 2/3',
  });
});

export default router;
