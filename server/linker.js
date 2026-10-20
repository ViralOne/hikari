import { basename } from "./dates.js";
import { pickByTitle, resolveEpisode, seasonContext } from "./autolink.js";
import * as shoko from "./shoko.js";
import * as sonarr from "./sonarr.js";

// The link dialog: a person confirming what auto-link would not decide alone.
//
// Auto-link only acts on what it can prove. Everything it skips ends up here instead, with the
// same rules' best guess filled in and the reason next to it, so fixing a show is one click rather
// than a code change. The guesses never apply themselves; only the dialog's Link button writes.

const firstSegment = path => (path || "").replace(/\\/g, "/").split("/").filter(Boolean)[0] || "";

// A file Sonarr has no record of still sits in a "Season N" folder more often than not.
const seasonFromPath = path => {
  const match = /(?:^|\/)season\s*(\d+)(?:\/|$)/i.exec((path || "").replace(/\\/g, "/"));
  return match ? Number(match[1]) : null;
};

// The guess for each file of one season, kept pure so it can be tested without a live stack.
// `items` are { file, episode } where episode is Sonarr's, or null when Sonarr has no record.
export function proposeSeason(items, anidbEpisodes, offset) {
  const unfilled = (anidbEpisodes || []).filter(item => !item.hasFile);

  const rows = items.map(({ file, episode }) => {
    let guess = null;
    let reason = null;

    if (!episode) {
      reason = "Sonarr has no episode for this file";
    } else {
      const resolved = resolveEpisode(episode, anidbEpisodes, { offset });
      if (resolved.episode) {
        guess = { shokoEpisodeId: resolved.episode.shokoEpisodeId, via: resolved.via };
      } else {
        // Weaker than the rules auto-link uses, which is why only a person gets to accept it.
        const byTitle = pickByTitle(episode.title, unfilled, item => item.titles);
        if (byTitle) guess = { shokoEpisodeId: byTitle.shokoEpisodeId, via: "title" };
        else if (/already has a file/.test(resolved.reason || "")) {
          // Every candidate is taken, so this is almost always a second copy of an episode that is
          // already linked; the Extra copies box is where it gets cleaned up.
          reason = "looks like a second copy of an episode that is already linked; see Extra copies";
        } else reason = resolved.reason;
      }
    }
    return { file, episode, guess, reason };
  });

  // Two files pointing at one episode means at least one guess is wrong, and there is no telling
  // which, so neither is offered.
  const claims = new Map();
  for (const row of rows) {
    if (row.guess) claims.set(row.guess.shokoEpisodeId, (claims.get(row.guess.shokoEpisodeId) || 0) + 1);
  }
  for (const row of rows) {
    if (row.guess && claims.get(row.guess.shokoEpisodeId) > 1) {
      row.guess = null;
      row.reason = "another file points at the same episode";
    }
  }
  return rows;
}

const sonarrRef = episode =>
  episode
    ? {
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        title: episode.title,
        airDate: episode.airDate
      }
    : null;

// Every unlinked file under one library folder, grouped by season, each with its guess.
// `overrides` maps a season number to the Shoko series a person picked for it.
export async function buildPlan(folder, overrides = {}) {
  const [index, seriesList, shokoIndex] = await Promise.all([
    shoko.fileIndex(),
    sonarr.series(),
    shoko.seriesIndex()
  ]);
  const key = folder.toLowerCase();
  const files = index.unlinkedFiles.filter(file => firstSegment(file.path).toLowerCase() === key);
  const series = seriesList.find(item => basename(item.path).toLowerCase() === key) || null;
  const episodes = series ? await sonarr.episodes(series.id) : [];

  const byTail = new Map();
  for (const episode of episodes) {
    const tail = shoko.pathTail(episode.relativePath);
    if (tail) byTail.set(tail, episode);
  }

  const seasons = new Map();
  for (const file of files) {
    const episode = byTail.get(shoko.pathTail(file.path)) || null;
    const seasonNumber = episode?.seasonNumber ?? seasonFromPath(file.path);
    if (!seasons.has(seasonNumber)) seasons.set(seasonNumber, []);
    seasons.get(seasonNumber).push({ file, episode });
  }

  const result = [];
  for (const [seasonNumber, items] of [...seasons].sort((a, b) => (a[0] ?? 999) - (b[0] ?? 999))) {
    const override = Number(overrides[seasonNumber]) || null;
    const context = await seasonContext({ series, seasonNumber, episodes, index, shokoIndex, shokoId: override });
    const entry = context ? shokoIndex.byShoko.get(context.shokoId) : null;
    const rows = proposeSeason(
      items.sort((a, b) => (a.episode?.episodeNumber ?? 0) - (b.episode?.episodeNumber ?? 0)),
      context?.detail.episodes ?? [],
      context?.offset ?? null
    );

    result.push({
      seasonNumber,
      shoko: context
        ? { id: context.shokoId, name: entry?.name ?? `Shoko series ${context.shokoId}`, anidbId: entry?.anidbId ?? null }
        : null,
      chosenBy: override ? "you" : context ? "automatic" : null,
      offset: context?.offset ?? null,
      episodes: (context?.detail.episodes ?? []).map(item => ({
        shokoEpisodeId: item.shokoEpisodeId,
        episode: item.episode,
        title: item.title,
        airDate: item.airDate,
        hasFile: item.hasFile
      })),
      files: rows.map(row => ({
        fileId: row.file.fileId,
        name: row.file.path.split("/").pop(),
        size: row.file.size,
        sonarr: sonarrRef(row.episode),
        guess: row.guess,
        reason: context ? row.reason : "pick the AniDB series for this season first"
      }))
    });
  }

  return {
    folder,
    series: series ? { id: series.id, title: series.title, titles: series.titles || [series.title] } : null,
    seasons: result
  };
}
