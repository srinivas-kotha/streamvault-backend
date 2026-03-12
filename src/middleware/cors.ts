import cors from 'cors';
import { config } from '../config';

export const corsMiddleware = cors({
  origin: config.nodeEnv === 'production'
    ? config.cors.origin
    : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-csrf-token'],
});
