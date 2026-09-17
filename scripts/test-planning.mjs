// The "Ready to start" row is a filter over your AniList plan, and a wrong filter either hides the
// one thing you could watch tonight or fills the row with shows still airing. The rules are pinned
// here without a network: readyToStart() takes annotated media exactly as index.js hands it over.
// Run: npm test

const { readyToStart } = await import("../server/planning.js");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const media = (id, extra) => ({ id, title: { display: `#${id}` }, episodes: 12, status: "RELEASING", popularity: id, plannedAt: 0, library: null, watch: null, ...extra });

console.log("what counts as ready");

const ready = readyToStart([
  media(1, { status: "FINISHED" }),
  media(2, { status: "RELEASING" }),
  media(3, { status: "RELEASING", library: { complete: true } }),
  media(4, { status: "FINISHED", library: { complete: true } }),
  media(5, { status: "RELEASING", watch: { onDisk: 12, started: false, scoped: true } }),
  media(6, { status: "RELEASING", watch: { onDisk: 6, started: false, scoped: true } }),
  media(7, { status: "FINISHED", watch: { onDisk: 12, started: true, played: 3 } }),
  media(8, { status: "NOT_YET_RELEASED" }),
  media(9, { status: "FINISHED", episodes: null, watch: { onDisk: 3, started: false, scoped: true } }),
  media(14, { status: "RELEASING", watch: { onDisk: 30, started: false, scoped: false } }),
  media(15, { status: "RELEASING", format: "MOVIE", episodes: 1, movie: { complete: true } }),
  null
]);
const ids = ready.map(item => item.id);

check("a finished show with nothing on disk is ready", ids.includes(1));
check("an airing show with nothing on disk is not", !ids.includes(2));
check("an airing show Sonarr calls complete is ready", ids.includes(3));
check("a finished show that is complete in Sonarr is ready", ids.includes(4));
check("Jellyfin holding every episode counts as complete without Sonarr", ids.includes(5));
check("half the episodes on disk does not", !ids.includes(6));
check("something you have already started is left for 'continue'", !ids.includes(7));
check("an unaired show is not ready", !ids.includes(8));
check("a finished show with an unknown episode count is still ready", ids.includes(9));
check("a Jellyfin match by title or path is not trusted for the count: it may be every season", !ids.includes(14));
check("a film Radarr has on disk counts as owned", ids.includes(15) && ready.find(item => item.id === 15)?.ready.owned === true);
check("a null entry is skipped rather than thrown on", ready.length === 6, `${ready.length}`);

console.log("\nwhat the card says");

const note = id => ready.find(item => item.id === id)?.note;
check("finished and complete says complete", note(4) === "Complete in your library");
check("complete but still airing says aired episodes are on disk", note(3) === "All aired episodes on disk");
check("finished but not on disk says finished airing", note(1) === "Finished airing");

console.log("\norder");

const ordered = readyToStart([
  media(10, { status: "FINISHED", plannedAt: 300, popularity: 1 }),
  media(11, { status: "FINISHED", plannedAt: 100, library: { complete: true }, popularity: 1 }),
  media(12, { status: "FINISHED", plannedAt: 200, popularity: 1 }),
  media(13, { status: "FINISHED", plannedAt: 200, popularity: 9 })
]).map(item => item.id);
check("owned comes first whatever was planned when", ordered[0] === 11);
check("then the most recently planned", ordered[1] === 10, ordered.join(","));
check("ties on planned date break on popularity", ordered.indexOf(13) < ordered.indexOf(12));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
