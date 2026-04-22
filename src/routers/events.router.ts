import { Router, Request, Response } from 'express';

const router = Router();

/**
 * Last-resort 404 for any /api/* path that no specific router handles.
 *
 * Previously returned 501 "Not implemented yet — coming in Phase 2/3",
 * which silently masked real route-shape mismatches: the v3 frontend called
 * /api/live/channels and /api/search for months while this catchall
 * responded with an obscure Phase-2/3 placeholder, making bugs look like
 * backend-not-yet-written rather than routing typos. Returning 404 with
 * the requested path makes those surface as actionable "No such route"
 * rather than a misleading 501.
 */
router.all('*', (req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `No route matches ${req.method} ${req.originalUrl}`,
  });
});

export default router;
