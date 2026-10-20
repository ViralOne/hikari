// File problems: what is on disk in the anime library that should not be, or is there but cannot be
// followed.
//
// Two things go wrong without anything noticing. A second copy of an episode lands in a series
// folder (a torrent added by hand with the library as its save path, or an import that kept the old
// file), and since Sonarr does not track it, nothing ever removes it; Shoko links whichever copy
// AniDB knows, which may well be the worse one. And a release whose name promises subtitles ships
// without them, or with only French or Chinese ones, and plays without anyone knowing until it is
// opened. Both are found here from data the stack already has: Shoko's file list, Sonarr's
// episodes with their media scan, and qBittorrent's torrents.

const norm = path => (path || "").replace(/\\/g, "/").replace(/\/+$/, "");
const tailOf = path => norm(path).split("/").filter(Boolean).slice(-2).join("/").toLowerCase();
const nameOf = path => norm(path).split("/").pop() || "";
const folderKey = path => (norm(path).split("/").pop() || "").toLowerCase();

const label = (season, episode) =>
  `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

// "S02E07", "S2 - 07" and "Season 2/… - 07" all name the same episode; null when the name says nothing.
export function episodeFromName(path) {
  const name = nameOf(path);
  let match = /\bS(\d{1,2})E(\d{1,3})\b/i.exec(name);
  if (match) return { season: Number(match[1]), episode: Number(match[2]) };
  match = /\bS(\d{1,2})\s*-\s*(\d{1,3})\b/i.exec(name);
  if (match) return { season: Number(match[1]), episode: Number(match[2]) };
  const season = /(?:^|\/)season\s*(\d+)\//i.exec(norm(path));
  match = /\s-\s(\d{1,3})(?:v\d)?\b/.exec(name);
  if (season && match) return { season: Number(season[1]), episode: Number(match[1]) };
  return null;
}

const codes = value => (value || "").toLowerCase().split(/[\s/,]+/).filter(Boolean);

// Watchable when it has a subtitle or an audio track in one of the wanted languages. A file Sonarr
// has not scanned yet (no audio info at all) is not judged.
export function watchable(episode, wanted) {
  const audio = codes(episode.audioLanguages);
  if (audio.length === 0 && codes(episode.subtitles).length === 0) return null;
  return [...codes(episode.subtitles), ...audio].some(code => wanted.includes(code));
}

// `series` are Sonarr's anime series, `episodesBySeries` maps a series id to its episodes (with the
// file fields from sonarr.episodes), `shokoFiles` is every file Shoko knows (one entry per
// location), `torrents` is qBittorrent's list.
export function findFileProblems({ series, episodesBySeries, shokoFiles, torrents, wanted }) {
  const byFolder = new Map(series.map(item => [folderKey(item.path), item]));
  const torrentByName = new Map();
  for (const torrent of torrents) {
    const name = nameOf(torrent.contentPath).toLowerCase();
    if (name) torrentByName.set(name, torrent);
  }

  const extraCopies = [];
  const seen = new Set();
  for (const file of shokoFiles) {
    if (seen.has(file.fileId)) continue;
    seen.add(file.fileId);

    const owner = byFolder.get((norm(file.path).split("/")[0] || "").toLowerCase());
    if (!owner) continue;
    const episodes = episodesBySeries.get(owner.id) || [];
    const tracked = new Set(episodes.filter(item => item.relativePath).map(item => tailOf(item.relativePath)));
    if (tracked.has(tailOf(file.path))) continue;

    const parsed = episodeFromName(file.path);
    const kept = parsed
      ? episodes.find(item => item.seasonNumber === parsed.season && item.episodeNumber === parsed.episode && item.relativePath)
      : null;
    const torrent = torrentByName.get(nameOf(file.path).toLowerCase()) || null;

    extraCopies.push({
      fileId: file.fileId,
      name: nameOf(file.path),
      size: file.size ?? 0,
      linked: Boolean(file.linked),
      series: { id: owner.id, title: owner.title },
      episode: parsed ? label(parsed.season, parsed.episode) : null,
      // The copy Sonarr does track for the same episode, so the panel can show what stays.
      kept: kept ? { name: nameOf(kept.relativePath), size: kept.size ?? 0, subtitles: kept.subtitles || "" } : null,
      torrent: torrent ? { hash: torrent.hash, name: torrent.name, category: torrent.category } : null
    });
  }

  const unwatchable = [];
  for (const item of series) {
    for (const episode of episodesBySeries.get(item.id) || []) {
      if (!episode.relativePath || watchable(episode, wanted) !== false) continue;
      unwatchable.push({
        series: { id: item.id, title: item.title },
        episodeId: episode.id,
        episode: label(episode.seasonNumber, episode.episodeNumber),
        name: nameOf(episode.relativePath),
        release: episode.sceneName,
        subtitles: episode.subtitles || "",
        audio: episode.audioLanguages || ""
      });
    }
  }

  return {
    extraCopies: extraCopies.sort((a, b) => b.size - a.size),
    unwatchable: unwatchable.sort((a, b) => a.series.title.localeCompare(b.series.title) || a.episode.localeCompare(b.episode)),
    wanted
  };
}
