import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getProvider } from "../providers";
import type { CatalogItem } from "../providers";
import { cacheGet, cacheSet, CacheTTL } from "../services/cache.service";
import { searchSchema } from "../utils/validators";

const router = Router();
const MAX_RESULTS_PER_TYPE = 50;

interface SearchResults {
  live: CatalogItem[];
  vod: CatalogItem[];
  series: CatalogItem[];
}

function matchesQuery(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

// GET /api/search?q=
router.get("/", authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Bad Request",
        message: 'Query parameter "q" is required (1-200 chars)',
      });
      return;
    }

    const { q } = parsed.data;
    const hideAdult = req.query.hideAdult !== "false"; // default true
    const cacheKey = `search:${q.toLowerCase().trim()}:${hideAdult}`;

    const cached = cacheGet<SearchResults>(cacheKey);
    if (cached !== undefined) {
      res.json(cached);
      return;
    }

    // Fetch all streams for each type (use category_id=0 to get all)
    const [liveStreams, vodStreams, seriesItems] = await Promise.allSettled([
      getProvider().getStreams("0", "live"),
      getProvider().getStreams("0", "vod"),
      getProvider().getStreams("0", "series"),
    ]);

    const results: SearchResults = {
      live: [],
      vod: [],
      series: [],
    };

    if (
      liveStreams.status === "fulfilled" &&
      Array.isArray(liveStreams.value)
    ) {
      results.live = liveStreams.value
        .filter((s) => matchesQuery(s.name, q))
        .filter((s) => !hideAdult || !s.isAdult)
        .slice(0, MAX_RESULTS_PER_TYPE);
    }

    if (vodStreams.status === "fulfilled" && Array.isArray(vodStreams.value)) {
      results.vod = vodStreams.value
        .filter((s) => matchesQuery(s.name, q))
        .filter((s) => !hideAdult || !s.isAdult)
        .slice(0, MAX_RESULTS_PER_TYPE);
    }

    if (
      seriesItems.status === "fulfilled" &&
      Array.isArray(seriesItems.value)
    ) {
      results.series = seriesItems.value
        .filter((s) => matchesQuery(s.name, q))
        .filter((s) => !hideAdult || !s.isAdult)
        .slice(0, MAX_RESULTS_PER_TYPE);
    }

    cacheSet(cacheKey, results, CacheTTL.SEARCH);
    res.json(results);
  } catch (err) {
    console.error(
      "[search] Search failed:",
      err instanceof Error ? err.message : err,
    );
    res.status(502).json({ error: "Bad Gateway", message: "Search failed" });
  }
});

export default router;
