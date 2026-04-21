import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import authRouter from "./auth.router";

// Mock db.service so tests don't need a real DB
vi.mock("../services/db.service", () => ({
  query: vi.fn(),
}));

// Mock bcryptjs so we don't run real hashing in tests
vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
  },
}));

// Mock authMiddleware — inject req.user for authenticated endpoint tests
vi.mock("../middleware/auth", () => ({
  authMiddleware: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.user = { userId: 1, username: "test" };
    next();
  },
}));

// Mock rate limiters — pass through in tests
// Note: vi.mock factory is hoisted, so inline functions are required (no variable refs)
vi.mock("../middleware/rateLimiter", () => ({
  loginLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
  changePasswordLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

// Mock jwt utils
vi.mock("../utils/jwt", () => ({
  signAccessToken: vi.fn(() => "mock-access-token"),
  signRefreshToken: vi.fn(() => "mock-refresh-token"),
  verifyRefreshToken: vi.fn(),
  hashToken: vi.fn(() => "mock-hash"),
}));

// Mock config
vi.mock("../config", () => ({
  config: {
    auth: { bypassIPs: [] },
  },
}));

// Mock isIPTrusted
vi.mock("../utils/ip", () => ({
  isIPTrusted: vi.fn(() => false),
}));

import { query } from "../services/db.service";
import bcrypt from "bcryptjs";

const mockQuery = vi.mocked(query);
const mockBcryptCompare = vi.mocked(bcrypt.compare);
const mockBcryptHash = vi.mocked(bcrypt.hash);

const app = express();
app.use(express.json());
app.use("/api/auth", authRouter);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// POST /api/auth/change-password
// ---------------------------------------------------------------------------
describe("POST /api/auth/change-password", () => {
  const ENDPOINT = "/api/auth/change-password";

  const VALID_BODY = {
    currentPassword: "OldPassword123!",
    newPassword: "NewPassword456!",
  };

  const HASHED_CURRENT = "$2b$12$existingHashOfOldPassword";

  // -------------------------------------------------------------------------
  // SUCCESS
  // -------------------------------------------------------------------------
  it("returns 204 on valid currentPassword and policy-compliant newPassword", async () => {
    // SELECT sv_users
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, password_hash: HASHED_CURRENT }],
      rowCount: 1,
    } as never);
    // UPDATE sv_users SET password_hash
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    // UPDATE sv_refresh_tokens SET revoked = true
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 } as never);

    mockBcryptCompare.mockResolvedValueOnce(true as never);
    mockBcryptHash.mockResolvedValueOnce("$2b$12$newHashValue" as never);

    const res = await request(app).post(ENDPOINT).send(VALID_BODY);

    expect(res.status).toBe(204);

    // Two UPDATE queries must have been issued (users then refresh_tokens)
    const updateCalls = mockQuery.mock.calls.filter(([sql]) =>
      (sql as string).includes("UPDATE"),
    );
    expect(updateCalls).toHaveLength(2);

    // First UPDATE must target sv_users.password_hash
    expect((updateCalls[0][0] as string).toLowerCase()).toContain("sv_users");
    expect((updateCalls[0][0] as string).toLowerCase()).toContain(
      "password_hash",
    );

    // Second UPDATE must revoke refresh tokens
    expect((updateCalls[1][0] as string).toLowerCase()).toContain(
      "sv_refresh_tokens",
    );
    expect((updateCalls[1][0] as string).toLowerCase()).toContain("revoked");

    // Cookies must be cleared: both access_token and refresh_token should be
    // expired (maxAge=0 / Expires in the past / empty value)
    const setCookieHeader = res.headers["set-cookie"] as string[] | undefined;
    expect(setCookieHeader).toBeDefined();
    const cookieStr = Array.isArray(setCookieHeader)
      ? setCookieHeader.join("; ")
      : (setCookieHeader as string);
    expect(cookieStr).toMatch(/access_token=/);
    expect(cookieStr).toMatch(/refresh_token=/);
  });

  // -------------------------------------------------------------------------
  // WRONG CURRENT PASSWORD → 401, NO UPDATE queries issued
  // -------------------------------------------------------------------------
  it("returns 401 when currentPassword does not match stored hash", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, password_hash: HASHED_CURRENT }],
      rowCount: 1,
    } as never);
    mockBcryptCompare.mockResolvedValueOnce(false as never);

    const res = await request(app).post(ENDPOINT).send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid credentials");

    // No UPDATE queries must have been issued
    const updateCalls = mockQuery.mock.calls.filter(([sql]) =>
      (sql as string).includes("UPDATE"),
    );
    expect(updateCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // newPassword < 12 chars → 422
  // -------------------------------------------------------------------------
  it("returns 422 when newPassword is shorter than 12 characters", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ currentPassword: "OldPassword123!", newPassword: "Short1!" });

    expect(res.status).toBe(422);
    expect(res.body.message).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // newPassword equals currentPassword → 422
  // -------------------------------------------------------------------------
  it("returns 422 when newPassword equals currentPassword", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, password_hash: HASHED_CURRENT }],
      rowCount: 1,
    } as never);
    mockBcryptCompare
      // First call: compare currentPassword → stored hash (passes)
      .mockResolvedValueOnce(true as never)
      // Second call: compare newPassword → stored hash (same → reject)
      .mockResolvedValueOnce(true as never);

    const res = await request(app).post(ENDPOINT).send({
      currentPassword: "OldPassword123!",
      newPassword: "OldPassword123!",
    });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/same/i);
  });

  // -------------------------------------------------------------------------
  // Missing fields → 400
  // -------------------------------------------------------------------------
  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ currentPassword: "OldPassword123!" }); // no newPassword

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
  });

  it("returns 400 when body is empty", async () => {
    const res = await request(app).post(ENDPOINT).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
  });

  // -------------------------------------------------------------------------
  // DB error on SELECT → 500, no refresh_tokens touched
  // -------------------------------------------------------------------------
  it("returns 500 on DB error during user SELECT and does not touch refresh_tokens", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB connection lost") as never);

    const res = await request(app).post(ENDPOINT).send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal Server Error");

    // refresh_tokens must NOT have been touched
    const refreshTokenCalls = mockQuery.mock.calls.filter(([sql]) =>
      (sql as string).includes("sv_refresh_tokens"),
    );
    expect(refreshTokenCalls).toHaveLength(0);
  });
});
