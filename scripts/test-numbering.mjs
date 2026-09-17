// Turning a watched Jellyfin item into an AniList progress number. Reading it as "the Nth item of
// this series" is only the same thing as "episode N" when the season is complete from episode one:
// a season whose first files are missing reads nine episodes low, which is how watching episode 17
// of Re:Zero's 2026 season wrote progress 8 and then refused every later write as already-past.
// Run: npm test

const { numbersAsProgress, progressForItem, runUpTo } = await import("../server/jellyfin.js");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

// The shape episodeItems returns, minus the fields numbering does not read.
const run = (numbers, { season = 1, played = () => false } = {}) =>
  numbers.map(episode => ({
    id: `s${season}e${episode}`,
    season,
    episode,
    name: `Episode ${episode}`,
    played: played(episode)
  }));

console.log("when the item's own episode numbers can be read as progress");

check("a complete season from episode one", numbersAsProgress(run([1, 2, 3, 4]), 12) === true);
check("a season missing its first files", numbersAsProgress(run([10, 11, 12]), 19) === true);
check(
  "not across two seasons, where the numbers restart",
  numbersAsProgress([...run([1, 2], { season: 1 }), ...run([1, 2], { season: 2 })], 24) === false
);
check(
  "not when a release numbers episodes absolutely",
  numbersAsProgress(run([67, 68, 69]), 19) === false
);
check("not when two items share one number", numbersAsProgress(run([5, 5, 6]), 12) === false);
check("not when an item has no number", numbersAsProgress([{ id: "x", season: 1, episode: null }], 12) === false);
check("not without a season length to check against", numbersAsProgress(run([10, 11]), null) === false);
check("not for an empty run", numbersAsProgress([], 12) === false);

console.log("\nthe progress a finished episode means");

const whole = run([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
check("the eighth episode of a whole season is 8", progressForItem(whole, "s1e8", 12) === 8);

// The bug: eight files on disk, none of them episode 1.
const gapped = run([10, 11, 12, 13, 14, 15, 16, 17]);
check("the last episode of a season missing its first nine files is 17, not 8", progressForItem(gapped, "s1e17", 19) === 17);
check("the first file of that season is 10, not 1", progressForItem(gapped, "s1e10", 19) === 10);

const absolute = run([67, 68, 69]);
check("an absolutely numbered run falls back to its position", progressForItem(absolute, "s1e69", 19) === 3);

const twoSeasons = [...run([1, 2, 3], { season: 1 }), ...run([1, 2, 3], { season: 2 })];
check("a two-season item falls back to its position", progressForItem(twoSeasons, "s2e2", 24) === 5);

check("an episode that is not in the run has no progress", progressForItem(gapped, "s1e99", 19) === null);
check("progress cannot overshoot the season length", progressForItem(run([1, 2, 3]), "s1e3", 2) === 2);

console.log("\nwhich episodes to mark played to reach a given progress");

const reach = (items, upTo, total) => runUpTo(items, upTo, total).items.map(item => item.episode);

check("progress 3 of a whole season is its first three", String(reach(whole, 3, 12)) === "1,2,3");
check(
  "progress 10 of a season missing its first nine files is episode 10 alone, not eight files",
  String(reach(gapped, 10, 19)) === "10"
);
check("progress past the end stops at the end", String(reach(gapped, 25, 19)) === "10,11,12,13,14,15,16,17");
check("an absolutely numbered run takes its first n items", String(reach(absolute, 2, 19)) === "67,68");
check("a two-season item takes its first n items", runUpTo(twoSeasons, 4, 24).items.length === 4);

const plan = runUpTo(gapped, 10, 19);
check("the reported reach is the episode, not the count", plan.upTo === 10 && plan.byEpisode === true);
check("a position fallback reports the count it used", runUpTo(absolute, 2, 19).upTo === 2);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
