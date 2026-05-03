export interface IAppConfig {
  nodeEnv: string;
  providerType: "xtream";
  port: number;
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  jwt: {
    secret: string;
    refreshSecret: string;
    accessExpiresIn: string;
    refreshExpiresIn: string;
  };
  xtream: {
    host: string;
    port: number;
    username: string;
    password: string;
  };
  download: {
    idleStart: string;
    idleEnd: string;
  };
  storage: {
    maxStorageGB: number;
    dataDir: string;
    downloadsDir: string;
    recordingsDir: string;
    hlsTmpDir: string;
  };
  cors: {
    origin: string;
  };
  auth: {
    bypassIPs: string[];
  };
}

function requiredEnv(key: string, env: NodeJS.ProcessEnv): string {
  const val = env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optionalEnv(
  key: string,
  fallback: string,
  env: NodeJS.ProcessEnv,
): string {
  return env[key] || fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IAppConfig {
  return {
    nodeEnv: optionalEnv("NODE_ENV", "development", env),
    providerType: optionalEnv("PROVIDER_TYPE", "xtream", env) as "xtream",
    port: parseInt(optionalEnv("PORT", "3001", env), 10),

    postgres: {
      host: requiredEnv("POSTGRES_HOST", env),
      port: parseInt(optionalEnv("POSTGRES_PORT", "5432", env), 10),
      database: requiredEnv("POSTGRES_DB", env),
      user: requiredEnv("POSTGRES_USER", env),
      password: requiredEnv("POSTGRES_PASSWORD", env),
    },

    jwt: {
      secret: requiredEnv("JWT_SECRET", env),
      refreshSecret: requiredEnv("JWT_REFRESH_SECRET", env),
      accessExpiresIn: "15m",
      // 60-day sliding session — tightened from 90d in Phase 1 of the v3 UX
      // rebuild (streamvault-v3-frontend docs/ux/00-ia-navigation.md §7).
      // Sliding is automatic: every successful /auth/refresh issues a fresh
      // expires_at, so users stay logged in as long as they open the app
      // at least once per 60 days.
      refreshExpiresIn: "60d",
    },

    xtream: {
      host: requiredEnv("XTREAM_HOST", env),
      port: parseInt(optionalEnv("XTREAM_PORT", "80", env), 10),
      username: requiredEnv("XTREAM_USERNAME", env),
      password: requiredEnv("XTREAM_PASSWORD", env),
    },

    download: {
      idleStart: optionalEnv("DOWNLOAD_IDLE_START", "02:00", env),
      idleEnd: optionalEnv("DOWNLOAD_IDLE_END", "06:00", env),
    },

    storage: {
      maxStorageGB: parseInt(optionalEnv("MAX_STORAGE_GB", "15", env), 10),
      dataDir: "/data/streamvault",
      downloadsDir: "/data/streamvault/downloads",
      recordingsDir: "/data/streamvault/recordings",
      hlsTmpDir: "/tmp/streamvault-hls",
    },

    cors: {
      origin: optionalEnv(
        "CORS_ORIGIN",
        "https://streamvault.srinivaskotha.uk",
        env,
      ),
    },

    auth: {
      bypassIPs: (env["AUTH_BYPASS_IPS"] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
  };
}

export const config = loadConfig();
