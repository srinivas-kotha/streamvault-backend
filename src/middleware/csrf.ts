import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const CSRF_COOKIE = 'sv_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

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

  // Safe methods don't need CSRF validation
  if (SAFE_METHODS.includes(req.method)) {
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
