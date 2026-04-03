import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { query } from "../services/db.service";

const router = Router();

// GET /api/alerts — return unresolved alerts sorted by severity (critical first)
router.get("/", authMiddleware, async (_req: Request, res: Response) => {
  try {
    const result = await query<{
      id: string;
      type: string;
      severity: string;
      entity_type: string;
      entity_id: string;
      entity_name: string;
      message: string;
      resolved: boolean;
      resolved_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, type, severity, entity_type, entity_id, entity_name,
              message, resolved, resolved_at, created_at, updated_at
       FROM ceo_dashboard.alerts
       WHERE resolved = false
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 ELSE 1 END,
         created_at DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(
      "[alerts] GET /api/alerts failed:",
      err instanceof Error ? err.message : err,
    );
    res
      .status(500)
      .json({
        error: "Internal Server Error",
        message: "Failed to fetch alerts",
      });
  }
});

// PATCH /api/alerts/:id — mark alert as resolved
router.patch("/:id", authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const result = await query<{ id: string }>(
      `UPDATE ceo_dashboard.alerts
       SET resolved = true, resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND resolved = false
       RETURNING id`,
      [id],
    );

    if (result.rowCount === 0) {
      res
        .status(404)
        .json({
          error: "Not Found",
          message: "Alert not found or already resolved",
        });
      return;
    }

    res.json({ id: result.rows[0].id, resolved: true });
  } catch (err) {
    console.error(
      "[alerts] PATCH /api/alerts/:id failed:",
      err instanceof Error ? err.message : err,
    );
    res
      .status(500)
      .json({
        error: "Internal Server Error",
        message: "Failed to resolve alert",
      });
  }
});

export default router;
