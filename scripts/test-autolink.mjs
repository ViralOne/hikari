import { resolveEpisode } from "../server/autolink.js";
import { basename, hoursSince, withinADay } from "../server/dates.js";

// The automatic linker writes to Shoko, and a wrong link sticks an episode to the wrong file
// permanently, so its decision function is tested directly. No services are needed.
// Run: npm test

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const ep = (episode, airDate, extra = {}) => ({
  episode,
  airDate,
  hasFile: false,
  shokoEpisodeId: 1000 + episode,
  ...extra
});

const sonarr = (airDate, seasonNumber = 1, episodeNumber = 1) => ({ airDate, seasonNumber, episodeNumber });

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

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
