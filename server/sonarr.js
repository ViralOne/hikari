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

// Every episode of one series, with air dates and file state. Air date is the only field that
// survives the AniDB-to-TVDB numbering difference, so it is what missing episodes match on.
export function episodes(seriesId) {
  return cached(`sonarr:episodes:${seriesId}`, 60 * 1000, async () => {
    const list = await api(`/episode?seriesId=${Number(seriesId)}&includeEpisodeFile=true`);
    return list.map(item => ({
      id: item.id,
      seasonNumber: item.seasonNumber,
      episodeNumber: item.episodeNumber,
      absoluteEpisodeNumber: item.absoluteEpisodeNumber ?? null,
      title: item.title || null,
      airDate: item.airDate || null,
      airDateUtc: item.airDateUtc || null,
      hasFile: Boolean(item.hasFile),
      monitored: Boolean(item.monitored),
      // The relative path is what ties a Sonarr episode to the file Shoko hashed: the two
      // mount the library at different roots, so only the tail can be compared.
      relativePath: item.episodeFile?.relativePath || null,
      size: item.episodeFile?.size ?? null
    }));
  });
}

// Unmonitored episodes are skipped by the search command, so they have to be monitored first
// or the search silently does nothing.
export async function monitorEpisodes(episodeIds) {
  return setEpisodeMonitoring(episodeIds, true);
}

export async function setEpisodeMonitoring(episodeIds, monitored) {
  if (!episodeIds.length) return { changed: 0 };
  await api("/episode/monitor", {
    method: "PUT",
    body: JSON.stringify({ episodeIds, monitored: Boolean(monitored) })
  });
  invalidate("sonarr:episodes:");
  return { changed: episodeIds.length };
}

// Season-level monitoring is what Sonarr's own searches and its RSS sync read, so narrowing the
// episodes without narrowing the seasons leaves Sonarr free to pull the rest of the show in later on
// its own. These three cover the three things a user can mean:
//
//   keepOnlySeason    this cour and nothing else -- what a fresh request for one cour needs
//   addSeason         this cour as well as whatever is already monitored
//   monitorAllSeasons the whole series, for when that is genuinely what was asked for
//
// Season 0 is specials, and Sonarr treats it separately everywhere else. None of these touch it:
// silently turning specials on or off is never what was meant.
//
// seriesType is set in the same PUT rather than through setSeriesType: both send the whole series
// object back, and two sequential read-modify-writes on the same record is how one silently undoes
// the other.
async function writeSeasons(id, decide, seriesType) {
  const series = await api(`/series/${id}`);
  const previousType = series.seriesType;

  const seasons = (series.seasons || []).map(season =>
    season.seasonNumber === 0 ? { ...season } : { ...season, monitored: decide(season) }
  );

  await api(`/series/${id}`, {
    method: "PUT",
    body: JSON.stringify({ ...series, monitored: true, seasons, ...(seriesType ? { seriesType } : {}) })
  });
  invalidate("sonarr:series");
  invalidate("sonarr:match:");

  const before = new Map((series.seasons || []).map(season => [season.seasonNumber, season.monitored]));
  return {
    seriesType: seriesType
      ? { changed: previousType !== seriesType, previous: previousType, seriesType }
      : { changed: false, previous: previousType, seriesType: previousType },
    unmonitored: seasons.filter(s => s.seasonNumber > 0 && before.get(s.seasonNumber) && !s.monitored).map(s => s.seasonNumber),
    monitored: seasons.filter(s => s.seasonNumber > 0 && !before.get(s.seasonNumber) && s.monitored).map(s => s.seasonNumber)
  };
}

// `keep` names seasons to leave exactly as they are. Seasons with files on disk belong there: they
// predate this request, the user is plainly managing them, and switching their monitoring off is a
// side effect of a request for a different cour that nobody asked for.
export async function keepOnlySeason(id, seasonNumber, { keep = [], seriesType = null } = {}) {
  const target = Number(seasonNumber);
  const protected_ = new Set(keep.map(Number));

  const result = await writeSeasons(
    id,
    season => (protected_.has(season.seasonNumber) ? season.monitored : season.seasonNumber === target),
    seriesType
  );

  return { seasonNumber: target, kept: [...protected_].sort((a, b) => a - b), ...result };
}

// Additive: nothing that is already monitored is turned off. This is "get season 2 as well", which
// on a show whose TMDB seasons are lumped together cannot be expressed as a Jellyseerr request at
// all -- Jellyseerr already considers the whole show requested.
export async function addSeason(id, seasonNumber, { seriesType = null } = {}) {
  const target = Number(seasonNumber);
  const result = await writeSeasons(id, season => season.monitored || season.seasonNumber === target, seriesType);
  return { seasonNumber: target, kept: [], ...result };
}

export async function monitorAllSeasons(id, { seriesType = null } = {}) {
  const result = await writeSeasons(id, () => true, seriesType);
  return { seasonNumber: null, kept: [], ...result };
}

// The full queue including which episode each item is for, so callers can tell a wanted download
// from one Jellyseerr kicked off for the wrong season. Uncached: it is read to decide what to
// delete, and a stale read there deletes the wrong thing.
export async function queueForSeries(seriesId) {
  const body = await api("/queue?pageSize=200&includeSeries=true&includeEpisode=true");
  return (body.records || [])
    .filter(record => record.seriesId === Number(seriesId))
    .map(record => ({
      id: record.id,
      episodeId: record.episodeId ?? null,
      seasonNumber: record.episode?.seasonNumber ?? null,
      episodeNumber: record.episode?.episodeNumber ?? null,
      title: record.title,
      size: record.size ?? 0,
      status: record.status
    }));
}

// Destructive, and the only destructive call in this module. Removes queue items and the partial
// downloads behind them.
//
// blocklist stays false on purpose: these releases are not bad, they are simply for a season that
// was not asked for, and blocklisting them would stop Sonarr ever grabbing them if that season is
// requested later. Callers must pass ids they resolved themselves from queueForSeries.
export async function removeQueueItems(queueIds) {
  if (!queueIds.length) return { removed: 0 };

  for (const id of queueIds) {
    await api(`/queue/${Number(id)}?removeFromClient=true&blocklist=false&skipRedownload=true`, {
      method: "DELETE"
    });
  }

  invalidate("sonarr:queue");
  return { removed: queueIds.length };
}

// Search commands Sonarr is currently running for one series. Jellyseerr triggers a search the
// moment it adds a series, and that command outlives the request response: one observed
// MissingEpisodeSearch was still going two minutes later, grabbing episodes the whole time.
//
// RssSync and other library-wide commands carry no seriesId and are deliberately never matched:
// cancelling those would affect every series in the library.
const SEARCH_COMMANDS = new Set([
  "MissingEpisodeSearch",
  "SeriesSearch",
  "SeasonSearch",
  "EpisodeSearch",
  "CutoffUnmetEpisodeSearch"
]);

export async function runningSearchesFor(seriesId) {
  const list = await api("/command");
  return (Array.isArray(list) ? list : [])
    .filter(command => command.status === "started" || command.status === "queued")
    .filter(command => SEARCH_COMMANDS.has(command.name))
    .filter(command => Number(command.body?.seriesId) === Number(seriesId))
    .map(command => ({ id: command.id, name: command.name, status: command.status }));
}

// Cancelling a search is not destructive: it stops Sonarr looking, and anything already grabbed is
// dealt with separately by the queue sweep.
//
// Sonarr only cancels commands that have not started yet. A started one answers 409 "Unable to
// cancel task", so this reports whether it actually worked rather than assuming: claiming a search
// was stopped when it is still running is worse than admitting it could not be.
export async function cancelCommand(id) {
  try {
    await api(`/command/${Number(id)}`, { method: "DELETE" });
    return { id: Number(id), cancelled: true };
  } catch (err) {
    return { id: Number(id), cancelled: false, error: err.status === 409 ? "already started" : err.message };
  }
}

// Sonarr adds a series asynchronously after Jellyseerr's request lands, so it is not there to
// correct on the first look. Polls the series list until it appears.
//
// `fallback` is tried once the ids fail, because Sonarr does not always record a tmdbId: 3 of the
// 176 series in the library this was built against have none. Without it those shows would silently
// skip narrowing and download whichever season Jellyseerr picked, which is the whole failure being
// prevented. The caller supplies a title matcher rather than this module guessing.
export async function waitForSeries({ tmdbId, tvdbId, timeoutMs = 25000, intervalMs = 1500, fallback = null }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    invalidate("sonarr:series");
    const list = await series().catch(() => []);
    const found = list.find(
      item =>
        (tvdbId && item.tvdbId === Number(tvdbId)) || (tmdbId && item.tmdbId && item.tmdbId === Number(tmdbId))
    );
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  if (fallback) {
    invalidate("sonarr:series");
    invalidate("sonarr:match:");
    return (await fallback().catch(() => null)) || null;
  }

  return null;
}

// Triggers a real indexer search and grab. Only ever called with ids Hikari resolved itself.
export async function searchEpisodes(episodeIds) {
  const command = await api("/command", {
    method: "POST",
    body: JSON.stringify({ name: "EpisodeSearch", episodeIds })
  });
  invalidate("sonarr:queue");
  return { commandId: command.id ?? null, status: command.status ?? null };
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
//
// `shoko` is optional and only ever helps: when present it supplies TvDB ids, which match
// Sonarr exactly. The cache key carries them because the same AniList id resolved with and
// without the bridge can legitimately give different answers.
export function findMatch(anime, shoko) {
  if (!enabled.sonarr) return Promise.resolve(null);
  if (anime.format === "MOVIE") return Promise.resolve(null);
  const bridge = shoko?.tvdbIds?.length ? shoko.tvdbIds.join(",") : "0";
  return cached(`sonarr:match:${anime.id}:${bridge}`, 2 * 60 * 1000, () => computeMatch(anime, shoko));
}

async function computeMatch(anime, shoko) {
  let list;
  try {
    list = await series();
  } catch {
    return null;
  }

  // AniList idMal -> Shoko -> AniDB -> TvDB -> Sonarr. Every hop is an id, so a hit here is
  // correct by construction and no threshold can turn it into a false positive.
  for (const tvdbId of shoko?.tvdbIds || []) {
    const exact = list.find(item => item.tvdbId === tvdbId);
    if (exact) return shape(exact, 1, "shoko:tvdb");
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
  return shape(best.item, best.score, "title");
}

function shape(item, confidence, via) {
  return {
    id: item.id,
    tvdbId: item.tvdbId,
    title: item.title,
    path: item.path,
    seriesType: item.seriesType,
    monitored: item.monitored,
    episodeCount: item.episodeCount,
    episodeFileCount: item.episodeFileCount,
    sizeOnDisk: item.sizeOnDisk,
    complete: item.episodeCount > 0 && item.episodeFileCount >= item.episodeCount,
    confidence: Number(confidence.toFixed(3)),
    via
  };
}
