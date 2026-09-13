import { readFileSync } from "node:fs";
import { normalize, similarity, usable, searchTitle, seasonOrdinal } from "../server/match.js";

// Regression test for the title matcher. Runs the shipping thresholds against the labelled
// fixtures and fails if precision or recall drops. Run: npm test

const THRESHOLDS = { sonarr: 0.8, jellyfin: 0.7 };
const FLOORS = {
  sonarr: { precision: 1.0, recall: 1.0 },
  jellyfin: { precision: 0.95, recall: 0.95 }
};

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
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
let fixtures;
try {
  fixtures = JSON.parse(readFileSync("fixtures/match-cases.json", "utf8"));
} catch {
  console.log("\nfixtures/match-cases.json missing — run scripts/build-match-fixtures.mjs to regenerate");
  process.exit(failures > 0 ? 1 : 0);
}

const best = (titles, target, alternates) => {
  let top = 0;
  for (const candidate of [target, ...(alternates || [])]) {
    for (const title of titles) top = Math.max(top, similarity(title, candidate));
  }
  return top;
};

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
