import { readFileSync } from "node:fs";
import { normalize, similarity, usable, searchTitle, seasonOrdinal, pickBest, guessSeasonNumber } from "../server/match.js";
import { SONARR_MATCH_THRESHOLD } from "../server/sonarr.js";
import { JELLYFIN_TITLE_THRESHOLD } from "../server/jellyfin.js";

// Regression test for the title matcher. Runs the shipping thresholds against the labelled
// fixtures and fails if precision or recall drops. Run: npm test

// Imported, not copied: a duplicated literal would let someone lower the shipping threshold
// without failing this test.
const THRESHOLDS = { sonarr: SONARR_MATCH_THRESHOLD, jellyfin: JELLYFIN_TITLE_THRESHOLD };
const FLOORS = {
  sonarr: { precision: 1.0, recall: 1.0 },
  jellyfin: { precision: 0.95, recall: 0.95 }
};

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("unit cases");

// Regressions that each cost real time to find.
check(
  "native title does not collapse to a bare digit",
  normalize("薬屋のひとりごと 第2期").length > 2,
  `normalised to "${normalize("薬屋のひとりごと 第2期")}"`
);
check("a bare digit is unusable", !usable(normalize("2")), `usable=${usable(normalize("2"))}`);
check(
  "Monster does not match Monogatari",
  similarity("Monster", "Monogatari") < 0.7,
  similarity("Monster", "Monogatari").toFixed(3)
);
check(
  "a trailing year costs nothing",
  similarity("Jigokuraku 2nd Season", "Jigokuraku (2026)") === similarity("Jigokuraku 2nd Season", "Jigokuraku"),
  `with year ${similarity("Jigokuraku 2nd Season", "Jigokuraku (2026)").toFixed(3)}, without ${similarity(
    "Jigokuraku 2nd Season",
    "Jigokuraku"
  ).toFixed(3)}`
);
check(
  "roman numeral seasons collapse like numeric ones",
  similarity("Youjo Senki II", "Youjo Senki (2026)") === 1 &&
    similarity("Youjo Senki II", "Youjo Senki 2nd Season") === 1,
  `vs year ${similarity("Youjo Senki II", "Youjo Senki (2026)").toFixed(3)}, vs 2nd Season ${similarity(
    "Youjo Senki II",
    "Youjo Senki 2nd Season"
  ).toFixed(3)}`
);
check(
  "a single trailing letter is not treated as a numeral",
  normalize("Cowboy Bebop") === "cowboy bebop",
  normalize("Cowboy Bebop")
);
check(
  "season markers collapse across languages",
  similarity("Kusuriya no Hitorigoto 2nd Season", "Kusuriya no Hitorigoto") === 1,
  similarity("Kusuriya no Hitorigoto 2nd Season", "Kusuriya no Hitorigoto").toFixed(3)
);
check(
  "unrelated Japanese titles do not match",
  similarity("薬屋のひとりごと", "灼眼のシャナ") < 0.7,
  similarity("薬屋のひとりごと", "灼眼のシャナ").toFixed(3)
);
check("search titles drop season markers", searchTitle("DAN DA DAN Season 2") === "DAN DA DAN", searchTitle("DAN DA DAN Season 2"));
check("ordinals are parsed", seasonOrdinal("Gintama Season 3") === 3 && seasonOrdinal("Slime 4th Season") === 4);

// TMDB files sequels as seasons of the base title and answers a numbered query with nothing at all,
// so these three found zero candidates rather than a wrong one.
check("a bare trailing sequel number is dropped", searchTitle("Dagashi Kashi 2") === "Dagashi Kashi", searchTitle("Dagashi Kashi 2"));
check("with or without a space", searchTitle("Tsugumomo2") === "Tsugumomo", searchTitle("Tsugumomo2"));
check("a roman part marker too", searchTitle("KENGAN ASHURA Part I") === "KENGAN ASHURA", searchTitle("KENGAN ASHURA Part I"));
check("and in Japanese", searchTitle("だがしかし2") === "だがしかし", searchTitle("だがしかし2"));
// Widening the query cannot pick the wrong entry, because scoring still sees the full title.
check(
  "a numeric title is not eaten",
  searchTitle("86") === "86" && searchTitle("5") === "5",
  `${searchTitle("86")}, ${searchTitle("5")}`
);
check(
  "Steins;Gate 0 still outscores Steins;Gate for itself",
  similarity("Steins;Gate 0", "Steins;Gate 0") > similarity("Steins;Gate 0", "Steins;Gate"),
  `${similarity("Steins;Gate 0", "Steins;Gate 0").toFixed(3)} vs ${similarity("Steins;Gate 0", "Steins;Gate").toFixed(3)}`
);

// --- candidate selection
//
// Link Click, as it actually is on TMDB. AniList 191832 "Link Click Season 3" premieres the same
// day as TMDB season 4 of the donghua (123542), while TMDB 314364 is a Japanese live-action remake
// carrying the identical title and the matching year. Requesting the remake sends a live-action
// drama into the anime root folder, so this pair is the whole reason the animation and sequel rules
// exist.
const linkClickS3 = {
  title: { romaji: "Shiguang Dailiren III", english: "Link Click Season 3", native: "时光代理人III" },
  format: "ONA",
  startDate: { year: 2026, month: 8, day: 14 },
  prequelDepth: 2
};
const linkClickDonghua = {
  id: 123542,
  mediaType: "tv",
  name: "LINK CLICK",
  firstAirDate: "2021-04-30",
  genreIds: [16, 10765, 9648, 18]
};
const linkClickLiveAction = {
  id: 314364,
  mediaType: "tv",
  name: "Link Click",
  firstAirDate: "2026-04-11",
  genreIds: [10765]
};

const linkClickPick = pickBest(linkClickS3, [linkClickLiveAction, linkClickDonghua]);
check(
  "a live-action remake loses to the series it was adapted from",
  linkClickPick?.candidate.id === 123542,
  `picked ${linkClickPick?.candidate.id} at ${linkClickPick?.score.toFixed(3)}`
);
check(
  "a sequel gains nothing from matching a candidate's first air date",
  pickBest(linkClickS3, [linkClickLiveAction])?.score < 0.8,
  `${pickBest(linkClickS3, [linkClickLiveAction])?.score.toFixed(3)}`
);

// TMDB files a one-off release as a movie, and only AniList's MOVIE format used to be allowed to
// match one, so a correctly-filed OVA lost 0.35 for it.
const bubble = { title: { romaji: "Bubble", english: "Bubble", native: "バブル" }, format: "ONA", episodes: 1 };
const bubbleMovie = { id: 912598, mediaType: "movie", title: "Bubble", releaseDate: "2022-04-28", genreIds: [16] };
check(
  "a single-episode ONA is allowed to be a TMDB movie",
  pickBest(bubble, [bubbleMovie])?.typeMatch === true,
  `score ${pickBest(bubble, [bubbleMovie])?.score.toFixed(3)}`
);
check(
  "a multi-episode ONA is still a series",
  pickBest({ ...bubble, episodes: 12 }, [bubbleMovie])?.typeMatch === false
);
check(
  "an unknown episode count penalises neither type",
  pickBest({ ...bubble, episodes: null }, [bubbleMovie])?.typeMatch === true
);
check(
  "a TV entry is still not a movie",
  pickBest({ ...bubble, format: "TV", episodes: 1 }, [bubbleMovie])?.typeMatch === false
);

// The year is still evidence for a first season, where the AniList start date and the TMDB series
// premiere describe the same thing.
const dandadan = {
  title: { romaji: "Dandadan", english: "Dan Da Dan", native: "ダンダダン" },
  format: "TV",
  startDate: { year: 2024, month: 10, day: 4 }
};
const dandadanPick = pickBest(dandadan, [
  { id: 2, mediaType: "tv", name: "Dandadan", firstAirDate: "2016-01-01", genreIds: [16] },
  { id: 1, mediaType: "tv", name: "Dan Da Dan", firstAirDate: "2024-10-04", genreIds: [16] }
]);
check("a first season still prefers its own year", dandadanPick?.candidate.id === 1, `picked ${dandadanPick?.candidate.id}`);

check(
  "an unclassified candidate is not treated as live action",
  pickBest(dandadan, [{ id: 3, mediaType: "tv", name: "Dan Da Dan", firstAirDate: "2024-10-04" }])?.candidate.id === 3
);

// --- season numbering
const linkClickSeasons = [
  { seasonNumber: 1, airDate: "2021-04-30" },
  { seasonNumber: 2, airDate: "2023-07-14" },
  { seasonNumber: 3, airDate: "2024-12-27" },
  { seasonNumber: 4, airDate: "2026-08-14" },
  { seasonNumber: 5, airDate: null }
];
check(
  "a shared premiere date beats the title ordinal",
  guessSeasonNumber(linkClickS3, linkClickSeasons) === 4,
  `got ${guessSeasonNumber(linkClickS3, linkClickSeasons)}`
);
check(
  "the ordinal still decides when no premiere date is close",
  guessSeasonNumber(
    { title: { romaji: "Kusuriya no Hitorigoto 2nd Season", english: null }, startDate: { year: 2026, month: 4, day: 1 } },
    [
      { seasonNumber: 1, airDate: "2023-10-22" },
      { seasonNumber: 2, airDate: "2026-01-10" }
    ]
  ) === 2
);

// --- fixture evaluation
//
// fixtures/ is generated from a live media stack, so CI cannot have it. --unit-only says so
// out loud; without the flag a missing fixture file is a failure, because silently skipping
// the precision and recall floors is how a threshold regression ships.
const unitOnly = process.argv.includes("--unit-only");

let fixtures;
try {
  fixtures = JSON.parse(readFileSync("fixtures/match-cases.json", "utf8"));
} catch {
  console.log(
    `\n${unitOnly ? "SKIP" : "FAIL"}  fixtures/match-cases.json is missing, so no precision or recall floor was checked.` +
      "\n      Run `npm run fixtures` against a live stack to regenerate it."
  );
  if (!unitOnly) process.exit(1);
  console.log(failures === 0 ? "\nunit checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures > 0 ? 1 : 0);
}

const best = (titles, target, alternates) => {
  let top = 0;
  for (const candidate of [target, ...(alternates || [])]) {
    for (const title of titles) top = Math.max(top, similarity(title, candidate));
  }
  return top;
};

// --- the id bridge
//
// Sonarr positives were built from Shoko's TvDB id, so the bridge must resolve every one of
// them without any title comparison. This fails if shoko.js stops carrying tvdbIds, which is
// the one change that would silently push these back onto fuzzy matching.
{
  const cases = (fixtures.sonarr?.positives || []).filter(item => item.targetTvdbId);
  const bridged = cases.filter(item => (item.shokoTvdbIds || []).includes(item.targetTvdbId));
  console.log("\nshoko tvdb bridge");
  check(
    "every Sonarr positive resolves by id alone",
    cases.length > 0 && bridged.length === cases.length,
    `${bridged.length} of ${cases.length}`
  );
}

for (const [name, cases] of Object.entries(fixtures)) {
  if (name === "builtAt") continue;
  const threshold = THRESHOLDS[name];
  const floor = FLOORS[name];
  if (!threshold) continue;

  let tp = 0;
  let fn = 0;
  let fp = 0;

  for (const item of cases.positives) {
    if (best(item.titles, item.target, item.targetAlternates) >= threshold) tp += 1;
    else fn += 1;
  }
  for (const item of cases.negatives) {
    if (best(item.titles, item.target, item.targetAlternates) >= threshold) fp += 1;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);

  console.log(`\n${name} matcher at threshold ${threshold}`);
  check(
    `precision >= ${floor.precision}`,
    precision >= floor.precision - 1e-9,
    `${precision.toFixed(3)} (${tp} true, ${fp} false positives)`
  );
  check(
    `recall >= ${floor.recall}`,
    recall >= floor.recall - 1e-9,
    `${recall.toFixed(3)} (${fn} missed of ${cases.positives.length})`
  );
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
