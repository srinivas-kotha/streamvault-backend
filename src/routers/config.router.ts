import { Router, Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/jwt";
import {
  getMergedFlags,
  upsertFlag,
  isValidFlagKey,
} from "../services/feature-flags.service";

const router = Router();

// Authoritative client cache TTL in seconds (master plan A13). The FE
// honors this when caching the response in localStorage. Server-driven so
// we can shorten it from a future config change without a FE deploy.
const FLAG_CLIENT_TTL_SECONDS = 5;

// Helper: ensure error responses are also marked no-store. A proxy that
// caches a 500 makes failures look persistent after recovery (F3).
function setNoStore(res: Response): void {
  res.set("Cache-Control", "no-store");
}

// Soft-auth: read the access_token cookie if present, attach req.user, but
// NEVER 401. The flags endpoint must serve global defaults to unauthed
// callers (e.g. landing page before login) so the FE can render correctly.
function softAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const token = req.cookies?.access_token;
  if (!token) return next();
  try {
    req.user = verifyAccessToken(token);
  } catch {
    /* ignore — soft auth, fall through */
  }
  next();
}

// GET /api/config/flags
// Returns merged global + per-user flag map. No-store cache so kill-switch
// flips propagate immediately. Public read (no 401) so unauthed callers
// get global defaults — per master plan A4 + A13.
router.get(
  "/flags",
  softAuthMiddleware,
  async (req: Request, res: Response) => {
    setNoStore(res);
    try {
      const userId = req.user?.userId && req.user.userId > 0 ? req.user.userId : undefined;
      const flags = await getMergedFlags(userId);
      res.json({
        flags,
        scope: userId ? "user" : "global",
        ttl_seconds: FLAG_CLIENT_TTL_SECONDS,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(
        "[config] GET /api/config/flags failed:",
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to fetch flags",
      });
    }
  },
);

// POST /api/config/flags/:key
// Admin only (userId === 1). CSRF already covered by global middleware.
router.post(
  "/flags/:key",
  softAuthMiddleware,
  async (req: Request, res: Response) => {
    setNoStore(res);
    if (!req.user || req.user.userId !== 1) {
      res.status(403).json({ error: "Forbidden", message: "Admin only" });
      return;
    }

    const { key } = req.params;
    if (!isValidFlagKey(key)) {
      res
        .status(400)
        .json({ error: "Bad Request", message: "Invalid flag key" });
      return;
    }

    const { value, scope, scope_id } = req.body ?? {};
    if (value === undefined) {
      res
        .status(400)
        .json({ error: "Bad Request", message: "Missing value" });
      return;
    }
    if (scope && !["global", "user", "device"].includes(scope)) {
      res
        .status(400)
        .json({ error: "Bad Request", message: "Invalid scope" });
      return;
    }

    try {
      await upsertFlag({
        key,
        value,
        scope,
        scope_id,
        updated_by: `userId:${req.user.userId}`,
      });
      res.status(204).end();
    } catch (err) {
      console.error(
        "[config] POST /api/config/flags/:key failed:",
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to upsert flag",
      });
    }
  },
);

export default router;
