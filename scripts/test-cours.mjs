import { readFileSync } from "node:fs";
import { courEpisodes, lumped, lumpedByChain, narrowingKind } from "../server/cours.js";
import { GUARD_MAX_MS, QUEUE_SWEEP_WINDOW_MS } from "../server/reconcile.js";

// Regression test for the cour mapper: which of Sonarr's episodes does one AniList entry mean?
//
// AniList, TMDB and TVDB disagree in both directions, and the fixtures capture real examples of
// each from a live library (npm run fixtures:cours rebuilds them):
//   - TMDB lumps where TVDB splits, so Jellyseerr can only offer one giant season
//   - AniList splits where TVDB lumps, so one Sonarr season holds two AniList entries
// Getting either wrong downloads the wrong episodes, which is the bug this file exists to stop.

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const bounds = result => {
  if (!result || result.matched.length === 0) return null;
  const numbers = result.matched.map(ep => ep.absoluteEpisodeNumber ?? ep.episodeNumber);
  return { first: Math.min(...numbers), last: Math.max(...numbers) };
};

// fixtures/ is gitignored, the same as match-cases.json: it is built from a live library, so it is
// regenerated rather than committed. Missing fixtures fail the full run, because silently skipping
// the real season shapes is how a mapping regression ships, but --unit-only tolerates it so the
// offline cases can still be run on a fresh clone.
const unitOnly = process.argv.includes("--unit-only");

let fixtures = null;
try {
  fixtures = JSON.parse(readFileSync(new URL("../fixtures/cour-cases.json", import.meta.url), "utf8"));
} catch {
  console.log(
    `  ${unitOnly ? "SKIP" : "FAIL"}  fixtures/cour-cases.json is missing, so no real season shapes were checked.` +
      "\n      Run `npm run fixtures:cours` against a live stack to regenerate it."
  );
  if (!unitOnly) failures += 1;
}

console.log("fixture cases");

for (const show of fixtures?.shows || []) {
  for (const entry of show.entries) {
    const result = courEpisodes(entry.anime, show.episodes);
    const got = bounds(result);
    const want = entry.expect;

    const pass =
      result !== null &&
      result.seasonNumber === want.seasonNumber &&
      got !== null &&
      got.first === want.first &&
      got.last === want.last;

    check(
      `${show.label} / ${entry.label}`,
      pass,
      result === null
        ? "no match"
        : `S${result.seasonNumber} ${got.first}-${got.last} via ${result.via} (want S${want.seasonNumber} ${want.first}-${want.last})`
    );
  }
}

console.log("\nunit cases");

// The show that started this. It is not in Sonarr yet, so the episode list is derived from
// AniList's own schedule: S1 weekly from 2023-10-22, S2 from 2025-01-10, S3 from 2026-10-02.
// TMDB 220542 carries all of this as a single "Season 1" of 48 episodes; TVDB 431162 splits it.
const apothecary = [];
const runs = [
  { season: 1, start: "2023-10-22", count: 24 },
  { season: 2, start: "2025-01-10", count: 24 },
  { season: 3, start: "2026-10-02", count: 24 }
];
let absolute = 1;
for (const run of runs) {
  for (let index = 0; index < run.count; index += 1) {
    const airs = new Date(`${run.start}T00:00:00Z`);
    airs.setUTCDate(airs.getUTCDate() + index * 7);
    apothecary.push({
      seasonNumber: run.season,
      episodeNumber: index + 1,
      absoluteEpisodeNumber: absolute,
      airDate: airs.toISOString().slice(0, 10)
    });
    absolute += 1;
  }
}

// episodes is null because the season has not aired, which is exactly the case that has to work:
// the count cannot be used, so the air date has to carry the match on its own.
const apothecaryS3 = {
  id: 195516,
  title: { romaji: "Kusuriya no Hitorigoto 3rd Season", english: "The Apothecary Diaries Season 3" },
  format: "TV",
  episodes: null,
  startDate: { year: 2026, month: 10, day: 2 }
};

const s3 = courEpisodes(apothecaryS3, apothecary);
check(
  "Apothecary S3 maps to Sonarr season 3, not the lumped season 1",
  s3?.seasonNumber === 3,
  s3 ? `S${s3.seasonNumber} via ${s3.via}` : "no match"
);
check(
  "Apothecary S3 takes the whole of season 3 when AniList has no episode count yet",
  s3?.matched.length === 24 && bounds(s3)?.first === 49 && bounds(s3)?.last === 72,
  s3 ? `${s3.matched.length} episodes, ${JSON.stringify(bounds(s3))}` : "no match"
);

const apothecaryS1 = {
  id: 161645,
  title: { romaji: "Kusuriya no Hitorigoto" },
  format: "TV",
  episodes: 24,
  startDate: { year: 2023, month: 10, day: 22 }
};
const s1 = courEpisodes(apothecaryS1, apothecary);
check(
  "Apothecary S1 still maps to season 1",
  s1?.seasonNumber === 1 && bounds(s1)?.last === 24,
  s1 ? `S${s1.seasonNumber} ${JSON.stringify(bounds(s1))}` : "no match"
);

// Refusing is the documented behaviour: a wrong season costs a 20GB download, a refusal costs a
// click. Both of these have to come back null rather than guess.
check(
  "a year-only start date refuses to match",
  courEpisodes({ ...apothecaryS3, startDate: { year: 2026, month: null, day: null } }, apothecary) === null
);
check(
  "a start date far from every episode refuses to match",
  courEpisodes({ ...apothecaryS3, episodes: 12, startDate: { year: 2031, month: 4, day: 1 } }, apothecary) === null
);
check("an empty episode list refuses to match", courEpisodes(apothecaryS1, []) === null);
check("a missing start date refuses to match", courEpisodes({ ...apothecaryS1, startDate: null }, apothecary) === null);

// Sonarr only fills absoluteEpisodeNumber in for seriesType anime. A series still sitting on
// standard has to map by episode number instead of crashing or silently matching nothing.
const standard = apothecary.map(episode => ({ ...episode, absoluteEpisodeNumber: null }));
const withoutAbsolute = courEpisodes(apothecaryS3, standard);
check(
  "a standard-type series with no absolute numbering still maps",
  withoutAbsolute?.seasonNumber === 3 && bounds(withoutAbsolute)?.first === 1 && bounds(withoutAbsolute)?.last === 24,
  withoutAbsolute ? `S${withoutAbsolute.seasonNumber} ${JSON.stringify(bounds(withoutAbsolute))}` : "no match"
);

// A cour whose count runs past the end of its Sonarr season is clamped rather than spilling into
// the next one. Spilling would monitor episodes belonging to a different AniList entry.
const clamped = courEpisodes({ ...apothecaryS3, episodes: 40 }, apothecary);
check(
  "a cour longer than its Sonarr season is clamped to the season",
  clamped?.matched.length === 24 && clamped?.clamped === true,
  clamped ? `${clamped.matched.length} episodes, clamped=${clamped.clamped}` : "no match"
);

// The prequel-chain fallback only applies when the air date cannot decide, and only when the
// episode count agrees. Depth 2 plus 24 episodes means season 3.
const noDates = apothecary.map(episode => ({ ...episode, airDate: null }));
const byChain = courEpisodes({ ...apothecaryS3, episodes: 24, prequelDepth: 2 }, noDates);
check(
  "the prequel chain resolves the season when no episode has an air date",
  byChain?.seasonNumber === 3 && byChain?.via === "chain-ordinal",
  byChain ? `S${byChain.seasonNumber} via ${byChain.via}` : "no match"
);
check(
  "the prequel chain is refused when the episode count disagrees",
  courEpisodes({ ...apothecaryS3, episodes: 13, prequelDepth: 2 }, noDates) === null
);
check(
  "the prequel chain is refused when the season does not exist",
  courEpisodes({ ...apothecaryS3, episodes: 24, prequelDepth: 9 }, noDates) === null
);

console.log("\nlumped detection");

// What triggers the whole flow: TMDB claiming fewer seasons than Sonarr actually has.
check(
  "one TMDB season against three Sonarr seasons is lumped",
  lumped([{ seasonNumber: 1, episodeCount: 48 }], apothecary) === true
);
check(
  "matching season counts are not lumped",
  lumped(
    [
      { seasonNumber: 1, episodeCount: 24 },
      { seasonNumber: 2, episodeCount: 24 },
      { seasonNumber: 3, episodeCount: 24 }
    ],
    apothecary
  ) === false
);
check("an unknown Sonarr side is not lumped", lumped([{ seasonNumber: 1, episodeCount: 48 }], []) === false);

// TVDB pre-announces a sequel as a season with one dateless placeholder episode long before TMDB
// adds it. Wistoria really looked like this: three TVDB seasons against two on TMDB, which made a
// show both sources agree about read as lumped and would have narrowed monitoring for no reason.
const withPlaceholder = [
  ...apothecary.filter(episode => episode.seasonNumber <= 2),
  { seasonNumber: 3, episodeNumber: 1, absoluteEpisodeNumber: 49, airDate: null }
];
check(
  "a dateless placeholder season does not count as a real season",
  lumped([{ seasonNumber: 1, episodeCount: 24 }, { seasonNumber: 2, episodeCount: 24 }], withPlaceholder) === false
);
check(
  "a real third season still counts",
  lumped([{ seasonNumber: 1, episodeCount: 24 }, { seasonNumber: 2, episodeCount: 24 }], apothecary) === true
);

// The pre-request check, for a show Sonarr does not hold yet. This is the real Apothecary S3
// shape: TMDB 220542 reports one season, and the AniList chain says this is the third.
check(
  "one TMDB season for a third-season entry is lumped by the chain",
  lumpedByChain([{ seasonNumber: 1, episodeCount: 48 }], 2) === true
);
check(
  "three TMDB seasons for a third-season entry is not lumped",
  lumpedByChain([{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }], 2) === false
);
check("a first season is never lumped by the chain", lumpedByChain([{ seasonNumber: 1 }], 0) === false);
check("an unknown chain depth is not lumped", lumpedByChain([{ seasonNumber: 1 }], null) === false);

console.log("\nnarrowing decision");

// Checking season counts alone is not enough, and this is the case that proves it: Slime has four
// seasons on both sides, so nothing looks wrong, yet AniList's 2nd Season Part 2 is only the back
// half of Sonarr's season 2. Requesting that season would fetch 24 episodes for a 12-episode entry.
const slime = fixtures?.shows.find(show => show.label.includes("Slime"));
const fourSeasons = [1, 2, 3, 4].map(seasonNumber => ({ seasonNumber, episodeCount: 24 }));

if (slime) {
  const slimePart2 = slime.entries.find(entry => entry.label.includes("Part 2"));
  const slimeS1 = slime.entries.find(entry => entry.label === "Slime S1");

  check(
    "a cour that is half a Sonarr season needs narrowing even when the season counts agree",
  narrowingKind({
    tmdbSeasons: fourSeasons,
    sonarrEpisodes: slime.episodes,
    prequelDepth: 1,
    target: courEpisodes(slimePart2.anime, slime.episodes)
    }) === "cour-within-season"
  );

  // The same show's first season is a whole Sonarr season, so it needs nothing.
  check(
    "a cour that is a whole Sonarr season needs no narrowing",
    narrowingKind({
      tmdbSeasons: fourSeasons,
      sonarrEpisodes: slime.episodes,
      prequelDepth: 0,
      target: courEpisodes(slimeS1.anime, slime.episodes)
    }) === null
  );

  // Nothing resolved and nothing folded means there is no evidence a request would overshoot.
  check(
    "an unresolvable entry on a well-behaved show needs no narrowing",
    narrowingKind({ tmdbSeasons: fourSeasons, sonarrEpisodes: slime.episodes, prequelDepth: 0, target: null }) === null
  );
}

check(
  "folded seasons are reported as such",
  narrowingKind({
    tmdbSeasons: [{ seasonNumber: 1, episodeCount: 48 }],
    sonarrEpisodes: apothecary,
    prequelDepth: 2,
    target: courEpisodes(apothecaryS3, apothecary)
  }) === "seasons-folded"
);

console.log("\nqueue sweep window");

// Jellyseerr keeps grabbing after the request returns, and Sonarr will not cancel a search it has
// already started, so sweeping the queue repeatedly is the only thing that actually stops the wrong
// season downloading. On a real request the grabs spanned 44 seconds; a single sweep at 4 seconds
// removed twelve and left twelve behind. Imported, not copied, so shortening the window fails here.
check(
  "the initial queue sweep covers the first grabs",
  QUEUE_SWEEP_WINDOW_MS >= 20_000,
  `${QUEUE_SWEEP_WINDOW_MS / 1000}s`
);

// The real lesson, learned twice: no fixed window works. Sonarr's MissingEpisodeSearch collects and
// then grabs in one burst at the end -- observed eleven minutes after it started, long after a
// fifty-second sweep had finished and reported success. The background guard is tied to whether the
// search is still running, and its cap has to comfortably exceed how long such a search can take.
check(
  "the background guard outlasts a long Sonarr search",
  GUARD_MAX_MS >= 15 * 60 * 1000,
  `${GUARD_MAX_MS / 60000} minutes`
);

console.log(`\n${failures === 0 ? "all cour cases passed" : `${failures} cour case(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
