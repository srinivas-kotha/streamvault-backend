function requiredEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  providerType: optionalEnv('PROVIDER_TYPE', 'xtream') as 'xtream',
  port: parseInt(optionalEnv('PORT', '3001'), 10),

  postgres: {
    host: requiredEnv('POSTGRES_HOST'),
    port: parseInt(optionalEnv('POSTGRES_PORT', '5432'), 10),
    database: requiredEnv('POSTGRES_DB'),
    user: requiredEnv('POSTGRES_USER'),
    password: requiredEnv('POSTGRES_PASSWORD'),
  },

  jwt: {
    secret: requiredEnv('JWT_SECRET'),
    refreshSecret: requiredEnv('JWT_REFRESH_SECRET'),
    accessExpiresIn: '15m',
    // 60-day sliding session — tightened from 90d in Phase 1 of the v3 UX
    // rebuild (streamvault-v3-frontend docs/ux/00-ia-navigation.md §7).
    // Sliding is automatic: every successful /auth/refresh issues a fresh
    // expires_at, so users stay logged in as long as they open the app
    // at least once per 60 days.
    refreshExpiresIn: '60d',
  },

  xtream: {
    host: requiredEnv('XTREAM_HOST'),
    port: parseInt(optionalEnv('XTREAM_PORT', '80'), 10),
    username: requiredEnv('XTREAM_USERNAME'),
    password: requiredEnv('XTREAM_PASSWORD'),
  },

  download: {
    idleStart: optionalEnv('DOWNLOAD_IDLE_START', '02:00'),
    idleEnd: optionalEnv('DOWNLOAD_IDLE_END', '06:00'),
  },

  storage: {
    maxStorageGB: parseInt(optionalEnv('MAX_STORAGE_GB', '15'), 10),
    dataDir: '/data/streamvault',
    downloadsDir: '/data/streamvault/downloads',
    recordingsDir: '/data/streamvault/recordings',
    hlsTmpDir: '/tmp/streamvault-hls',
  },

  cors: {
    origin: optionalEnv('CORS_ORIGIN', 'https://streamvault.srinivaskotha.uk'),
  },

  auth: {
    bypassIPs: (process.env.AUTH_BYPASS_IPS || '').split(',').map(s => s.trim()).filter(Boolean),
  },
} as const;
