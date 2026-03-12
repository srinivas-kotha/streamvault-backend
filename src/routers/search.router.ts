import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { xtreamService } from '../services/xtream.service';
import { cacheGet, cacheSet, CacheTTL } from '../services/cache.service';
import { searchSchema } from '../utils/validators';
import type { XtreamLiveStream, XtreamVODStream, XtreamSeriesItem } from '../types/xtream.types';

const router = Router();
const MAX_RESULTS_PER_TYPE = 50;

interface SearchResults {
  live: XtreamLiveStream[];
  vod: XtreamVODStream[];
  series: XtreamSeriesItem[];
}

function matchesQuery(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

// GET /api/search?q=
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'Query parameter "q" is required (1-200 chars)' });
      return;
    }

    const { q } = parsed.data;
    const cacheKey = `search:${q.toLowerCase().trim()}`;

    const cached = cacheGet<SearchResults>(cacheKey);
    if (cached !== undefined) {
      res.json(cached);
      return;
    }

    // Fetch all categories to get full stream lists
    const [liveCategories, vodCategories, seriesCategories] = await Promise.allSettled([
      xtreamService.getCategories('live'),
      xtreamService.getCategories('vod'),
      xtreamService.getCategories('series'),
    ]);

    // Fetch all streams for each type (use category_id=0 or empty to get all)
    const [liveStreams, vodStreams, seriesItems] = await Promise.allSettled([
      xtreamService.getStreams('0', 'live'),
      xtreamService.getStreams('0', 'vod'),
      xtreamService.getStreams('0', 'series'),
    ]);

    const results: SearchResults = {
      live: [],
      vod: [],
      series: [],
    };

    if (liveStreams.status === 'fulfilled' && Array.isArray(liveStreams.value)) {
      results.live = (liveStreams.value as XtreamLiveStream[])
        .filter((s) => matchesQuery(s.name, q))
        .slice(0, MAX_RESULTS_PER_TYPE);
    }

    if (vodStreams.status === 'fulfilled' && Array.isArray(vodStreams.value)) {
      results.vod = (vodStreams.value as XtreamVODStream[])
        .filter((s) => matchesQuery(s.name, q))
        .slice(0, MAX_RESULTS_PER_TYPE);
    }

    if (seriesItems.status === 'fulfilled' && Array.isArray(seriesItems.value)) {
      results.series = (seriesItems.value as XtreamSeriesItem[])
        .filter((s) => matchesQuery(s.name, q))
        .slice(0, MAX_RESULTS_PER_TYPE);
    }

    cacheSet(cacheKey, results, CacheTTL.SEARCH);
    res.json(results);
  } catch (err) {
    console.error('[search] Search failed:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Bad Gateway', message: 'Search failed' });
  }
});

export default router;
