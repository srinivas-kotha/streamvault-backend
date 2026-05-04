/**
 * search.router.test.ts — Phase 3: surface content_uid on results when flag on
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import type { IStreamProvider } from "../providers";

// ─── mocks ───────────────────────────────────────────────────────────────────

vi.mock("../services/catalog.service", () => ({
  searchCatalog: vi.fn(),
}));

vi.mock("../middleware/auth", () => ({
  authMiddleware: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../providers", () => ({
  getProvider: (): Partial<IStreamProvider> => ({
    name: "test",
    isHealthy: () => true,
  }),
}));

import { searchCatalog } from "../services/catalog.service";
import searchRouter from "./search.router";

const mockSearchCatalog = vi.mocked(searchCatalog);

const app = express();
app.use(express.json());
app.use("/api/search", searchRouter);

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SV_USE_CONTENT_UID;
});
afterEach(() => {
  delete process.env.SV_USE_CONTENT_UID;
});

// ── flag off ──────────────────────────────────────────────────────────────────

describe("GET /api/search (flag off)", () => {
  it("returns search results without content_uid when flag off", async () => {
    mockSearchCatalog.mockResolvedValueOnce({
      live: [{ id: "1234", name: "Test Channel", type: "live" }],
      vod: [],
      series: [],
    });

    const res = await request(app).get("/api/search?q=test");
    expect(res.status).toBe(200);
    expect(res.body.live).toHaveLength(1);
    // content_uid not present (no DB lookup for uid)
    expect(res.body.live[0].content_uid).toBeUndefined();
  });
});

// ── flag on ───────────────────────────────────────────────────────────────────

describe("GET /api/search (flag on)", () => {
  it("includes content_uid field on search results when flag on", async () => {
    process.env.SV_USE_CONTENT_UID = "1";

    mockSearchCatalog.mockResolvedValueOnce({
      live: [
        {
          id: "1234",
          name: "Test Channel",
          type: "live",
          content_uid: "abcd1234abcd1234",
        },
      ],
      vod: [],
      series: [],
    });

    const res = await request(app).get("/api/search?q=test");
    expect(res.status).toBe(200);
    expect(res.body.live[0].content_uid).toBe("abcd1234abcd1234");
  });

  it("handles results where content_uid is null gracefully", async () => {
    process.env.SV_USE_CONTENT_UID = "1";

    mockSearchCatalog.mockResolvedValueOnce({
      live: [
        { id: "5678", name: "Orphan Channel", type: "live", content_uid: null },
      ],
      vod: [],
      series: [],
    });

    const res = await request(app).get("/api/search?q=orphan");
    expect(res.status).toBe(200);
    expect(res.body.live[0].content_uid).toBeNull();
  });
});

// ── Validation still enforced ─────────────────────────────────────────────────

describe("GET /api/search — validation", () => {
  it("returns 400 when q param missing", async () => {
    const res = await request(app).get("/api/search");
    expect(res.status).toBe(400);
  });
});
