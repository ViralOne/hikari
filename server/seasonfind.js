// Finds the AniDB anime for a Sonarr season by name, year and air date (seasonmatch.js scores it),
// and creates Shoko's entry for it so the episodes can be linked. Used only when no verified link
// and no unambiguous TVDB mapping says which anime the season is.

import * as anilist from "./anilist.js";
import * as shoko from "./shoko.js";
import * as ai from "./ai.js";
import { cached } from "./cache.js";
import { airTiming, decide, scoreCandidates, seasonFacts } from "./seasonmatch.js";

// AniList's one entry that was airing when the run began. Its romaji title is usually
// AniDB's main title, subtitle and all ("Tougen Anki: Nikkou Kegon no Taki-hen").
async function anilistTitles(series, seasonStart) {
  if (!seasonStart) return [];
  try {
    // AniList's rate limit can queue a request for a minute; the names it adds are a bonus.
    const { media } = await Promise.race([
      anilist.page({ search: series.title, perPage: 15 }, 6 * 60 * 60 * 1000),
      new Promise((_, reject) => setTimeout(() => reject(new Error("AniList busy")), 15000).unref?.())
    ]);
    const near = media.filter(item => {
      const start = item.startDate?.year
        ? Date.UTC(item.startDate.year, (item.startDate.month || 1) - 1, item.startDate.day || 1)
        : NaN;
      return Number.isFinite(start) && item.format !== "MOVIE" && airTiming(start, item.episodes, seasonStart) !== null;
    });
    if (near.length !== 1) return [];
    const { romaji, english, native } = near[0].title;
    return [romaji, english, native].filter(Boolean).map(title => ({ title, weight: 2, from: "anilist" }));
  } catch {
    return [];
  }
}

export function findSeasonSeries({ series, seasonNumber, episodes, focusNumbers = null }) {
  const facts = seasonFacts(series, seasonNumber, episodes, focusNumbers);
  const key = `seasonfind:${series.id}:${seasonNumber}:${facts.seasonStart}:${facts.releases.length}:${ai.order().join("+")}`;
  return cached(key, 6 * 60 * 60 * 1000, async () => {
    facts.titles.push(...(await anilistTitles(series, facts.seasonStart)));

    const queries = [...new Set([
      ...facts.titles.filter(item => item.from === "anilist").map(item => item.title),
      ...facts.titles.filter(item => item.from === "release").map(item => item.title).slice(0, 3),
      ...(series.titles || [series.title]).slice(0, 3)
    ].filter(query => query && /[a-z]{3}/i.test(query)))].slice(0, 7);

    const byId = new Map();
    for (const query of queries) {
      const results = await shoko.searchAnidb(query).catch(() => []);
      for (const item of results) if (!byId.has(item.anidbId)) byId.set(item.anidbId, item);
    }

    const scored = scoreCandidates(facts, [...byId.values()]);
    const top = scored.slice(0, 6);
    let pick = decide(scored);
    let via = pick ? "title" : null;
    let reason = pick ? pick.reasons.join(", ") : null;

    if (!pick && top.length > 0 && ai.enabled()) {
      const answer = await ai.chooseSeries(
        {
          sonarrTitles: series.titles || [series.title],
          seasonNumber,
          seasonStart: facts.seasonStart ? new Date(facts.seasonStart).toISOString().slice(0, 10) : null,
          episodeCount: facts.episodeCount,
          releaseNames: facts.releases.slice(0, 3),
          anilistTitles: facts.titles.filter(item => item.from === "anilist").map(item => item.title)
        },
        top.map(({ anidbId, title, type, airDate, episodes: count, score, reasons }) => ({
          anidbId, title, type, airDate, episodes: count, ruleScore: score, ruleNotes: reasons
        }))
      );
      if (answer) {
        pick = top.find(item => item.anidbId === answer.anidbId);
        via = "ai";
        reason = `${answer.model} on ${ai.PROVIDERS[answer.provider].label}: ${answer.reason}`;
      }
    }

    return {
      pick: pick ? { anidbId: pick.anidbId, shokoId: pick.shokoId, title: pick.title, via, reason } : null,
      candidates: top.map(({ anidbId, shokoId, title, airDate, score, reasons }) => ({ anidbId, shokoId, title, airDate, score, reasons }))
    };
  });
}

// Shoko's series id for the pick, creating the entry if Shoko has none. Null while AniDB is still
// being asked; the next sweep finds it. One attempt per anime every 12 hours keeps AniDB happy.
const createdAt = new Map();
export async function ensureShokoSeries(pick) {
  if (!pick) return null;
  if (pick.shokoId) return pick.shokoId;
  const existing = (await shoko.seriesIndex()).byShoko;
  for (const [shokoId, entry] of existing) if (entry.anidbId === pick.anidbId) return shokoId;
  const last = createdAt.get(pick.anidbId) || 0;
  if (Date.now() - last < 12 * 60 * 60 * 1000) return null;
  createdAt.set(pick.anidbId, Date.now());
  return shoko.createSeries(pick.anidbId).catch(() => null);
}
