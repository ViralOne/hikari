import { DETAIL_TTL_MS, STATUS, takenSeasons } from "../server/jellyseerr.js";

// Regression test for "already requested" state.
//
// The bug this exists to stop: a request deleted in Jellyseerr's own UI left Hikari insisting every
// season was still requested, with the request button replaced by a link to a request that no longer
// existed. Jellyseerr drops mediaInfo entirely when the last request for a title goes, so the data
// was right and the cache was old -- tvDetail held it for an hour and there is no webhook for a
// deletion. Nothing here can catch a stale cache directly, so it pins both halves: the derivation
// clears when the record is gone, and the window it can be wrong for stays small.

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("taken seasons");

// What Jellyseerr returns for a title with an approved request for season 1.
const requested = {
  seasons: [{ seasonNumber: 1, episodeCount: 48 }],
  mediaInfo: { status: 3, seasons: [], requests: [{ status: 2, seasons: [{ seasonNumber: 1 }] }] }
};

check("an approved request locks its season", takenSeasons(requested).get(1) === "already requested");

// And what it returns once that request is deleted: no mediaInfo at all. This is the real shape,
// read from a live Jellyseerr after deleting the request for TMDB 220542.
const deleted = { seasons: [{ seasonNumber: 1, episodeCount: 48 }], mediaInfo: null };

check("deleting the request unlocks the season", takenSeasons(deleted).size === 0, `${takenSeasons(deleted).size} still taken`);
check("a title Jellyseerr has never seen locks nothing", takenSeasons({ seasons: [] }).size === 0);
check("a missing detail locks nothing rather than throwing", takenSeasons(null).size === 0);

// Pending approval counts as taken: requesting it again is a duplicate. Declined and failed do not,
// because the season genuinely still needs requesting.
check(
  "a request pending approval locks its season",
  takenSeasons({ mediaInfo: { requests: [{ status: 1, seasons: [{ seasonNumber: 2 }] }] } }).get(2) ===
    "pending approval"
);
check(
  "a declined request does not lock its season",
  takenSeasons({ mediaInfo: { requests: [{ status: 3, seasons: [{ seasonNumber: 2 }] }] } }).size === 0
);
check(
  "a failed request does not lock its season",
  takenSeasons({ mediaInfo: { requests: [{ status: 4, seasons: [{ seasonNumber: 2 }] }] } }).size === 0
);

// Availability reported by Sonarr locks a season too, even with no request attached: mediaInfo.seasons
// is filled in for media added outside Jellyseerr.
check(
  "an available season is locked with no request present",
  takenSeasons({ mediaInfo: { seasons: [{ seasonNumber: 1, status: 5 }], requests: [] } }).get(1) === "available",
  STATUS[5]
);

console.log("\ndetail freshness");

// Imported, not copied: a duplicated literal would let someone raise the TTL back to an hour without
// failing this test, which is exactly how the bug shipped.
check(
  "the request-state cache is measured in seconds, not minutes",
  DETAIL_TTL_MS <= 60 * 1000,
  `${DETAIL_TTL_MS / 1000}s`
);

console.log(`\n${failures === 0 ? "all request-state cases passed" : `${failures} request-state case(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
