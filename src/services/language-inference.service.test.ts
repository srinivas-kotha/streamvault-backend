import { describe, it, expect } from "vitest";
import { inferLanguage, LANGUAGE_PATTERNS } from "./language-inference.service";

// ─── LANGUAGE_PATTERNS shape ─────────────────────────────────────────────────

describe("LANGUAGE_PATTERNS", () => {
  it("has entries for all four languages", () => {
    expect(Object.keys(LANGUAGE_PATTERNS)).toEqual(
      expect.arrayContaining(["telugu", "hindi", "english", "sports"]),
    );
  });

  it("telugu patterns include 'telugu'", () => {
    expect(LANGUAGE_PATTERNS.telugu).toContain("telugu");
  });

  it("hindi patterns include 'hindi' and 'bollywood'", () => {
    expect(LANGUAGE_PATTERNS.hindi).toContain("hindi");
    expect(LANGUAGE_PATTERNS.hindi).toContain("bollywood");
  });

  it("english patterns include 'english', 'netflix', 'amazon'", () => {
    expect(LANGUAGE_PATTERNS.english).toContain("english");
    expect(LANGUAGE_PATTERNS.english).toContain("netflix");
    expect(LANGUAGE_PATTERNS.english).toContain("amazon");
  });

  it("sports patterns include 'sports', 'cricket', 'football'", () => {
    expect(LANGUAGE_PATTERNS.sports).toContain("sports");
    expect(LANGUAGE_PATTERNS.sports).toContain("cricket");
    expect(LANGUAGE_PATTERNS.sports).toContain("football");
  });
});

// ─── inferLanguage — telugu ──────────────────────────────────────────────────

describe("inferLanguage — telugu", () => {
  it("matches 'Telugu Movies HD'", () => {
    expect(inferLanguage("Telugu Movies HD")).toBe("telugu");
  });

  it("matches case-insensitively 'TELUGU SERIALS'", () => {
    expect(inferLanguage("TELUGU SERIALS")).toBe("telugu");
  });

  it("matches mixed case 'Star Maa (Telugu)'", () => {
    expect(inferLanguage("Star Maa (Telugu)")).toBe("telugu");
  });
});

// ─── inferLanguage — hindi ───────────────────────────────────────────────────

describe("inferLanguage — hindi", () => {
  it("matches 'Hindi Movies'", () => {
    expect(inferLanguage("Hindi Movies")).toBe("hindi");
  });

  it("matches 'India Entertainment'", () => {
    expect(inferLanguage("India Entertainment")).toBe("hindi");
  });

  it("matches 'Indian Channels'", () => {
    expect(inferLanguage("Indian Channels")).toBe("hindi");
  });

  it("matches 'Bollywood Classics'", () => {
    expect(inferLanguage("Bollywood Classics")).toBe("hindi");
  });

  it("matches case-insensitively 'HINDI SERIALS'", () => {
    expect(inferLanguage("HINDI SERIALS")).toBe("hindi");
  });
});

// ─── inferLanguage — english ─────────────────────────────────────────────────

describe("inferLanguage — english", () => {
  it("matches 'English Movies'", () => {
    expect(inferLanguage("English Movies")).toBe("english");
  });

  it("matches 'Netflix Originals'", () => {
    expect(inferLanguage("Netflix Originals")).toBe("english");
  });

  it("matches 'Amazon Prime'", () => {
    expect(inferLanguage("Amazon Prime")).toBe("english");
  });

  it("matches 'HBO Series'", () => {
    expect(inferLanguage("HBO Series")).toBe("english");
  });

  it("matches 'USA Channels'", () => {
    expect(inferLanguage("USA Channels")).toBe("english");
  });

  it("matches 'UK Entertainment'", () => {
    expect(inferLanguage("UK Entertainment")).toBe("english");
  });

  it("matches case-insensitively 'ENGLISH SERIES'", () => {
    expect(inferLanguage("ENGLISH SERIES")).toBe("english");
  });
});

// ─── inferLanguage — sports ──────────────────────────────────────────────────

describe("inferLanguage — sports", () => {
  it("matches 'Sports HD'", () => {
    expect(inferLanguage("Sports HD")).toBe("sports");
  });

  it("matches 'IPL Cricket Live'", () => {
    expect(inferLanguage("IPL Cricket Live")).toBe("sports");
  });

  it("matches 'Football Channels'", () => {
    expect(inferLanguage("Football Channels")).toBe("sports");
  });

  it("matches 'NBA Basketball'", () => {
    expect(inferLanguage("NBA Basketball")).toBe("sports");
  });

  it("matches 'NFL Games'", () => {
    expect(inferLanguage("NFL Games")).toBe("sports");
  });

  it("matches 'F1 Racing'", () => {
    expect(inferLanguage("F1 Racing")).toBe("sports");
  });

  it("matches 'Cricket Live'", () => {
    expect(inferLanguage("Cricket Live")).toBe("sports");
  });

  it("matches 'Tennis Grand Slam'", () => {
    expect(inferLanguage("Tennis Grand Slam")).toBe("sports");
  });
});

// ─── inferLanguage — no match ────────────────────────────────────────────────

describe("inferLanguage — no match returns null", () => {
  it("returns null for 'News'", () => {
    expect(inferLanguage("News")).toBeNull();
  });

  it("returns null for 'Action Movies'", () => {
    expect(inferLanguage("Action Movies")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(inferLanguage("")).toBeNull();
  });

  it("returns null for 'Kids'", () => {
    expect(inferLanguage("Kids")).toBeNull();
  });

  it("returns null for 'Documentary'", () => {
    expect(inferLanguage("Documentary")).toBeNull();
  });
});

// ─── inferLanguage — first-match ordering ────────────────────────────────────

describe("inferLanguage — first-match ordering", () => {
  it("returns 'telugu' for a category that could match telugu before hindi", () => {
    // 'Telugu Indian' matches telugu first, not hindi (because telugu is checked first)
    const result = inferLanguage("Telugu Indian Movies");
    expect(result).toBe("telugu");
  });
});
