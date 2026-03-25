// These tests define the contract: every provider method must return normalized types
// (CatalogCategory, CatalogItem, CatalogItemDetail, EPGEntry) by
// running raw Xtream API responses through the adapter functions.
//
// Mocking strategy:
//   - Spy on the protected `cachedFetch` / `fetchJson` methods on the provider instance
//   - Return realistic raw Xtream API responses
//   - Assert the provider returns normalized shapes — NOT raw Xtream shapes

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { XtreamProvider } from "./xtream.provider";
import { cacheFlush } from "../../services/cache.service";
import type {
  CatalogCategory,
  CatalogItem,
  CatalogItemDetail,
  EPGEntry,
} from "../provider.types";
import type {
  XtreamCategory,
  XtreamLiveStream,
  XtreamVODStream,
  XtreamSeriesItem,
  XtreamVODInfo,
  XtreamSeriesInfo,
  XtreamEPGItem,
} from "./xtream.types";

// ---------------------------------------------------------------------------
// Shared config / factory
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  host: "test.example.com",
  port: 8080,
  username: "testuser",
  password: "testpass",
};

function makeProvider(): XtreamProvider {
  return new XtreamProvider(TEST_CONFIG);
}

// ---------------------------------------------------------------------------
// Raw Xtream fixtures (realistic API responses)
// ---------------------------------------------------------------------------

const rawCategories: XtreamCategory[] = [
  { category_id: "1", category_name: "News", parent_id: 0 },
  { category_id: "2", category_name: "Sports", parent_id: 0 },
  { category_id: "3", category_name: "US News", parent_id: 1 },
];

const rawLiveStreams: XtreamLiveStream[] = [
  {
    num: 1,
    name: "CNN HD",
    stream_type: "live",
    stream_id: 101,
    stream_icon: "https://example.com/cnn.png",
    epg_channel_id: "cnn.us",
    added: "1698000000",
    is_adult: "0",
    category_id: "5",
    category_ids: [5],
    custom_sid: "",
    tv_archive: 0,
    direct_source: "",
    tv_archive_duration: 0,
  },
  {
    num: 2,
    name: "Adult Channel",
    stream_type: "live",
    stream_id: 102,
    stream_icon: "",
    epg_channel_id: "adult.1",
    added: "1698000001",
    is_adult: "1",
    category_id: "5",
    category_ids: [5],
    custom_sid: "",
    tv_archive: 0,
    direct_source: "",
    tv_archive_duration: 0,
  },
];

const rawVODStreams: XtreamVODStream[] = [
  {
    num: 1,
    name: "Interstellar",
    stream_type: "movie",
    stream_id: 202,
    stream_icon: "https://example.com/interstellar.jpg",
    rating: "8.6",
    rating_5based: 4.3,
    added: "1700000000",
    is_adult: "0",
    category_id: "12",
    category_ids: [12],
    container_extension: "mkv",
    custom_sid: "",
    direct_source: "",
  },
  {
    num: 2,
    name: "Adult Film",
    stream_type: "movie",
    stream_id: 203,
    stream_icon: "",
    rating: "",
    rating_5based: 0,
    added: "1700000002",
    is_adult: "1",
    category_id: "12",
    category_ids: [12],
    container_extension: "mp4",
    custom_sid: "",
    direct_source: "",
  },
];

const rawSeriesItems: XtreamSeriesItem[] = [
  {
    num: 1,
    name: "Breaking Bad",
    series_id: 303,
    cover: "https://example.com/bb.jpg",
    plot: "A chemistry teacher turns to cooking methamphetamine.",
    cast: "Bryan Cranston, Aaron Paul",
    director: "Vince Gilligan",
    genre: "Crime, Drama",
    releaseDate: "2008-01-20",
    last_modified: "1710000000",
    rating: "9.5",
    rating_5based: 4.75,
    backdrop_path: ["https://example.com/bb-backdrop.jpg"],
    category_id: "7",
    category_ids: [7],
  },
];

const rawVODInfo: XtreamVODInfo = {
  info: {
    movie_image: "https://example.com/inter-poster.jpg",
    tmdb_id: "157336",
    name: "Interstellar",
    o_name: "Interstellar",
    plot: "A team of explorers travel through a wormhole in space.",
    cast: "Matthew McConaughey, Anne Hathaway",
    director: "Christopher Nolan",
    genre: "Adventure, Drama, Sci-Fi",
    releaseDate: "2014-11-07",
    duration: "169 min",
    duration_secs: 10140,
    rating: "8.6",
  },
  movie_data: {
    stream_id: 202,
    name: "Interstellar",
    added: "1700000000",
    category_id: "12",
    container_extension: "mkv",
    custom_sid: "",
    direct_source: "",
  },
};

const rawSeriesInfo: XtreamSeriesInfo = {
  info: {
    name: "Breaking Bad",
    cover: "https://example.com/bb.jpg",
    plot: "A chemistry teacher turns to cooking methamphetamine.",
    cast: "Bryan Cranston, Aaron Paul",
    director: "Vince Gilligan",
    genre: "Crime, Drama",
    releaseDate: "2008-01-20",
    rating: "9.5",
    backdrop_path: ["https://example.com/bb-backdrop.jpg"],
  },
  seasons: [
    {
      air_date: "2008-01-20",
      episode_count: 7,
      id: 1,
      name: "Season 1",
      overview: "Walter White begins his transformation.",
      season_number: 1,
      cover: "https://example.com/bb-s1.jpg",
    },
  ],
  episodes: {
    "1": [
      {
        id: "ep001",
        episode_num: 1,
        title: "Pilot",
        container_extension: "mkv",
        info: {
          duration_secs: 3840,
          duration: "64 min",
          plot: "Walter White receives a cancer diagnosis.",
          movie_image: "https://example.com/bb-s1e1.jpg",
        },
        season: 1,
        direct_source: "",
      },
    ],
  },
};

const rawEPGItems: XtreamEPGItem[] = [
  {
    id: "epg999",
    epg_id: "cnn.us",
    title: "World News Tonight",
    lang: "en",
    start: "2024-01-15 20:00:00",
    end: "2024-01-15 20:30:00",
    description: "Top stories from around the globe.",
    channel_id: "cnn-hd",
    start_timestamp: "1705348800",
    stop_timestamp: "1705350600",
  },
  {
    id: "epg1000",
    epg_id: "cnn.us",
    title: "Late Edition",
    lang: "en",
    start: "2024-01-15 20:30:00",
    end: "2024-01-15 21:00:00",
    description: "Breaking news updates.",
    channel_id: "cnn-hd",
    start_timestamp: "1705350600",
    stop_timestamp: "1705352400",
  },
];

// ---------------------------------------------------------------------------
// getCategories() — returns CatalogCategory[]
// ---------------------------------------------------------------------------

describe("XtreamProvider.getCategories() — returns CatalogCategory[]", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = makeProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns CatalogCategory[] with camelCase id field for live type", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawCategories);

    const result = await provider.getCategories("live");

    expect(result[0]).toHaveProperty("id");
    expect(result[0]).not.toHaveProperty("category_id");
  });

  it("maps category_id (string) → id (string)", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawCategories);

    const result = await provider.getCategories("live");

    expect(result[0]!.id).toBe("1");
    expect(result[1]!.id).toBe("2");
  });

  it("maps category_name → name", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawCategories);

    const result = await provider.getCategories("live");

    expect(result[0]!.name).toBe("News");
    expect(result[1]!.name).toBe("Sports");
  });

  it("maps parent_id 0 → parentId null", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawCategories);

    const result = await provider.getCategories("live");

    expect(result[0]!.parentId).toBeNull();
  });

  it("maps non-zero parent_id → parentId as string", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawCategories);

    const result = await provider.getCategories("live");

    // rawCategories[2] has parent_id: 1
    expect(result[2]!.parentId).toBe("1");
  });

  it("sets type to 'live' for live categories", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawCategories);

    const result = await provider.getCategories("live");

    result.forEach((cat) => expect(cat.type).toBe("live"));
  });

  it("sets type to 'vod' for vod categories", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawCategories);

    const result = await provider.getCategories("vod");

    result.forEach((cat) => expect(cat.type).toBe("vod"));
  });

  it("sets type to 'series' for series categories", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawCategories);

    const result = await provider.getCategories("series");

    result.forEach((cat) => expect(cat.type).toBe("series"));
  });

  it("returns the correct full CatalogCategory shape", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([
      rawCategories[0],
    ]);

    const result = await provider.getCategories("live");

    expect(result[0]).toEqual<CatalogCategory>({
      id: "1",
      name: "News",
      parentId: null,
      type: "live",
    });
  });

  it("returns empty array when API returns empty", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([]);

    const result = await provider.getCategories("live");

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getStreams() — returns CatalogItem[]
// ---------------------------------------------------------------------------

describe("XtreamProvider.getStreams() — live — returns CatalogItem[]", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = makeProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns CatalogItem[] with camelCase id field", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawLiveStreams);

    const result = await provider.getStreams("5", "live");

    expect(result[0]).toHaveProperty("id");
    expect(result[0]).not.toHaveProperty("stream_id");
  });

  it("maps stream_id (number) → id (string)", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawLiveStreams);

    const result = await provider.getStreams("5", "live");

    expect(result[0]!.id).toBe("101");
  });

  it("sets type to 'live'", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawLiveStreams);

    const result = await provider.getStreams("5", "live");

    result.forEach((item) => expect(item.type).toBe("live"));
  });

  it("maps categoryId as string", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawLiveStreams);

    const result = await provider.getStreams("5", "live");

    expect(result[0]!.categoryId).toBe("5");
  });

  it("maps is_adult '0' → isAdult false", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawLiveStreams);

    const result = await provider.getStreams("5", "live");

    expect(result[0]!.isAdult).toBe(false);
  });

  it("maps is_adult '1' → isAdult true", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawLiveStreams);

    const result = await provider.getStreams("5", "live");

    // rawLiveStreams[1] has is_adult: "1"
    expect(result[1]!.isAdult).toBe(true);
  });

  it("maps empty stream_icon → icon null", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawLiveStreams);

    const result = await provider.getStreams("5", "live");

    // rawLiveStreams[1] has stream_icon: ""
    expect(result[1]!.icon).toBeNull();
  });

  it("returns the correct full CatalogItem shape for live", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([
      rawLiveStreams[0],
    ]);

    const result = await provider.getStreams("5", "live");

    expect(result[0]).toEqual<CatalogItem>({
      id: "101",
      name: "CNN HD",
      type: "live",
      categoryId: "5",
      icon: "https://example.com/cnn.png",
      added: "1698000000",
      isAdult: false,
    });
  });
});

describe("XtreamProvider.getStreams() — vod — returns CatalogItem[]", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = makeProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps stream_id (number) → id (string) for VOD", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODStreams);

    const result = await provider.getStreams("12", "vod");

    expect(result[0]!.id).toBe("202");
  });

  it("sets type to 'vod'", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODStreams);

    const result = await provider.getStreams("12", "vod");

    result.forEach((item) => expect(item.type).toBe("vod"));
  });

  it("maps rating field for VOD", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODStreams);

    const result = await provider.getStreams("12", "vod");

    expect(result[0]!.rating).toBe("8.6");
  });

  it("maps is_adult '1' → isAdult true for VOD", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODStreams);

    const result = await provider.getStreams("12", "vod");

    expect(result[1]!.isAdult).toBe(true);
  });

  it("returns the correct full CatalogItem shape for VOD", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([
      rawVODStreams[0],
    ]);

    const result = await provider.getStreams("12", "vod");

    expect(result[0]).toEqual<CatalogItem>({
      id: "202",
      name: "Interstellar",
      type: "vod",
      categoryId: "12",
      icon: "https://example.com/interstellar.jpg",
      added: "1700000000",
      isAdult: false,
      rating: "8.6",
    });
  });
});

describe("XtreamProvider.getStreams() — series — returns CatalogItem[]", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = makeProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses series_id (not stream_id) → id (string)", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesItems);

    const result = await provider.getStreams("7", "series");

    // series_id is 303 — must NOT fall back to stream_id
    expect(result[0]!.id).toBe("303");
  });

  it("sets type to 'series'", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesItems);

    const result = await provider.getStreams("7", "series");

    result.forEach((item) => expect(item.type).toBe("series"));
  });

  it("maps cover → icon for series", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesItems);

    const result = await provider.getStreams("7", "series");

    expect(result[0]!.icon).toBe("https://example.com/bb.jpg");
  });

  it("maps genre for series", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesItems);

    const result = await provider.getStreams("7", "series");

    expect(result[0]!.genre).toBe("Crime, Drama");
  });

  it("maps year from releaseDate for series", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesItems);

    const result = await provider.getStreams("7", "series");

    expect(result[0]!.year).toBe("2008");
  });

  it("returns the correct full CatalogItem shape for series", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([
      rawSeriesItems[0],
    ]);

    const result = await provider.getStreams("7", "series");

    expect(result[0]).toEqual<CatalogItem>({
      id: "303",
      name: "Breaking Bad",
      type: "series",
      categoryId: "7",
      icon: "https://example.com/bb.jpg",
      added: "1710000000",
      isAdult: false,
      rating: "9.5",
      genre: "Crime, Drama",
      year: "2008",
    });
  });
});

// ---------------------------------------------------------------------------
// getVODInfo() — returns CatalogItemDetail
// ---------------------------------------------------------------------------

describe("XtreamProvider.getVODInfo() — returns CatalogItemDetail", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = makeProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns CatalogItemDetail with camelCase fields", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODInfo);

    const result = await provider.getVODInfo("202");

    // Should have normalized fields
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("tmdbId");
    expect(result).toHaveProperty("containerExtension");
    // Should NOT have raw Xtream field names
    expect(result).not.toHaveProperty("tmdb_id");
    expect(result).not.toHaveProperty("container_extension");
    expect(result).not.toHaveProperty("movie_data");
    expect(result).not.toHaveProperty("info");
  });

  it("maps movie_data.stream_id → id (string)", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODInfo);

    const result = await provider.getVODInfo("202");

    expect(result.id).toBe("202");
  });

  it("maps info.plot → plot", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODInfo);

    const result = await provider.getVODInfo("202");

    expect(result.plot).toBe(
      "A team of explorers travel through a wormhole in space.",
    );
  });

  it("maps info.cast → cast", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODInfo);

    const result = await provider.getVODInfo("202");

    expect(result.cast).toBe("Matthew McConaughey, Anne Hathaway");
  });

  it("maps movie_data.container_extension → containerExtension", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODInfo);

    const result = await provider.getVODInfo("202");

    expect(result.containerExtension).toBe("mkv");
  });

  it("maps info.tmdb_id → tmdbId", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODInfo);

    const result = await provider.getVODInfo("202");

    expect(result.tmdbId).toBe("157336");
  });

  it("maps info.duration_secs → durationSecs", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODInfo);

    const result = await provider.getVODInfo("202");

    expect(result.durationSecs).toBe(10140);
  });

  it("maps type to 'vod'", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODInfo);

    const result = await provider.getVODInfo("202");

    expect(result.type).toBe("vod");
  });

  it("returns the correct full CatalogItemDetail shape", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawVODInfo);

    const result = await provider.getVODInfo("202");

    expect(result).toEqual<CatalogItemDetail>({
      id: "202",
      name: "Interstellar",
      type: "vod",
      categoryId: "12",
      icon: "https://example.com/inter-poster.jpg",
      added: "1700000000",
      isAdult: false,
      rating: "8.6",
      genre: "Adventure, Drama, Sci-Fi",
      plot: "A team of explorers travel through a wormhole in space.",
      cast: "Matthew McConaughey, Anne Hathaway",
      director: "Christopher Nolan",
      duration: "169 min",
      durationSecs: 10140,
      containerExtension: "mkv",
      backdropUrl: "https://example.com/inter-poster.jpg",
      tmdbId: "157336",
    });
  });
});

// ---------------------------------------------------------------------------
// getSeriesInfo() — returns CatalogItemDetail
// ---------------------------------------------------------------------------

describe("XtreamProvider.getSeriesInfo() — returns CatalogItemDetail", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = makeProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns CatalogItemDetail with camelCase fields", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesInfo);

    const result = await provider.getSeriesInfo("303");

    // Should have normalized fields
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("seasons");
    expect(result).toHaveProperty("episodes");
    // Should NOT have raw Xtream wrapper structure
    expect(result).not.toHaveProperty("info");
    expect(result).not.toHaveProperty("series_id");
  });

  it("uses the seriesId param as id", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesInfo);

    const result = await provider.getSeriesInfo("303");

    expect(result.id).toBe("303");
  });

  it("maps type to 'series'", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesInfo);

    const result = await provider.getSeriesInfo("303");

    expect(result.type).toBe("series");
  });

  it("maps info.plot → plot", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesInfo);

    const result = await provider.getSeriesInfo("303");

    expect(result.plot).toBe(
      "A chemistry teacher turns to cooking methamphetamine.",
    );
  });

  it("returns seasons as SeasonInfo[] with camelCase fields", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesInfo);

    const result = await provider.getSeriesInfo("303");

    expect(result.seasons).toHaveLength(1);
    expect(result.seasons![0]).toEqual({
      seasonNumber: 1,
      name: "Season 1",
      episodeCount: 7,
      icon: "https://example.com/bb-s1.jpg",
    });
    // Should NOT have raw field names
    expect(result.seasons![0]).not.toHaveProperty("season_number");
    expect(result.seasons![0]).not.toHaveProperty("episode_count");
  });

  it("returns episodes as Record<string, EpisodeInfo[]> with camelCase fields", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesInfo);

    const result = await provider.getSeriesInfo("303");

    expect(result.episodes).toBeDefined();
    expect(result.episodes!["1"]).toHaveLength(1);
    const ep = result.episodes!["1"]![0]!;
    expect(ep.id).toBe("ep001");
    expect(ep.episodeNumber).toBe(1);
    expect(ep.title).toBe("Pilot");
    expect(ep.duration).toBe(3840);
    // Should NOT have raw field names
    expect(ep).not.toHaveProperty("episode_num");
    expect(ep).not.toHaveProperty("duration_secs");
  });

  it("maps info.backdrop_path[0] → backdropUrl", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesInfo);

    const result = await provider.getSeriesInfo("303");

    expect(result.backdropUrl).toBe("https://example.com/bb-backdrop.jpg");
  });

  it("returns empty seasons array when API has no seasons", async () => {
    const noSeasons: XtreamSeriesInfo = { ...rawSeriesInfo, seasons: [] };
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(noSeasons);

    const result = await provider.getSeriesInfo("303");

    expect(result.seasons).toEqual([]);
  });

  it("returns empty episodes record when API has no episodes", async () => {
    const noEpisodes: XtreamSeriesInfo = { ...rawSeriesInfo, episodes: {} };
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(noEpisodes);

    const result = await provider.getSeriesInfo("303");

    expect(result.episodes).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getEPG() — returns EPGEntry[]
// ---------------------------------------------------------------------------

describe("XtreamProvider.getEPG() — returns EPGEntry[]", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = makeProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns EPGEntry[] with camelCase channelId field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ epg_listings: rawEPGItems }),
      }),
    );

    const result = await provider.getEPG("100");

    expect(result[0]).toHaveProperty("channelId");
    expect(result[0]).not.toHaveProperty("epg_id");
    expect(result[0]).not.toHaveProperty("channel_id");
    expect(result[0]).not.toHaveProperty("start_timestamp");
    expect(result[0]).not.toHaveProperty("stop_timestamp");
  });

  it("maps epg_id → channelId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ epg_listings: rawEPGItems }),
      }),
    );

    const result = await provider.getEPG("100");

    expect(result[0]!.channelId).toBe("cnn.us");
  });

  it("maps id, title, description, start, end fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ epg_listings: [rawEPGItems[0]] }),
      }),
    );

    const result = await provider.getEPG("100");

    expect(result[0]).toEqual<EPGEntry>({
      id: "epg999",
      channelId: "cnn.us",
      title: "World News Tonight",
      description: "Top stories from around the globe.",
      start: "2024-01-15 20:00:00",
      end: "2024-01-15 20:30:00",
    });
  });

  it("returns all listings from the API response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ epg_listings: rawEPGItems }),
      }),
    );

    const result = await provider.getEPG("100");

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("epg1000");
    expect(result[1]!.title).toBe("Late Edition");
  });

  it("returns empty array when epg_listings is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ epg_listings: [] }),
      }),
    );

    const result = await provider.getEPG("100");

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getFullEPG() — returns EPGEntry[]
// ---------------------------------------------------------------------------

describe("XtreamProvider.getFullEPG() — returns EPGEntry[]", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = makeProvider();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns EPGEntry[] with channelId (not epg_id)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ epg_listings: rawEPGItems }),
      }),
    );

    const result = await provider.getFullEPG();

    expect(result[0]).toHaveProperty("channelId");
    expect(result[0]).not.toHaveProperty("epg_id");
  });

  it("maps all items from epg_listings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ epg_listings: rawEPGItems }),
      }),
    );

    const result = await provider.getFullEPG();

    expect(result).toHaveLength(2);
    expect(result[0]!.channelId).toBe("cnn.us");
    expect(result[1]!.channelId).toBe("cnn.us");
  });
});

// ---------------------------------------------------------------------------
// isAdult field accuracy
// ---------------------------------------------------------------------------

describe("isAdult field accuracy across getStreams()", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = makeProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("live: is_adult '0' → isAdult false", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([
      rawLiveStreams[0],
    ]);

    const result = await provider.getStreams("5", "live");

    expect(result[0]!.isAdult).toBe(false);
  });

  it("live: is_adult '1' → isAdult true", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([
      rawLiveStreams[1],
    ]);

    const result = await provider.getStreams("5", "live");

    expect(result[0]!.isAdult).toBe(true);
  });

  it("vod: is_adult '0' → isAdult false", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([
      rawVODStreams[0],
    ]);

    const result = await provider.getStreams("12", "vod");

    expect(result[0]!.isAdult).toBe(false);
  });

  it("vod: is_adult '1' → isAdult true", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([
      rawVODStreams[1],
    ]);

    const result = await provider.getStreams("12", "vod");

    expect(result[0]!.isAdult).toBe(true);
  });

  it("series: isAdult defaults to false (no is_adult field on XtreamSeriesItem)", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(rawSeriesItems);

    const result = await provider.getStreams("7", "series");

    result.forEach((item) => expect(item.isAdult).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  let provider: XtreamProvider;

  beforeEach(() => {
    cacheFlush();
    provider = makeProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getStreams() returns empty array for empty API response", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([]);

    const result = await provider.getStreams("999", "live");

    expect(result).toEqual([]);
  });

  it("getStreams() returns empty array for empty VOD API response", async () => {
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([]);

    const result = await provider.getStreams("999", "vod");

    expect(result).toEqual([]);
  });

  it("getStreams() handles live stream with missing stream_icon (null icon)", async () => {
    const streamNoIcon: XtreamLiveStream = {
      ...rawLiveStreams[0]!,
      stream_icon: "",
    };
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([streamNoIcon]);

    const result = await provider.getStreams("5", "live");

    expect(result[0]!.icon).toBeNull();
  });

  it("getStreams() handles live stream with missing added (null added)", async () => {
    const streamNoAdded: XtreamLiveStream = {
      ...rawLiveStreams[0]!,
      added: "",
    };
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue([streamNoAdded]);

    const result = await provider.getStreams("5", "live");

    expect(result[0]!.added).toBeNull();
  });

  it("getVODInfo() handles missing optional fields gracefully", async () => {
    const minimalVODInfo: XtreamVODInfo = {
      info: {
        movie_image: "",
        tmdb_id: "",
        name: "Minimal Movie",
        o_name: "Minimal Movie",
        plot: "",
        cast: "",
        director: "",
        genre: "",
        releaseDate: "",
        duration: "",
        duration_secs: 0,
        rating: "",
      },
      movie_data: {
        stream_id: 999,
        name: "Minimal Movie",
        added: "",
        category_id: "1",
        container_extension: "",
        custom_sid: "",
        direct_source: "",
      },
    };
    vi.spyOn(provider as any, "cachedFetch").mockResolvedValue(minimalVODInfo);

    const result = await provider.getVODInfo("999");

    // Must not throw; optional fields should be undefined, not null
    expect(result.id).toBe("999");
    expect(result.plot).toBeUndefined();
    expect(result.cast).toBeUndefined();
    expect(result.tmdbId).toBeUndefined();
    expect(result.containerExtension).toBeUndefined();
    expect(result.icon).toBeNull();
    expect(result.added).toBeNull();
  });
});
