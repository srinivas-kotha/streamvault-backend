import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getProvider } from "../providers";
import { getAccountStatus } from "../services/account.service";

const router = Router();

// GET /api/account/info
router.get("/info", authMiddleware, async (_req: Request, res: Response) => {
  try {
    const provider = getProvider();
    const status = await getAccountStatus(provider);
    res.json(status);
  } catch (err) {
    console.error(
      "[account] Failed to fetch account info:",
      err instanceof Error ? err.message : err,
    );
    res.status(502).json({
      error: "Bad Gateway",
      message: "Failed to fetch account info",
    });
  }
});

export default router;
