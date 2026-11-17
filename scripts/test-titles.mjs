import { compareTitles, episodeByTitle, episodeTitleFrom, namesAnotherShow } from "../server/titles.js";
import { findFileProblems } from "../server/files.js";

// Titles decide when a numbered file is the wrong episode, and the panel offers to re-map or replace
// on that basis, so both the reading and the comparison are tested. Every case is a real one.
// Run: npm test

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("reading titles");
check("scene release", episodeTitleFrom("LINK.CLICK.S04E07.Chinatown.Investigation.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG.mkv") === "Chinatown Investigation");
check("spaced release", episodeTitleFrom("Link Click Bridon Arc S01E02 Prelude 1080p CR WEB-DL AAC2.0 H 264 DUAL") === "Prelude");
check("Sonarr's own file name", episodeTitleFrom("Season 4/Link Click - S04E12 - Welcome Home WEBDL-1080p.mkv") === "Welcome Home");
check("no title in the name", episodeTitleFrom("Berlin 2023 S01E07 1080p WEB H264-SuccessfulCrab") === null);
check("absolute-numbered anime has none", episodeTitleFrom("[SubsPlease] Kusuriya no Hitorigoto - 06 (1080p).mkv") === null);
check("a placeholder is not a title", episodeTitleFrom("Show - S01E12 - Episode 12 WEBDL-1080p.mkv") === null);

check("a year is not a title", episodeTitleFrom("Dollhouse S01E10 2009 BluRay 1080p DTS X264-FraMeSToR") === null);
check("the show name with a number is not a title", episodeTitleFrom("Reincarnated.as.a.Sword.S02E05.Reincarnated.as.a.Sword.5.1080p.CR.WEB-DL") === null);
check("a spin-off names another show", namesAnotherShow("Link Click Bridon Arc S01E02 Prelude 1080p CR WEB-DL", ["Link Click"]));
check("the series itself does not", !namesAnotherShow("LINK.CLICK.2021.S04E07.Chinatown.Investigation.1080p", ["Link Click"]) &&
  !namesAnotherShow("Dollhouse S01E03 Vogue Down 1080p WEBDL x265-Pisces", ["Dollhouse"]));
check("an unrelated alias is not judged", !namesAnotherShow("Tensei.Goblin.dakedo.Shitsumon.Aru.S01E02.1080p", ["So What's Wrong with Getting Reborn as a Goblin?"]));

console.log("comparing");
check("the spin-off episode is a mismatch", compareTitles("Prelude", "The Caged Beast") === "mismatch");
check("case and punctuation do not matter", compareTitles("Jae", "JAE") === "match" && compareTitles("Do You Believe in Reincarnation", "Do You Believe in Reincarnation?") === "match");
check("small shared words do not make a match", compareTitles("The Caged Beast", "The Forgotten Past") === "mismatch");
check("a reworded title is never called a mismatch", compareTitles("The Exit Disappears", "The Vanishing Exit") !== "mismatch");
check("placeholders are unknown", compareTitles("Welcome Home", "TBA") === "unknown");
check("finding the one episode by title",
  episodeByTitle("Chinatown Investigation", [{ id: 1, title: "Puzzle" }, { id: 2, title: "Chinatown Investigation" }])?.id === 2);

console.log("renumbering and wrong content");
const series = [{ id: 351, title: "Link Click", path: "/data/anime/Link Click" }];
const ep = (season, n, title, relativePath = null, extra = {}) => ({ id: season * 100 + n, seasonNumber: season, episodeNumber: n, title, relativePath, size: 1, subtitles: "eng", audioLanguages: "chi", sceneName: null, ...extra });
{
  // TVDB moved the season back: S3 is now the Bridon Arc, and Sonarr attached a Season-4 file to S3E01.
  const episodes = [
    ep(3, 1, "So Time Begins to Flow Again", "Season 4/Link Click - S04E01 - The Forgotten Past WEBDL-1080p v2.mkv"),
    ep(4, 1, "The Forgotten Past"),
    ep(4, 7, "Chinatown Investigation"),
    ep(4, 2, "The Caged Beast", "Season 4/Link Click - S04E02 - The Caged Beast WEBDL-1080p.mkv", { sceneName: "Link Click Bridon Arc S01E02 Prelude 1080p CR WEB-DL" })
  ];
  const shokoFiles = [
    { fileId: 9, path: "Link Click/Season 3/Link Click - S03E07 - Chinatown Investigation WEBDL-1080p.mkv", size: 1, linked: true, links: [] },
    { fileId: 10, path: "Link Click/Season 4/Link Click - S04E01 - The Forgotten Past WEBDL-1080p v2.mkv", size: 1, linked: true, links: [] },
    { fileId: 11, path: "Link Click/Season 4/Link Click - S04E02 - The Caged Beast WEBDL-1080p.mkv", size: 1, linked: true, links: [] }
  ];
  const r = findFileProblems({ series, episodesBySeries: new Map([[351, episodes]]), shokoFiles, torrents: [], wanted: ["eng"] });
  const moves = r.misplaced.map(m => `${m.from}>${m.to}`).sort();
  check("a tracked file whose title names another empty episode is re-mapped there", moves.includes("S03E01>S04E01"), JSON.stringify(moves));
  check("an untracked file is re-mapped by its title too", moves.includes("null>S04E07"), JSON.stringify(moves));
  check("re-mapping keeps the file's real path", r.misplaced.find(m => m.to === "S04E07")?.path === "/data/anime/Link Click/Season 3/Link Click - S03E07 - Chinatown Investigation WEBDL-1080p.mkv");
  check("a spin-off imported under the main show's number is the wrong episode",
    r.wrongEpisode.length === 1 && r.wrongEpisode[0].episode === "S04E02" && r.wrongEpisode[0].fileTitle === "Prelude", JSON.stringify(r.wrongEpisode));
}
{
  const episodes = [ep(1, 7, "Komaro's Challenge", "Season 1/Show - S01E07 - Komaro's Challenge WEBDL-1080p.mkv", { sceneName: "Show 2026 S01E07 1080p WEB H264-GRP" })];
  const r = findFileProblems({ series, episodesBySeries: new Map([[351, episodes]]), shokoFiles: [], torrents: [], wanted: ["eng"] });
  check("an alternate episode title from the same show is not called wrong", findFileProblems({ series: [{ id: 5, title: "Dollhouse", path: "/data/tv/Dollhouse" }],
    episodesBySeries: new Map([[5, [ep(1, 3, "Stage Fright", "Season 1/a.mkv", { sceneName: "Dollhouse S01E03 Vogue Down 1080p WEBDL x265-Pisces" })]]]), shokoFiles: [], torrents: [], wanted: ["eng"] }).wrongEpisode.length === 0);
  check("a correct file is not touched", r.misplaced.length === 0 && r.wrongEpisode.length === 0);
}
{
  const episodes = [ep(1, 3, "Reunion", "Season 1/x.mkv", { sceneName: "Show.S01E03.Puzzle.1080p.WEB" }), ep(1, 6, "Puzzle", "Season 1/y.mkv")];
  const r = findFileProblems({ series, episodesBySeries: new Map([[351, episodes]]), shokoFiles: [], torrents: [], wanted: ["eng"] });
  check("a move onto an episode that already has a file is never proposed", r.misplaced.length === 0 && r.wrongEpisode.length === 0);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
