import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getProvider } from '../providers';
import { categoryIdSchema, vodIdSchema } from '../utils/validators';
import { inferLanguage } from '../services/language-inference.service';

const router = Router();

// GET /api/vod/categories
router.get('/categories', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const categories = await getProvider().getCategories('vod');
    res.json(categories);
  } catch (err) {
    console.error('[vod] Failed to fetch categories:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Bad Gateway', message: 'Failed to fetch VOD categories' });
  }
});

// GET /api/vod/streams/:catId
router.get('/streams/:catId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = categoryIdSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid category ID' });
      return;
    }

    // Fetch categories and streams in parallel; categories needed for inferredLang.
    const [categories, streams] = await Promise.all([
      getProvider().getCategories('vod'),
      getProvider().getStreams(parsed.data.catId, 'vod'),
    ]);
    const catNameById = new Map<string, string>(
      categories.map((c) => [c.id, c.name]),
    );
    const annotated = streams.map((item) => {
      const catName = catNameById.get(item.categoryId);
      return { ...item, inferredLang: catName ? inferLanguage(catName) : null };
    });
    res.json(annotated);
  } catch (err) {
    console.error('[vod] Failed to fetch streams:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Bad Gateway', message: 'Failed to fetch VOD streams' });
  }
});

// GET /api/vod/info/:vodId
router.get('/info/:vodId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = vodIdSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid VOD ID' });
      return;
    }

    const info = await getProvider().getVODInfo(parsed.data.vodId);
    res.json(info);
  } catch (err) {
    console.error('[vod] Failed to fetch VOD info:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Bad Gateway', message: 'Failed to fetch VOD info' });
  }
});

export default router;
