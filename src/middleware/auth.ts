import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { isIPTrusted } from '../utils/ip';
import { config } from '../config';
import type { TokenPayload } from '../types/api.types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // IP bypass: trusted networks skip JWT check
  if (config.auth.bypassIPs.length > 0 && req.ip && isIPTrusted(req.ip, config.auth.bypassIPs)) {
    req.user = { userId: 0, username: 'lan-user' };
    next();
    return;
  }

  const token = req.cookies?.access_token;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized', message: 'No access token provided' });
    return;
  }

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired access token' });
  }
}
