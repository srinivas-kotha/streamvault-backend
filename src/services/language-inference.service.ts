/**
 * Language Inference Service
 *
 * Provides server-side language inference by matching category names against
 * known language patterns. This replaces the client-side LANGUAGE_PATTERNS
 * regex blocks that were duplicated across LiveRoute, MoviesRoute, and
 * SeriesRoute in the frontend (issue streamvault-v3-frontend#52).
 *
 * The patterns mirror what was in the frontend exactly.
 */

export type InferredLang = "telugu" | "hindi" | "english" | "sports";

/**
 * Language → category-name substring patterns.
 * Matched case-insensitively against the item's resolved category name.
 * Order matters: first match wins.
 */
export const LANGUAGE_PATTERNS: Record<InferredLang, string[]> = {
  telugu: ["telugu"],
  hindi: ["hindi", "india entertainment", "indian", "bollywood"],
  english: ["english", "netflix", "amazon", "hbo", "usa ", "uk "],
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
 * Infer the language of a catalog item from its category name.
 *
 * Matching is case-insensitive substring matching. Returns the first
 * matching language, or null when no pattern matches.
 *
 * @param categoryName - The resolved category name (e.g. "Telugu Movies HD")
 * @returns The inferred language id, or null if no match
 */
export function inferLanguage(categoryName: string): InferredLang | null {
  const lower = categoryName.toLowerCase();
  for (const [lang, patterns] of Object.entries(LANGUAGE_PATTERNS) as Array<
    [InferredLang, string[]]
  >) {
    if (patterns.some((pat) => lower.includes(pat))) {
      return lang;
    }
  }
  return null;
}
