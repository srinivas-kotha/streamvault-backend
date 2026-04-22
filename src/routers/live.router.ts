import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getProvider } from "../providers";
import type { CatalogCategory, CatalogItem } from "../providers";
import {
  categoryIdSchema,
  streamIdSchema,
  bulkEpgQuerySchema,
} from "../utils/validators";
import { cacheGet, cacheSet, CacheTTL } from "../services/cache.service";

const router = Router();

// Priority channel patterns — matched case-insensitively against stream names
const PRIORITY_PATTERNS = [
  "etv telugu",
  "etv hd",
  "etv",
  "maa tv",
  "maa hd",
  "star maa",
  "maa gold",
  "maa movies",
  "gemini tv",
  "gemini hd",
  "gemini movies",
  "gemini",
  "zee telugu",
  "zee telugu hd",
];

// Category name patterns that likely contain Telugu live channels
const TELUGU_CATEGORY_PATTERNS = [
  "telugu",
  "india entertainment",
  "indian",
  "india",
];

function matchesPriority(name: string): number {
  const lower = name.toLowerCase().trim();
  for (let i = 0; i < PRIORITY_PATTERNS.length; i++) {
    if (
      lower === PRIORITY_PATTERNS[i] ||
      lower.includes(PRIORITY_PATTERNS[i]!)
    ) {
      return i;
    }
  }
  return -1;
}

function isTeluguCategory(catName: string): boolean {
  const lower = catName.toLowerCase();
  return TELUGU_CATEGORY_PATTERNS.some((pat) => lower.includes(pat));
}

// GET /api/live/featured — priority channels
router.get(
  "/featured",
  authMiddleware,
  async (_req: Request, res: Response) => {
    try {
      const cacheKey = "xtream:live:featured";
      const cached = cacheGet<CatalogItem[]>(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      // 1. Fetch all live categories
      const categories: CatalogCategory[] =
        await getProvider().getCategories("live");

      // 2. Filter to Telugu/Indian categories
      const teluguCats = categories.filter((cat) => isTeluguCategory(cat.name));

      // 3. Fetch streams from each Telugu category in parallel
      const streamResults = await Promise.allSettled(
        teluguCats.map((cat) => getProvider().getStreams(cat.id, "live")),
      );

      // 4. Flatten and deduplicate
      const allStreams: CatalogItem[] = [];
      const seen = new Set<string>();
      for (const result of streamResults) {
        if (result.status === "fulfilled") {
          for (const stream of result.value) {
            if (!seen.has(stream.id)) {
              seen.add(stream.id);
              allStreams.push(stream);
            }
          }
        }
      }

      // 5. Filter to priority channels and sort by priority order
      const priorityStreams = allStreams
        .map((s) => ({ stream: s, rank: matchesPriority(s.name) }))
        .filter((entry) => entry.rank >= 0)
        .sort((a, b) => a.rank - b.rank)
        .map((entry) => entry.stream);

      // Take top 20 priority channels
      const featured = priorityStreams.slice(0, 20);

      cacheSet(cacheKey, featured, CacheTTL.CHANNEL_LIST);
      res.json(featured);
    } catch (err) {
      console.error(
        "[live] Failed to fetch featured channels:",
        err instanceof Error ? err.message : err,
      );
      res.status(502).json({
        error: "Bad Gateway",
        message: "Failed to fetch featured channels",
      });
    }
  },
);

// GET /api/live/categories
router.get(
  "/categories",
  authMiddleware,
  async (_req: Request, res: Response) => {
    try {
      const categories = await getProvider().getCategories("live");
      res.json(categories);
    } catch (err) {
      console.error(
        "[live] Failed to fetch categories:",
        err instanceof Error ? err.message : err,
      );
      res.status(502).json({
        error: "Bad Gateway",
        message: "Failed to fetch live categories",
      });
    }
  },
);

// GET /api/live/streams/:catId
router.get(
  "/streams/:catId",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const parsed = categoryIdSchema.safeParse(req.params);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid category ID" });
        return;
      }

      const streams = await getProvider().getStreams(parsed.data.catId, "live");
      res.json(streams);
    } catch (err) {
      console.error(
        "[live] Failed to fetch streams:",
        err instanceof Error ? err.message : err,
      );
      res.status(502).json({
        error: "Bad Gateway",
        message: "Failed to fetch live streams",
      });
    }
  },
);

// GET /api/live/channels                — all live streams flattened across categories
// GET /api/live/channels?categoryId=X   — streams for one category (same as /streams/:catId)
//
// The v3 frontend (src/api/live.ts fetchChannels / fetchChannelsByCategory)
// calls /api/live/channels — this endpoint was missing from Phase 2 and
// returned 501 via the events.router catchall after merge, so the Live
// screen rendered "Can't load channels" on the deployed site.
router.get(
  "/channels",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const categoryId =
        typeof req.query["categoryId"] === "string"
          ? req.query["categoryId"]
          : undefined;

      if (categoryId) {
        const streams = await getProvider().getStreams(categoryId, "live");
        res.json(streams);
        return;
      }

      // No filter → fetch categories then parallel-fetch all streams.
      // Cached so repeat hits stay fast; TTL matches channel-list cache.
      const cacheKey = "xtream:live:channels:all";
      const cached = cacheGet<CatalogItem[]>(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const categories: CatalogCategory[] =
        await getProvider().getCategories("live");

      const streamResults = await Promise.allSettled(
        categories.map((cat) => getProvider().getStreams(cat.id, "live")),
      );

      const all: CatalogItem[] = [];
      const seen = new Set<string>();
      for (const result of streamResults) {
        if (result.status === "fulfilled") {
          for (const stream of result.value) {
            if (!seen.has(stream.id)) {
              seen.add(stream.id);
              all.push(stream);
            }
          }
        }
      }

      cacheSet(cacheKey, all, CacheTTL.CHANNEL_LIST);
      res.json(all);
    } catch (err) {
      console.error(
        "[live] Failed to fetch channels:",
        err instanceof Error ? err.message : err,
      );
      res.status(502).json({
        error: "Bad Gateway",
        message: "Failed to fetch live channels",
      });
    }
  },
);

// GET /api/live/epg/bulk?streamIds=1,2,3
// Must be defined BEFORE /epg/:streamId so Express doesn't treat "bulk" as a streamId
router.get("/epg/bulk", authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = bulkEpgQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const message =
        parsed.error.errors[0]?.message ?? "Invalid streamIds parameter";
      res.status(400).json({ error: "Bad Request", message });
      return;
    }

    const { streamIds } = parsed.data;
    const results = await Promise.all(
      streamIds.map((id) =>
        getProvider()
          .getEPG(id)
          .then((entries) => ({ id, entries })),
      ),
    );

    const response: Record<string, unknown> = {};
    for (const { id, entries } of results) {
      response[id] = entries;
    }

    res.json(response);
  } catch (err) {
    console.error(
      "[live] Failed to fetch bulk EPG:",
      err instanceof Error ? err.message : err,
    );
    res.status(502).json({
      error: "Bad Gateway",
      message: "Failed to fetch bulk EPG data",
    });
  }
});

// GET /api/live/epg/:streamId
router.get(
  "/epg/:streamId",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const parsed = streamIdSchema.safeParse(req.params);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid stream ID" });
        return;
      }

      const epg = await getProvider().getEPG(parsed.data.streamId);
      res.json(epg);
    } catch (err) {
      console.error(
        "[live] Failed to fetch EPG:",
        err instanceof Error ? err.message : err,
      );
      res
        .status(502)
        .json({ error: "Bad Gateway", message: "Failed to fetch EPG data" });
    }
  },
);

export default router;
