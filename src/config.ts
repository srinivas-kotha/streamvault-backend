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
    refreshExpiresIn: '90d',
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
} as const;
