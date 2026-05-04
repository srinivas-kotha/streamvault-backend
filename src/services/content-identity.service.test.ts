import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import {
  normalize,
  computeContentUid,
  findNearDuplicates,
} from "./content-identity.service";

// ─────────────────────────────────────────────────────────────────────────────
// normalize
// ─────────────────────────────────────────────────────────────────────────────

describe("normalize", () => {
  it.each([
    ["Mad For Each Other - S1E3", "mad for each other"],
    ["Mad For Each Other · S1E03 - ", "mad for each other"],
    ["Border 2 (2026) (Hindi)", "border 2"],
    ["Border 2 [2026] (Hindi)", "border 2"],
    ["One Battle After Another (2025)", "one battle after another"],
    ["Amélie", "amelie"],
    ["The Office (2005)", "the office"],
    ["IN || & TV HD", "& tv hd"],
    ["USA: CBS REALITY", "cbs reality"],
    ["[IN] Sun TV HD", "sun tv hd"],
    ["The Office", "the office"], // NBSP
    ["The​Office", "the office"], // ZWSP
    ["The 'Office'", "the office"],
    ["Naruto: Shippuden", "naruto shippuden"],
    ["The Office — UK", "the office uk"],
    ["", ""],
  ])('"%s" → "%s"', (input, expected) => {
    expect(normalize(input, "live")).toBe(expected);
  });

  it("idempotent — normalize(normalize(x)) === normalize(x)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const n1 = normalize(s, "movie");
        const n2 = normalize(n1, "movie");
        return n1 === n2;
      }),
    );
  });

  it("returns empty string on null/whitespace input", () => {
    expect(normalize(null as unknown as string, "movie")).toBe("");
    expect(normalize("   ", "movie")).toBe("");
    expect(normalize(" ​", "movie")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeContentUid
// ─────────────────────────────────────────────────────────────────────────────

describe("computeContentUid", () => {
  it("movie: same title+year → same uid", () => {
    const a = computeContentUid({
      type: "movie",
      title: "Border 2",
      year: 2026,
    });
    const b = computeContentUid({
      type: "movie",
      title: "Border 2",
      year: 2026,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it("movie: different year → different uid", () => {
    const a = computeContentUid({
      type: "movie",
      title: "Border 2",
      year: 2026,
    });
    const b = computeContentUid({
      type: "movie",
      title: "Border 2",
      year: 2018,
    });
    expect(a).not.toBe(b);
  });

  it("episode: derives from parent_show_uid + S+E", () => {
    const showUid = computeContentUid({
      type: "series",
      title: "Mad For Each Other",
      year: 2025,
    });
    const ep = computeContentUid({
      type: "episode",
      parentShowUid: showUid,
      seasonNum: 1,
      episodeNum: 3,
    });
    expect(ep).toMatch(/^[a-f0-9]{16}$/);
    // Episode uid is independent of episode title
    const ep2 = computeContentUid({
      type: "episode",
      parentShowUid: showUid,
      seasonNum: 1,
      episodeNum: 3,
    });
    expect(ep).toBe(ep2);
  });

  it("live: normalises country prefix", () => {
    const a = computeContentUid({ type: "live", title: "USA: CBS REALITY" });
    const b = computeContentUid({ type: "live", title: "[USA] CBS Reality" });
    const c = computeContentUid({ type: "live", title: "USA || CBS REALITY" });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("returns empty string '' uid for null/whitespace title (caller must skip)", () => {
    expect(computeContentUid({ type: "movie", title: "", year: 2026 })).toBe(
      "",
    );
    expect(
      computeContentUid({
        type: "movie",
        title: null as unknown as string,
        year: 2026,
      }),
    ).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveOrCreateContentUid (mocked query)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveOrCreateContentUid", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("title-only hit returns confidence:medium when year present", async () => {
    vi.doMock("./db.service", () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));
    const { resolveOrCreateContentUid } =
      await import("./content-identity.service");
    const result = await resolveOrCreateContentUid({
      type: "movie",
      title: "Border 2",
      year: 2026,
      raw_data: {},
    });
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("medium");
    expect(result!.content_uid).toMatch(/^[a-f0-9]{16}$/);
  });

  it("title-only hit returns confidence:low when year absent", async () => {
    vi.doMock("./db.service", () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));
    const { resolveOrCreateContentUid } =
      await import("./content-identity.service");
    const result = await resolveOrCreateContentUid({
      type: "movie",
      title: "Some Movie",
      year: null,
      raw_data: {},
    });
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("low");
  });

  it("external_id hit returns confidence:high", async () => {
    const mockUid = "abcdef1234567890";
    vi.doMock("./db.service", () => ({
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ content_uid: mockUid }] }) // external_id lookup
        .mockResolvedValueOnce({ rows: [{ content_uid: mockUid }] }), // existence check
    }));
    const { resolveOrCreateContentUid } =
      await import("./content-identity.service");
    const result = await resolveOrCreateContentUid({
      type: "movie",
      title: "Border 2",
      year: 2026,
      raw_data: { imdb_id: "tt1234567" },
    });
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.content_uid).toBe(mockUid);
  });

  it("conflict (external→A, title→B) returns A with conflict field set", async () => {
    const externalUid = "aaaaaaaabbbbbbbb";
    vi.doMock("./db.service", () => ({
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ content_uid: externalUid }] }), // external_id lookup
    }));
    const { resolveOrCreateContentUid } =
      await import("./content-identity.service");
    // title+year produces a different uid than externalUid
    const result = await resolveOrCreateContentUid({
      type: "movie",
      title: "Completely Different Title",
      year: 1999,
      raw_data: { imdb_id: "tt9999999" },
    });
    expect(result).not.toBeNull();
    expect(result!.content_uid).toBe(externalUid);
    expect(result!.confidence).toBe("high");
    expect(result!.conflict).toBeDefined();
    expect(result!.conflict!.external_id_uid).toBe(externalUid);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findNearDuplicates
// ─────────────────────────────────────────────────────────────────────────────

describe("findNearDuplicates", () => {
  it("flags titles within Levenshtein distance 2 in same length window", async () => {
    const pairs = await findNearDuplicates([
      { content_uid: "a", normalized_title: "border 2", content_type: "movie" },
      {
        content_uid: "b",
        normalized_title: "border ii",
        content_type: "movie",
      },
    ]);
    expect(pairs).toContainEqual({
      uid_a: "a",
      uid_b: "b",
      reason: "near_duplicate",
    });
  });

  it("does NOT flag titles in different length windows", async () => {
    const pairs = await findNearDuplicates([
      { content_uid: "a", normalized_title: "ab", content_type: "movie" },
      {
        content_uid: "b",
        normalized_title: "abcdefghij",
        content_type: "movie",
      },
    ]);
    expect(pairs).toHaveLength(0);
  });

  it("does NOT flag across content_type", async () => {
    const pairs = await findNearDuplicates([
      { content_uid: "a", normalized_title: "abc", content_type: "movie" },
      { content_uid: "b", normalized_title: "abc", content_type: "series" },
    ]);
    expect(pairs).toHaveLength(0);
  });
});
