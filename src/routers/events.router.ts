import { Router, Request, Response } from 'express';

const router = Router();

router.all('*', (_req: Request, res: Response) => {
  res.status(501).json({
    error: 'Not Implemented',
    message: 'Not implemented yet — coming in Phase 2/3',
  });
});

export default router;
