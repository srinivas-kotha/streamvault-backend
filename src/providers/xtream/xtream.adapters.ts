// Pure adapter functions: Xtream raw API types → provider-agnostic types.
// No side effects, no async, no dependencies beyond types.

import type {
  XtreamLiveStream,
  XtreamVODStream,
  XtreamSeriesItem,
  XtreamVODInfo,
  XtreamSeriesInfo,
  XtreamEPGItem,
  XtreamAuthResponse,
} from "./xtream.types";
import type {
  CatalogItem,
  CatalogItemDetail,
  EPGEntry,
  CatalogCategory,
  AccountInfo,
  ContentType,
  SeasonInfo,
  EpisodeInfo,
} from "../provider.types";

export function adaptLiveStream(raw: XtreamLiveStream): CatalogItem {
  return {
    id: String(raw.stream_id),
    name: raw.name,
    type: "live" as ContentType,
    categoryId: String(raw.category_id),
    icon: raw.stream_icon || null,
    added: raw.added || null,
    isAdult: raw.is_adult === "1",
  };
}

export function adaptVODStream(raw: XtreamVODStream): CatalogItem {
  return {
    id: String(raw.stream_id),
    name: raw.name,
    type: "vod" as ContentType,
    categoryId: String(raw.category_id),
    icon: raw.stream_icon || null,
    added: raw.added || null,
    isAdult: raw.is_adult === "1",
    rating: raw.rating || undefined,
  };
}

export function adaptSeriesItem(raw: XtreamSeriesItem): CatalogItem {
  return {
    id: String(raw.series_id),
    name: raw.name,
    type: "series" as ContentType,
    categoryId: String(raw.category_id),
    icon: raw.cover || null,
    added: raw.last_modified || null,
    isAdult: false,
    rating: raw.rating || undefined,
    genre: raw.genre || undefined,
    year: raw.releaseDate ? raw.releaseDate.split("-")[0] : undefined,
  };
}

export function adaptVODInfo(raw: XtreamVODInfo): CatalogItemDetail {
  const { info, movie_data } = raw;
  // Note: XtreamVODInfo doesn't include is_adult; defaults to false
  // Caller should merge from list-level data if needed
  return {
    id: String(movie_data.stream_id),
    name: info.name || movie_data.name,
    type: "vod" as ContentType,
    categoryId: String(movie_data.category_id),
    icon: info.movie_image || null,
    added: movie_data.added || null,
    isAdult: false,
    rating: info.rating || undefined,
    genre: info.genre || undefined,
    plot: info.plot || undefined,
    cast: info.cast || undefined,
    director: info.director || undefined,
    duration: info.duration || undefined,
    durationSecs: info.duration_secs != null ? info.duration_secs : undefined,
    containerExtension: movie_data.container_extension || undefined,
    backdropUrl: info.movie_image || undefined,
    tmdbId: info.tmdb_id || undefined,
  };
}

export function adaptSeriesInfo(
  raw: XtreamSeriesInfo,
  seriesId: string,
  categoryId?: string,
): CatalogItemDetail {
  const { info, seasons, episodes } = raw;

  const adaptedSeasons: SeasonInfo[] = (seasons ?? []).map((s) => ({
    seasonNumber: s.season_number,
    name: s.name,
    episodeCount: s.episode_count,
    icon: s.cover || undefined,
  }));

  const adaptedEpisodes: Record<string, EpisodeInfo[]> = {};
  for (const [seasonKey, episodeList] of Object.entries(episodes ?? {})) {
    adaptedEpisodes[seasonKey] = episodeList.map((ep) => ({
      id: String(ep.id),
      episodeNumber: ep.episode_num,
      title: ep.title,
      containerExtension: ep.container_extension || undefined,
      duration:
        ep.info?.duration_secs != null ? ep.info.duration_secs : undefined,
      plot: ep.info?.plot || undefined,
      icon: ep.info?.movie_image || undefined,
    }));
  }

  // Note: XtreamSeriesInfo doesn't include is_adult; defaults to false
  // Caller should merge from list-level data if needed
  return {
    id: seriesId,
    name: info.name,
    type: "series" as ContentType,
    categoryId: categoryId ?? "",
    icon: info.cover || null,
    added: null,
    isAdult: false,
    rating: info.rating || undefined,
    genre: info.genre || undefined,
    year: info.releaseDate || undefined,
    plot: info.plot || undefined,
    cast: info.cast || undefined,
    director: info.director || undefined,
    backdropUrl: info.backdrop_path?.[0] || undefined,
    seasons: adaptedSeasons,
    episodes: adaptedEpisodes,
  };
}

export function adaptEPGItem(raw: XtreamEPGItem): EPGEntry {
  // TODO(PR-2): Convert to proper ISO 8601 when EPG normalization is wired up
  // Xtream sends "YYYY-MM-DD HH:MM:SS" format, not true ISO 8601
  return {
    id: raw.id,
    channelId: raw.epg_id,
    title: raw.title,
    description: raw.description,
    start: raw.start,
    end: raw.end,
  };
}

export function adaptCategory(
  raw: { category_id: string; category_name: string; parent_id: number },
  type: ContentType,
): CatalogCategory {
  return {
    id: String(raw.category_id),
    name: raw.category_name,
    parentId: raw.parent_id === 0 ? null : String(raw.parent_id),
    type,
  };
}

export function adaptAuthResponse(raw: XtreamAuthResponse): AccountInfo {
  const ui = raw.user_info;

  let status: AccountInfo["status"];
  switch (ui.status) {
    case "Active":
    case "active":
      status = "active";
      break;
    case "Expired":
    case "expired":
      status = "expired";
      break;
    case "Banned":
    case "banned":
      status = "banned";
      break;
    case "Disabled":
    case "disabled":
      status = "disabled";
      break;
    default:
      status = undefined;
  }

  return {
    username: ui.username,
    maxConnections: ui.max_connections ? Number(ui.max_connections) : undefined,
    activeConnections: ui.active_cons ? Number(ui.active_cons) : undefined,
    expiryDate: ui.exp_date || undefined,
    isTrial: ui.is_trial === "1",
    status,
    allowedFormats: ui.allowed_output_formats ?? undefined,
  };
}
