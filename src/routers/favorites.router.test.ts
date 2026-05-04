/**
 * favorites.router.test.ts — Phase 3 dual-mode (content_uid vs legacy)
 *
 * Tests written BEFORE implementation per TDD. Each test covers both
 * flag-on (SV_USE_CONTENT_UID=1) and flag-off (legacy) paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

// ─── mocks ───────────────────────────────────────────────────────────────────

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
import favoritesRouter from "./favorites.router";

const mockQuery = vi.mocked(query);

const app = express();
app.use(express.json());
app.use("/api/favorites", favoritesRouter);

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SV_USE_CONTENT_UID;
});

afterEach(() => {
  delete process.env.SV_USE_CONTENT_UID;
});

// ── GET /api/favorites ────────────────────────────────────────────────────────

describe("GET /api/favorites", () => {
  it("returns favorites list (flag off — legacy SELECT)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          content_type: "vod",
          content_id: 123,
          content_name: "Test Movie",
          content_icon: null,
          category_name: null,
          sort_order: 1,
          added_at: new Date().toISOString(),
          content_uid: null,
        },
      ],
    } as never);

    const res = await request(app).get("/api/favorites");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].content_id).toBe(123);
  });

  it("returns favorites with content_uid when flag on", async () => {
    process.env.SV_USE_CONTENT_UID = "1";

    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          content_type: "vod",
          content_id: 123,
          content_name: "Test Movie",
          content_icon: null,
          category_name: null,
          sort_order: 1,
          added_at: new Date().toISOString(),
          content_uid: "abcd1234abcd1234",
        },
      ],
    } as never);

    const res = await request(app).get("/api/favorites");
    expect(res.status).toBe(200);
    expect(res.body[0].content_uid).toBe("abcd1234abcd1234");
  });
});

// ── POST /api/favorites/:contentId ────────────────────────────────────────────

describe("POST /api/favorites/:contentId (flag off — legacy)", () => {
  it("adds a favorite using content_id path when flag off", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_order: 0 }] } as never) // MAX sort_order
      .mockResolvedValueOnce({ rows: [] } as never); // INSERT

    const res = await request(app)
      .post("/api/favorites/456")
      .send({ content_type: "vod", content_name: "Test" });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Favorite added");
  });

  it("rejects invalid numeric content_id with 400", async () => {
    const res = await request(app)
      .post("/api/favorites/notanumber")
      .send({ content_type: "vod" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/favorites/uid/:contentUid (flag on — content_uid path)", () => {
  it("adds a favorite using content_uid when flag on", async () => {
    process.env.SV_USE_CONTENT_UID = "1";

    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_order: 2 }] } as never) // MAX sort_order
      .mockResolvedValueOnce({ rows: [] } as never); // INSERT

    const res = await request(app)
      .post("/api/favorites/uid/abcd1234abcd1234")
      .send({ content_type: "vod", content_name: "Test" });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Favorite added");
  });

  it("rejects invalid content_uid format with 400 (flag on)", async () => {
    process.env.SV_USE_CONTENT_UID = "1";

    const res = await request(app)
      .post("/api/favorites/uid/notavaliduid")
      .send({ content_type: "vod" });

    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/favorites/:contentId ─────────────────────────────────────────

describe("DELETE /api/favorites/:contentId (flag off — legacy)", () => {
  it("removes a favorite using content_id when flag off", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    const res = await request(app)
      .delete("/api/favorites/456")
      .send({ content_type: "vod" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Favorite removed");
  });
});

describe("DELETE /api/favorites/uid/:contentUid (flag on — content_uid path)", () => {
  it("removes a favorite using content_uid when flag on", async () => {
    process.env.SV_USE_CONTENT_UID = "1";

    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    const res = await request(app)
      .delete("/api/favorites/uid/abcd1234abcd1234")
      .send({ content_type: "vod" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Favorite removed");
  });
});
