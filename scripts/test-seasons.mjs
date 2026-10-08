import { defaultSelection, nextSelection } from "../src/components/detail/seasons.ts";

// Which TMDB seasons a request starts with, and what a checkbox does to that. Pulled out of the
// detail panel because getting either wrong sends a request for the wrong half of a series, and
// neither can be checked by looking at the rendered panel. Run with node's type stripping.

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const season = (seasonNumber, taken = false) => ({ seasonNumber, taken });
const show = value => JSON.stringify(value);

console.log("what is selected before you touch anything");

check("no season list at all means the whole thing", defaultSelection(null, null) === "all");
check("an empty season list means the whole thing", defaultSelection([], 1) === "all");
check(
  "the suggested season is picked when it is still open",
  show(defaultSelection([season(1), season(2)], 2)) === show([2])
);
check(
  "a suggested season that is already requested is not preselected",
  show(defaultSelection([season(1), season(2, true), season(3)], 2)) === show([])
);
check(
  "but it still falls through to the only open season when there is just one",
  show(defaultSelection([season(1), season(2, true)], 2)) === show([1])
);
check(
  "with one season left open and nothing suggested, that one is picked",
  show(defaultSelection([season(1, true), season(2)], null)) === show([2])
);
check(
  "with several open and nothing suggested, nothing is picked",
  show(defaultSelection([season(1), season(2), season(3)], null)) === show([])
);
check(
  "a suggested season that does not exist falls back to the open-season rule",
  show(defaultSelection([season(1, true), season(2)], 9)) === show([2])
);

console.log("\nticking and unticking");

check("ticking an unselected season adds it", show(nextSelection(2, [1], [1, 2, 3])) === show([1, 2]));
check("ticking a selected season removes it", show(nextSelection(1, [1, 2], [1, 2, 3])) === show([2]));
check("the result stays in order", show(nextSelection(1, [3, 2], [1, 2, 3])) === show([1, 2, 3]));
// "all" has to expand before the toggle, or unticking one box reads as "not present -> add it" and
// collapses the selection to just that season.
check(
  "unticking a box while everything is selected removes only that season",
  show(nextSelection(2, "all", [1, 2, 3])) === show([1, 3])
);
check("ticking the last remaining season empties the selection", show(nextSelection(1, [1], [1])) === show([]));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
