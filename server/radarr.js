import { config, enabled } from "./config.js";
import { cached } from "./cache.js";
import { request } from "./http.js";
import { normalize, similarity, usable } from "./match.js";

function api(path) {
  if (!enabled.radarr) throw new Error("Radarr is not configured");
  return request("radarr", `${config.radarr.url}/api/v3${path}`, {
    headers: { "X-Api-Key": config.radarr.key }
  });
}

export function version() {
  return cached("radarr:version", 5 * 60 * 1000, async () => {
    const status = await api("/system/status");
    return `v${status.version}`;
  });
}

export function movies() {
  return cached("radarr:movies", 2 * 60 * 1000, async () => {
    const list = await api("/movie");
    return list.map(item => ({
      id: item.id,
      tmdbId: item.tmdbId ?? null,
      title: item.title,
      year: item.year ?? null,
      path: item.path,
      monitored: item.monitored,
      hasFile: Boolean(item.hasFile),
      sizeOnDisk: item.sizeOnDisk ?? 0,
      quality: item.movieFile?.quality?.quality?.name ?? null,
      keys: [
        ...new Set(
          [item.title, item.originalTitle, ...(item.alternateTitles || []).map(alt => alt.title)]
            .filter(Boolean)
            .map(normalize)
            .filter(usable)
        )
      ]
    }));
  }, { staleFor: 8 * 60 * 1000 });
}

// Movies live in Radarr, so the Sonarr matcher deliberately skips them. TMDB id is exact when
// Jellyseerr has already resolved one; titles are the fallback.
export function findMatch(anime, tmdbId) {
  if (!enabled.radarr) return Promise.resolve(null);
  if (anime.format !== "MOVIE") return Promise.resolve(null);
  return cached(`radarr:match:${anime.id}:${tmdbId ?? 0}`, 2 * 60 * 1000, () => computeMatch(anime, tmdbId));
}

async function computeMatch(anime, tmdbId) {
  let list;
  try {
    list = await movies();
  } catch {
    return null;
  }

  if (tmdbId) {
    const exact = list.find(movie => movie.tmdbId === Number(tmdbId));
    if (exact) return shape(exact, 1, "tmdb");
  }

  const titles = [anime.title.english, anime.title.romaji, anime.title.native].filter(Boolean);
  let best = null;

  for (const movie of list) {
    for (const key of movie.keys) {
      for (const title of titles) {
        const score = similarity(title, key);
        if (!best || score > best.score) best = { score, movie };
      }
    }
  }

  if (!best || best.score < 0.8) return null;
  return shape(best.movie, best.score, "title");
}

function shape(movie, confidence, via) {
  return {
    id: movie.id,
    tmdbId: movie.tmdbId,
    title: movie.title,
    year: movie.year,
    path: movie.path,
    monitored: movie.monitored,
    hasFile: movie.hasFile,
    sizeOnDisk: movie.sizeOnDisk,
    quality: movie.quality,
    complete: movie.hasFile,
    confidence: Number(confidence.toFixed(3)),
    via
  };
}
