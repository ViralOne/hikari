// Which AniDB anime one Sonarr season is, when nothing proves it yet.
//
// AniDB gives every season its own anime, and a new one often has no TVDB mapping and no file AniDB
// has matched by hash, so the id bridges have nothing to offer. What is left is what a person would
// look at: the titles (Sonarr's, the release names, AniList's entry that aired that week), the year
// AniDB puts on same-named sequels ("Kikansha no Mahou wa Tokubetsu Desu" is 2025, "... (2026)" the
// second season), an ordinal in the title, and the air date once Shoko has the anime. The scoring
// below is the same for every show. When two candidates are still too close to call, an LLM may be
// asked (see groq.js), but it can only choose among the candidates this file kept.

import { normalize, similarity } from "./match.js";
import { titleKey } from "./titles.js";

const DAY = 24 * 60 * 60 * 1000;
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };

export function titleYear(title) {
  const match = /\((19|20)(\d\d)\)\s*$/.exec(title || "");
  return match ? Number(match[1] + match[2]) : null;
}

// The season a title spells out: "2nd Season", "Season 2", "Dai 3 Ki", "第3期", "II", "Part 2", a
// trailing "2". Null when it names none, which is what a first season or a subtitled arc looks like.
export function titleOrdinal(title) {
  const lower = (title || "").toLowerCase().replace(/\((19|20)\d\d\)\s*$/, "").trim();
  const numeric =
    /\bseason\s*(\d{1,2})\b/.exec(lower) ||
    /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/.exec(lower) ||
    /\bdai\s*(\d{1,2})\s*ki\b/.exec(lower) ||
    /第\s*(\d{1,2})\s*(?:期|季|シーズン)/.exec(lower) ||
    /\bs(\d{1,2})$/.exec(lower) ||
    /\s(\d{1,2})$/.exec(lower);
  if (numeric) return Number(numeric[1]);
  const word = /\b(first|second|third|fourth|fifth|sixth)\s+season\b/.exec(lower);
  if (word) return WORDS[word[1]];
  const roman = /\s(i{1,3}|iv|vi{0,3}|ix|x)$/.exec(lower);
  return roman ? ROMAN[roman[1]] ?? null : null;
}

// The show names inside a release name. "[Erai-raws] Tougen Anki: Nikko Kegon no Taki-hen - 06 [1080p]"
// gives the arc's own title, which is often AniDB's; ToonsHub adds alternates in brackets:
// "... (BLEACH: Sennen Kessen-hen, Dual-Audio, Multi-Subs)".
export function releaseShowNames(name) {
  if (!name) return [];
  const names = [];
  const base = name.replace(/\{[^}]*\}/g, " ");
  const head = base
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .split(/(?:[ ._]-[ ._]\d{1,4}\b|\bS\d{1,2}E\d{1,4}\b|[ ._]\d{1,4}[ ._]?(?:v\d)?[ ._]?[[(]|\[)/i)[0]
    .replace(/[._]+/g, " ")
    .trim();
  if (head) names.push(head);
  for (const group of base.matchAll(/\(([^()]+)\)/g)) {
    for (const part of group[1].split(",")) {
      const text = part.trim();
      if (/^(dual[- ]audio|multi[- ]subs?|multi|eng(lish)? (dub|sub)s?|\d{3,4}p|hevc|x26[45])$/i.test(text)) continue;
      if (/[a-z]{3}/i.test(text)) names.push(text);
    }
  }
  return [...new Set(names)];
}

// How a candidate's start date relates to when the run began: "week", "month", "airing" (the run
// starts mid-way, after a broadcast break), or null when it cannot be the same anime. Without an
// episode count a run can only start near the anime's own start.
export function airTiming(start, episodes, runStart) {
  const days = (runStart - start) / DAY;
  if (Math.abs(days) <= 10) return "week";
  if (Math.abs(days) <= 30) return "month";
  const span = Number.isInteger(episodes) && episodes > 0 ? episodes * 7 + 45 : 60;
  return days > 0 && days <= span ? "airing" : null;
}

const strippedKey = title => titleKey((title || "").replace(/\((19|20)\d\d\)\s*$/, ""));

// Scores every AniDB candidate for one Sonarr season. `facts`:
//   seasonNumber, seasonStart (ms or null), episodeCount,
//   titles: what the season is called (Sonarr, releases, AniList), each { title, weight }.
// Returns the candidates that survived, best first, each with its score and the reasons for it.
export function scoreCandidates(facts, candidates) {
  const { seasonNumber, seasonStart, episodeCount } = facts;
  const seasonYear = seasonStart ? new Date(seasonStart).getUTCFullYear() : null;
  const nearNewYear = seasonStart
    ? (() => { const d = new Date(seasonStart); return (d.getUTCMonth() === 0 && d.getUTCDate() <= 10) || (d.getUTCMonth() === 11 && d.getUTCDate() >= 22); })()
    : false;
  const titles = (facts.titles || []).filter(item => item?.title);
  const out = [];

  for (const candidate of candidates) {
    const reasons = [];
    let score = 0;

    if (/movie/i.test(candidate.type || "")) continue;

    const air = candidate.airDate ? Date.parse(candidate.airDate) : NaN;
    if (seasonStart && Number.isFinite(air)) {
      const timing = airTiming(air, candidate.episodes, seasonStart);
      if (!timing) continue;
      if (timing === "week") { score += 3; reasons.push("starts the same week"); }
      else if (timing === "month") { score += 1; reasons.push("starts the same month"); }
      else { score += 1; reasons.push("was airing then"); }
    }

    const year = titleYear(candidate.title);
    if (year && seasonYear) {
      if (year === seasonYear) { score += 2; reasons.push(`year ${year} matches`); }
      else if (!(nearNewYear && Math.abs(year - seasonYear) === 1)) continue;
    }

    // How well the name fits. Exact (bar case, punctuation and AniDB's year) is strong; a close
    // match on the base title only says it is the right franchise.
    const key = strippedKey(candidate.title);
    let exact = 0;
    let close = 0;
    for (const { title, weight = 1 } of titles) {
      if (key && key === strippedKey(title)) exact = Math.max(exact, weight);
      close = Math.max(close, similarity(candidate.title, title));
    }
    if (close < 0.6 && !exact) continue;
    if (exact) { score += 3 * exact; reasons.push("title matches exactly"); }
    else if (close >= 0.85) { score += 1; reasons.push("title is close"); }

    const ordinal = titleOrdinal(candidate.title);
    if (ordinal) {
      if (ordinal === seasonNumber) { score += 1; reasons.push(`says season ${ordinal}`); }
      else { score -= 1; reasons.push(`says season ${ordinal}`); }
    } else if (!year && normalize(candidate.title).replace(/'/g, "") === key && !/[:\-–]/.test(candidate.title)) {
      // A bare base title with no year, ordinal or subtitle is how AniDB names the first season.
      if (seasonNumber === 1) { score += 1; reasons.push("plain title, like a first season"); }
      else { score -= 1; reasons.push("plain title, like a first season"); }
    }

    if (Number.isInteger(candidate.episodes) && candidate.episodes > 0 && episodeCount) {
      if (Math.abs(candidate.episodes - episodeCount) <= 1) { score += 1; reasons.push(`${candidate.episodes} episodes`); }
    }

    out.push({ ...candidate, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

// The clear winner, or null when the best is weak or the runner-up is close behind.
export function decide(scored, { minScore = 4, margin = 2 } = {}) {
  const [best, second] = scored;
  if (!best || best.score < minScore) return null;
  if (second && best.score - second.score < margin) return null;
  return best;
}

// The episodes of a season that aired as one run: no gap of more than three weeks between them.
// Sonarr keeps a long show's cours in one season (Bleach's Thousand-Year Blood War is all season 17),
// while AniDB gives each cour its own anime, so the run holding the file is what must match.
export function airingRun(seasonEpisodes, focusNumbers) {
  const dated = seasonEpisodes
    .map(episode => ({ episode, at: Date.parse(episode.airDate || episode.airDateUtc || "") }))
    .filter(item => Number.isFinite(item.at))
    .sort((a, b) => a.episode.episodeNumber - b.episode.episodeNumber);
  if (dated.length === 0) return [];
  const runs = [[dated[0]]];
  for (const item of dated.slice(1)) {
    const run = runs[runs.length - 1];
    if (item.at - run[run.length - 1].at > 21 * DAY) runs.push([item]);
    else run.push(item);
  }
  const focus = new Set(focusNumbers || []);
  const run = focus.size ? runs.find(items => items.some(item => focus.has(item.episode.episodeNumber))) : null;
  return (run || runs[0]).map(item => item.episode);
}

export function seasonFacts(series, seasonNumber, episodes, focusNumbers = null) {
  const season = episodes.filter(episode => episode.seasonNumber === seasonNumber && episode.episodeNumber > 0);
  const run = airingRun(season, focusNumbers);
  const dates = run.map(episode => Date.parse(episode.airDate || episode.airDateUtc || "")).filter(Number.isFinite);
  const releases = [...new Set(run.map(episode => episode.sceneName).filter(Boolean))].slice(0, 6);
  return {
    seasonNumber,
    seasonStart: dates.length ? Math.min(...dates) : null,
    episodeCount: run.length || season.length,
    releases,
    titles: [
      ...(series.titles || [series.title]).map(title => ({ title, weight: 1, from: "sonarr" })),
      ...releases.flatMap(releaseShowNames).map(title => ({ title, weight: 1, from: "release" }))
    ]
  };
}
