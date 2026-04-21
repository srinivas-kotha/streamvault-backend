import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { loginSchema, changePasswordSchema } from "../utils/validators";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
} from "../utils/jwt";
import { query } from "../services/db.service";
import { authMiddleware } from "../middleware/auth";
import { loginLimiter } from "../middleware/rateLimiter";
import { config } from "../config";
import { isIPTrusted } from "../utils/ip";
import type { DbUser, DbRefreshToken } from "../types/db.types";
import type { TokenPayload } from "../types/api.types";

const router = Router();
const isProduction = process.env.NODE_ENV === "production";

const COOKIE_OPTS_BASE = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "strict" as const,
  path: "/",
};

const ACCESS_MAX_AGE = 15 * 60 * 1000; // 15 minutes
const REFRESH_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days

function setTokenCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
): void {
  res.cookie("access_token", accessToken, {
    ...COOKIE_OPTS_BASE,
    maxAge: ACCESS_MAX_AGE,
  });
  res.cookie("refresh_token", refreshToken, {
    ...COOKIE_OPTS_BASE,
    maxAge: REFRESH_MAX_AGE,
  });
}

function clearTokenCookies(res: Response): void {
  res.clearCookie("access_token", { ...COOKIE_OPTS_BASE });
  res.clearCookie("refresh_token", { ...COOKIE_OPTS_BASE });
}

// GET /api/auth/auto-login — issues tokens if request comes from a trusted IP
router.get("/auto-login", async (req: Request, res: Response) => {
  try {
    if (
      config.auth.bypassIPs.length === 0 ||
      !req.ip ||
      !isIPTrusted(req.ip, config.auth.bypassIPs)
    ) {
      res
        .status(403)
        .json({ error: "Forbidden", message: "IP not in bypass list" });
      return;
    }

    // Find admin user (first user in DB)
    const result = await query<DbUser>(
      "SELECT id, username FROM sv_users ORDER BY id ASC LIMIT 1",
    );

    if (result.rows.length === 0) {
      res.status(500).json({
        error: "Internal Server Error",
        message: "No users configured",
      });
      return;
    }

    const user = result.rows[0];
    const payload: TokenPayload = { userId: user.id, username: user.username };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    // Store refresh token hash in DB
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_MAX_AGE);

    await query(
      "INSERT INTO sv_refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [user.id, tokenHash, expiresAt],
    );

    setTokenCookies(res, accessToken, refreshToken);
    res.json({
      message: "Auto-login successful",
      userId: user.id,
      username: user.username,
    });
  } catch (err) {
    console.error(
      "[auth] Auto-login error:",
      err instanceof Error ? err.message : err,
    );
    res
      .status(500)
      .json({ error: "Internal Server Error", message: "Auto-login failed" });
  }
});

// POST /api/auth/login
router.post("/login", loginLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Bad Request",
        message: parsed.error.errors[0].message,
      });
      return;
    }

    const { username, password } = parsed.data;

    const result = await query<DbUser>(
      "SELECT id, username, password_hash FROM sv_users WHERE username = $1",
      [username],
    );

    if (result.rows.length === 0) {
      res
        .status(401)
        .json({ error: "Unauthorized", message: "Invalid credentials" });
      return;
    }

    const user = result.rows[0];
    const passwordValid = await bcrypt.compare(password, user.password_hash);

    if (!passwordValid) {
      res
        .status(401)
        .json({ error: "Unauthorized", message: "Invalid credentials" });
      return;
    }

    const payload: TokenPayload = { userId: user.id, username: user.username };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    // Store refresh token hash in DB
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_MAX_AGE);

    await query(
      "INSERT INTO sv_refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [user.id, tokenHash, expiresAt],
    );

    setTokenCookies(res, accessToken, refreshToken);
    res.json({
      message: "Login successful",
      userId: user.id,
      username: user.username,
    });
  } catch (err) {
    console.error(
      "[auth] Login error:",
      err instanceof Error ? err.message : err,
    );
    res
      .status(500)
      .json({ error: "Internal Server Error", message: "Login failed" });
  }
});

// POST /api/auth/refresh
router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.refresh_token;

    if (!token) {
      res
        .status(401)
        .json({ error: "Unauthorized", message: "No refresh token provided" });
      return;
    }

    let payload: TokenPayload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      clearTokenCookies(res);
      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid or expired refresh token",
      });
      return;
    }

    const tokenHash = hashToken(token);

    // Check token exists, is not revoked, and has not expired in DB
    const result = await query<DbRefreshToken>(
      "SELECT id, revoked FROM sv_refresh_tokens WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW()",
      [tokenHash, payload.userId],
    );

    if (result.rows.length === 0 || result.rows[0].revoked) {
      clearTokenCookies(res);
      res.status(401).json({
        error: "Unauthorized",
        message: "Refresh token revoked or not found",
      });
      return;
    }

    // Revoke old token
    await query("UPDATE sv_refresh_tokens SET revoked = true WHERE id = $1", [
      result.rows[0].id,
    ]);

    // Issue new pair
    const newPayload: TokenPayload = {
      userId: payload.userId,
      username: payload.username,
    };
    const newAccessToken = signAccessToken(newPayload);
    const newRefreshToken = signRefreshToken(newPayload);

    const newTokenHash = hashToken(newRefreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_MAX_AGE);

    await query(
      "INSERT INTO sv_refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [payload.userId, newTokenHash, expiresAt],
    );

    setTokenCookies(res, newAccessToken, newRefreshToken);

    // Cleanup expired and old revoked tokens (non-blocking)
    query(
      "DELETE FROM sv_refresh_tokens WHERE user_id = $1 AND (expires_at < NOW() OR (revoked = true AND created_at < NOW() - INTERVAL '7 days'))",
      [payload.userId],
    ).catch(() => {
      /* cleanup failure is non-critical */
    });

    res.json({ message: "Tokens refreshed" });
  } catch (err) {
    console.error(
      "[auth] Refresh error:",
      err instanceof Error ? err.message : err,
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "Token refresh failed",
    });
  }
});

// POST /api/auth/logout
router.post("/logout", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    // Revoke all refresh tokens for this user
    await query(
      "UPDATE sv_refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false",
      [userId],
    );

    clearTokenCookies(res);
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    console.error(
      "[auth] Logout error:",
      err instanceof Error ? err.message : err,
    );
    res
      .status(500)
      .json({ error: "Internal Server Error", message: "Logout failed" });
  }
});

// POST /api/auth/change-password
// Requires: authMiddleware (access_token cookie) + csrfMiddleware (applied globally)
// Does NOT add this path to CSRF_EXEMPT_PATHS — authenticated endpoints stay CSRF-protected.
router.post(
  "/change-password",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      // 1. Validate request body
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Bad Request",
          message: parsed.error.errors[0].message,
        });
        return;
      }

      const { currentPassword, newPassword } = parsed.data;

      // 2. Password policy checks → 422 (not 400, which is reserved for malformed input).
      //    Length is checked here so policy violations are clearly distinct from missing fields.
      if (newPassword.length < 12) {
        res.status(422).json({
          error: "Unprocessable Entity",
          message: "newPassword must be at least 12 characters",
        });
        return;
      }
      if (newPassword.length > 200) {
        res.status(422).json({
          error: "Unprocessable Entity",
          message: "newPassword must be at most 200 characters",
        });
        return;
      }
      // same-as-current check happens after DB fetch (we need the hash first)

      const userId = req.user!.userId;

      // 3. Fetch current password hash
      const userResult = await query<Pick<DbUser, "id" | "password_hash">>(
        "SELECT id, password_hash FROM sv_users WHERE id = $1",
        [userId],
      );

      if (userResult.rows.length === 0) {
        // Should never happen for a valid JWT, but guard defensively
        res
          .status(401)
          .json({ error: "Unauthorized", message: "Invalid credentials" });
        return;
      }

      const { password_hash: currentHash } = userResult.rows[0];

      // 4. Verify currentPassword
      const currentPasswordValid = await bcrypt.compare(
        currentPassword,
        currentHash,
      );
      if (!currentPasswordValid) {
        res
          .status(401)
          .json({ error: "Unauthorized", message: "Invalid credentials" });
        return;
      }

      // 5. Reject if newPassword is the same as currentPassword
      const isSamePassword = await bcrypt.compare(newPassword, currentHash);
      if (isSamePassword) {
        res.status(422).json({
          error: "Unprocessable Entity",
          message: "New password must not be the same as the current password",
        });
        return;
      }

      // 6. Hash new password — match the cost factor used across the codebase (12)
      const BCRYPT_ROUNDS = 12;
      const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

      // 7. Update password hash (parameterized)
      await query(
        "UPDATE sv_users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
        [newHash, userId],
      );

      // 8. Purge all refresh tokens for this user (matches logout pattern)
      await query(
        "UPDATE sv_refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false",
        [userId],
      );

      // 9. Clear auth cookies — force re-login on next request
      clearTokenCookies(res);

      // 10. Return 204 No Content
      res.status(204).end();
    } catch (err) {
      console.error(
        "[auth] Change-password error:",
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: "Password change failed",
      });
    }
  },
);

export default router;
