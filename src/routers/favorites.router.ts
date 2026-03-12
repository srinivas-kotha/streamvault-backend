import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { query } from '../services/db.service';
import { contentIdSchema, favoriteSchema } from '../utils/validators';
import type { DbFavorite } from '../types/db.types';

const router = Router();

// GET /api/favorites
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    const result = await query<DbFavorite>(
      'SELECT id, content_type, content_id, content_name, content_icon, category_name, sort_order, added_at FROM sv_favorites WHERE user_id = $1 ORDER BY sort_order ASC, added_at DESC',
      [userId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[favorites] Failed to fetch favorites:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch favorites' });
  }
});

// POST /api/favorites/:contentId
router.post('/:contentId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const paramsParsed = contentIdSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid content ID' });
      return;
    }

    const bodyParsed = favoriteSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: 'Bad Request', message: bodyParsed.error.errors[0].message });
      return;
    }

    const userId = req.user!.userId;
    const contentId = parseInt(paramsParsed.data.contentId, 10);
    const { content_type, content_name, content_icon, category_name } = bodyParsed.data;

    // Get next sort_order
    const orderResult = await query<{ max_order: number | null }>(
      'SELECT MAX(sort_order) as max_order FROM sv_favorites WHERE user_id = $1',
      [userId],
    );
    const nextOrder = (orderResult.rows[0]?.max_order ?? 0) + 1;

    await query(
      `INSERT INTO sv_favorites (user_id, content_type, content_id, content_name, content_icon, category_name, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, content_type, content_id) DO NOTHING`,
      [userId, content_type, contentId, content_name ?? null, content_icon ?? null, category_name ?? null, nextOrder],
    );

    res.status(201).json({ message: 'Favorite added' });
  } catch (err) {
    console.error('[favorites] Failed to add favorite:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to add favorite' });
  }
});

// DELETE /api/favorites/:contentId
router.delete('/:contentId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = contentIdSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid content ID' });
      return;
    }

    const bodyParsed = favoriteSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'content_type is required' });
      return;
    }

    const userId = req.user!.userId;
    const contentId = parseInt(parsed.data.contentId, 10);
    const { content_type } = bodyParsed.data;

    await query(
      'DELETE FROM sv_favorites WHERE user_id = $1 AND content_id = $2 AND content_type = $3',
      [userId, contentId, content_type],
    );

    res.json({ message: 'Favorite removed' });
  } catch (err) {
    console.error('[favorites] Failed to remove favorite:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to remove favorite' });
  }
});

export default router;
