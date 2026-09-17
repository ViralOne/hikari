import { config, enabled } from "./config.js";
import { cached, invalidate } from "./cache.js";
import { request } from "./http.js";
import { pickBest, guessSeasonNumber, searchTitle } from "./match.js";

export const STATUS = {
  1: "unknown",
  2: "pending",
  3: "processing",
  4: "partial",
  5: "available",
  6: "blacklisted"
};

function api(path, options = {}) {
  if (!enabled.jellyseerr) throw new Error("Jellyseerr is not configured");
  return request("jellyseerr", `${config.jellyseerr.url}/api/v1${path}`, {
    ...options,
    headers: {
      "X-Api-Key": config.jellyseerr.key,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

export function status() {
  return cached("seerr:status", 5 * 60 * 1000, () => api("/status"));
}

export function links(anime, match) {
  const base = config.jellyseerr.browserUrl;
  if (!base) return { media: null, search: null };

  const query = searchTitle(anime.title.english || anime.title.romaji || anime.title.display);
  return {
    media: match?.matched ? `${base}/${match.mediaType}/${match.tmdbId}` : null,
    search: `${base}/search?query=${encodeURIComponent(query)}`
  };
}

export function search(query) {
  const key = `seerr:search:${query.toLowerCase()}`;
  return cached(key, 30 * 60 * 1000, async () => {
    const body = await api(`/search?query=${encodeURIComponent(query)}&page=1&language=en`);
    return body.results || [];
  }, { staleFor: 60 * 60 * 1000 });
}

// Jellyseerr's detail response embeds the requesting user's email, Plex/Jellyfin ids and the
// Sonarr server internals. None of that is used here, and the cache is written to disk, so
// keep only the fields this module actually reads.
function projectDetail(detail) {
  return {
    seasons: (detail.seasons || []).map(season => ({
      seasonNumber: season.seasonNumber,
      name: season.name,
      airDate: season.airDate ?? null,
      episodeCount: season.episodeCount ?? 0
    })),
    keywords: (detail.keywords || []).map(keyword => ({ id: keyword.id })),
    mediaInfo: detail.mediaInfo
      ? {
          status: detail.mediaInfo.status ?? null,
          seasons: (detail.mediaInfo.seasons || []).map(season => ({
            seasonNumber: season.seasonNumber,
            status: season.status
          })),
          requests: (detail.mediaInfo.requests || []).map(request => ({
            status: request.status,
            seasons: (request.seasons || []).map(season => ({ seasonNumber: season.seasonNumber }))
          }))
        }
      : null
  };
}

// Short on purpose. This response carries mediaInfo, which is where "already requested" comes from,
// and requests get deleted in Jellyseerr's own UI where Hikari cannot see it happen. Cached for an
// hour, deleting a request left the panel insisting every season was still requested until the entry
// expired, with no way to clear it. There is no webhook for a deleted request, so the only honest
// option is to re-read.
//
// The cost is one call to a service on the same LAN per panel open: resolve() is the only caller
// besides the request route, and it runs once per detail view rather than per card.
export const DETAIL_TTL_MS = 30 * 1000;

export function tvDetail(tmdbId) {
  return cached(`seerr:tv:${tmdbId}`, DETAIL_TTL_MS, async () => projectDetail(await api(`/tv/${tmdbId}`)));
}

export function movieDetail(tmdbId) {
  return cached(`seerr:movie:${tmdbId}`, DETAIL_TTL_MS, async () => projectDetail(await api(`/movie/${tmdbId}`)));
}

export function sonarrServers() {
  return cached("seerr:sonarr-settings", 10 * 60 * 1000, () => api("/settings/sonarr"));
}

export function radarrServers() {
  return cached("seerr:radarr-settings", 10 * 60 * 1000, () => api("/settings/radarr"));
}

const AVAILABLE_STATUSES = new Set(["pending", "processing", "partial", "available"]);

// Jellyseerr request statuses: 1 pending approval, 2 approved, 3 declined, 4 failed, 5 completed.
const LIVE_REQUEST_STATUSES = new Map([
  [1, "pending approval"],
  [2, "already requested"],
  [5, "already requested"]
]);

// Which seasons are already spoken for. mediaInfo.seasons only fills in once Sonarr reports
// availability and is frequently empty, so open requests have to be read from
// mediaInfo.requests as well or duplicates slip through.
export function takenSeasons(detail) {
  const taken = new Map();

  for (const season of detail?.mediaInfo?.seasons || []) {
    const label = STATUS[season.status];
    if (AVAILABLE_STATUSES.has(label)) taken.set(season.seasonNumber, label);
  }

  for (const request of detail?.mediaInfo?.requests || []) {
    const label = LIVE_REQUEST_STATUSES.get(request.status);
    if (!label) continue;
    for (const season of request.seasons || []) {
      if (!taken.has(season.seasonNumber)) taken.set(season.seasonNumber, label);
    }
  }

  return taken;
}

// Jellyseerr decides "this is anime" purely from TMDB keyword 210024.
export const ANIME_KEYWORD_ID = 210024;

export function hasAnimeKeyword(detail) {
  return (detail?.keywords || []).some(keyword => keyword.id === ANIME_KEYWORD_ID);
}

export function requests(take = 30) {
  return cached(`seerr:requests:${take}`, 20 * 1000, async () => {
    const body = await api(`/request?take=${take}&skip=0&sort=added&filter=all`);
    return body.results || [];
  });
}

export async function resolve(anime) {
  const queries = [
    ...new Set(
      [anime.title.english, anime.title.romaji, anime.title.native]
        .filter(Boolean)
        .flatMap(title => [searchTitle(title), title])
        .filter(title => title.length >= 2)
    )
  ];

  const seen = new Set();
  const candidates = [];

  for (const query of queries.slice(0, 3)) {
    let results;
    try {
      results = await search(query);
    } catch {
      continue;
    }
    for (const item of results) {
      const id = `${item.mediaType}:${item.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push(item);
    }
  }

  const best = pickBest(anime, candidates);
  if (!best) return { matched: false, candidates: candidates.slice(0, 5).map(slim) };

  const item = best.candidate;
  const result = {
    matched: true,
    confidence: Number(best.score.toFixed(3)),
    tmdbId: item.id,
    mediaType: item.mediaType,
    title: item.name || item.title,
    year: best.candidateYear,
    status: STATUS[item.mediaInfo?.status] || "none",
    animeKeyword: null,
    seasons: null,
    suggestedSeason: null
  };

  try {
    const detail = item.mediaType === "tv" ? await tvDetail(item.id) : await movieDetail(item.id);
    result.animeKeyword = hasAnimeKeyword(detail);
    result.status = detail.mediaInfo ? STATUS[detail.mediaInfo.status] || "none" : "none";
  } catch {
    result.animeKeyword = null;
  }

  if (item.mediaType === "tv") {
    try {
      const detail = await tvDetail(item.id);
      const taken = takenSeasons(detail);

      result.seasons = (detail.seasons || [])
        .filter(s => s.seasonNumber > 0)
        .map(s => {
          const label = taken.get(s.seasonNumber);
          return {
            seasonNumber: s.seasonNumber,
            name: s.name,
            airDate: s.airDate,
            episodeCount: s.episodeCount,
            // `taken` is the flag clients branch on; `status` is only for display, so changing
            // the wording cannot silently re-enable requesting.
            taken: Boolean(label),
            status: label || "none"
          };
        });
      result.suggestedSeason = guessSeasonNumber(anime, result.seasons);
    } catch {
      result.seasons = null;
    }
  }

  return result;
}

export async function createRequest({ tmdbId, mediaType, seasons, overrides }) {
  const body = { mediaId: Number(tmdbId), mediaType, ...(overrides || {}) };
  if (mediaType === "tv") body.seasons = seasons === "all" ? "all" : seasons.map(Number);

  const created = await api("/request", { method: "POST", body: JSON.stringify(body) });
  invalidate("seerr:requests");
  invalidate(`seerr:tv:${tmdbId}`);
  invalidate("seerr:search:");
  return created;
}

function slim(item) {
  return {
    tmdbId: item.id,
    mediaType: item.mediaType,
    title: item.name || item.title,
    year: (item.firstAirDate || item.releaseDate || "").slice(0, 4) || null,
    status: STATUS[item.mediaInfo?.status] || "none"
  };
}
