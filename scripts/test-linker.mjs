import { proposeSeason } from "../server/linker.js";

// The link dialog pre-fills a guess for every file. A person confirms it, but a wrong guess that
// looks confident is still how a file ends up on the wrong episode, so the guessing is tested.
// Run: npm test

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const anidb = (episode, airDate, extra = {}) => ({ episode, airDate, hasFile: false, shokoEpisodeId: 600 + episode, titles: [], ...extra });
const file = fileId => ({ fileId, path: `Show/Season 1/${fileId}.mkv`, size: 1 });
const sonarr = (episodeNumber, airDate, title = null) => ({ seasonNumber: 1, episodeNumber, airDate, title });

console.log("guesses");

{
  const rows = proposeSeason(
    [{ file: file(1), episode: sonarr(1, "2026-10-08") }, { file: file(3), episode: sonarr(3, "2026-10-22") }],
    [anidb(1, "2026-10-01"), anidb(2, "2026-10-08", { hasFile: true }), anidb(3, "2026-10-15"), anidb(4, "2026-10-22")],
    0
  );
  check("a proven numbering guesses by number", rows[0].guess?.shokoEpisodeId === 601 && rows[0].guess.via === "numbering");
  check("even where the date points elsewhere", rows[1].guess?.shokoEpisodeId === 603);
}
{
  const rows = proposeSeason([{ file: file(1), episode: sonarr(5, "2026-10-08", "The Floating Island") }],
    [anidb(1, "2026-10-01", { titles: ["The Floating Island"] }), anidb(2, "2026-10-20")], null);
  check("with no date match, an exact title still gives a guess", rows[0].guess?.shokoEpisodeId === 601 && rows[0].guess.via === "title");
}
{
  const rows = proposeSeason([{ file: file(1), episode: sonarr(5, "2026-10-08", "Episode 5") }],
    [anidb(5, "2026-10-01", { titles: ["Episode 5"] })], null);
  check("a placeholder title is not a guess", rows[0].guess === null && /no unfilled/.test(rows[0].reason));
}
{
  const rows = proposeSeason([{ file: file(9), episode: null }], [anidb(1, "2026-10-01")], 0);
  check("a file Sonarr does not know gets no guess, with the reason", rows[0].guess === null && /Sonarr has no episode/.test(rows[0].reason));
}
{
  const rows = proposeSeason(
    [{ file: file(1), episode: sonarr(1, "2026-10-08", "Same") }, { file: file(2), episode: sonarr(2, "2026-10-30", "Same") }],
    [anidb(1, "2026-10-08", { titles: ["Same"] })],
    null
  );
  check("two files guessing one episode both lose the guess", rows.every(row => row.guess === null) &&
    rows.every(row => /same episode/.test(row.reason)), JSON.stringify(rows.map(r => r.reason)));
}
{
  const rows = proposeSeason([{ file: file(1), episode: sonarr(2, "2026-10-08") }], [anidb(2, "2026-10-08", { hasFile: true })], 0);
  check("an episode that already has a file is never guessed, and the row says it is a second copy", rows[0].guess === null && /second copy/.test(rows[0].reason));
}
check("no AniDB episodes at all is handled", proposeSeason([{ file: file(1), episode: sonarr(1, "2026-10-08") }], undefined, null)[0].guess === null);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
