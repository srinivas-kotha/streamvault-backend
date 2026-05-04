import { describe, it, expect } from "vitest";
import { extractExternalIds } from "./probe-provider-external-ids";

describe("extractExternalIds", () => {
  it("returns imdb_id when raw_data has imdb_id", () => {
    expect(extractExternalIds({ imdb_id: "tt1234567" })).toEqual({
      imdb_id: "tt1234567",
    });
  });

  it("returns tmdb_id when raw_data has tmdb_id (numeric or string)", () => {
    expect(extractExternalIds({ tmdb_id: 998 })).toEqual({ tmdb_id: "998" });
    expect(extractExternalIds({ tmdb_id: "998" })).toEqual({ tmdb_id: "998" });
  });

  it("recognises field aliases: imdbid, tmdbid, tvdbid", () => {
    expect(extractExternalIds({ imdbid: "tt1234567" })).toEqual({
      imdb_id: "tt1234567",
    });
    expect(extractExternalIds({ tmdbid: 12 })).toEqual({ tmdb_id: "12" });
    expect(extractExternalIds({ tvdbid: 77 })).toEqual({ tvdb_id: "77" });
  });

  it("returns {} when none present", () => {
    expect(extractExternalIds({ name: "X" })).toEqual({});
  });

  it("ignores empty string ids", () => {
    expect(extractExternalIds({ imdb_id: "" })).toEqual({});
  });
});
