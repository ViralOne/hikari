import { readFileSync } from "node:fs";
import { normalize, usable, seasonOrdinal } from "../server/match.js";

// Grid-searches the scoring knobs against fixtures/match-cases.json and prints precision,
// recall and F1 per configuration. Run: node scripts/tune-match.mjs

const fixtures = JSON.parse(readFileSync("fixtures/match-cases.json", "utf8"));

const grams = (value, size) => {
  const set = new Set();
  for (let i = 0; i <= value.length - size; i += 1) set.add(value.slice(i, i + size));
  return set;
};

const dice = (left, right, size) => {
  const a = grams(left, size);
  const b = grams(right, size);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
};

// Length-normalised edit distance, as an alternative to n-gram overlap.
const levenshtein = (a, b) => {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
};

const stripYear = value => value.replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").trim();

function score(rawLeft, rawRight, config) {
  const preLeft = config.stripYear ? stripYear(rawLeft) : rawLeft;
  const preRight = config.stripYear ? stripYear(rawRight) : rawRight;
  const left = normalize(preLeft);
  const right = normalize(preRight);
  if (!usable(left) || !usable(right)) return 0;

  // Ordinals must be compared before the exact-equality shortcut: "Slime 4th Season" and
  // "Slime (2024)" normalise to the same string, which is the whole sequel-vs-base problem.
  let ordinalMismatch = false;
  if (config.ordinalMode !== "off") {
    ordinalMismatch = (seasonOrdinal(preLeft) ?? 1) !== (seasonOrdinal(preRight) ?? 1);
  }

  const cap = value =>
    ordinalMismatch
      ? Math.max(config.ordinalMode === "gate" ? Math.min(value, config.ordinalCap) : value - config.ordinalCap, 0)
      : value;

  if (left === right) return cap(1);

  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;

  if (
    config.containment > 0 &&
    shorter.length >= config.minContainLength &&
    shorter.length / longer.length >= config.lengthRatio &&
    longer.includes(shorter)
  ) {
    return cap(config.containment);
  }

  const overlap = config.metric === "lev" ? levenshtein(left, right) : dice(left, right, config.gram);
  return cap(overlap);
}

const best = (titles, target, alternates, config) => {
  const candidates = [target, ...(alternates || [])];
  let top = 0;
  for (const candidate of candidates) {
    for (const title of titles) top = Math.max(top, score(title, candidate, config));
  }
  return top;
};

function evaluate(cases, config) {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  const misses = [];

  for (const item of cases.positives) {
    const value = best(item.titles, item.target, item.targetAlternates, config);
    if (value >= config.threshold) tp += 1;
    else {
      fn += 1;
      misses.push({ kind: "missed", titles: item.titles[0], target: item.target, score: Number(value.toFixed(3)) });
    }
  }

  for (const item of cases.negatives) {
    const value = best(item.titles, item.target, item.targetAlternates, config);
    if (value >= config.threshold) {
      fp += 1;
      misses.push({ kind: "false-positive", titles: item.titles[0], target: item.target, score: Number(value.toFixed(3)) });
    } else tn += 1;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fn, fp, tn, precision, recall, f1, misses };
}

const configs = [];
for (const metric of ["dice", "lev"]) {
  for (const gram of metric === "dice" ? [2, 3] : [0]) {
    for (const threshold of [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
      for (const containment of [0, 0.85, 0.9]) {
        for (const lengthRatio of containment === 0 ? [0] : [0.5, 0.6, 0.75]) {
          for (const stripYear of [false, true]) {
            for (const [ordinalMode, ordinalCap] of [["off", 0], ["penalty", 0.3], ["gate", 0.5], ["gate", 0.35]]) {
              configs.push({ metric, gram, threshold, containment, lengthRatio, minContainLength: 6, stripYear, ordinalMode, ordinalCap });
            }
          }
        }
      }
    }
  }
}

const label = c =>
  `${c.metric}${c.gram ? c.gram : ""} thr=${c.threshold} contain=${c.containment || "off"}${
    c.containment ? `@${c.lengthRatio}` : ""
  }${c.stripYear ? " +year" : ""}${c.ordinalMode !== "off" ? ` ${c.ordinalMode}@${c.ordinalCap}` : ""}`;

for (const [name, cases] of Object.entries(fixtures).filter(([key]) => key !== "builtAt")) {
  console.log(`\n=== ${name}: ${cases.positives.length} positives, ${cases.negatives.length} negatives ===`);

  const scored = configs
    .map(config => ({ config, result: evaluate(cases, config) }))
    .sort((a, b) => b.result.f1 - a.result.f1 || b.result.precision - a.result.precision);

  console.log("  top 8 by F1:");
  for (const { config, result } of scored.slice(0, 8)) {
    console.log(
      `    ${label(config).padEnd(40)} P=${result.precision.toFixed(3)} R=${result.recall.toFixed(3)} F1=${result.f1.toFixed(3)}  (fp=${result.fp} fn=${result.fn})`
    );
  }

  const current = evaluate(cases, {
    metric: "dice",
    gram: 2,
    threshold: name === "sonarr" ? 0.75 : 0.85,
    containment: 0.9,
    lengthRatio: 0.6,
    minContainLength: 6,
    stripYear: false,
    ordinalMode: "off",
    ordinalCap: 0
  });
  console.log(
    `  current shipping config:               P=${current.precision.toFixed(3)} R=${current.recall.toFixed(3)} F1=${current.f1.toFixed(3)}  (fp=${current.fp} fn=${current.fn})`
  );

  console.log("  candidate shortlist:");
  const base = { metric:"dice", gram:2, containment:0.9, lengthRatio:0.6, minContainLength:6, ordinalMode:"off", ordinalCap:0 };
  const shortlist = [
    { ...base, threshold:0.65, stripYear:true },
    { ...base, threshold:0.70, stripYear:true },
    { ...base, threshold:0.75, stripYear:true },
    { ...base, threshold:0.80, stripYear:true },
    { ...base, threshold:0.85, stripYear:true }
  ];
  for (const config of shortlist) {
    const r = evaluate(cases, config);
    console.log(`    ${label(config).padEnd(44)} P=${r.precision.toFixed(3)} R=${r.recall.toFixed(3)} F1=${r.f1.toFixed(3)}  (fp=${r.fp} fn=${r.fn})`);
    for (const m of r.misses.slice(0,3)) console.log(`        ${m.kind} ${m.score} "${m.titles}" vs "${m.target}"`);
  }

  const winner = scored[0];
  if (winner.result.misses.length) {
    console.log(`  remaining errors for the best config (${label(winner.config)}):`);
    for (const miss of winner.result.misses.slice(0, 8)) {
      console.log(`    ${miss.kind.padEnd(15)} ${miss.score}  "${miss.titles}" vs "${miss.target}"`);
    }
  }
}
