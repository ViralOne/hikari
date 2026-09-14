import { config, enabled } from "./config.js";
import { cached, invalidate } from "./cache.js";
import { request } from "./http.js";

function api(path, options = {}) {
  if (!enabled.shoko) throw new Error("Shoko is not configured");
  return request("shoko", `${config.shoko.url}/api/v3${path}`, {
    ...options,
    headers: {
      apikey: config.shoko.key,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
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
  if (!enabled.shoko) {
    return Promise.resolve({ byMal: new Map(), byAnidb: new Map(), byTmdb: new Map(), byTvdb: new Map() });
  }

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
    const byTvdb = new Map();

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
      for (const tvdb of entry.tvdbIds) byTvdb.set(Number(tvdb), entry);
    }

    return { byMal, byAnidb, byTmdb, byTvdb };
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

// Every file Shoko has hashed, with whether it is linked to a series. A file with no cross
// reference is what Shoko's UI calls unrecognised: it exists, it is hashed, but AniDB never
// matched it, so it counts as a missing episode even though it is sitting on the disk.
//
// There is no server-side filter for "unlinked": `include` only takes Ignored, MediaInfo,
// XRefs, AbsolutePaths and ImportLimbo, and an unknown query parameter is silently dropped.
// An earlier version passed include_unrecognized=only and got the unfiltered total back,
// which reported every file in the collection as unrecognised.
export function fileIndex() {
  if (!enabled.shoko) return Promise.resolve({ total: 0, unlinked: 0, byTail: new Map() });

  return cached("shoko:files:index", 5 * 60 * 1000, async () => {
    const files = [];
    for (let page = 1; page <= 40; page += 1) {
      const body = await api(`/File?pageSize=100&page=${page}&include=XRefs`);
      const batch = body.List || [];
      files.push(...batch);
      if (batch.length < 100) break;
      if (body.Total != null && files.length >= body.Total) break;
    }

    const byTail = new Map();
    const unlinkedFiles = [];
    // One entry per file, not per location: a file with two locations was counted twice, which
    // inflated the number shown in the panel and put a duplicate in the sweep's candidate list.
    const counted = new Set();

    for (const file of files) {
      const linked = (file.SeriesIDs || []).length > 0;

      for (const location of file.Locations || []) {
        const entry = {
          fileId: file.ID,
          linked,
          size: file.Size ?? 0,
          path: location.RelativePath,
          // When Shoko first saw the file. The automatic linker uses it to leave new files
          // alone for a while, so AniDB gets its chance before anything is linked by hand.
          created: file.Created ?? null
        };
        const tail = pathTail(location.RelativePath);
        if (tail) byTail.set(tail, entry);
        if (!linked && !counted.has(file.ID)) {
          counted.add(file.ID);
          unlinkedFiles.push(entry);
        }
      }
    }

    return { total: files.length, unlinked: unlinkedFiles.length, unlinkedFiles, byTail };
  });
}

// Shoko and Sonarr mount the library at different roots, so only the tail of the path can be
// compared. Two segments keeps "Season 1/01.mkv" style names from colliding across shows.
export function pathTail(path) {
  if (!path) return null;
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join("/")
    .toLowerCase();
}

// Ask AniDB about the file again. Harmless: it either finds a match or changes nothing.
export async function rescanFile(fileId) {
  await api(`/File/${Number(fileId)}/Rescan`, { method: "POST" });
  invalidate("shoko:");
  return { rescanned: true };
}

// Collection-wide maintenance. Allowlisted rather than proxied by name: Shoko's Action group
// also holds SyncMyList and the Purge commands, which are genuinely destructive.
//
// All three are queued jobs, so they return immediately and the numbers move a while later.
const ACTIONS = {
  // Asks AniDB again for every file it has no record for. The first thing to try for a file
  // that is on disk but unlinked.
  "refresh-anidb": { path: "/Action/UpdateMissingAniDBFileInfo", label: "retry AniDB on files with missing info" },
  // Drops database rows for files that no longer exist. removeFromMyList stays false so this
  // cannot touch your AniDB list. Sonarr replacing a file with an upgrade leaves one of these
  // behind, and it counts as unlinked until it is cleared.
  "forget-deleted": { path: "/Action/RemoveMissingFiles/false", label: "forget files that are no longer on disk" },
  // Hashes anything in the import folder Shoko has not seen yet.
  "import-new": { path: "/Action/ImportNewFiles", label: "import new files" }
};

export function actionLabel(name) {
  return ACTIONS[name]?.label ?? null;
}

export async function runAction(name) {
  const action = ACTIONS[name];
  if (!action) throw new Error(`unknown action ${name}`);
  await api(action.path);
  invalidate("shoko:");
  return { queued: true, action: name, label: action.label };
}

// The fix when AniDB simply has no record of the release: point the file at the episode by
// hand. Metadata only, nothing on disk is touched.
export async function linkFile(fileId, episodeIds) {
  await api(`/File/${Number(fileId)}/Link`, {
    method: "POST",
    body: JSON.stringify({ EpisodeIDs: episodeIds.map(Number) })
  });
  invalidate("shoko:");
  return { linked: episodeIds.length };
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
        // Needed to link a file by hand, which is the only fix when AniDB has no record of
        // the release.
        shokoEpisodeId: episode.IDs?.ID ?? null,
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
