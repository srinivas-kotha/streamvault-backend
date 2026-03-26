import { describe, it, expect } from "vitest";
import {
  loginSchema,
  favoriteSchema,
  historyUpdateSchema,
  downloadQueueSchema,
  searchSchema,
  categoryIdSchema,
} from "./validators";

describe("loginSchema", () => {
  it("accepts valid input", () => {
    const result = loginSchema.safeParse({
      username: "admin",
      password: "pass123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty username", () => {
    const result = loginSchema.safeParse({ username: "", password: "pass123" });
    expect(result.success).toBe(false);
  });

  it("rejects empty password", () => {
    const result = loginSchema.safeParse({ username: "admin", password: "" });
    expect(result.success).toBe(false);
  });
});

describe("favoriteSchema", () => {
  it("accepts valid input", () => {
    const result = favoriteSchema.safeParse({ content_type: "channel" });
    expect(result.success).toBe(true);
  });

  it("accepts input with optional fields", () => {
    const result = favoriteSchema.safeParse({
      content_type: "vod",
      content_name: "My Movie",
      content_icon: "https://example.com/icon.png",
      category_name: "Drama",
    });
    expect(result.success).toBe(true);
  });

  it('accepts "live" and normalizes to "channel"', () => {
    const result = favoriteSchema.safeParse({ content_type: "live" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content_type).toBe("channel");
    }
  });

  it("rejects invalid content_type", () => {
    const result = favoriteSchema.safeParse({ content_type: "movie" });
    expect(result.success).toBe(false);
  });
});

describe("historyUpdateSchema", () => {
  it("rejects negative progress", () => {
    const result = historyUpdateSchema.safeParse({
      content_type: "vod",
      progress_seconds: -1,
      duration_seconds: 100,
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid progress", () => {
    const result = historyUpdateSchema.safeParse({
      content_type: "vod",
      progress_seconds: 50,
      duration_seconds: 100,
    });
    expect(result.success).toBe(true);
  });
});

describe("downloadQueueSchema", () => {
  it("rejects non-positive vod_id", () => {
    const result = downloadQueueSchema.safeParse({
      vod_id: 0,
      vod_name: "Test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative vod_id", () => {
    const result = downloadQueueSchema.safeParse({
      vod_id: -5,
      vod_name: "Test",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid input", () => {
    const result = downloadQueueSchema.safeParse({
      vod_id: 42,
      vod_name: "Movie Name",
    });
    expect(result.success).toBe(true);
  });
});

describe("searchSchema", () => {
  it("rejects empty query", () => {
    const result = searchSchema.safeParse({ q: "" });
    expect(result.success).toBe(false);
  });

  it("accepts valid query", () => {
    const result = searchSchema.safeParse({ q: "action movies" });
    expect(result.success).toBe(true);
  });
});

describe("categoryIdSchema", () => {
  it("accepts numeric string", () => {
    const result = categoryIdSchema.safeParse({ catId: "123" });
    expect(result.success).toBe(true);
  });

  it("rejects non-numeric string", () => {
    const result = categoryIdSchema.safeParse({ catId: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects empty string", () => {
    const result = categoryIdSchema.safeParse({ catId: "" });
    expect(result.success).toBe(false);
  });
});
