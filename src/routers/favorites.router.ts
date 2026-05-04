import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { query } from "../services/db.service";
import { contentIdSchema, favoriteSchema } from "../utils/validators";
import { z } from "zod";
import type { DbFavorite } from "../types/db.types";

const router = Router();

/** content_uid format: 16 lowercase hex chars */
const contentUidParamSchema = z.object({
  contentUid: z.string().regex(/^[a-f0-9]{16}$/, "Invalid content_uid format"),
});

// ── GET /api/favorites ────────────────────────────────────────────────────────

// GET /api/favorites
router.get("/", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const useNewPath = process.env.SV_USE_CONTENT_UID === "1";

    const selectCols = useNewPath
      ? "id, content_type, content_id, content_name, content_icon, category_name, sort_order, added_at, content_uid"
      : "id, content_type, content_id, content_name, content_icon, category_name, sort_order, added_at";

    const result = await query<DbFavorite>(
      `SELECT ${selectCols} FROM sv_favorites WHERE user_id = $1 ORDER BY sort_order ASC, added_at DESC`,
      [userId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(
      "[favorites] Failed to fetch favorites:",
      err instanceof Error ? err.message : err,
    );
    res
      .status(500)
      .json({
        error: "Internal Server Error",
        message: "Failed to fetch favorites",
      });
  }
});

// ── Legacy path (flag off): POST /api/favorites/:contentId ───────────────────

// POST /api/favorites/:contentId
router.post(
  "/:contentId",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const paramsParsed = contentIdSchema.safeParse(req.params);
      if (!paramsParsed.success) {
        res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid content ID" });
        return;
      }

      const bodyParsed = favoriteSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          error: "Bad Request",
          message: bodyParsed.error.errors[0]?.message,
        });
        return;
      }

      const userId = req.user!.userId;
      const contentId = parseInt(paramsParsed.data.contentId, 10);
      const { content_type, content_name, content_icon, category_name } =
        bodyParsed.data;

      // Get next sort_order
      const orderResult = await query<{ max_order: number | null }>(
        "SELECT MAX(sort_order) as max_order FROM sv_favorites WHERE user_id = $1",
        [userId],
      );
      const nextOrder = (orderResult.rows[0]?.max_order ?? 0) + 1;

      await query(
        `INSERT INTO sv_favorites (user_id, content_type, content_id, content_name, content_icon, category_name, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, content_type, content_id) DO NOTHING`,
        [
          userId,
          content_type,
          contentId,
          content_name ?? null,
          content_icon ?? null,
          category_name ?? null,
          nextOrder,
        ],
      );

      res.status(201).json({ message: "Favorite added" });
    } catch (err) {
      console.error(
        "[favorites] Failed to add favorite:",
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to add favorite",
      });
    }
  },
);

// ── Legacy path (flag off): DELETE /api/favorites/:contentId ─────────────────

// DELETE /api/favorites/:contentId
router.delete(
  "/:contentId",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const parsed = contentIdSchema.safeParse(req.params);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid content ID" });
        return;
      }

      const bodyParsed = favoriteSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          error: "Bad Request",
          message: "content_type is required",
        });
        return;
      }

      const userId = req.user!.userId;
      const contentId = parseInt(parsed.data.contentId, 10);
      const { content_type } = bodyParsed.data;

      await query(
        "DELETE FROM sv_favorites WHERE user_id = $1 AND content_id = $2 AND content_type = $3",
        [userId, contentId, content_type],
      );

      res.json({ message: "Favorite removed" });
    } catch (err) {
      console.error(
        "[favorites] Failed to remove favorite:",
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to remove favorite",
      });
    }
  },
);

// ── New path (flag on): POST /api/favorites/uid/:contentUid ──────────────────

// POST /api/favorites/uid/:contentUid — add favorite by content_uid
router.post(
  "/uid/:contentUid",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (process.env.SV_USE_CONTENT_UID !== "1") {
      res
        .status(404)
        .json({ error: "Not Found", message: "Endpoint not enabled" });
      return;
    }

    try {
      const paramsParsed = contentUidParamSchema.safeParse(req.params);
      if (!paramsParsed.success) {
        res.status(400).json({
          error: "Bad Request",
          message:
            paramsParsed.error.errors[0]?.message ?? "Invalid content_uid",
        });
        return;
      }

      const bodyParsed = favoriteSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          error: "Bad Request",
          message: bodyParsed.error.errors[0]?.message,
        });
        return;
      }

      const userId = req.user!.userId;
      const { contentUid } = paramsParsed.data;
      const { content_type, content_name, content_icon, category_name } =
        bodyParsed.data;

      // Get next sort_order
      const orderResult = await query<{ max_order: number | null }>(
        "SELECT MAX(sort_order) as max_order FROM sv_favorites WHERE user_id = $1",
        [userId],
      );
      const nextOrder = (orderResult.rows[0]?.max_order ?? 0) + 1;

      await query(
        `INSERT INTO sv_favorites (user_id, content_type, content_uid, content_name, content_icon, category_name, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, content_type, content_uid) DO NOTHING`,
        [
          userId,
          content_type,
          contentUid,
          content_name ?? null,
          content_icon ?? null,
          category_name ?? null,
          nextOrder,
        ],
      );

      res.status(201).json({ message: "Favorite added" });
    } catch (err) {
      console.error(
        "[favorites] Failed to add favorite (uid):",
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to add favorite",
      });
    }
  },
);

// ── New path (flag on): DELETE /api/favorites/uid/:contentUid ────────────────

// DELETE /api/favorites/uid/:contentUid — remove favorite by content_uid
router.delete(
  "/uid/:contentUid",
  authMiddleware,
  async (req: Request, res: Response) => {
    if (process.env.SV_USE_CONTENT_UID !== "1") {
      res
        .status(404)
        .json({ error: "Not Found", message: "Endpoint not enabled" });
      return;
    }

    try {
      const parsed = contentUidParamSchema.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          error: "Bad Request",
          message: parsed.error.errors[0]?.message ?? "Invalid content_uid",
        });
        return;
      }

      const bodyParsed = favoriteSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          error: "Bad Request",
          message: "content_type is required",
        });
        return;
      }

      const userId = req.user!.userId;
      const { contentUid } = parsed.data;
      const { content_type } = bodyParsed.data;

      await query(
        "DELETE FROM sv_favorites WHERE user_id = $1 AND content_uid = $2 AND content_type = $3",
        [userId, contentUid, content_type],
      );

      res.json({ message: "Favorite removed" });
    } catch (err) {
      console.error(
        "[favorites] Failed to remove favorite (uid):",
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to remove favorite",
      });
    }
  },
);

export default router;
