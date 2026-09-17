import { config, enabled } from "./config.js";
import { cached, invalidate } from "./cache.js";
import { request } from "./http.js";
import { normalize, seasonOrdinal, similarity, usable } from "./match.js";

// Tuned against fixtures/match-cases.json (23 known-correct pairs, 184 known-wrong).
// 0.70 gives precision 0.957 / recall 0.957; the previous 0.85 only reached recall 0.826
// because Shokofin names items without the season ordinal AniList carries.
export const JELLYFIN_TITLE_THRESHOLD = 0.7;

// Jellyfin 12 only accepts the Authorization header form; X-Emby-Token was removed.
function headers() {
  return { Authorization: `MediaBrowser Token="${config.jellyfin.key}"`, Accept: "application/json" };
}

function api(path) {
  if (!enabled.jellyfin) throw new Error("Jellyfin is not configured");
  return request("jellyfin", `${config.jellyfin.url}${path}`, { headers: headers(), timeout: 30000 });
}

export function userId() {
  return cached("jellyfin:user", 60 * 60 * 1000, async () => {
    if (config.jellyfin.userId) return config.jellyfin.userId;
    const users = await api("/Users");
    const admin = users.find(user => user.Policy?.IsAdministrative) || users[0];
    if (!admin) throw new Error("Jellyfin has no users");
    return admin.Id;
  });
}

export function systemInfo() {
  return cached("jellyfin:system", 5 * 60 * 1000, () => api("/System/Info"));
}

export function seriesIndex() {
  // The full recursive listing is the slow call behind every card badge; an index a few minutes old
  // answers at once and refreshes behind, and markPlayed/refresh still invalidate it outright.
  return cached("jellyfin:series", 60 * 1000, async () => {
    const user = await userId();
    const body = await api(
      `/Items?userId=${user}&IncludeItemTypes=Series&Recursive=true` +
        `&Fields=Path,ProviderIds,OriginalTitle,RecursiveItemCount`
    );

    const byAniList = new Map();
    const byAnidb = new Map();
    const byTvdb = new Map();
    const byPath = new Map();
    const byTitle = [];
    // Jellyfin item id -> entry, for the webhook, which arrives with a SeriesId and nothing else.
    const byId = new Map();

    for (const item of body.Items || []) {
      const providers = item.ProviderIds || {};
      const data = item.UserData || {};

      const entry = {
        id: item.Id,
        name: item.Name,
        path: item.Path || null,
        anilistId: providers.AniList ? Number(providers.AniList) : null,
        anidbId: providers.AniDB ? Number(providers.AniDB) : null,
        tvdbId: providers.Tvdb ? Number(providers.Tvdb) : null,
        percent: Math.round(data.PlayedPercentage ?? 0),
        unplayed: data.UnplayedItemCount ?? 0,
        onDisk: item.RecursiveItemCount ?? 0,
        fullyPlayed: Boolean(data.Played)
      };

      byId.set(entry.id, entry);
      if (entry.anilistId) push(byAniList, entry.anilistId, entry);
      if (entry.anidbId) push(byAnidb, entry.anidbId, entry);
      if (entry.tvdbId) push(byTvdb, entry.tvdbId, entry);
      if (entry.path) push(byPath, entry.path.replace(/\/+$/, ""), entry);

      for (const title of [item.Name, item.OriginalTitle]) {
        const key = normalize(title);
        if (usable(key)) byTitle.push({ key, entry });
      }
    }

    return { byAniList, byAnidb, byTvdb, byPath, byTitle, byId };
  }, { staleFor: 4 * 60 * 1000 });
}

function push(map, key, value) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

// Cheap lookup used for every card. Exact ids first, then the Sonarr path, then titles.
export function progressFor(anime, library, shoko) {
  if (!enabled.jellyfin) return Promise.resolve(null);
  return cached(`jellyfin:progress:${anime.id}:${library?.id ?? 0}:${shoko?.anidbId ?? 0}`, 60 * 1000, () =>
    computeProgress(anime, library, shoko)
  );
}

async function computeProgress(anime, library, shoko) {
  let index;
  try {
    index = await seriesIndex();
  } catch {
    return null;
  }

  let matches = index.byAniList.get(anime.id) || null;
  let via = matches ? "anilist" : null;

  // Shokofin sometimes tags an item with only an AniDB id. Shoko bridges AniList's idMal to
  // that AniDB id, which keeps the match exact instead of falling back to a path guess.
  if (!matches && shoko?.anidbId) {
    matches = index.byAnidb.get(Number(shoko.anidbId)) || null;
    via = matches ? "anidb" : null;
  }

  if (!matches && library?.tvdbId) {
    matches = index.byTvdb.get(library.tvdbId) || null;
    via = matches ? "tvdb" : null;
  }

  if (!matches && library?.path) {
    matches = index.byPath.get(library.path.replace(/\/+$/, "")) || null;
    via = matches ? "path" : null;
  }

  if (!matches) {
    const titles = [anime.title.english, anime.title.romaji, anime.title.native].filter(Boolean);
    // Stripping season markers makes "Youjo Senki" and "Youjo Senki II" score 1.000 against
    // each other, so a plain > comparison silently picked whichever Jellyfin listed first.
    // Compare the ordinals that normalisation removed to break the tie deterministically.
    const wanted = titles.map(title => seasonOrdinal(title)).find(value => value != null) ?? 1;
    let best = null;

    for (const candidate of index.byTitle) {
      for (const title of titles) {
        const score = similarity(title, candidate.key);
        if (score < JELLYFIN_TITLE_THRESHOLD) continue;

        const ordinalMatch = (seasonOrdinal(candidate.entry.name) ?? 1) === wanted;
        if (!best || score > best.score || (score === best.score && ordinalMatch && !best.ordinalMatch)) {
          best = { score, entry: candidate.entry, ordinalMatch };
        }
      }
    }

    if (best) {
      matches = [best.entry];
      via = "title";
    }
  }

  if (!matches || matches.length === 0) return null;

  const percent = Math.max(...matches.map(entry => entry.percent));
  const unplayed = matches.reduce((sum, entry) => sum + entry.unplayed, 0);
  const onDisk = matches.reduce((sum, entry) => sum + entry.onDisk, 0);
  const played = Math.max(onDisk - unplayed, 0);

  // How long the season actually is, and how much of it has aired. Jellyfin only knows
  // what is on disk, so these come from AniList and are what "11 of 13" needs.
  const total = shoko?.totalEpisodes || anime.episodes || null;
  const aired = anime.nextEpisode
    ? Math.max(anime.nextEpisode.episode - 1, 0)
    : anime.status === "FINISHED"
      ? total
      : null;

  // Only an AniList-id match is guaranteed to be this exact entry. A tvdb/path/title match can
  // be a whole multi-season series, and mixing its episode totals with AniList's per-season
  // count produces nonsense like "60 of 25".
  const scoped = via === "anilist" || via === "anidb";

  return {
    via,
    scoped,
    ids: matches.map(entry => entry.id),
    name: matches[0].name,
    percent,
    unplayed,
    onDisk,
    played,
    total,
    aired,
    started: played > 0 || percent > 0,
    finished: matches.every(entry => entry.fullyPlayed) || (percent >= 100 && unplayed === 0)
  };
}

// Ordered episode items with their Jellyfin ids, which is what marking played needs. Season 0
// is dropped: specials are not part of the run AniList counts.
export async function episodeItems(seriesIds) {
  if (!enabled.jellyfin || !seriesIds?.length) return [];

  const user = await userId();
  const items = [];

  for (const seriesId of seriesIds.slice(0, 4)) {
    const body = await api(
      `/Items?userId=${user}&ParentId=${seriesId}&IncludeItemTypes=Episode&Recursive=true` +
        `&Fields=UserData&SortBy=ParentIndexNumber,IndexNumber&SortOrder=Ascending`
    );
    for (const item of body.Items || []) {
      if ((item.ParentIndexNumber ?? 0) === 0) continue;
      items.push({
        id: item.Id,
        season: item.ParentIndexNumber ?? null,
        episode: item.IndexNumber ?? null,
        name: item.Name,
        played: Boolean(item.UserData?.Played)
      });
    }
  }

  return items.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
}

// Which library holds the anime. On a Shoko stack that is whichever library points at the
// Shokofin VFS directory, which is a stronger signal than the library's name.
export function libraries() {
  return cached("jellyfin:libraries", 10 * 60 * 1000, async () => {
    const folders = await api("/Library/VirtualFolders");
    return (folders || []).map(folder => ({
      id: folder.ItemId,
      name: folder.Name,
      collectionType: folder.CollectionType || null,
      locations: folder.Locations || []
    }));
  }, { staleFor: 30 * 60 * 1000 });
}

export async function animeLibrary() {
  if (config.jellyfin.libraryId) {
    const known = await libraries().catch(() => []);
    const match = known.find(library => library.id === config.jellyfin.libraryId);
    return match ?? { id: config.jellyfin.libraryId, name: "configured library", locations: [] };
  }

  const known = await libraries();
  return (
    known.find(library => library.locations.some(path => /shokofin/i.test(path))) ??
    known.find(library => /anime/i.test(library.name)) ??
    null
  );
}

// Shokofin only exposes newly linked files after Jellyfin scans the library, and its live
// SignalR connection is off by default, so linking a file in Shoko otherwise waits for the
// 12-hourly Scan Media Library task.
//
// Refreshing one library item validates that folder's children, which is what discovers the
// new VFS entries. replaceAllMetadata stays false: rewriting metadata for a whole library is
// what churns item ids, and item ids are what watched flags hang off.
export async function refreshLibrary() {
  const library = await animeLibrary().catch(() => null);

  if (library) {
    await request(
      "jellyfin",
      `${config.jellyfin.url}/Items/${library.id}/Refresh` +
        `?metadataRefreshMode=Default&imageRefreshMode=Default&replaceAllMetadata=false&replaceAllImages=false`,
      { method: "POST", headers: headers(), timeout: 30000 }
    );
    invalidate("jellyfin:");
    return { queued: true, scope: "library", library: library.name };
  }

  // No library could be identified, so fall back to everything rather than doing nothing.
  await request("jellyfin", `${config.jellyfin.url}/Library/Refresh`, {
    method: "POST",
    headers: headers(),
    timeout: 30000
  });
  invalidate("jellyfin:");
  return { queued: true, scope: "all", library: null };
}

// Marks an item played for the configured user. Jellyfin 12 dropped /Users/{id}/PlayedItems.
export async function markPlayed(itemId) {
  const user = await userId();
  await request("jellyfin", `${config.jellyfin.url}/UserPlayedItems/${itemId}?userId=${user}`, {
    method: "POST",
    headers: headers(),
    timeout: 30000
  });
  invalidate("jellyfin:");
  return true;
}

// Exact episode counts and the next unwatched episode. Only used by the detail panel, which
// paid for up to four sequential /Items queries on every open, including reopening a title it
// had already shown. Keyed on the ids so a changed match recomputes, and cleared by the
// invalidate("jellyfin:") that markPlayed already issues, so a freshly marked episode is not
// hidden behind the TTL.
export function episodeProgress(seriesIds) {
  if (!enabled.jellyfin || !seriesIds?.length) return Promise.resolve(null);

  const ids = seriesIds.slice(0, 4);
  return cached(`jellyfin:episodes:${ids.join(",")}`, 60 * 1000, () => computeEpisodeProgress(ids));
}

async function computeEpisodeProgress(seriesIds) {
  const user = await userId();
  const episodes = [];

  for (const seriesId of seriesIds) {
    const body = await api(
      `/Items?userId=${user}&ParentId=${seriesId}&IncludeItemTypes=Episode&Recursive=true` +
        `&Fields=UserData&SortBy=ParentIndexNumber,IndexNumber&SortOrder=Ascending`
    );
    for (const item of body.Items || []) {
      episodes.push({
        season: item.ParentIndexNumber ?? null,
        episode: item.IndexNumber ?? null,
        name: item.Name,
        played: Boolean(item.UserData?.Played),
        lastPlayed: item.UserData?.LastPlayedDate || null
      });
    }
  }

  if (episodes.length === 0) return null;

  const played = episodes.filter(item => item.played);
  const next = episodes.find(item => !item.played) || null;
  const lastPlayed = played
    .map(item => item.lastPlayed)
    .filter(Boolean)
    .sort()
    .pop() || null;

  return {
    total: episodes.length,
    played: played.length,
    percent: Math.round((played.length / episodes.length) * 100),
    lastPlayed,
    next: next ? { season: next.season, episode: next.episode, name: next.name } : null,
    furthest: played.length > 0 ? lastWatchedLabel(played) : null
  };
}

function lastWatchedLabel(played) {
  const sorted = [...played].sort(
    (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0)
  );
  const last = sorted[sorted.length - 1];
  return { season: last.season, episode: last.episode, name: last.name };
}
