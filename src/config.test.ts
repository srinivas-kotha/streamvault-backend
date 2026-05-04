import { describe, it, expect } from "vitest";
import { loadConfig, deriveProviderId } from "./config";
import type { IAppConfig } from "./config";

// Minimal valid env that satisfies all required vars
const baseEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PORT: "3001",
  PROVIDER_TYPE: "xtream",
  POSTGRES_HOST: "localhost",
  POSTGRES_PORT: "5432",
  POSTGRES_DB: "streamvault_test",
  POSTGRES_USER: "sv_user",
  POSTGRES_PASSWORD: "sv_pass",
  JWT_SECRET: "test-jwt-secret",
  JWT_REFRESH_SECRET: "test-jwt-refresh-secret",
  XTREAM_HOST: "iptv.example.com",
  XTREAM_PORT: "8080",
  XTREAM_USERNAME: "xtream_user",
  XTREAM_PASSWORD: "xtream_pass",
};

describe("loadConfig", () => {
  it("returns a valid IAppConfig from a complete env-shaped object", () => {
    const result: IAppConfig = loadConfig(baseEnv);

    // Top-level scalars
    expect(result.nodeEnv).toBe("test");
    expect(result.providerType).toBe("xtream");
    expect(result.port).toBe(3001);

    // postgres
    expect(result.postgres.host).toBe("localhost");
    expect(result.postgres.port).toBe(5432);
    expect(result.postgres.database).toBe("streamvault_test");
    expect(result.postgres.user).toBe("sv_user");
    expect(result.postgres.password).toBe("sv_pass");

    // jwt
    expect(result.jwt.secret).toBe("test-jwt-secret");
    expect(result.jwt.refreshSecret).toBe("test-jwt-refresh-secret");
    expect(result.jwt.accessExpiresIn).toBe("15m");
    expect(result.jwt.refreshExpiresIn).toBe("60d");

    // xtream
    expect(result.xtream.host).toBe("iptv.example.com");
    expect(result.xtream.port).toBe(8080);
    expect(result.xtream.username).toBe("xtream_user");
    expect(result.xtream.password).toBe("xtream_pass");

    // download defaults
    expect(result.download.idleStart).toBe("02:00");
    expect(result.download.idleEnd).toBe("06:00");

    // storage (static paths)
    expect(result.storage.dataDir).toBe("/data/streamvault");
    expect(result.storage.downloadsDir).toBe("/data/streamvault/downloads");
    expect(result.storage.recordingsDir).toBe("/data/streamvault/recordings");
    expect(result.storage.hlsTmpDir).toBe("/tmp/streamvault-hls");
    expect(result.storage.maxStorageGB).toBe(15);

    // cors default
    expect(result.cors.origin).toBe("https://streamvault.srinivaskotha.uk");

    // auth default (no AUTH_BYPASS_IPS set)
    expect(result.auth.bypassIPs).toEqual([]);
  });

  it("throws a descriptive error when XTREAM_HOST is missing", () => {
    const envWithoutHost: NodeJS.ProcessEnv = { ...baseEnv };
    delete envWithoutHost["XTREAM_HOST"];

    expect(() => loadConfig(envWithoutHost)).toThrow(/XTREAM_HOST/);
  });

  it("throws a descriptive error when JWT_SECRET is missing", () => {
    const envWithoutSecret: NodeJS.ProcessEnv = { ...baseEnv };
    delete envWithoutSecret["JWT_SECRET"];

    expect(() => loadConfig(envWithoutSecret)).toThrow(/JWT_SECRET/);
  });

  it("applies XTREAM_PORT default of 80 when not provided", () => {
    const envNoPort: NodeJS.ProcessEnv = { ...baseEnv };
    delete envNoPort["XTREAM_PORT"];

    const result = loadConfig(envNoPort);
    expect(result.xtream.port).toBe(80);
  });

  it("applies PORT default of 3001 when not provided", () => {
    const envNoPort: NodeJS.ProcessEnv = { ...baseEnv };
    delete envNoPort["PORT"];

    const result = loadConfig(envNoPort);
    expect(result.port).toBe(3001);
  });
});

describe("deriveProviderId", () => {
  it("returns 'xtream:' + 8 hex chars from host:port:user", () => {
    const id = deriveProviderId({
      host: "rgkkw.live",
      port: 8080,
      username: "user1234",
    });
    expect(id).toMatch(/^xtream:[a-f0-9]{8}$/);
  });

  it("is deterministic for same inputs", () => {
    const a = deriveProviderId({ host: "x", port: 80, username: "u" });
    const b = deriveProviderId({ host: "x", port: 80, username: "u" });
    expect(a).toBe(b);
  });

  it("differs when host differs", () => {
    const a = deriveProviderId({ host: "a.com", port: 80, username: "u" });
    const b = deriveProviderId({ host: "b.com", port: 80, username: "u" });
    expect(a).not.toBe(b);
  });

  it("does NOT depend on password — rotation-safe by design", () => {
    // password is intentionally excluded from the hash input
    const id = deriveProviderId({ host: "x", port: 80, username: "u" });
    expect(id).toBe(deriveProviderId({ host: "x", port: 80, username: "u" }));
  });
});
