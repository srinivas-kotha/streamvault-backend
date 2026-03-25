import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

export const favoriteSchema = z.object({
  content_type: z.enum(["channel", "vod", "series"]),
  content_name: z.string().max(500).optional(),
  content_icon: z.string().url().max(2000).optional(),
  category_name: z.string().max(200).optional(),
});

export const historyUpdateSchema = z.object({
  content_type: z.enum(["channel", "vod", "series"]),
  content_name: z.string().max(500).optional(),
  content_icon: z.string().url().max(2000).optional(),
  progress_seconds: z.number().int().min(0),
  duration_seconds: z.number().int().min(0),
});

export const downloadQueueSchema = z.object({
  vod_id: z.number().int().positive(),
  vod_name: z.string().min(1).max(500),
});

export const recordingScheduleSchema = z.object({
  channel_id: z.number().int().positive(),
  channel_name: z.string().min(1).max(500),
  scheduled_start: z.string().datetime(),
  duration_minutes: z.number().int().min(1).max(480),
});

export const searchSchema = z.object({
  q: z.string().min(1).max(200),
});

export const categoryIdSchema = z.object({
  catId: z.string().regex(/^\d+$/),
});

export const streamIdSchema = z.object({
  streamId: z.string().regex(/^\d+$/),
});

export const vodIdSchema = z.object({
  vodId: z.string().regex(/^\d+$/),
});

export const seriesIdSchema = z.object({
  seriesId: z.string().regex(/^\d+$/),
});

export const contentIdSchema = z.object({
  contentId: z.string().regex(/^\d+$/),
});

export const idSchema = z.object({
  id: z.string().regex(/^\d+$/),
});

export const episodeIdSchema = z.object({
  epId: z.string().regex(/^\d+$/),
});

export const bulkEpgQuerySchema = z.object({
  streamIds: z
    .string()
    .min(1)
    .transform((val) => val.split(",").map((id) => id.trim()))
    .pipe(
      z
        .array(z.string().regex(/^\d+$/, "Each stream ID must be numeric"))
        .min(1, "At least one stream ID required")
        .max(50, "Maximum 50 stream IDs allowed"),
    ),
});
