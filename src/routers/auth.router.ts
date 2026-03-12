import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { loginSchema } from '../utils/validators';
import { signAccessToken, signRefreshToken, verifyRefreshToken, hashToken } from '../utils/jwt';
import { query } from '../services/db.service';
import { authMiddleware } from '../middleware/auth';
import { loginLimiter } from '../middleware/rateLimiter';
import type { DbUser, DbRefreshToken } from '../types/db.types';
import type { TokenPayload } from '../types/api.types';

const router = Router();
const isProduction = process.env.NODE_ENV === 'production';

const COOKIE_OPTS_BASE = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict' as const,
  path: '/',
};

const ACCESS_MAX_AGE = 15 * 60 * 1000;       // 15 minutes
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function setTokenCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie('access_token', accessToken, { ...COOKIE_OPTS_BASE, maxAge: ACCESS_MAX_AGE });
  res.cookie('refresh_token', refreshToken, { ...COOKIE_OPTS_BASE, maxAge: REFRESH_MAX_AGE });
}

function clearTokenCookies(res: Response): void {
  res.clearCookie('access_token', { ...COOKIE_OPTS_BASE });
  res.clearCookie('refresh_token', { ...COOKIE_OPTS_BASE });
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Bad Request', message: parsed.error.errors[0].message });
      return;
    }

    const { username, password } = parsed.data;

    const result = await query<DbUser>(
      'SELECT id, username, password_hash FROM sv_users WHERE username = $1',
      [username],
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];
    const passwordValid = await bcrypt.compare(password, user.password_hash);

    if (!passwordValid) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid credentials' });
      return;
    }

    const payload: TokenPayload = { userId: user.id, username: user.username };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    // Store refresh token hash in DB
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_MAX_AGE);

    await query(
      'INSERT INTO sv_refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt],
    );

    setTokenCookies(res, accessToken, refreshToken);
    res.json({ message: 'Login successful', userId: user.id, username: user.username });
  } catch (err) {
    console.error('[auth] Login error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Login failed' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.refresh_token;

    if (!token) {
      res.status(401).json({ error: 'Unauthorized', message: 'No refresh token provided' });
      return;
    }

    let payload: TokenPayload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      clearTokenCookies(res);
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired refresh token' });
      return;
    }

    const tokenHash = hashToken(token);

    // Check token exists and is not revoked
    const result = await query<DbRefreshToken>(
      'SELECT id, revoked FROM sv_refresh_tokens WHERE token_hash = $1 AND user_id = $2',
      [tokenHash, payload.userId],
    );

    if (result.rows.length === 0 || result.rows[0].revoked) {
      clearTokenCookies(res);
      res.status(401).json({ error: 'Unauthorized', message: 'Refresh token revoked or not found' });
      return;
    }

    // Revoke old token
    await query(
      'UPDATE sv_refresh_tokens SET revoked = true WHERE id = $1',
      [result.rows[0].id],
    );

    // Issue new pair
    const newPayload: TokenPayload = { userId: payload.userId, username: payload.username };
    const newAccessToken = signAccessToken(newPayload);
    const newRefreshToken = signRefreshToken(newPayload);

    const newTokenHash = hashToken(newRefreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_MAX_AGE);

    await query(
      'INSERT INTO sv_refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [payload.userId, newTokenHash, expiresAt],
    );

    setTokenCookies(res, newAccessToken, newRefreshToken);
    res.json({ message: 'Tokens refreshed' });
  } catch (err) {
    console.error('[auth] Refresh error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Token refresh failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    // Revoke all refresh tokens for this user
    await query(
      'UPDATE sv_refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false',
      [userId],
    );

    clearTokenCookies(res);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('[auth] Logout error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Logout failed' });
  }
});

export default router;
