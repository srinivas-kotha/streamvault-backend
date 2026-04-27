/**
 * Audio-tracks router — player-reported multi-audio cache.
 *
 *  POST /api/audio-tracks/:streamId  — ingest a report from a single player
 *                                      session. Upserts on (provider, stream,
 *                                      content_type, track_index); on
 *                                      conflict, increments report_count
 *                                      WITHOUT overwriting language/label
 *                                      (first reporter wins).
 *
 *  GET  /api/audio-tracks/bulk?ids=1,2&content_type=vod
 *                                    — bulk-fetch tracks for badge rendering.
 *
 * Live streams excluded — the FFmpeg path collapses audio to AAC stereo.
 */
import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { audioTrackLimiter } from "../middleware/rateLimiter";
import { query } from "../services/db.service";
import { getProvider } from "../providers";
import {
  audioTrackReportSchema,
  audioTracksBulkQuerySchema,
  streamIdSchema,
} from "../utils/validators";
import type { DbStreamAudioTrack } from "../types/db.types";

const router = Router();

// Validate that the same track_index isn't reported twice in the same batch
// — that's malformed player data and a sign of a buggy client. Reject early.
function hasDuplicateIndices(
  tracks: { track_index: number }[],
): boolean {
  const seen = new Set<number>();
  for (const t of tracks) {
    if (seen.has(t.track_index)) return true;
    seen.add(t.track_index);
  }
  return false;
}

// POST /api/audio-tracks/:streamId
router.post(
  "/:streamId",
  audioTrackLimiter,
  authMiddleware,
  async (req: Request, res: Response) => {
    const paramsParsed = streamIdSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      res
        .status(400)
        .json({ error: "Bad Request", message: "Invalid stream ID" });
      return;
    }

    const bodyParsed = audioTrackReportSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "Bad Request",
        message: bodyParsed.error.errors[0]?.message ?? "Invalid body",
      });
      return;
    }

    if (hasDuplicateIndices(bodyParsed.data.tracks)) {
      res.status(400).json({
        error: "Bad Request",
        message: "Duplicate track_index values in batch",
      });
      return;
    }

    const userId = req.user!.userId;
    const streamId = paramsParsed.data.streamId;
    const { content_type, tracks } = bodyParsed.data;
    const providerId = getProvider().name;

    let accepted = 0;
    try {
      for (const track of tracks) {
        // Skip tracks with no useful identifying data — saves a row insert
        // for noise (e.g. unlabelled track 0 from a poorly-tagged container).
        if (!track.language_code && !track.label) continue;

        await query(
          `INSERT INTO sv_stream_audio_tracks
             (provider_id, stream_id, content_type, track_index,
              language_code, label, codec, channel_count, bitrate_bps,
              source, reporter_user_id, report_count,
              first_reported_at, last_reported_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'player', $10, 1, NOW(), NOW())
           ON CONFLICT (provider_id, stream_id, content_type, track_index)
             DO UPDATE SET
               report_count = sv_stream_audio_tracks.report_count + 1,
               last_reported_at = NOW()`,
          [
            providerId,
            streamId,
            content_type,
            track.track_index,
            track.language_code ?? null,
            track.label ?? null,
            track.codec ?? null,
            track.channel_count ?? null,
            track.bitrate_bps ?? null,
            userId,
          ],
        );
        accepted += 1;
      }
      res.json({ accepted });
    } catch (err) {
      console.error(
        "[audio-tracks] Failed to ingest:",
        err instanceof Error ? err.message : err,
      );
      res
        .status(500)
        .json({
          error: "Internal Server Error",
          message: "Failed to record audio tracks",
        });
    }
  },
);

// GET /api/audio-tracks/bulk?ids=1,2,3&content_type=vod
router.get(
  "/bulk",
  authMiddleware,
  async (req: Request, res: Response) => {
    const parsed = audioTracksBulkQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Bad Request",
        message: parsed.error.errors[0]?.message ?? "Invalid query",
      });
      return;
    }

    const { ids, content_type } = parsed.data;
    const providerId = getProvider().name;

    try {
      const result = await query<
        Pick<
          DbStreamAudioTrack,
          | "stream_id"
          | "track_index"
          | "language_code"
          | "label"
          | "codec"
          | "channel_count"
          | "bitrate_bps"
          | "report_count"
        >
      >(
        `SELECT stream_id, track_index, language_code, label, codec,
                channel_count, bitrate_bps, report_count
           FROM sv_stream_audio_tracks
          WHERE provider_id = $1
            AND content_type = $2
            AND stream_id = ANY($3::text[])
       ORDER BY stream_id, track_index`,
        [providerId, content_type, ids],
      );

      const grouped: Record<
        string,
        Array<{
          track_index: number;
          language_code: string | null;
          label: string | null;
          codec: string | null;
          channel_count: number | null;
          bitrate_bps: number | null;
          report_count: number;
        }>
      > = {};
      for (const id of ids) grouped[id] = [];
      for (const row of result.rows) {
        grouped[row.stream_id]!.push({
          track_index: row.track_index,
          language_code: row.language_code,
          label: row.label,
          codec: row.codec,
          channel_count: row.channel_count,
          bitrate_bps: row.bitrate_bps,
          report_count: row.report_count,
        });
      }
      res.json(grouped);
    } catch (err) {
      console.error(
        "[audio-tracks] Failed bulk fetch:",
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to fetch audio tracks",
      });
    }
  },
);

export default router;
