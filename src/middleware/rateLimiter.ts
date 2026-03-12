import rateLimit from 'express-rate-limit';

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: 'Too Many Requests', message: 'Too many login attempts, try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  message: { error: 'Too Many Requests', message: 'Rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Higher limit for stream routes — HLS live streams generate frequent segment requests
export const streamLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: { error: 'Too Many Requests', message: 'Stream rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});
