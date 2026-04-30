import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import configRouter from "./config.router";

vi.mock("../services/db.service", () => ({
  query: vi.fn(),
}));

vi.mock("../utils/jwt", () => ({
  verifyAccessToken: vi.fn(),
}));

import { query } from "../services/db.service";
import { verifyAccessToken } from "../utils/jwt";
const mockQuery = vi.mocked(query);
const mockVerify = vi.mocked(verifyAccessToken);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/config", configRouter);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/config/flags", () => {
  it("returns globals to unauthenticated callers (no 401)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { key: "adaptive.player.tap_toggle", value: false },
        { key: "adaptive.mobile.enabled", value: false },
      ],
      rowCount: 2,
    } as never);

    const res = await request(app).get("/api/config/flags");

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("global");
    expect(res.body.ttl_seconds).toBe(5);
    expect(res.body.flags).toEqual({
      "adaptive.player.tap_toggle": false,
      "adaptive.mobile.enabled": false,
    });
  });

  it("sets Cache-Control: no-store", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const res = await request(app).get("/api/config/flags");

    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("merges per-user overrides when authenticated", async () => {
    mockVerify.mockReturnValueOnce({ userId: 1, username: "admin" });
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ key: "adaptive.player.tap_toggle", value: false }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ key: "adaptive.player.tap_toggle", value: true }],
        rowCount: 1,
      } as never);

    const res = await request(app)
      .get("/api/config/flags")
      .set("Cookie", "access_token=valid-token");

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("user");
    expect(res.body.flags["adaptive.player.tap_toggle"]).toBe(true);
  });

  it("falls through to globals when token invalid", async () => {
    mockVerify.mockImplementationOnce(() => {
      throw new Error("expired");
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const res = await request(app)
      .get("/api/config/flags")
      .set("Cookie", "access_token=bad-token");

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("global");
  });

  it("returns 500 on DB error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection refused") as never);

    const res = await request(app).get("/api/config/flags");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal Server Error");
  });

  it("sets Cache-Control: no-store on 500 responses too (F3)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection refused") as never);

    const res = await request(app).get("/api/config/flags");

    expect(res.status).toBe(500);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("POST /api/config/flags/:key", () => {
  it("rejects unauthenticated callers with 403", async () => {
    const res = await request(app)
      .post("/api/config/flags/adaptive.player.tap_toggle")
      .send({ value: true });

    expect(res.status).toBe(403);
  });

  it("rejects non-admin users with 403", async () => {
    mockVerify.mockReturnValueOnce({ userId: 2, username: "user" });

    const res = await request(app)
      .post("/api/config/flags/adaptive.player.tap_toggle")
      .set("Cookie", "access_token=valid-token")
      .send({ value: true });

    expect(res.status).toBe(403);
  });

  it("rejects invalid keys with 400", async () => {
    mockVerify.mockReturnValueOnce({ userId: 1, username: "admin" });

    const res = await request(app)
      .post("/api/config/flags/INVALID_KEY")
      .set("Cookie", "access_token=valid-token")
      .send({ value: true });

    expect(res.status).toBe(400);
  });

  it("rejects missing value with 400", async () => {
    mockVerify.mockReturnValueOnce({ userId: 1, username: "admin" });

    const res = await request(app)
      .post("/api/config/flags/adaptive.player.tap_toggle")
      .set("Cookie", "access_token=valid-token")
      .send({});

    expect(res.status).toBe(400);
  });

  it("upserts a flag for admin and returns 204", async () => {
    mockVerify.mockReturnValueOnce({ userId: 1, username: "admin" });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const res = await request(app)
      .post("/api/config/flags/adaptive.player.tap_toggle")
      .set("Cookie", "access_token=valid-token")
      .send({ value: true });

    expect(res.status).toBe(204);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO sv_feature_flags");
    expect(sql).toContain("ON CONFLICT (key, scope, COALESCE(scope_id, ''))");
    expect(params?.[0]).toBe("adaptive.player.tap_toggle");
    expect(params?.[1]).toBe("global");
    expect(params?.[3]).toBe("true");
    expect(params?.[4]).toBe("userId:1");
  });

  it("rejects invalid scope with 400", async () => {
    mockVerify.mockReturnValueOnce({ userId: 1, username: "admin" });

    const res = await request(app)
      .post("/api/config/flags/adaptive.player.tap_toggle")
      .set("Cookie", "access_token=valid-token")
      .send({ value: true, scope: "tenant" });

    expect(res.status).toBe(400);
  });

  it("returns 500 on DB error", async () => {
    mockVerify.mockReturnValueOnce({ userId: 1, username: "admin" });
    mockQuery.mockRejectedValueOnce(new Error("constraint violation") as never);

    const res = await request(app)
      .post("/api/config/flags/adaptive.player.tap_toggle")
      .set("Cookie", "access_token=valid-token")
      .send({ value: true });

    expect(res.status).toBe(500);
  });
});
