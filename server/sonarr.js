import { config, enabled } from "./config.js";
import { cached, invalidate } from "./cache.js";
import { request } from "./http.js";
import { normalize, similarity, usable } from "./match.js";

// Tuned against fixtures/match-cases.json (20 known-correct pairs, 160 known-wrong).
// 0.80 gives precision 1.000 / recall 1.000; 0.75 admitted one false positive
// ("Re:Zero 4th Season" matching "Farming Life in Another World" at 0.787).
export const SONARR_MATCH_THRESHOLD = 0.8;

function api(path, options = {}) {
  if (!enabled.sonarr) throw new Error("Sonarr is not configured");
  return request("sonarr", `${config.sonarr.url}/api/v3${path}`, {
    ...options,
    headers: { "X-Api-Key": config.sonarr.key, "Content-Type": "application/json", ...(options.headers || {}) }
  });
}

// Sonarr's seriesType drives absolute episode numbering, which anime releases need.
// Jellyseerr can only set it when TMDB tagged the show as anime, so this is the repair path.
export async function setSeriesType(id, seriesType) {
  const series = await api(`/series/${id}`);
  const previous = series.seriesType;

  if (previous === seriesType) return { changed: false, previous, seriesType };

  await api(`/series/${id}`, { method: "PUT", body: JSON.stringify({ ...series, seriesType }) });
  invalidate("sonarr:series");
  invalidate("sonarr:match:");
  return { changed: true, previous, seriesType };
}

export function version() {
  return cached("sonarr:version", 5 * 60 * 1000, async () => `v${(await api("/system/status")).version}`);
}

export function series() {
  return cached("sonarr:series", 2 * 60 * 1000, async () => {
    const list = await api("/series");
    return list.map(item => ({
      id: item.id,
      tvdbId: item.tvdbId,
      tmdbId: item.tmdbId || null,
      title: item.title,
      path: item.path,
      seriesType: item.seriesType,
      monitored: item.monitored,
      episodeCount: item.statistics?.episodeCount ?? 0,
      episodeFileCount: item.statistics?.episodeFileCount ?? 0,
      sizeOnDisk: item.statistics?.sizeOnDisk ?? 0,
      keys: [...new Set(
        [item.title, ...(item.alternateTitles || []).map(alt => alt.title)]
          .filter(Boolean)
          .map(normalize)
          .filter(usable)
      )]
    }));
  });
}

export function qualityProfiles() {
  return cached("sonarr:profiles", 10 * 60 * 1000, async () => {
    const list = await api("/qualityprofile");
    return Object.fromEntries(list.map(profile => [profile.id, profile.name]));
  });
}

export function downloadClients() {
  return cached("sonarr:clients", 10 * 60 * 1000, async () => {
    const list = await api("/downloadclient");
    return list
      .filter(client => client.enable)
      .map(client => ({
        name: client.name,
        implementation: client.implementation,
        category: client.fields?.find(field => field.name === "tvCategory")?.value ?? null,
        tags: client.tags || []
      }));
  });
}

export function queue() {
  return cached("sonarr:queue", 15 * 1000, async () => {
    const body = await api("/queue?pageSize=100&includeSeries=true&includeEpisode=true");
    return (body.records || []).map(record => ({
      id: record.id,
      series: record.series?.title || "Unknown",
      seriesType: record.series?.seriesType || null,
      episode: record.episode
        ? `S${String(record.episode.seasonNumber).padStart(2, "0")}E${String(record.episode.episodeNumber).padStart(2, "0")}`
        : null,
      title: record.title,
      quality: record.quality?.quality?.name || null,
      size: record.size ?? 0,
      sizeleft: record.sizeleft ?? 0,
      status: record.status,
      trackedStatus: record.trackedDownloadState || null,
      messages: (record.statusMessages || []).flatMap(m => m.messages || []).slice(0, 3)
    }));
  });
}

// Matching is O(series x keys x titles) per anime, and discover annotates 120 of them across
// four rows. Cache per AniList id for the same window as the series list itself.
export function findMatch(anime) {
  if (!enabled.sonarr) return Promise.resolve(null);
  if (anime.format === "MOVIE") return Promise.resolve(null);
  return cached(`sonarr:match:${anime.id}`, 2 * 60 * 1000, () => computeMatch(anime));
}

async function computeMatch(anime) {
  let list;
  try {
    list = await series();
  } catch {
    return null;
  }

  const titles = [anime.title.english, anime.title.romaji, anime.title.native].filter(Boolean);
  let best = null;

  for (const item of list) {
    for (const key of item.keys) {
      for (const title of titles) {
        const score = similarity(title, key);
        if (!best || score > best.score) best = { score, item };
      }
    }
  }

  if (!best || best.score < SONARR_MATCH_THRESHOLD) return null;
  return {
    id: best.item.id,
    tvdbId: best.item.tvdbId,
    title: best.item.title,
    path: best.item.path,
    seriesType: best.item.seriesType,
    monitored: best.item.monitored,
    episodeCount: best.item.episodeCount,
    episodeFileCount: best.item.episodeFileCount,
    sizeOnDisk: best.item.sizeOnDisk,
    complete: best.item.episodeCount > 0 && best.item.episodeFileCount >= best.item.episodeCount,
    confidence: Number(best.score.toFixed(3))
  };
}
