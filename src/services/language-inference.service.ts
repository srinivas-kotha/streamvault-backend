/**
 * Language Inference Service
 *
 * Server-side language inference by matching category names against known
 * language patterns. Source-of-truth for the patterns shared between
 * frontend and backend; the frontend mirror lives at
 * `streamvault-v3-frontend/src/lib/inferLanguage.ts`.
 *
 * KEEP THE PATTERN SET IN LOCKSTEP. A drift causes a category to surface
 * under one language on Live/Movies/Series (server-annotated) but a
 * different language on Search (client-annotated), producing inconsistent
 * results across surfaces.
 */

export type InferredLang = "telugu" | "hindi" | "english" | "sports";

/**
 * Language → category-name substring patterns. Order matters: first match
 * wins (telugu before hindi before english before sports). Case-insensitive.
 *
 * Multi-language OTT platforms (Netflix, Hotstar, Zee5, Prime Video, etc.)
 * are NOT in this table — they would mis-bucket Telugu/Hindi titles as
 * English. They live in OTT_PLATFORM_PATTERNS instead.
 */
export const LANGUAGE_PATTERNS: Record<InferredLang, string[]> = {
  telugu: [
    "telugu",
    "aha",
    "star maa",
    "etv",
    "gemini",
    "maa tv",
    "mahaa",
  ],
  hindi: [
    "hindi",
    "india entertainment",
    "indian",
    "bollywood",
    "colors tv",
    "colors hindi",
    "star plus",
    "star bharat",
    "zee tv",
    "sab tv",
    "and tv",
    "mtv hindi",
    "sun neo",
    "sony set",
    "bigg boss",
  ],
  english: ["english", "hbo", "apple tv", "usa ", "uk "],
  sports: [
    "sport",
    "sports",
    "football",
    "cricket",
    "tennis",
    "nba",
    "nfl",
    "mlb",
    "epl",
    "ipl",
    "rugby",
    "f1",
    "racing",
  ],
};

/**
 * Multi-language OTT / streaming-service categories.
 *
 * These platforms carry Telugu, Hindi, and English content side-by-side.
 * Routing the whole category to one language would mis-bucket the rest.
 * Frontend handles per-item disambiguation via series-name matching; the
 * backend exposes this list so callers can detect and skip auto-tagging.
 */
export const OTT_PLATFORM_PATTERNS: string[] = [
  "hotstar",
  "disney+",
  "zee5",
  "sonyliv",
  "sony liv",
  "jiocinema",
  "jio cinema",
  "voot",
  "netflix",
  "amazon",
  "prime video",
  "alt balaji",
  "altbalaji",
];

/**
 * True when a category looks like a multi-language OTT platform.
 * Such categories should be left as inferredLang: null.
 */
export function isOttPlatform(categoryName: string): boolean {
  const lower = categoryName.toLowerCase();
  return OTT_PLATFORM_PATTERNS.some((pat) => lower.includes(pat));
}

/**
 * Infer the language of a catalog item from its category name.
 *
 * Returns the first matching language, or null when no pattern matches OR
 * when the category is a multi-language OTT platform.
 */
export function inferLanguage(categoryName: string): InferredLang | null {
  const lower = categoryName.toLowerCase();
  if (OTT_PLATFORM_PATTERNS.some((pat) => lower.includes(pat))) {
    return null;
  }
  for (const [lang, patterns] of Object.entries(LANGUAGE_PATTERNS) as Array<
    [InferredLang, string[]]
  >) {
    if (patterns.some((pat) => lower.includes(pat))) {
      return lang;
    }
  }
  return null;
}
