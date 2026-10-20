import { anchorSeries, episodeTitleKey, numberingOffset, pickByTitle, resolveEpisode } from "../server/autolink.js";
import { basename, hoursSince, withinADay } from "../server/dates.js";

// The automatic linker writes to Shoko, and a wrong link sticks an episode to the wrong file
// permanently, so its decision function is tested directly. No services are needed.
// Run: npm test

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const ep = (episode, airDate, extra = {}) => ({
  episode,
  airDate,
  hasFile: false,
  shokoEpisodeId: 1000 + episode,
  ...extra
});

const sonarr = (airDate, seasonNumber = 1, episodeNumber = 1, title = null) => ({ airDate, seasonNumber, episodeNumber, title });

console.log("date helpers");

check("the same date matches", withinADay("2026-08-03", "2026-08-03"));
check("a day either side matches", withinADay("2026-08-02", "2026-08-03") && withinADay("2026-08-04", "2026-08-03"));
check("two days apart does not", !withinADay("2026-08-01", "2026-08-03"));
check("a missing date never matches", !withinADay(null, "2026-08-03") && !withinADay("2026-08-03", null));
check("garbage never matches", !withinADay("not-a-date", "2026-08-03"));
check(
  "an unknown creation time counts as old, so it is not held back forever",
  hoursSince(null) === Infinity && hoursSince("nonsense") === Infinity
);
check("a timestamp with an offset parses", hoursSince(new Date(Date.now() - 7200000).toISOString()) > 1.9);
check("basename ignores a trailing slash", basename("/data/anime/Some Show/") === "Some Show");

console.log("\nresolveEpisode");

check(
  "one candidate on the same day resolves",
  resolveEpisode(sonarr("2026-08-03"), [ep(6, "2026-08-03")]).episode?.shokoEpisodeId === 1006
);

check(
  "a one-day timezone difference still resolves",
  resolveEpisode(sonarr("2026-08-03"), [ep(6, "2026-08-04")]).episode?.episode === 6
);

check(
  "an episode that already has a file is not a candidate",
  resolveEpisode(sonarr("2026-08-03"), [ep(6, "2026-08-03", { hasFile: true })]).reason ===
    "no unfilled AniDB episode aired on 2026-08-03"
);

// A batch-released season has every episode on one date, which is exactly where a naive matcher
// would link twelve files to whichever episode happened to be first.
check(
  "two episodes on one date refuse rather than guess",
  /^2 unfilled AniDB episodes/.test(
    resolveEpisode(sonarr("2026-08-03"), [ep(6, "2026-08-03"), ep(7, "2026-08-03")]).reason ?? ""
  )
);

check(
  "a neighbouring week is not picked up",
  resolveEpisode(sonarr("2026-08-03"), [ep(5, "2026-07-27"), ep(7, "2026-08-10")]).episode === undefined
);

check(
  "the right episode is chosen out of a full season",
  resolveEpisode(sonarr("2026-08-03"), [
    ep(4, "2026-07-20"),
    ep(5, "2026-07-27"),
    ep(6, "2026-08-03"),
    ep(7, "2026-08-10")
  ]).episode?.episode === 6
);

check(
  "no Sonarr episode refuses",
  resolveEpisode(undefined, [ep(6, "2026-08-03")]).reason === "Sonarr has no episode with that file path"
);

check(
  "a Sonarr episode without an air date refuses",
  resolveEpisode(sonarr(null, 3, 6), [ep(6, "2026-08-03")]).reason === "Sonarr has no air date for S3E6"
);

check(
  "an episode Shoko gave no id for refuses",
  resolveEpisode(sonarr("2026-08-03"), [ep(6, "2026-08-03", { shokoEpisodeId: null })]).reason ===
    "Shoko reported no episode id"
);

check("an empty AniDB list refuses", resolveEpisode(sonarr("2026-08-03"), []).episode === undefined);
check("a missing AniDB list refuses", resolveEpisode(sonarr("2026-08-03"), undefined).episode === undefined);

console.log("\nsame-day tie broken by title");

// Link Click S4: a double premiere, both episodes on 2026-08-14, which the air date alone refused.
{
  const premiere = [
    ep(1, "2026-08-14", { titles: ["The Forgotten Past", "Vergessene Vergangenheit"] }),
    ep(2, "2026-08-14", { titles: ["The Caged Beast", "Eingesperrt"] })
  ];
  check("an exact title picks the right one of two same-day episodes",
    resolveEpisode(sonarr("2026-08-14", 4, 2, "The Caged Beast"), premiere).episode?.episode === 2);
  check("title matching ignores case and punctuation",
    resolveEpisode(sonarr("2026-08-14", 4, 1, "the forgotten past!"), premiere).episode?.episode === 1);
  check("a title that matches neither still refuses",
    /no title matches exactly/.test(resolveEpisode(sonarr("2026-08-14", 4, 1, "Something Else"), premiere).reason ?? ""));
  check("no Sonarr title still refuses", resolveEpisode(sonarr("2026-08-14"), premiere).episode === undefined);
  check("a near title is not enough",
    resolveEpisode(sonarr("2026-08-14", 4, 1, "The Forgotten Past Part 2"), premiere).episode === undefined);
}
{
  const batch = [ep(1, "2026-08-14", { titles: ["Episode 1"] }), ep(2, "2026-08-14", { titles: ["Episode 2"] })];
  check("placeholder titles never break a tie",
    resolveEpisode(sonarr("2026-08-14", 1, 1, "Episode 1"), batch).episode === undefined);
  const twins = [ep(1, "2026-08-14", { titles: ["Same"] }), ep(2, "2026-08-14", { titles: ["Same"] })];
  check("a title shared by two candidates refuses", resolveEpisode(sonarr("2026-08-14", 1, 1, "Same"), twins).episode === undefined);
}
check("an AniDB episode's titles pick one Sonarr episode",
  pickByTitle(["Eingesperrt", "The Caged Beast"], [{ id: 1, title: "The Forgotten Past" }, { id: 2, title: "The Caged Beast" }], i => i.title)?.id === 2);
check("the title key keeps words and drops punctuation", episodeTitleKey("  Bloodbath — in  Laos!? ") === "bloodbath in laos");

console.log("\nnumbering proven by AniDB matches");

// Reincarnated as a Sword S2: AniDB matched E02 by hash, its season entry has no TVDB id, and
// TVDB's dates run a week behind AniDB's, so the air date points every file at the wrong episode.
{
  const anidb = [
    ep(1, "2026-10-01", { shokoEpisodeId: 636 }),
    ep(2, "2026-10-08", { shokoEpisodeId: 637, hasFile: true }),
    ep(3, "2026-10-15", { shokoEpisodeId: 638 }),
    ep(4, "2026-10-22", { shokoEpisodeId: 639 })
  ];
  const anchors = [{ episodeNumber: 2, shokoSeriesId: 34, shokoEpisodeId: 637 }];
  const offset = numberingOffset(anchors, anidb);
  check("one hash-matched episode proves the numbering", offset === 0);
  check("the anchor names the Shoko series", anchorSeries(anchors) === 34);
  check("the date alone would have picked the wrong episode",
    resolveEpisode(sonarr("2026-10-22", 2, 3), anidb).episode?.episode === 4);
  const third = resolveEpisode(sonarr("2026-10-22", 2, 3), anidb, { offset });
  check("with the numbering, E03 goes to AniDB episode 3", third.episode?.shokoEpisodeId === 638 && third.via === "numbering");
  check("E01 goes to episode 1 although no date lines up",
    resolveEpisode(sonarr("2026-10-08", 2, 1), anidb, { offset }).episode?.shokoEpisodeId === 636);
  check("an episode that already has a file is refused",
    /already has a file/.test(resolveEpisode(sonarr("2026-10-15", 2, 2), anidb, { offset }).reason ?? ""));
  check("a number AniDB does not have is refused",
    /no episode 9/.test(resolveEpisode(sonarr("2026-11-26", 2, 9), anidb, { offset }).reason ?? ""));
}
{
  // A split cour: AniDB starts the second half from 1 while Sonarr keeps counting.
  const anidb = [ep(1, "2026-04-01", { shokoEpisodeId: 10, hasFile: true }), ep(2, "2026-04-08", { shokoEpisodeId: 11 })];
  const offset = numberingOffset([{ episodeNumber: 13, shokoSeriesId: 5, shokoEpisodeId: 10 }], anidb);
  check("an offset numbering is carried over", offset === -12 &&
    resolveEpisode(sonarr("2026-04-08", 1, 14), anidb, { offset }).episode?.shokoEpisodeId === 11);
}
check("anchors that disagree prove nothing", numberingOffset(
  [{ episodeNumber: 1, shokoEpisodeId: 1 }, { episodeNumber: 2, shokoEpisodeId: 3 }],
  [ep(1, null, { shokoEpisodeId: 1 }), ep(3, null, { shokoEpisodeId: 3 })]) === null);
check("no anchors prove nothing", numberingOffset([], [ep(1, null)]) === null);
check("an anchor on an episode Shoko did not list proves nothing",
  numberingOffset([{ episodeNumber: 1, shokoEpisodeId: 99 }], [ep(1, null, { shokoEpisodeId: 1 })]) === null);
check("anchors in two Shoko series name neither",
  anchorSeries([{ shokoSeriesId: 1 }, { shokoSeriesId: 2 }]) === null && anchorSeries([]) === null);
check("without an offset the air date still decides",
  resolveEpisode(sonarr("2026-08-03"), [ep(6, "2026-08-03")]).via === "air date");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
