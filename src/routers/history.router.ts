import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { query } from '../services/db.service';
import { contentIdSchema, historyUpdateSchema } from '../utils/validators';
import type { DbWatchHistory } from '../types/db.types';

const router = Router();

// GET /api/history
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    const result = await query<DbWatchHistory>(
      'SELECT id, content_type, content_id, content_name, content_icon, progress_seconds, duration_seconds, watched_at FROM sv_watch_history WHERE user_id = $1 ORDER BY watched_at DESC LIMIT 50',
      [userId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[history] Failed to fetch history:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch watch history' });
  }
});

// PUT /api/history/:contentId
router.put('/:contentId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const paramsParsed = contentIdSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid content ID' });
      return;
    }

    const bodyParsed = historyUpdateSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: 'Bad Request', message: bodyParsed.error.errors[0].message });
      return;
    }

    const userId = req.user!.userId;
    const contentId = parseInt(paramsParsed.data.contentId, 10);
    const { content_type, content_name, content_icon, progress_seconds, duration_seconds } = bodyParsed.data;

    await query(
      `INSERT INTO sv_watch_history (user_id, content_type, content_id, content_name, content_icon, progress_seconds, duration_seconds, watched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, content_type, content_id) DO UPDATE SET
         progress_seconds = EXCLUDED.progress_seconds,
         duration_seconds = EXCLUDED.duration_seconds,
         content_name = COALESCE(EXCLUDED.content_name, sv_watch_history.content_name),
         content_icon = COALESCE(EXCLUDED.content_icon, sv_watch_history.content_icon),
         watched_at = NOW()`,
      [userId, content_type, contentId, content_name ?? null, content_icon ?? null, progress_seconds, duration_seconds],
    );

    res.json({ message: 'Watch history updated' });
  } catch (err) {
    console.error('[history] Failed to update history:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to update watch history' });
  }
});

// DELETE /api/history/:contentId?content_type=channel|vod|series
router.delete('/:contentId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const paramsParsed = contentIdSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid content ID' });
      return;
    }

    const contentType = req.query.content_type as string;
    const validContentTypes = ['channel', 'vod', 'series'];
    if (!contentType || !validContentTypes.includes(contentType)) {
      res.status(400).json({ error: 'Bad Request', message: 'content_type must be one of: channel, vod, series' });
      return;
    }

    const userId = req.user!.userId;
    const contentId = parseInt(paramsParsed.data.contentId, 10);

    await query(
      'DELETE FROM sv_watch_history WHERE user_id = $1 AND content_id = $2 AND content_type = $3',
      [userId, contentId, contentType],
    );

    res.json({ message: 'History item removed' });
  } catch (err) {
    console.error('[history] Failed to delete history item:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to remove history item' });
  }
});

export default router;
