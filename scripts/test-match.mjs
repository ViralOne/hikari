import { readFileSync } from "node:fs";
import { normalize, similarity, usable, searchTitle, seasonOrdinal } from "../server/match.js";
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
