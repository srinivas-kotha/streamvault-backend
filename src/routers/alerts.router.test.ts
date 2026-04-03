import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import alertsRouter from "./alerts.router";

// Mock db.service so tests don't need a real DB
vi.mock("../services/db.service", () => ({
  query: vi.fn(),
}));

// Mock auth middleware — pass through for tests
vi.mock("../middleware/auth", () => ({
  authMiddleware: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

import { query } from "../services/db.service";
const mockQuery = vi.mocked(query);

const app = express();
app.use(express.json());
app.use("/api/alerts", alertsRouter);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/alerts", () => {
  it("returns unresolved alerts sorted by severity", async () => {
    const fakeAlerts = [
      {
        id: "uuid-1",
        type: "no_heartbeat",
        severity: "critical",
        entity_type: "agent",
        entity_id: "agent-abc",
        entity_name: "Backend Engineer",
        message: "No heartbeat in >24h",
        resolved: false,
        resolved_at: null,
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      {
        id: "uuid-2",
        type: "stuck_issue",
        severity: "warning",
        entity_type: "issue",
        entity_id: "SRI-50",
        entity_name: "Fix login bug",
        message: "Issue SRI-50 has no activity for 8 days",
        resolved: false,
        resolved_at: null,
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
    ];

    mockQuery.mockResolvedValueOnce({ rows: fakeAlerts, rowCount: 2 } as never);

    const res = await request(app).get("/api/alerts");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].type).toBe("no_heartbeat");
    expect(res.body[0].severity).toBe("critical");
  });

  it("returns 500 on DB error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB connection lost") as never);

    const res = await request(app).get("/api/alerts");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal Server Error");
  });
});

describe("PATCH /api/alerts/:id", () => {
  it("resolves an alert and returns it", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "uuid-1" }],
      rowCount: 1,
    } as never);

    const res = await request(app).patch("/api/alerts/uuid-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "uuid-1", resolved: true });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("resolved = true");
    expect(params).toEqual(["uuid-1"]);
  });

  it("returns 404 when alert not found or already resolved", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const res = await request(app).patch("/api/alerts/nonexistent-id");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Not Found");
  });

  it("returns 500 on DB error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB error") as never);

    const res = await request(app).patch("/api/alerts/uuid-1");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal Server Error");
  });
});
