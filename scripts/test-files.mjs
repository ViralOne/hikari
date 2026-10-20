import { episodeFromName, findFileProblems, watchable } from "../server/files.js";

// The file problems panel offers a button that deletes files from disk, so what counts as an extra
// copy is tested directly. Every case is one found on a real library first.
// Run: npm test

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const series = [{ id: 1, title: "Skeleton Knight in Another World", path: "/data/anime/Skeleton Knight in Another World" }];
const ep = (n, relativePath, extra = {}) => ({ id: 100 + n, seasonNumber: 2, episodeNumber: n, relativePath, size: 1400, subtitles: "eng", audioLanguages: "jpn", sceneName: null, ...extra });
const shoko = (fileId, path, extra = {}) => ({ fileId, path, size: 500, linked: true, ...extra });
const run = overrides => findFileProblems({
  series,
  episodesBySeries: new Map([[1, [ep(7, "Season 2/Skeleton Knight - S02E07 - Title WEBDL-1080p.mkv"), ep(8, "Season 2/Skeleton Knight - S02E08 - Other WEBDL-1080p.mkv")]]]),
  shokoFiles: [],
  torrents: [],
  wanted: ["eng"],
  ...overrides
});

console.log("episode names");
check("SxxEyy", JSON.stringify(episodeFromName("Show - S02E07 - Title.mkv")) === '{"season":2,"episode":7}');
check("SubsPlease style", JSON.stringify(episodeFromName("[SubsPlease] Gaikotsu Kishi-sama S2 - 07 (1080p) [A74C13D1].mkv")) === '{"season":2,"episode":7}');
check("a season folder and a bare number", JSON.stringify(episodeFromName("Show/Season 3/[Group] Show - 05v2 [1080p].mkv")) === '{"season":3,"episode":5}');
check("nothing to go on", episodeFromName("Show/random.mkv") === null);

console.log("extra copies");
{
  const report = run({
    shokoFiles: [
      shoko(1, "Skeleton Knight in Another World/Season 2/Skeleton Knight - S02E07 - Title WEBDL-1080p.mkv"),
      shoko(2, "Skeleton Knight in Another World/Season 2/[SubsPlease] Gaikotsu Kishi-sama S2 - 07 (1080p) [A74C13D1].mkv", { size: 1455 })
    ],
    torrents: [{ hash: "abc", name: "[SubsPlease] Gaikotsu S2 - 07", category: "Anime", contentPath: "/data/anime/Skeleton Knight in Another World/Season 2/[SubsPlease] Gaikotsu Kishi-sama S2 - 07 (1080p) [A74C13D1].mkv" }]
  });
  const copy = report.extraCopies[0];
  check("a file Sonarr does not track in its series folder is an extra copy", report.extraCopies.length === 1 && copy.fileId === 2);
  check("it names the episode and the copy that stays", copy.episode === "S02E07" && /S02E07/.test(copy.kept?.name ?? ""));
  check("it finds the torrent that put it there", copy.torrent?.hash === "abc");
}
check("the file Sonarr tracks is never an extra copy",
  run({ shokoFiles: [shoko(1, "Skeleton Knight in Another World/Season 2/Skeleton Knight - S02E07 - Title WEBDL-1080p.mkv")] }).extraCopies.length === 0);
check("path case does not matter",
  run({ shokoFiles: [shoko(1, "skeleton knight in another world/season 2/skeleton knight - s02e07 - title webdl-1080p.mkv")] }).extraCopies.length === 0);
check("a folder no Sonarr series owns is left to the unmanaged-folders check",
  run({ shokoFiles: [shoko(9, "Tetsunabe no Jan/Iron.Wok.Jan.S01E08.mkv")] }).extraCopies.length === 0);
{
  const report = run({ shokoFiles: [shoko(3, "Skeleton Knight in Another World/Season 2/[SubsPlease] Gaikotsu S2 - 09 (1080p).mkv")] });
  check("an extra copy of an episode Sonarr has no file for still shows, without a kept copy",
    report.extraCopies.length === 1 && report.extraCopies[0].kept === null);
}
check("one Shoko file seen at two locations is reported once", run({
  shokoFiles: [shoko(4, "Skeleton Knight in Another World/Season 2/x - 07.mkv"), shoko(4, "Skeleton Knight in Another World/Season 2/x - 07.mkv")]
}).extraCopies.length === 1);

console.log("subtitles");
check("English subtitles are watchable", watchable({ subtitles: "eng/ara", audioLanguages: "jpn" }, ["eng"]) === true);
check("an English dub without subtitles is watchable", watchable({ subtitles: "", audioLanguages: "jpn/eng" }, ["eng"]) === true);
check("French-only subtitles are not", watchable({ subtitles: "fre", audioLanguages: "jpn" }, ["eng"]) === false);
check("no subtitles and foreign audio is not", watchable({ subtitles: "", audioLanguages: "chi" }, ["eng"]) === false);
check("a file Sonarr has not scanned is not judged", watchable({ subtitles: "", audioLanguages: "" }, ["eng"]) === null);
check("another wanted language counts", watchable({ subtitles: "rum", audioLanguages: "jpn" }, ["eng", "rum"]) === true);
{
  const report = run({ episodesBySeries: new Map([[1, [ep(7, "Season 2/a.mkv", { subtitles: "chi/chi", audioLanguages: "jpn", sceneName: "[绿茶字幕组] Show - 07" })]]]) });
  check("an unwatchable file is listed with its release", report.unwatchable.length === 1 && report.unwatchable[0].episodeId === 107 &&
    report.unwatchable[0].release.includes("绿茶"));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
