import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import type { TokenPayload } from '../types/api.types';

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
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
