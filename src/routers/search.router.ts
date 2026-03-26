import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getProvider } from "../providers";
import { searchSchema } from "../utils/validators";
import { searchCatalog } from "../services/catalog.service";

const router = Router();

// GET /api/search?q=&type=live|vod|series&hideAdult=true|false
// Uses PostgreSQL FTS (CatalogService) — replaces O(n) in-memory filter.
// Falls back to in-memory search when DB is unavailable.
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

    // Optional type filter — only accept valid content types
    const rawType = req.query.type as string | undefined;
    const type =
      rawType === "live" || rawType === "vod" || rawType === "series"
        ? rawType
        : undefined;

    const provider = getProvider();
    const results = await searchCatalog(provider, q, type, hideAdult);

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
