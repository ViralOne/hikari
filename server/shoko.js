import { config, enabled } from "./config.js";
import { cached } from "./cache.js";
import { request } from "./http.js";

function api(path) {
  if (!enabled.shoko) throw new Error("Shoko is not configured");
  return request("shoko", `${config.shoko.url}/api/v3${path}`, {
    headers: { apikey: config.shoko.key, Accept: "application/json" },
    timeout: 30000
  });
}

export function version() {
  return cached("shoko:version", 5 * 60 * 1000, async () => {
    const status = await api("/Init/Status");
    return status.State || "unknown";
  });
}

// Shoko is authoritative on anime episode counts because it reads AniDB, which numbers
// specials and split cours correctly where TMDB does not. One call carries every series
// plus its sizes, so this stays cheap.
export function seriesIndex() {
  if (!enabled.shoko) return Promise.resolve({ byMal: new Map(), byAnidb: new Map(), byTmdb: new Map() });

  return cached("shoko:series", 5 * 60 * 1000, async () => {
    // Shoko rejects pageSize above 100, so walk the pages.
    const items = [];
    for (let page = 1; page <= 20; page += 1) {
      const body = await api(`/Series?pageSize=100&page=${page}&includeDataFrom=AniDB`);
      const batch = body.List || [];
      items.push(...batch);
      if (batch.length < 100) break;
      if (body.Total != null && items.length >= body.Total) break;
    }

    const byMal = new Map();
    const byAnidb = new Map();
    const byTmdb = new Map();

    for (const item of items) {
      const ids = item.IDs || {};
      const sizes = item.Sizes || {};
      const local = sizes.Local || {};
      const missing = sizes.Missing || {};
      const total = sizes.Total || {};
      const watched = sizes.Watched || {};

      const entry = {
        shokoId: ids.ID,
        name: item.Name,
        anidbId: ids.AniDB ?? null,
        malIds: ids.MAL || [],
        // Shoko records the TvDB id AniDB maps to, and Sonarr keys every series by tvdbId.
        // That pair is an exact bridge, which is what lets the Sonarr match skip title
        // similarity entirely for anything Shoko knows about.
        tvdbIds: (ids.TvDB || []).map(Number).filter(Number.isFinite),
        tmdbShowIds: ids.TMDB?.Show || [],
        onDisk: local.Episodes ?? 0,
        missing: missing.Episodes ?? 0,
        totalEpisodes: total.Episodes ?? 0,
        watched: watched.Episodes ?? 0,
        specials: { onDisk: local.Specials ?? 0, missing: missing.Specials ?? 0 },
        sources: Object.entries(sizes.FileSources || {})
          .filter(([, count]) => count > 0)
          .map(([name, count]) => ({ name, count }))
      };

      for (const mal of entry.malIds) byMal.set(Number(mal), entry);
      if (entry.anidbId) byAnidb.set(Number(entry.anidbId), entry);
      for (const tmdb of entry.tmdbShowIds) byTmdb.set(Number(tmdb), entry);
    }

    return { byMal, byAnidb, byTmdb };
  });
}

// AniList exposes idMal, and Shoko records MAL ids, so that pair is an exact bridge for
// entries whose Jellyfin item only carries an AniDB id.
export async function infoFor(anime) {
  if (!enabled.shoko) return null;

  let index;
  try {
    index = await seriesIndex();
  } catch {
    return null;
  }

  const entry = anime.malId ? index.byMal.get(Number(anime.malId)) : null;
  const via = entry ? "mal" : null;

  if (!entry) return null;
  return { ...entry, via };
}

// Files on disk that Shoko could not match to an AniDB episode. They are the usual reason a
// season reads as "missing" while Sonarr and the filesystem both have the file.
export function unrecognizedCount() {
  if (!enabled.shoko) return Promise.resolve(null);
  return cached("shoko:unrecognized", 5 * 60 * 1000, async () => {
    const body = await api("/File?pageSize=1&include_unrecognized=only");
    return body.Total ?? (body.List || []).length;
  });
}

// Release group and source per episode. Only worth fetching for a single opened title.
export function fileDetail(shokoId) {
  return cached(`shoko:files:${shokoId}`, 30 * 60 * 1000, async () => {
    const body = await api(
      `/Series/${shokoId}/Episode?pageSize=100&includeMissing=true&includeDataFrom=AniDB&includeFiles=true`
    );

    const episodes = [];
    const groups = new Map();

    for (const episode of body.List || []) {
      const anidb = episode.AniDB || {};
      if (anidb.Type && anidb.Type !== "Normal" && anidb.Type !== "Episode") continue;

      const files = episode.Files || [];
      const first = files[0]?.AniDB || {};
      const rawGroup = first.ReleaseGroup;
      const group = typeof rawGroup === "object" && rawGroup ? rawGroup.Name : rawGroup || null;

      if (group) groups.set(group, (groups.get(group) || 0) + 1);

      episodes.push({
        episode: anidb.EpisodeNumber ?? null,
        airDate: anidb.AirDate ?? null,
        hasFile: files.length > 0,
        group,
        source: first.Source || null
      });
    }

    const missing = episodes.filter(item => !item.hasFile).map(item => item.episode);

    return {
      episodes,
      missing,
      groups: [...groups.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      mixedGroups: groups.size > 1
    };
  });
}
