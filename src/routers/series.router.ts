import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getProvider } from '../providers';
import { categoryIdSchema, seriesIdSchema } from '../utils/validators';

const router = Router();

// GET /api/series/categories
router.get('/categories', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const categories = await getProvider().getCategories('series');
    res.json(categories);
  } catch (err) {
    console.error('[series] Failed to fetch categories:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Bad Gateway', message: 'Failed to fetch series categories' });
  }
});

// GET /api/series/list/:catId
router.get('/list/:catId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = categoryIdSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid category ID' });
      return;
    }

    const series = await getProvider().getStreams(parsed.data.catId, 'series');
    res.json(series);
  } catch (err) {
    console.error('[series] Failed to fetch list:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Bad Gateway', message: 'Failed to fetch series list' });
  }
});

// GET /api/series/info/:seriesId
router.get('/info/:seriesId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = seriesIdSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid series ID' });
      return;
    }

    const info = await getProvider().getSeriesInfo(parsed.data.seriesId);
    res.json(info);
  } catch (err) {
    console.error('[series] Failed to fetch series info:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Bad Gateway', message: 'Failed to fetch series info' });
  }
});

export default router;
