import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/db.service", () => ({
  query: vi.fn(),
}));

vi.mock("../middleware/auth", () => ({
  authMiddleware: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    (req as express.Request & { user?: { userId: number } }).user = {
      userId: 1,
    };
    next();
  },
}));

vi.mock("../middleware/rateLimiter", () => ({
  audioTrackLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../providers", () => ({
  getProvider: () => ({ name: "test-provider" }),
}));

import { query } from "../services/db.service";
const mockQuery = vi.mocked(query);

import audioTracksRouter from "./audio-tracks.router";

const app = express();
app.use(express.json());
app.use("/api/audio-tracks", audioTracksRouter);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/audio-tracks/:streamId", () => {
  it("ingests a valid report and returns the accepted count", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 } as never);

    const res = await request(app)
      .post("/api/audio-tracks/42")
      .send({
        content_type: "vod",
        tracks: [
          { track_index: 0, language_code: "te", label: "Telugu" },
          { track_index: 1, language_code: "en", label: "English" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 2 });
    expect(mockQuery).toHaveBeenCalledTimes(2);

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO sv_stream_audio_tracks");
    expect(sql).toContain("ON CONFLICT");
    expect(params).toEqual([
      "test-provider",
      "42",
      "vod",
      0,
      "te",
      "Telugu",
      null,
      null,
      null,
      1, // userId from authMiddleware mock
    ]);
  });

  it("rejects content_type 'live' (Zod enum)", async () => {
    const res = await request(app)
      .post("/api/audio-tracks/42")
      .send({
        content_type: "live",
        tracks: [{ track_index: 0, language_code: "en" }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
  });

  it("rejects track_index out of range (>31)", async () => {
    const res = await request(app)
      .post("/api/audio-tracks/42")
      .send({
        content_type: "vod",
        tracks: [{ track_index: 99, language_code: "en" }],
      });

    expect(res.status).toBe(400);
  });

  it("rejects more than 32 tracks in one batch", async () => {
    const tracks = Array.from({ length: 33 }, (_, i) => ({
      track_index: i,
      language_code: "en",
    }));

    const res = await request(app)
      .post("/api/audio-tracks/42")
      .send({ content_type: "vod", tracks });

    expect(res.status).toBe(400);
  });

  it("rejects duplicate track_index in the same batch", async () => {
    const res = await request(app)
      .post("/api/audio-tracks/42")
      .send({
        content_type: "vod",
        tracks: [
          { track_index: 0, language_code: "en" },
          { track_index: 0, language_code: "te" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/duplicate/i);
  });

  it("skips tracks with neither language_code nor label", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 } as never);

    const res = await request(app)
      .post("/api/audio-tracks/42")
      .send({
        content_type: "vod",
        tracks: [
          { track_index: 0 }, // skipped (no useful data)
          { track_index: 1, language_code: "en" }, // accepted
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid streamId param", async () => {
    const res = await request(app)
      .post("/api/audio-tracks/abc")
      .send({
        content_type: "vod",
        tracks: [{ track_index: 0, language_code: "en" }],
      });

    expect(res.status).toBe(400);
  });

  it("returns 500 on DB error", async () => {
    mockQuery.mockRejectedValue(new Error("connection lost") as never);

    const res = await request(app)
      .post("/api/audio-tracks/42")
      .send({
        content_type: "vod",
        tracks: [{ track_index: 0, language_code: "en", label: "English" }],
      });

    expect(res.status).toBe(500);
  });
});

describe("GET /api/audio-tracks/bulk", () => {
  it("returns tracks grouped by stream_id", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          stream_id: "1",
          track_index: 0,
          language_code: "te",
          label: "Telugu",
          codec: null,
          channel_count: null,
          bitrate_bps: null,
          report_count: 3,
        },
        {
          stream_id: "2",
          track_index: 0,
          language_code: "hi",
          label: "Hindi",
          codec: null,
          channel_count: null,
          bitrate_bps: null,
          report_count: 1,
        },
      ],
      rowCount: 2,
    } as never);

    const res = await request(app).get(
      "/api/audio-tracks/bulk?ids=1,2,3&content_type=vod",
    );

    expect(res.status).toBe(200);
    expect(res.body["1"]).toHaveLength(1);
    expect(res.body["1"][0].language_code).toBe("te");
    expect(res.body["2"]).toHaveLength(1);
    expect(res.body["2"][0].language_code).toBe("hi");
    // Streams with no rows still appear as empty arrays.
    expect(res.body["3"]).toEqual([]);
  });

  it("rejects missing content_type query", async () => {
    const res = await request(app).get("/api/audio-tracks/bulk?ids=1,2");
    expect(res.status).toBe(400);
  });

  it("rejects more than 50 ids", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1).join(",");
    const res = await request(app).get(
      `/api/audio-tracks/bulk?ids=${ids}&content_type=vod`,
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 on DB error", async () => {
    mockQuery.mockRejectedValue(new Error("DB lost") as never);
    const res = await request(app).get(
      "/api/audio-tracks/bulk?ids=1&content_type=vod",
    );
    expect(res.status).toBe(500);
  });
});
