// AniList, TMDB and TVDB disagree about what a season is, and they disagree in both directions.
//
//   The Apothecary Diaries: TMDB 220542 carries one "Season 1" of 48 episodes, growing to 72 when
//   the third cour airs. TVDB 431162 splits the same show into three seasons. Jellyseerr speaks
//   TMDB, so the only season it can offer is 1, and requesting it monitors Sonarr's season 1 --
//   the first cour, not the one that was asked for.
//
//   That Time I Got Reincarnated as a Slime: AniList splits the second season into Part 1 and
//   Part 2, twelve episodes each. TVDB keeps both as a single 24-episode season 2. Mapping the
//   entry to a season would hand Part 2 all 24 episodes.
//
// Neither case can be expressed as a season number, so this module answers a narrower question:
// which of Sonarr's episodes does this one AniList entry mean? Air date is the only field the
// three sources agree on, so it is the anchor, and the episode count decides the length.
//
// The tests in scripts/test-cours.mjs run against real season shapes pulled from a live library.

// Cours are about thirteen weeks apart, so three weeks of slack absorbs a delayed premiere or a
// TVDB date recorded in the wrong timezone without ever reaching the neighbouring cour. The
// TMDB-side guess in match.js uses 400 days because TMDB only dates whole seasons; here the dates
// are per episode, so the window can be this tight.
export const AIR_DATE_WINDOW_DAYS = 21;

const DAY = 24 * 60 * 60 * 1000;

function startedAt(anime) {
  const date = anime?.startDate;
  // A year on its own is worthless for this: it cannot tell a winter cour from an autumn one.
  if (!date?.year || !date.month || !date.day) return null;
  return Date.UTC(date.year, date.month - 1, date.day);
}

function airedAt(episode) {
  if (!episode.airDate) return null;
  const parsed = Date.parse(`${episode.airDate}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

// Season 0 is specials. AniList entries never map onto them, and they carry air dates that can sit
// right next to a real premiere, so they are dropped before anything is compared.
function ordered(episodes) {
  return (episodes || [])
    .filter(episode => Number(episode.seasonNumber) > 0)
    .slice()
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

function seasonOf(episodes, seasonNumber) {
  return episodes.filter(episode => episode.seasonNumber === seasonNumber);
}

// Does TMDB fold several of Sonarr's seasons into fewer? That is the condition that makes a plain
// Jellyseerr season request unable to say what was meant, and it is what turns the reconcile flow
// on. Called with Jellyseerr's season list and Sonarr's episode list.
export function lumped(tmdbSeasons, sonarrEpisodes) {
  const episodes = ordered(sonarrEpisodes);
  if (episodes.length === 0) return false;

  // TVDB pre-announces a sequel as a season holding one dateless placeholder episode long before
  // TMDB adds it. Counting those made Wistoria look lumped -- three TVDB seasons against two on
  // TMDB -- when the two sources actually agree about everything that exists.
  const sonarrSeasons = new Set(
    episodes.filter(episode => episode.airDate).map(episode => episode.seasonNumber)
  );
  const tmdbCount = (tmdbSeasons || []).filter(season => Number(season.seasonNumber) > 0).length;
  if (tmdbCount === 0) return false;

  return sonarrSeasons.size > tmdbCount;
}

// The same question for a show Sonarr does not hold yet, where there are no episodes to compare
// against. TMDB offering one season for something AniList calls a third season is lumped by
// definition, and that is exactly the case that has to be caught before the first request.
export function lumpedByChain(tmdbSeasons, prequelDepth) {
  if (!Number.isInteger(prequelDepth) || prequelDepth < 1) return false;

  const tmdbCount = (tmdbSeasons || []).filter(season => Number(season.seasonNumber) > 0).length;
  if (tmdbCount === 0) return false;

  return tmdbCount < prequelDepth + 1;
}

// Would requesting the plain TMDB season fetch more than this AniList entry covers? That is the
// real question, and it has two independent answers:
//
//   seasons-folded      TMDB reports fewer seasons than Sonarr has, so the season number is
//                       ambiguous. Apothecary Diaries: one TMDB season, three in Sonarr.
//   cour-within-season  The counts agree, but the entry is only part of a Sonarr season. Slime:
//                       four seasons on both sides, yet AniList's 2nd Season Part 2 is the back
//                       half of Sonarr's season 2.
//
// Checking only the season counts misses the second case entirely, which is why this takes the
// resolved target too. Returns null when no narrowing is needed.
export function narrowingKind({ tmdbSeasons, sonarrEpisodes, prequelDepth, target }) {
  if (target && !target.wholeSeason) return "cour-within-season";
  if (lumped(tmdbSeasons, sonarrEpisodes) || lumpedByChain(tmdbSeasons, prequelDepth)) return "seasons-folded";
  return null;
}

// The episodes of one Sonarr series that belong to one AniList entry, or null when it cannot be
// worked out. Null is a real answer and callers are expected to surface it as "pick a season"
// rather than falling back to a guess: a wrong season costs a whole download, a refusal costs a
// click.
export function courEpisodes(anime, sonarrEpisodes, { windowDays = AIR_DATE_WINDOW_DAYS } = {}) {
  const episodes = ordered(sonarrEpisodes);
  if (episodes.length === 0) return null;

  const wanted = Number(anime?.episodes) > 0 ? Number(anime.episodes) : null;

  const anchor = anchorByAirDate(anime, episodes, windowDays);
  if (anchor) return run(episodes, anchor.episode, wanted, "air-date", anchor.exact ? 1 : 0.9);

  return byChainOrdinal(anime, episodes, wanted);
}

// The episode whose air date is closest to the AniList start date. Ties go to the earlier episode,
// which is the one a cour starts on.
function anchorByAirDate(anime, episodes, windowDays) {
  const target = startedAt(anime);
  if (target === null) return null;

  const limit = windowDays * DAY;
  let best = null;

  for (const episode of episodes) {
    const aired = airedAt(episode);
    if (aired === null) continue;
    const gap = Math.abs(aired - target);
    if (gap > limit) continue;
    if (!best || gap < best.gap) best = { gap, episode };
  }

  if (!best) return null;
  return { episode: best.episode, exact: best.gap === 0 };
}

// When no episode carries an air date there is nothing to anchor to, so fall back to counting the
// prequel chain: the third cour of a show is Sonarr's season 3. Accepted only when the episode
// count agrees, because the chain says nothing about how TVDB grouped the episodes -- the Slime
// case above has depth 2 pointing at a season holding two cours.
function byChainOrdinal(anime, episodes, wanted) {
  const depth = Number(anime?.prequelDepth);
  if (!Number.isInteger(depth) || depth < 0) return null;

  const seasonNumber = depth + 1;
  const season = seasonOf(episodes, seasonNumber);
  if (season.length === 0) return null;
  if (wanted !== null && season.length !== wanted) return null;

  return run(episodes, season[0], wanted, "chain-ordinal", 0.7);
}

// A contiguous run of episodes starting at `from`, never leaving its season. Leaving it would
// monitor episodes belonging to a different AniList entry, which is the failure this whole module
// exists to prevent, so a cour that claims to be longer than its season is clamped and says so.
function run(episodes, from, wanted, via, confidence) {
  const season = seasonOf(episodes, from.seasonNumber);
  const start = season.findIndex(episode => episode.episodeNumber === from.episodeNumber);
  if (start === -1) return null;

  const available = season.length - start;
  const take = wanted === null ? available : Math.min(wanted, available);
  const matched = season.slice(start, start + take);
  if (matched.length === 0) return null;

  return {
    seasonNumber: from.seasonNumber,
    matched,
    via,
    confidence,
    // True when AniList expects more episodes than the season has left, which usually means TVDB
    // has split a cour across two seasons. The caller should say so rather than pretend.
    clamped: wanted !== null && wanted > available,
    // Whether this is the season in its entirety. When it is, the request can be expressed as a
    // plain season and the episode-level narrowing is not needed.
    wholeSeason: matched.length === season.length
  };
}
