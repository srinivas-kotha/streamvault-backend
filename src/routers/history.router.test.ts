/**
 * history.router.test.ts — Phase 3 dual-mode (content_uid vs legacy)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/db.service", () => ({ query: vi.fn() }));
vi.mock("../middleware/auth", () => ({
  authMiddleware: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.user = { userId: 1, username: "test" } as express.Request["user"];
    next();
  },
}));

import { query } from "../services/db.service";
import historyRouter from "./history.router";

const mockQuery = vi.mocked(query);

const app = express();
app.use(express.json());
app.use("/api/history", historyRouter);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SV_USE_CONTENT_UID;
});
afterEach(() => {
  delete process.env.SV_USE_CONTENT_UID;
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe("GET /api/history", () => {
  it("returns history rows (flag off)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          content_type: "vod",
          content_id: 99,
          content_name: "Movie",
          content_icon: null,
          progress_seconds: 120,
          duration_seconds: 3600,
          watched_at: new Date().toISOString(),
          content_uid: null,
        },
      ],
    } as never);

    const res = await request(app).get("/api/history");
    expect(res.status).toBe(200);
    expect(res.body[0].content_id).toBe(99);
  });

  it("includes content_uid in response when flag on", async () => {
    process.env.SV_USE_CONTENT_UID = "1";
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          content_type: "vod",
          content_id: 99,
          content_name: "Movie",
          content_icon: null,
          progress_seconds: 120,
          duration_seconds: 3600,
          watched_at: new Date().toISOString(),
          content_uid: "abcd1234abcd1234",
        },
      ],
    } as never);

    const res = await request(app).get("/api/history");
    expect(res.status).toBe(200);
    expect(res.body[0].content_uid).toBe("abcd1234abcd1234");
  });
});

// ── PUT (upsert) via content_uid ──────────────────────────────────────────────

describe("PUT /api/history/uid/:contentUid (flag on)", () => {
  it("upserts history using content_uid when flag on", async () => {
    process.env.SV_USE_CONTENT_UID = "1";
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    const res = await request(app)
      .put("/api/history/uid/abcd1234abcd1234")
      .send({
        content_type: "vod",
        progress_seconds: 120,
        duration_seconds: 3600,
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Watch history updated");
  });

  it("returns 400 for invalid content_uid format", async () => {
    process.env.SV_USE_CONTENT_UID = "1";

    const res = await request(app)
      .put("/api/history/uid/notavaliduid")
      .send({ content_type: "vod", progress_seconds: 0, duration_seconds: 0 });

    expect(res.status).toBe(400);
  });

  it("returns 404 when flag off", async () => {
    const res = await request(app)
      .put("/api/history/uid/abcd1234abcd1234")
      .send({ content_type: "vod", progress_seconds: 0, duration_seconds: 0 });

    expect(res.status).toBe(404);
  });
});

// ── DELETE via content_uid ────────────────────────────────────────────────────

describe("DELETE /api/history/uid/:contentUid (flag on)", () => {
  it("deletes history using content_uid when flag on", async () => {
    process.env.SV_USE_CONTENT_UID = "1";
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    const res = await request(app)
      .delete("/api/history/uid/abcd1234abcd1234")
      .query({ content_type: "vod" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("History item removed");
  });

  it("returns 404 when flag off", async () => {
    const res = await request(app)
      .delete("/api/history/uid/abcd1234abcd1234")
      .query({ content_type: "vod" });

    expect(res.status).toBe(404);
  });
});

// ── Legacy path unchanged ─────────────────────────────────────────────────────

describe("PUT /api/history/:contentId (legacy, flag off)", () => {
  it("upserts history using content_id (legacy path)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    const res = await request(app).put("/api/history/456").send({
      content_type: "vod",
      progress_seconds: 60,
      duration_seconds: 1800,
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Watch history updated");
  });
});

describe("DELETE /api/history/:contentId (legacy, flag off)", () => {
  it("deletes history using content_id (legacy path)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    const res = await request(app)
      .delete("/api/history/456")
      .query({ content_type: "vod" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("History item removed");
  });
});
