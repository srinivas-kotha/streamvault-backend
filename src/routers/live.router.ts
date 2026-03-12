import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { xtreamService } from '../services/xtream.service';
import { categoryIdSchema, streamIdSchema } from '../utils/validators';

const router = Router();

// GET /api/live/categories
router.get('/categories', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const categories = await xtreamService.getCategories('live');
    res.json(categories);
  } catch (err) {
    console.error('[live] Failed to fetch categories:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Bad Gateway', message: 'Failed to fetch live categories' });
  }
});

// GET /api/live/streams/:catId
router.get('/streams/:catId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = categoryIdSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid category ID' });
      return;
    }

    const streams = await xtreamService.getStreams(parsed.data.catId, 'live');
    res.json(streams);
  } catch (err) {
    console.error('[live] Failed to fetch streams:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Bad Gateway', message: 'Failed to fetch live streams' });
  }
});

// GET /api/live/epg/:streamId
router.get('/epg/:streamId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = streamIdSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid stream ID' });
      return;
    }

    const epg = await xtreamService.getEPG(parsed.data.streamId);
    res.json(epg);
  } catch (err) {
    console.error('[live] Failed to fetch EPG:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Bad Gateway', message: 'Failed to fetch EPG data' });
  }
});

export default router;
