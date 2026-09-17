import { gqlAuthed } from "../server/anilist.js";
import { viewer } from "../server/anilist-list.js";
import * as seerr from "../server/jellyseerr.js";
import * as mapping from "../server/mapping.js";
import {
  scoreCandidate,
  searchTitle,
  seasonOrdinal,
  isSequel,
  guessSeasonNumber,
  ANIMATION_GENRE_ID
} from "../server/match.js";

// Sweeps your AniList list through the Jellyseerr matcher and reports every entry whose match is
// suspect, so a wrong series is found before a request lands on it. Read-only: it searches and
// reads details, and never creates a request.
//
//   node --env-file=.env scripts/audit-requests.mjs
//   node --env-file=.env scripts/audit-requests.mjs --status CURRENT,PLANNING --limit 40 --all
//
// --all also prints the entries that look fine. Anything flagged is worth a human look; a flag is
// a suspicion, not a verdict.

const arg = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};

// COMPLETED and DROPPED are not going to be requested, so they are not worth the calls by default.
const STATUSES = (arg("--status") || "CURRENT,PLANNING,PAUSED").split(",").map(s => s.trim().toUpperCase());
const LIMIT = Number(arg("--limit")) || Infinity;
const CONCURRENCY = Number(arg("--concurrency")) || 4;
const SHOW_ALL = process.argv.includes("--all");

const COLLECTION = `
  query ($userId: Int) {
    MediaListCollection(userId: $userId, type: ANIME) {
      lists {
        status
        entries {
          status
          media {
            id
            title { romaji english native }
            format
            status
            episodes
            countryOfOrigin
            startDate { year month day }
            seasonYear
            relations { edges { relationType } }
          }
        }
      }
    }
  }
`;

// prequelDepth walks the AniList relation chain one request per title, which is far too many for a
// sweep. A direct PREQUEL edge is enough to know an entry is not a first season, which is all the
// year rule needs; the ordinal in the title carries the rest.
function withSequelHint(media) {
  const hasPrequel = (media.relations?.edges || []).some(edge => edge.relationType === "PREQUEL");
  return { ...media, prequelDepth: hasPrequel ? 1 : 0 };
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await worker(items[index], index);
      }
    })
  );
  return out;
}

const animated = candidate => {
  const genres = Array.isArray(candidate.genreIds) ? candidate.genreIds : [];
  return genres.length === 0 ? null : genres.includes(ANIMATION_GENRE_ID);
};

const label = anime => anime.title.english || anime.title.romaji || anime.title.native;

async function audit(anime) {
  // Whatever resolve() would actually do, mapping included, rather than re-deriving it here.
  const resolved = await seerr.resolve(anime).catch(() => null);
  if (resolved?.via === "id") {
    const flags = [];
    if (resolved.mediaType === "tv" && resolved.seasons?.length > 1 && resolved.suggestedSeason === null) {
      flags.push({ code: "season-unknown", detail: `${resolved.seasons.length} TMDB seasons and nothing to choose between them` });
    }
    return {
      anime,
      flags,
      via: "id",
      suggestedSeason: resolved.suggestedSeason,
      best: {
        candidate: { id: resolved.tmdbId, mediaType: resolved.mediaType, name: resolved.title },
        score: 1,
        titleScore: 1,
        candidateYear: resolved.year
      }
    };
  }

  const query = searchTitle(anime.title.english || anime.title.romaji || anime.title.native);
  if (query.length < 2) return { anime, flags: [{ code: "unsearchable", detail: "no usable title" }] };

  let candidates;
  try {
    candidates = await seerr.search(query);
  } catch (error) {
    return { anime, flags: [{ code: "search-failed", detail: error.message }] };
  }

  const scored = candidates
    .filter(candidate => candidate.mediaType === "tv" || candidate.mediaType === "movie")
    .map(candidate => ({ candidate, ...scoreCandidate(anime, candidate) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const flags = [];

  if (!best || best.titleScore < 0.5) {
    flags.push({ code: "no-match", detail: `${scored.length} candidate(s), best title score ${best?.titleScore.toFixed(2) ?? "n/a"}` });
    return { anime, flags, best };
  }

  const ordinal = seasonOrdinal(anime.title.romaji) || seasonOrdinal(anime.title.english);

  if (animated(best.candidate) === false) {
    flags.push({
      code: "live-action",
      detail: `TMDB ${best.candidate.mediaType}/${best.candidate.id} has genres ${best.candidate.genreIds.join(",")} and not ${ANIMATION_GENRE_ID}`
    });
  }

  if (!best.typeMatch && best.candidate.mediaType === "tv") {
    // A bonus episode, a special or a shorts collection rarely has a TMDB entry of its own, so
    // landing on the parent series is the only answer available rather than a wrong one.
    flags.push({
      code: "parent-series-fallback",
      note: true,
      detail: `a one-off ${anime.format} with no TMDB entry of its own, matched to the parent series`
    });
  } else if (!best.typeMatch) {
    // The other direction is worth a look: a TV season matched to a movie is usually a compilation
    // or recap film standing in for the season you wanted.
    flags.push({ code: "type-mismatch", detail: `AniList ${anime.format} matched a ${best.candidate.mediaType}` });
  }

  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < 0.05) {
    flags.push({
      code: "close-call",
      detail: `${best.candidate.id} at ${best.score.toFixed(3)} vs ${runnerUp.candidate.id} "${runnerUp.candidate.name || runnerUp.candidate.title}" at ${runnerUp.score.toFixed(3)}`
    });
  }

  const animeYear = anime.startDate?.year || anime.seasonYear;
  if (!isSequel(anime) && animeYear && best.candidateYear && Math.abs(animeYear - best.candidateYear) > 4) {
    flags.push({ code: "year-far", detail: `AniList ${animeYear} vs TMDB ${best.candidateYear}, and no sequel marker to explain it` });
  }

  let suggestedSeason = null;
  let seasons = null;

  if (best.candidate.mediaType === "tv") {
    try {
      const detail = await seerr.tvDetail(best.candidate.id);
      seasons = (detail.seasons || []).filter(season => season.seasonNumber > 0);
      suggestedSeason = guessSeasonNumber(anime, seasons);

      // TMDB frequently files a long-running anime as one flat season -- Re:ZERO is 85 episodes of
      // "season 1" -- so a sequel pointing at season 1 is TMDB's shape, not a mismatch. Requesting
      // it does pull the whole series, which is why Hikari corrects Sonarr afterwards. Worth
      // knowing, not worth alarm, so it is reported as a note.
      const flat = seasons.length === 1 && ordinal && ordinal > 1;
      if (flat) {
        flags.push({
          code: "tmdb-flat-seasons",
          note: true,
          detail: `AniList season ${ordinal} against a single TMDB season of ${seasons[0].episodeCount} ep, so a request covers the whole run`
        });
      }

      if (seasons.length > 1 && suggestedSeason === null) {
        flags.push({ code: "season-unknown", detail: `${seasons.length} TMDB seasons and nothing to choose between them` });
      }
      if (ordinal && seasons.length > 1 && suggestedSeason !== null && suggestedSeason !== ordinal) {
        flags.push({
          code: "ordinal-shifted",
          note: true,
          detail: `title says season ${ordinal}, air dates say TMDB season ${suggestedSeason}`
        });
      }
      if (ordinal && seasons.length > 1 && seasons.length < ordinal) {
        flags.push({ code: "too-few-seasons", detail: `title says season ${ordinal}, TMDB has ${seasons.length}` });
      }

      // A cour split onto its own AniList entry against a TMDB season with roughly twice the
      // episodes is normal and corrected in Sonarr later, so this only fires on a gap wide enough
      // to suggest a different show -- and never for a flat season, where the gap is guaranteed.
      // On an exact title match the gap is TMDB grouping episodes its own way, not a wrong series,
      // which is why "Gintama" against 49 of its 201 episodes is a note.
      const target = seasons.find(season => season.seasonNumber === suggestedSeason);
      if (!flat && target && anime.episodes && target.episodeCount && Math.abs(target.episodeCount - anime.episodes) > 12) {
        flags.push({
          code: "episode-count-far",
          note: best.titleScore >= 0.9,
          detail: `AniList ${anime.episodes} ep vs TMDB season ${suggestedSeason} ${target.episodeCount} ep`
        });
      }
    } catch (error) {
      flags.push({ code: "detail-failed", detail: error.message });
    }
  }

  return { anime, flags, best, suggestedSeason, seasons };
}

const me = await viewer();
if (!me) {
  console.error("No AniList token, so there is no list to audit. Set ANILIST_TOKEN.");
  process.exit(1);
}

// Audit what the server would really answer, so load the same mapping it uses.
mapping.load();
await mapping.refresh();
console.log(`id mapping: ${mapping.status().entries} entries\n`);

const collection = await gqlAuthed(COLLECTION, { userId: me.id });
const entries = [];
for (const list of collection.MediaListCollection?.lists || []) {
  if (!STATUSES.includes(list.status)) continue;
  for (const entry of list.entries || []) entries.push({ status: list.status, media: withSequelHint(entry.media) });
}

// The same media can appear under more than one list.
const unique = [...new Map(entries.map(entry => [entry.media.id, entry])).values()].slice(0, LIMIT);

console.log(`${me.name}: auditing ${unique.length} entr${unique.length === 1 ? "y" : "ies"} (${STATUSES.join(", ")})\n`);

const results = await mapLimit(unique, CONCURRENCY, async entry => ({ status: entry.status, ...(await audit(entry.media)) }));

// A note describes something true about TMDB's data that Hikari already handles. Only a real flag
// means "this match may be wrong", and mixing the two buries the ones worth acting on.
const isReal = flag => !flag.note;
const flagged = results.filter(result => result.flags.some(isReal));
const noted = results.filter(result => result.flags.length > 0 && !result.flags.some(isReal));

const byCode = new Map();
for (const result of results) for (const flag of result.flags) byCode.set(flag.code, (byCode.get(flag.code) || 0) + 1);

for (const result of SHOW_ALL ? results : [...flagged, ...noted]) {
  const { anime, best, flags, suggestedSeason } = result;
  const matched = best
    ? `TMDB ${best.candidate.mediaType}/${best.candidate.id} "${best.candidate.name || best.candidate.title}" (${best.candidateYear ?? "?"}) score ${best.score.toFixed(3)}${suggestedSeason ? ` season ${suggestedSeason}` : ""}`
    : "no candidate";

  console.log(`${flags.some(isReal) ? "!" : flags.length > 0 ? "-" : " "} ${label(anime)}  [anilist ${anime.id}, ${result.status}]`);
  console.log(`    -> ${matched}`);
  for (const flag of flags) console.log(`    ${flag.code}${flag.note ? " (note)" : ""}: ${flag.detail}`);
  console.log();
}

console.log(`${flagged.length} of ${results.length} flagged, ${noted.length} noted only`);
for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) console.log(`  ${code}: ${count}`);
