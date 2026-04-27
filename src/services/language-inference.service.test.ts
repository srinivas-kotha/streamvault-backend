import { describe, it, expect } from "vitest";
import {
  inferLanguage,
  isOttPlatform,
  LANGUAGE_PATTERNS,
  OTT_PLATFORM_PATTERNS,
} from "./language-inference.service";

// ─── LANGUAGE_PATTERNS shape ─────────────────────────────────────────────────

describe("LANGUAGE_PATTERNS", () => {
  it("has entries for all four languages", () => {
    expect(Object.keys(LANGUAGE_PATTERNS)).toEqual(
      expect.arrayContaining(["telugu", "hindi", "english", "sports"]),
    );
  });

  it("telugu patterns include the broader Telugu-only channel set", () => {
    expect(LANGUAGE_PATTERNS.telugu).toEqual(
      expect.arrayContaining([
        "telugu",
        "aha",
        "star maa",
        "etv",
        "gemini",
        "maa tv",
        "mahaa",
      ]),
    );
  });

  it("hindi patterns include the broader Hindi-only channel set", () => {
    expect(LANGUAGE_PATTERNS.hindi).toEqual(
      expect.arrayContaining([
        "hindi",
        "bollywood",
        "colors tv",
        "star plus",
        "zee tv",
        "sab tv",
        "and tv",
        "sony set",
      ]),
    );
  });

  it("english patterns do NOT include OTT platforms (multi-lang)", () => {
    expect(LANGUAGE_PATTERNS.english).not.toContain("netflix");
    expect(LANGUAGE_PATTERNS.english).not.toContain("amazon");
    expect(LANGUAGE_PATTERNS.english).toContain("english");
    expect(LANGUAGE_PATTERNS.english).toContain("hbo");
    expect(LANGUAGE_PATTERNS.english).toContain("apple tv");
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

  it("matches Telugu-only OTT 'Aha Originals'", () => {
    expect(inferLanguage("Aha Originals")).toBe("telugu");
  });

  it("matches Telugu broadcaster 'Star Maa Movies'", () => {
    expect(inferLanguage("Star Maa Movies")).toBe("telugu");
  });

  it("matches Telugu broadcaster 'Gemini TV'", () => {
    expect(inferLanguage("Gemini TV")).toBe("telugu");
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

  it("matches Hindi broadcaster 'Colors TV HD'", () => {
    expect(inferLanguage("Colors TV HD")).toBe("hindi");
  });

  it("matches Hindi broadcaster 'Star Plus'", () => {
    expect(inferLanguage("Star Plus")).toBe("hindi");
  });

  it("matches Hindi broadcaster 'Zee TV'", () => {
    expect(inferLanguage("Zee TV")).toBe("hindi");
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

  it("matches 'HBO Series'", () => {
    expect(inferLanguage("HBO Series")).toBe("english");
  });

  it("matches 'Apple TV+'", () => {
    expect(inferLanguage("Apple TV+")).toBe("english");
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

// ─── inferLanguage — OTT platforms return null ───────────────────────────────

describe("inferLanguage — multi-language OTT platforms return null", () => {
  it("returns null for 'Netflix Originals' (mis-bucketed Telugu/Hindi as English before)", () => {
    expect(inferLanguage("Netflix Originals")).toBeNull();
  });

  it("returns null for 'Amazon Prime Video'", () => {
    expect(inferLanguage("Amazon Prime Video")).toBeNull();
  });

  it("returns null for 'Disney+ Hotstar'", () => {
    expect(inferLanguage("Disney+ Hotstar")).toBeNull();
  });

  it("returns null for 'Zee5'", () => {
    expect(inferLanguage("Zee5")).toBeNull();
  });

  it("returns null for 'SonyLIV'", () => {
    expect(inferLanguage("SonyLIV")).toBeNull();
  });

  it("returns null for 'JioCinema'", () => {
    expect(inferLanguage("JioCinema")).toBeNull();
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
    const result = inferLanguage("Telugu Indian Movies");
    expect(result).toBe("telugu");
  });
});

// ─── isOttPlatform helper ────────────────────────────────────────────────────

describe("isOttPlatform", () => {
  it.each([
    ["Netflix Originals"],
    ["Amazon Prime Video"],
    ["Disney+ Hotstar"],
    ["Zee5"],
    ["SonyLIV"],
    ["Sony LIV"],
    ["JioCinema"],
    ["Jio Cinema"],
    ["Voot Select"],
    ["Prime Video"],
    ["Alt Balaji"],
    ["AltBalaji"],
  ])("matches '%s' as an OTT platform", (name) => {
    expect(isOttPlatform(name)).toBe(true);
  });

  it.each([
    ["Telugu Movies"],
    ["Star Plus"],
    ["HBO Series"],
    ["News"],
    [""],
  ])("returns false for non-OTT '%s'", (name) => {
    expect(isOttPlatform(name)).toBe(false);
  });
});

// ─── OTT_PLATFORM_PATTERNS shape ─────────────────────────────────────────────

describe("OTT_PLATFORM_PATTERNS", () => {
  it("includes the major Indian + global OTT platforms", () => {
    expect(OTT_PLATFORM_PATTERNS).toEqual(
      expect.arrayContaining([
        "netflix",
        "amazon",
        "prime video",
        "hotstar",
        "zee5",
        "sonyliv",
        "jiocinema",
      ]),
    );
  });
});
