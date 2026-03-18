import { Router, Request, Response } from 'express';
import { getProvider } from '../providers';
import type { HealthResponse } from '../types/api.types';

const router = Router();
const startTime = Date.now();

// GET /health
router.get('/health', (_req: Request, res: Response) => {
  const healthy = getProvider().isHealthy();

  const response: HealthResponse = {
    status: healthy ? 'ok' : 'degraded',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    providerHealthy: healthy,
    timestamp: new Date().toISOString(),
  };

  res.json(response);
});

export default router;
