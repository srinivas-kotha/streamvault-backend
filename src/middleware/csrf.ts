import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { isIPTrusted } from '../utils/ip';
import { config } from '../config';

const CSRF_COOKIE = 'sv_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// Endpoints exempt from CSRF validation (unauthenticated — no session to hijack)
const CSRF_EXEMPT_PATHS = ['/api/auth/login', '/api/auth/refresh', '/api/auth/auto-login'];

export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Always ensure a CSRF cookie exists
  if (!req.cookies?.[CSRF_COOKIE]) {
    const csrfToken = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, csrfToken, {
      httpOnly: false, // JS must read this cookie to send it as a header
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    // For GET requests on first visit, allow through
    if (SAFE_METHODS.includes(req.method)) {
      next();
      return;
    }
  }

  // Trusted IPs bypass CSRF (auto-login sessions don't go through normal login flow)
  if (config.auth.bypassIPs.length > 0 && req.ip && isIPTrusted(req.ip, config.auth.bypassIPs)) {
    next();
    return;
  }

  // Safe methods don't need CSRF validation
  if (SAFE_METHODS.includes(req.method)) {
    next();
    return;
  }

  // Exempt unauthenticated endpoints (no session to protect)
  if (CSRF_EXEMPT_PATHS.includes(req.path)) {
    next();
    return;
  }

  // Validate: header must match cookie
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER] as string | undefined;

  if (!cookieToken || !headerToken ||
      cookieToken.length !== headerToken.length ||
      !crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))) {
    res.status(403).json({ error: 'Forbidden', message: 'CSRF token mismatch' });
    return;
  }

  next();
}
