// The anime health panel: what the cleanup tools miss. Every category below was first found by
// hand on a real library, where each had quietly piled up for weeks:
//
//   missing-files  qBittorrent still lists the torrent but its data is gone (deleted by Sonarr,
//                  Maintainerr or Shoko). Nothing ever removes these entries.
//   orphan         Sonarr grabbed it, but the series is gone or has no files left. The torrent
//                  copy is usually a hardlink, so the space is only freed when it goes too.
//   unmanaged      An anime torrent Sonarr never grabbed. Its files live in a folder Sonarr does
//                  not manage, so Maintainerr reports "handled" and deletes nothing.
//
// Plus the library side: files Shoko hashed but AniDB never matched (invisible in Jellyfin) and
// folders under the anime root that Sonarr lists as unmapped.

import { normalize, similarity } from "./match.js";
import { SONARR_MATCH_THRESHOLD } from "./sonarr.js";

// The only states the panel's Clear button may act on. Usually the data really is gone (Sonarr,
// Maintainerr or Shoko deleted it), but qBittorrent reports the same states when the storage is
// merely unreachable -- a share not mounted yet, a full disk -- and clearing then costs the
// torrent entries, their ratio and Sonarr's tracking. looksLikeStorageOutage() guards that case.
export const CLEARABLE_STATES = new Set(["missingFiles", "error"]);

// When most of a client's torrents report missing data at once, the storage is offline; files
// deleted one show at a time never look like that. The floor keeps a small client with two
// genuinely dead torrents out of it.
export function looksLikeStorageOutage(torrents) {
  const broken = torrents.filter(torrent => CLEARABLE_STATES.has(torrent.state)).length;
  return torrents.length >= 10 && broken / torrents.length > 0.5;
}

const trimSlash = path => (path || "").replace(/\/+$/, "");

export function isAnimeTorrent(torrent, animeHashes, animeRoot) {
  if (animeHashes.has((torrent.hash || "").toLowerCase())) return true;
  if ((torrent.category || "").toLowerCase().includes("anime")) return true;
  return underRoot(torrent.savePath, animeRoot);
}

// Inside the root, not merely sharing its prefix: /data/anime-archive is not under /data/anime.
export function underRoot(path, root) {
  const base = trimSlash(root);
  const target = trimSlash(path);
  return Boolean(base) && (target === base || target.startsWith(`${base}/`));
}

// The show a release name is for: group tag, episode, season marker and quality stripped.
// "[SubsPlease] Gaikotsu Kishi-sama, Tadaima Isekai e Odekakechuu S2 - 09 (1080p)" -> the title.
export function releaseTitle(name) {
  return (name || "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .split(/\s+-\s+\d+|\s+S\d+(?:E\d+)?\b|\s+\(\d{3,4}p|\s+\[|\s+\d{3,4}p\b|\s+(?:Season|Part)\s+\d+/i)[0]
    .trim();
}

// For a download Sonarr did not grab: does Sonarr still have the show? Matched against every
// title Sonarr knows the series by, because outside releases use romaji and Sonarr often the
// English title. Only ever used to label the item, never to decide what is safe to remove.
function guessSeries(name, series) {
  const wanted = normalize(releaseTitle(name));
  if (wanted.length < 4) return null;
  let best = null;
  for (const item of series) {
    for (const key of item.keys || [normalize(item.title)]) {
      const score = key === wanted ? 1 : similarity(key, wanted);
      if (score >= SONARR_MATCH_THRESHOLD && (!best || score > best.score)) best = { item, score };
    }
  }
  return best?.item ?? null;
}

function torrentIssue(torrent, animeHashes, seriesById) {
  if (CLEARABLE_STATES.has(torrent.state)) return "missing-files";
  const seriesId = animeHashes.get((torrent.hash || "").toLowerCase());
  if (seriesId == null) return "unmanaged";
  // A download still in progress has not been imported yet, so "no files" means nothing.
  if (torrent.progress < 1) return null;
  const series = seriesById.get(seriesId);
  if (!series || !series.episodeFileCount) return "orphan";
  return null;
}

// The first folder under the anime root, which is the show for every layout seen so far.
const showOf = path => (path || "").replace(/\\/g, "/").split("/").filter(Boolean)[0] || "unknown";
const folderKey = name => (name || "").trim().toLowerCase();
const lastSegment = path => (path || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";

// What the panel shows for a Sonarr series. Tags are resolved to their labels; an id Sonarr no
// longer has (a tag deleted after it was applied) is dropped rather than shown as a bare number.
function seriesRef(item, tags) {
  if (!item) return null;
  return {
    id: item.id,
    title: item.title,
    tags: (item.tagIds || []).map(id => tags.get(id)).filter(Boolean)
  };
}

export function classifyAnimeHealth({ animeRoot, torrents, animeHashes, series, unlinkedFiles, rootFolders, tags = new Map() }) {
  const seriesById = new Map(series.map(item => [item.id, item]));
  // Shoko's relative path starts at the series folder, which is the last segment of Sonarr's
  // series path. Case is ignored: the two have disagreed on it for the same folder.
  const seriesByFolder = new Map(series.map(item => [folderKey(lastSegment(item.path)), item]));

  const anime = torrents
    .filter(torrent => isAnimeTorrent(torrent, animeHashes, animeRoot))
    .map(torrent => {
      const seriesId = animeHashes.get((torrent.hash || "").toLowerCase()) ?? null;
      const issue = torrentIssue(torrent, animeHashes, seriesById);
      return {
        // The show the release name is for, so the panel groups with the same title the guess used.
        releaseTitle: releaseTitle(torrent.name) || torrent.name,
        // Only for downloads Sonarr did not grab: which series Sonarr has the show under, if any.
        seriesGuess: seriesId == null ? seriesRef(guessSeries(torrent.name, series), tags) : null,
        hash: torrent.hash,
        name: torrent.name,
        category: torrent.category,
        state: torrent.state,
        size: torrent.size,
        ratio: torrent.ratio,
        series: seriesId != null ? seriesRef(seriesById.get(seriesId), tags) : null,
        issue
      };
    });

  const root = trimSlash(animeRoot);
  const unmanagedFolders = rootFolders
    .filter(folder => trimSlash(folder.path) === root)
    .flatMap(folder => folder.unmapped || [])
    .sort((a, b) => a.localeCompare(b));

  const unlinked = [...unlinkedFiles].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  // Grouped by the Sonarr series that owns the folder; a folder Sonarr has no series for keeps
  // its own name and series: null, which the panel shows as "not in Sonarr".
  const groups = new Map();
  for (const file of unlinked) {
    const folder = showOf(file.path);
    const owner = seriesByFolder.get(folderKey(folder)) || null;
    const key = owner ? `series:${owner.id}` : `folder:${folderKey(folder)}`;
    const group = groups.get(key) || { show: owner ? owner.title : folder, series: seriesRef(owner, tags), files: 0, size: 0 };
    group.files += 1;
    group.size += file.size ?? 0;
    groups.set(key, group);
  }

  const withIssue = issue => anime.filter(torrent => torrent.issue === issue);
  const bytes = list => list.reduce((sum, torrent) => sum + (torrent.size ?? 0), 0);

  return {
    torrents: anime,
    unmanagedFolders,
    unlinked,
    unlinkedByShow: [...groups.values()].sort((a, b) => b.size - a.size),
    // How many tags Sonarr has at all, so the panel can say "none set" instead of looking broken.
    sonarrTags: tags.size,
    totals: {
      anime: anime.length,
      missingFiles: withIssue("missing-files").length,
      orphans: withIssue("orphan").length,
      orphanBytes: bytes(withIssue("orphan")),
      unmanaged: withIssue("unmanaged").length,
      unlinked: unlinked.length,
      unmanagedFolders: unmanagedFolders.length
    }
  };
}
