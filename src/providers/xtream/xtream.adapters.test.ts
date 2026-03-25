// TDD RED phase — these tests MUST fail until xtream.adapters.ts is implemented.
// They define the exact contract every adapter must satisfy.

import { describe, it, expect } from "vitest";
import {
  adaptLiveStream,
  adaptVODStream,
  adaptSeriesItem,
  adaptVODInfo,
  adaptSeriesInfo,
  adaptEPGItem,
  adaptCategory,
  adaptAuthResponse,
} from "./xtream.adapters";
import type {
  XtreamLiveStream,
  XtreamVODStream,
  XtreamSeriesItem,
  XtreamVODInfo,
  XtreamSeriesInfo,
  XtreamEPGItem,
  XtreamCategory,
  XtreamAuthResponse,
} from "./xtream.types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const rawLiveStream: XtreamLiveStream = {
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
};

const rawVODStream: XtreamVODStream = {
  num: 2,
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
};

const rawSeriesItem: XtreamSeriesItem = {
  num: 3,
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
};

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

const rawEPGItem: XtreamEPGItem = {
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
};

const rawCategory: XtreamCategory = {
  category_id: "5",
  category_name: "News",
  parent_id: 0,
};

const rawCategoryWithParent: XtreamCategory = {
  category_id: "15",
  category_name: "US News",
  parent_id: 5,
};

const rawAuthResponse: XtreamAuthResponse = {
  user_info: {
    username: "testuser",
    password: "testpass",
    message: "",
    auth: 1,
    status: "Active",
    exp_date: "1893456000",
    is_trial: "0",
    active_cons: "1",
    created_at: "1609459200",
    max_connections: "2",
    allowed_output_formats: ["m3u8", "ts"],
  },
  server_info: {
    url: "iptv.example.com",
    port: "8080",
    https_port: "8443",
    server_protocol: "http",
    rtmp_port: "1935",
    timezone: "America/New_York",
    timestamp_now: 1700000000,
    time_now: "2023-11-14 21:33:20",
  },
};

// ---------------------------------------------------------------------------
// adaptLiveStream
// ---------------------------------------------------------------------------

describe("adaptLiveStream", () => {
  it("maps stream_id (number) to id (string)", () => {
    const result = adaptLiveStream(rawLiveStream);
    expect(result.id).toBe("101");
  });

  it("maps name", () => {
    const result = adaptLiveStream(rawLiveStream);
    expect(result.name).toBe("CNN HD");
  });

  it('sets type to "live"', () => {
    const result = adaptLiveStream(rawLiveStream);
    expect(result.type).toBe("live");
  });

  it("maps category_id to categoryId", () => {
    const result = adaptLiveStream(rawLiveStream);
    expect(result.categoryId).toBe("5");
  });

  it("maps stream_icon to icon", () => {
    const result = adaptLiveStream(rawLiveStream);
    expect(result.icon).toBe("https://example.com/cnn.png");
  });

  it("maps added", () => {
    const result = adaptLiveStream(rawLiveStream);
    expect(result.added).toBe("1698000000");
  });

  it('maps is_adult "0" to false', () => {
    const result = adaptLiveStream(rawLiveStream);
    expect(result.isAdult).toBe(false);
  });

  it('maps is_adult "1" to true', () => {
    const result = adaptLiveStream({ ...rawLiveStream, is_adult: "1" });
    expect(result.isAdult).toBe(true);
  });

  it('maps is_adult "" to false', () => {
    const result = adaptLiveStream({ ...rawLiveStream, is_adult: "" });
    expect(result.isAdult).toBe(false);
  });

  it("returns null for empty stream_icon", () => {
    const result = adaptLiveStream({ ...rawLiveStream, stream_icon: "" });
    expect(result.icon).toBeNull();
  });

  it("returns null for empty added", () => {
    const result = adaptLiveStream({ ...rawLiveStream, added: "" });
    expect(result.added).toBeNull();
  });

  it("returns the correct full shape", () => {
    const result = adaptLiveStream(rawLiveStream);
    expect(result).toEqual({
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

// ---------------------------------------------------------------------------
// adaptVODStream
// ---------------------------------------------------------------------------

describe("adaptVODStream", () => {
  it("maps stream_id (number) to id (string)", () => {
    const result = adaptVODStream(rawVODStream);
    expect(result.id).toBe("202");
  });

  it("maps name", () => {
    const result = adaptVODStream(rawVODStream);
    expect(result.name).toBe("Interstellar");
  });

  it('sets type to "vod"', () => {
    const result = adaptVODStream(rawVODStream);
    expect(result.type).toBe("vod");
  });

  it("maps category_id to categoryId", () => {
    const result = adaptVODStream(rawVODStream);
    expect(result.categoryId).toBe("12");
  });

  it("maps stream_icon to icon", () => {
    const result = adaptVODStream(rawVODStream);
    expect(result.icon).toBe("https://example.com/interstellar.jpg");
  });

  it("maps added", () => {
    const result = adaptVODStream(rawVODStream);
    expect(result.added).toBe("1700000000");
  });

  it('maps is_adult "0" to false', () => {
    const result = adaptVODStream(rawVODStream);
    expect(result.isAdult).toBe(false);
  });

  it('maps is_adult "1" to true', () => {
    const result = adaptVODStream({ ...rawVODStream, is_adult: "1" });
    expect(result.isAdult).toBe(true);
  });

  it("maps rating", () => {
    const result = adaptVODStream(rawVODStream);
    expect(result.rating).toBe("8.6");
  });

  it("returns null for empty stream_icon", () => {
    const result = adaptVODStream({ ...rawVODStream, stream_icon: "" });
    expect(result.icon).toBeNull();
  });

  it("returns null for empty added", () => {
    const result = adaptVODStream({ ...rawVODStream, added: "" });
    expect(result.added).toBeNull();
  });

  it("returns the correct full shape", () => {
    const result = adaptVODStream(rawVODStream);
    expect(result).toEqual({
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

// ---------------------------------------------------------------------------
// adaptSeriesItem
// ---------------------------------------------------------------------------

describe("adaptSeriesItem", () => {
  it("maps series_id (number) to id (string) — NOT stream_id", () => {
    const result = adaptSeriesItem(rawSeriesItem);
    expect(result.id).toBe("303");
  });

  it("maps name", () => {
    const result = adaptSeriesItem(rawSeriesItem);
    expect(result.name).toBe("Breaking Bad");
  });

  it('sets type to "series"', () => {
    const result = adaptSeriesItem(rawSeriesItem);
    expect(result.type).toBe("series");
  });

  it("maps category_id to categoryId", () => {
    const result = adaptSeriesItem(rawSeriesItem);
    expect(result.categoryId).toBe("7");
  });

  it("maps cover to icon", () => {
    const result = adaptSeriesItem(rawSeriesItem);
    expect(result.icon).toBe("https://example.com/bb.jpg");
  });

  it("maps last_modified to added", () => {
    const result = adaptSeriesItem(rawSeriesItem);
    expect(result.added).toBe("1710000000");
  });

  it("maps genre", () => {
    const result = adaptSeriesItem(rawSeriesItem);
    expect(result.genre).toBe("Crime, Drama");
  });

  it("maps rating", () => {
    const result = adaptSeriesItem(rawSeriesItem);
    expect(result.rating).toBe("9.5");
  });

  it("maps year from releaseDate", () => {
    const result = adaptSeriesItem(rawSeriesItem);
    expect(result.year).toBe("2008");
  });

  it("returns null for empty cover", () => {
    const result = adaptSeriesItem({ ...rawSeriesItem, cover: "" });
    expect(result.icon).toBeNull();
  });

  it("returns null for empty last_modified", () => {
    const result = adaptSeriesItem({ ...rawSeriesItem, last_modified: "" });
    expect(result.added).toBeNull();
  });

  it("returns the correct full shape", () => {
    const result = adaptSeriesItem(rawSeriesItem);
    expect(result).toEqual({
      id: "303",
      name: "Breaking Bad",
      type: "series",
      categoryId: "7",
      icon: "https://example.com/bb.jpg",
      added: "1710000000",
      isAdult: false,
      genre: "Crime, Drama",
      rating: "9.5",
      year: "2008",
    });
  });
});

// ---------------------------------------------------------------------------
// adaptVODInfo
// ---------------------------------------------------------------------------

describe("adaptVODInfo", () => {
  it("maps movie_data.stream_id to id (string)", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.id).toBe("202");
  });

  it("maps info.name to name", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.name).toBe("Interstellar");
  });

  it('sets type to "vod"', () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.type).toBe("vod");
  });

  it("maps movie_data.category_id to categoryId", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.categoryId).toBe("12");
  });

  it("maps info.movie_image to icon and backdropUrl", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.icon).toBe("https://example.com/inter-poster.jpg");
    expect(result.backdropUrl).toBe("https://example.com/inter-poster.jpg");
  });

  it("maps movie_data.added to added", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.added).toBe("1700000000");
  });

  it("maps info.plot to plot", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.plot).toBe(
      "A team of explorers travel through a wormhole in space.",
    );
  });

  it("maps info.cast to cast", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.cast).toBe("Matthew McConaughey, Anne Hathaway");
  });

  it("maps info.director to director", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.director).toBe("Christopher Nolan");
  });

  it("maps info.duration to duration", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.duration).toBe("169 min");
  });

  it("maps info.duration_secs to durationSecs", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.durationSecs).toBe(10140);
  });

  it("maps movie_data.container_extension to containerExtension", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.containerExtension).toBe("mkv");
  });

  it("maps info.tmdb_id to tmdbId", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.tmdbId).toBe("157336");
  });

  it("maps info.rating to rating", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.rating).toBe("8.6");
  });

  it("maps info.genre to genre", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result.genre).toBe("Adventure, Drama, Sci-Fi");
  });

  it("returns the correct full shape", () => {
    const result = adaptVODInfo(rawVODInfo);
    expect(result).toEqual({
      id: "202",
      name: "Interstellar",
      type: "vod",
      categoryId: "12",
      icon: "https://example.com/inter-poster.jpg",
      added: "1700000000",
      isAdult: false,
      plot: "A team of explorers travel through a wormhole in space.",
      cast: "Matthew McConaughey, Anne Hathaway",
      director: "Christopher Nolan",
      genre: "Adventure, Drama, Sci-Fi",
      duration: "169 min",
      durationSecs: 10140,
      containerExtension: "mkv",
      backdropUrl: "https://example.com/inter-poster.jpg",
      tmdbId: "157336",
      rating: "8.6",
    });
  });
});

// ---------------------------------------------------------------------------
// adaptSeriesInfo
// ---------------------------------------------------------------------------

describe("adaptSeriesInfo", () => {
  it("uses seriesId parameter as id", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.id).toBe("303");
  });

  it("uses categoryId parameter as categoryId", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.categoryId).toBe("7");
  });

  it("defaults categoryId to empty string when omitted", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303");
    expect(result.categoryId).toBe("");
  });

  it("maps info.name to name", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.name).toBe("Breaking Bad");
  });

  it('sets type to "series"', () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.type).toBe("series");
  });

  it("maps info.cover to icon", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.icon).toBe("https://example.com/bb.jpg");
  });

  it("maps info.backdrop_path[0] to backdropUrl", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.backdropUrl).toBe("https://example.com/bb-backdrop.jpg");
  });

  it("maps info.plot to plot", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.plot).toBe(
      "A chemistry teacher turns to cooking methamphetamine.",
    );
  });

  it("maps info.cast to cast", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.cast).toBe("Bryan Cranston, Aaron Paul");
  });

  it("maps info.director to director", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.director).toBe("Vince Gilligan");
  });

  it("maps info.genre to genre", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.genre).toBe("Crime, Drama");
  });

  it("maps info.rating to rating", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.rating).toBe("9.5");
  });

  it("maps seasons array with all fields", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.seasons).toHaveLength(1);
    expect(result.seasons[0]).toEqual({
      seasonNumber: 1,
      name: "Season 1",
      episodeCount: 7,
      icon: "https://example.com/bb-s1.jpg",
    });
  });

  it("maps episodes record with all fields", () => {
    const result = adaptSeriesInfo(rawSeriesInfo, "303", "7");
    expect(result.episodes["1"]).toHaveLength(1);
    expect(result.episodes["1"][0]).toEqual({
      id: "ep001",
      episodeNumber: 1,
      title: "Pilot",
      containerExtension: "mkv",
      duration: 3840,
      plot: "Walter White receives a cancer diagnosis.",
      icon: "https://example.com/bb-s1e1.jpg",
    });
  });

  it("returns undefined for empty backdrop_path", () => {
    const result = adaptSeriesInfo(
      {
        ...rawSeriesInfo,
        info: { ...rawSeriesInfo.info, backdrop_path: [] },
      },
      "303",
      "7",
    );
    expect(result.backdropUrl).toBeUndefined();
  });

  it("returns null for empty cover", () => {
    const result = adaptSeriesInfo(
      {
        ...rawSeriesInfo,
        info: { ...rawSeriesInfo.info, cover: "" },
      },
      "303",
      "7",
    );
    expect(result.icon).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// adaptEPGItem
// ---------------------------------------------------------------------------

describe("adaptEPGItem", () => {
  it("maps id to id (string)", () => {
    const result = adaptEPGItem(rawEPGItem);
    expect(result.id).toBe("epg999");
  });

  it("maps epg_id to channelId", () => {
    const result = adaptEPGItem(rawEPGItem);
    expect(result.channelId).toBe("cnn.us");
  });

  it("maps title", () => {
    const result = adaptEPGItem(rawEPGItem);
    expect(result.title).toBe("World News Tonight");
  });

  it("maps description", () => {
    const result = adaptEPGItem(rawEPGItem);
    expect(result.description).toBe("Top stories from around the globe.");
  });

  it("maps start", () => {
    const result = adaptEPGItem(rawEPGItem);
    expect(result.start).toBe("2024-01-15 20:00:00");
  });

  it("maps end", () => {
    const result = adaptEPGItem(rawEPGItem);
    expect(result.end).toBe("2024-01-15 20:30:00");
  });

  it("returns the correct full shape", () => {
    const result = adaptEPGItem(rawEPGItem);
    expect(result).toEqual({
      id: "epg999",
      channelId: "cnn.us",
      title: "World News Tonight",
      description: "Top stories from around the globe.",
      start: "2024-01-15 20:00:00",
      end: "2024-01-15 20:30:00",
    });
  });
});

// ---------------------------------------------------------------------------
// adaptCategory
// ---------------------------------------------------------------------------

describe("adaptCategory", () => {
  it("maps category_id to id", () => {
    const result = adaptCategory(rawCategory, "live");
    expect(result.id).toBe("5");
  });

  it("maps category_name to name", () => {
    const result = adaptCategory(rawCategory, "live");
    expect(result.name).toBe("News");
  });

  it("maps parent_id 0 to null", () => {
    const result = adaptCategory(rawCategory, "live");
    expect(result.parentId).toBeNull();
  });

  it("maps non-zero parent_id to string", () => {
    const result = adaptCategory(rawCategoryWithParent, "live");
    expect(result.parentId).toBe("5");
  });

  it("passes through the type parameter for live", () => {
    const result = adaptCategory(rawCategory, "live");
    expect(result.type).toBe("live");
  });

  it("passes through the type parameter for vod", () => {
    const result = adaptCategory(rawCategory, "vod");
    expect(result.type).toBe("vod");
  });

  it("passes through the type parameter for series", () => {
    const result = adaptCategory(rawCategory, "series");
    expect(result.type).toBe("series");
  });

  it("returns the correct full shape for a root category", () => {
    const result = adaptCategory(rawCategory, "live");
    expect(result).toEqual({
      id: "5",
      name: "News",
      type: "live",
      parentId: null,
    });
  });

  it("returns the correct full shape for a child category", () => {
    const result = adaptCategory(rawCategoryWithParent, "vod");
    expect(result).toEqual({
      id: "15",
      name: "US News",
      type: "vod",
      parentId: "5",
    });
  });
});

// ---------------------------------------------------------------------------
// adaptAuthResponse
// ---------------------------------------------------------------------------

describe("adaptAuthResponse", () => {
  it("maps user_info.max_connections (string) to maxConnections (number)", () => {
    const result = adaptAuthResponse(rawAuthResponse);
    expect(result.maxConnections).toBe(2);
    expect(typeof result.maxConnections).toBe("number");
  });

  it("maps user_info.active_cons (string) to activeConnections (number)", () => {
    const result = adaptAuthResponse(rawAuthResponse);
    expect(result.activeConnections).toBe(1);
    expect(typeof result.activeConnections).toBe("number");
  });

  it("maps user_info.exp_date to expiryDate", () => {
    const result = adaptAuthResponse(rawAuthResponse);
    expect(result.expiryDate).toBe("1893456000");
  });

  it('maps user_info.is_trial "0" to isTrial false', () => {
    const result = adaptAuthResponse(rawAuthResponse);
    expect(result.isTrial).toBe(false);
  });

  it('maps user_info.is_trial "1" to isTrial true', () => {
    const result = adaptAuthResponse({
      ...rawAuthResponse,
      user_info: { ...rawAuthResponse.user_info, is_trial: "1" },
    });
    expect(result.isTrial).toBe(true);
  });

  it("maps user_info.status to status (lowercased)", () => {
    const result = adaptAuthResponse(rawAuthResponse);
    expect(result.status).toBe("active");
  });

  it("maps user_info.allowed_output_formats to allowedFormats", () => {
    const result = adaptAuthResponse(rawAuthResponse);
    expect(result.allowedFormats).toEqual(["m3u8", "ts"]);
  });

  it("maps user_info.username to username", () => {
    const result = adaptAuthResponse(rawAuthResponse);
    expect(result.username).toBe("testuser");
  });

  it("returns the correct full shape", () => {
    const result = adaptAuthResponse(rawAuthResponse);
    expect(result).toEqual({
      username: "testuser",
      maxConnections: 2,
      activeConnections: 1,
      expiryDate: "1893456000",
      isTrial: false,
      status: "active",
      allowedFormats: ["m3u8", "ts"],
    });
  });

  it('handles max_connections "0" correctly', () => {
    const result = adaptAuthResponse({
      ...rawAuthResponse,
      user_info: { ...rawAuthResponse.user_info, max_connections: "0" },
    });
    expect(result.maxConnections).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge case: is_adult with undefined-like values
// ---------------------------------------------------------------------------

describe("is_adult edge cases", () => {
  it('adaptLiveStream: is_adult "0" → false', () => {
    expect(adaptLiveStream({ ...rawLiveStream, is_adult: "0" }).isAdult).toBe(
      false,
    );
  });

  it('adaptLiveStream: is_adult "1" → true', () => {
    expect(adaptLiveStream({ ...rawLiveStream, is_adult: "1" }).isAdult).toBe(
      true,
    );
  });

  it('adaptLiveStream: is_adult "" → false', () => {
    expect(adaptLiveStream({ ...rawLiveStream, is_adult: "" }).isAdult).toBe(
      false,
    );
  });

  it('adaptVODStream: is_adult "0" → false', () => {
    expect(adaptVODStream({ ...rawVODStream, is_adult: "0" }).isAdult).toBe(
      false,
    );
  });

  it('adaptVODStream: is_adult "1" → true', () => {
    expect(adaptVODStream({ ...rawVODStream, is_adult: "1" }).isAdult).toBe(
      true,
    );
  });

  it('adaptVODStream: is_adult "" → false', () => {
    expect(adaptVODStream({ ...rawVODStream, is_adult: "" }).isAdult).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Edge case: icon / added null coercion
// ---------------------------------------------------------------------------

describe("icon and added null coercion", () => {
  it("adaptLiveStream: empty stream_icon → null", () => {
    expect(
      adaptLiveStream({ ...rawLiveStream, stream_icon: "" }).icon,
    ).toBeNull();
  });

  it("adaptLiveStream: non-empty stream_icon → string", () => {
    expect(adaptLiveStream(rawLiveStream).icon).toBe(
      "https://example.com/cnn.png",
    );
  });

  it("adaptLiveStream: empty added → null", () => {
    expect(adaptLiveStream({ ...rawLiveStream, added: "" }).added).toBeNull();
  });

  it("adaptVODStream: empty stream_icon → null", () => {
    expect(
      adaptVODStream({ ...rawVODStream, stream_icon: "" }).icon,
    ).toBeNull();
  });

  it("adaptVODStream: empty added → null", () => {
    expect(adaptVODStream({ ...rawVODStream, added: "" }).added).toBeNull();
  });

  it("adaptSeriesItem: empty cover → null", () => {
    expect(adaptSeriesItem({ ...rawSeriesItem, cover: "" }).icon).toBeNull();
  });

  it("adaptSeriesItem: empty last_modified → null", () => {
    expect(
      adaptSeriesItem({ ...rawSeriesItem, last_modified: "" }).added,
    ).toBeNull();
  });
});
