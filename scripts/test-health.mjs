import { pageTorrents, PAGE_SIZES } from "../server/activity.js";
import { classifyAnimeHealth, isAnimeTorrent, CLEARABLE_STATES, looksLikeStorageOutage, releaseTitle } from "../server/health.js";

// The health panel offers a button that removes torrents, so the classification behind it is
// tested directly. Every case here is one that was found by hand on a real library first.
// Run: npm test

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const torrent = (hash, extra = {}) => ({
  hash,
  name: `torrent ${hash}`,
  category: "tv",
  state: "stalledUP",
  progress: 1,
  size: 1000,
  savePath: "/data/torrents/tv",
  isAnime: false,
  ...extra
});
const series = (id, extra = {}) => ({
  id,
  title: `series ${id}`,
  seriesType: "anime",
  episodeFileCount: 12,
  path: `/data/anime/Folder ${id}`,
  tagIds: [],
  ...extra
});

const base = {
  animeRoot: "/data/anime",
  torrents: [],
  animeHashes: new Map(),
  series: [],
  unlinkedFiles: [],
  rootFolders: [],
  tags: new Map()
};
const run = overrides => classifyAnimeHealth({ ...base, ...overrides });
const issueOf = (result, hash) => result.torrents.find(t => t.hash === hash)?.issue ?? null;

console.log("anime detection");

check("a Sonarr grab for an anime series is anime even in the tv category",
  isAnimeTorrent(torrent("a"), new Map([["a", 1]]), "/data/anime"));
check("an Anime category is anime", isAnimeTorrent(torrent("b", { category: "Anime" }), new Map(), "/data/anime"));
check("a save path under the anime root is anime",
  isAnimeTorrent(torrent("c", { category: null, savePath: "/data/anime/Kaya-chan" }), new Map(), "/data/anime"));
check("a plain tv torrent Sonarr never tied to anime is not",
  !isAnimeTorrent(torrent("d"), new Map(), "/data/anime"));
check("hash matching ignores case", isAnimeTorrent(torrent("ABC"), new Map([["abc", 1]]), "/data/anime"));

check("a sibling folder that shares the prefix is not anime",
  !isAnimeTorrent(torrent("p", { category: null, savePath: "/data/anime-archive/x" }), new Map(), "/data/anime"));
check("the root itself counts", isAnimeTorrent(torrent("r", { category: null, savePath: "/data/anime/" }), new Map(), "/data/anime"));

console.log("release titles");

check("group tag and episode are stripped", releaseTitle("[SubsPlease] Show Name - 09 (1080p) [ABC].mkv") === "Show Name");
check("a season marker is stripped", releaseTitle("[Group] Show Name S2 [1080p]") === "Show Name");
check("Season N is stripped", releaseTitle("Show Name Season 2 1080p WEB") === "Show Name");
check("SxxEyy is stripped", releaseTitle("Show Name S01E08 Malice 1080p CR WEB-DL") === "Show Name");

console.log("storage outage guard");

{
  const many = n => Array.from({ length: n }, (_, i) => torrent(`h${i}`));
  check("most torrents missing at once looks like an outage",
    looksLikeStorageOutage([...many(4), ...Array.from({ length: 8 }, (_, i) => torrent(`m${i}`, { state: "missingFiles" }))]));
  check("a few dead torrents among many do not",
    !looksLikeStorageOutage([...many(20), torrent("m", { state: "missingFiles" }), torrent("e", { state: "error" })]));
  check("a tiny client is never judged an outage",
    !looksLikeStorageOutage([torrent("m", { state: "missingFiles" }), torrent("n", { state: "missingFiles" })]));
}

console.log("torrent issues");

{
  const result = run({
    torrents: [torrent("m", { state: "missingFiles", category: "Anime" })]
  });
  check("missingFiles is reported as missing-files", issueOf(result, "m") === "missing-files");
}
{
  const result = run({ torrents: [torrent("e", { state: "error", category: "Anime" })] });
  check("error is reported as missing-files", issueOf(result, "e") === "missing-files");
}
{
  // Sakamoto Days: Sonarr grabbed it, the series is still there, but every file was deleted.
  const result = run({
    torrents: [torrent("s")],
    animeHashes: new Map([["s", 360]]),
    series: [series(360, { episodeFileCount: 0 })]
  });
  check("a grab whose series has no files left is an orphan", issueOf(result, "s") === "orphan");
}
{
  // DAN DA DAN: the series was deleted from Sonarr outright.
  const result = run({ torrents: [torrent("d")], animeHashes: new Map([["d", 344]]), series: [] });
  check("a grab whose series is gone is an orphan", issueOf(result, "d") === "orphan");
}
{
  const result = run({
    torrents: [torrent("ok")],
    animeHashes: new Map([["ok", 1]]),
    series: [series(1)]
  });
  check("a grab for a series that still has files is healthy", issueOf(result, "ok") === null);
}
{
  const result = run({
    torrents: [torrent("dl", { progress: 0.4, state: "downloading" })],
    animeHashes: new Map([["dl", 360]]),
    series: [series(360, { episodeFileCount: 0 })]
  });
  check("an unfinished download is never an orphan", issueOf(result, "dl") === null);
}
{
  // Kaya-chan: a [Judas] pack added by hand straight into the library folder.
  const result = run({ torrents: [torrent("k", { category: "Anime" })] });
  check("an anime torrent Sonarr never grabbed is unmanaged", issueOf(result, "k") === "unmanaged");
}
{
  const result = run({ torrents: [torrent("tv")] });
  check("a non-anime torrent is not in the anime report at all", !result.torrents.some(t => t.hash === "tv"));
}
check("only missing-file states can be cleared", CLEARABLE_STATES.has("missingFiles") && CLEARABLE_STATES.has("error") &&
  !CLEARABLE_STATES.has("stalledUP") && !CLEARABLE_STATES.has("pausedUP"));

console.log("library");

{
  const result = run({
    rootFolders: [
      { path: "/data/tvshows", unmapped: ["Some Show"] },
      { path: "/data/anime", unmapped: ["Kaya-chan wa Kowakunai", "MF Ghost 3rd Season"] }
    ]
  });
  check("unmanaged folders come only from the anime root", result.unmanagedFolders.length === 2 &&
    result.unmanagedFolders.includes("Kaya-chan wa Kowakunai") && !result.unmanagedFolders.includes("Some Show"));
}
{
  const result = run({ rootFolders: [{ path: "/data/anime/", unmapped: ["X"] }] });
  check("a trailing slash on the root still matches", result.unmanagedFolders.length === 1);
}
{
  const result = run({
    unlinkedFiles: [
      { fileId: 1, path: "Reincarnated as a Sword/Season 2/S02E01.mkv", size: 5 },
      { fileId: 2, path: "DAN DA DAN/Season 1/S01E01.mkv", size: 7 }
    ]
  });
  check("unlinked files are passed through, largest first",
    result.unlinked.length === 2 && result.unlinked[0].fileId === 2);
  check("unlinked files not in Sonarr are grouped by folder and flagged",
    result.unlinkedByShow.every(g => g.series === null) && result.unlinkedByShow[0].show === "DAN DA DAN");
}

console.log("Sonarr grouping and tags");

{
  // Shoko's path starts at the series folder, which is the tail of Sonarr's series path.
  const result = run({
    series: [series(7, { title: "Reincarnated as a Sword", path: "/data/anime/Reincarnated as a Sword", tagIds: [3] })],
    tags: new Map([[3, "airing"]]),
    unlinkedFiles: [
      { fileId: 1, path: "Reincarnated as a Sword/Season 2/S02E01.mkv", size: 5 },
      { fileId: 2, path: "reincarnated as a sword/Season 2/S02E02.mkv", size: 5 }
    ]
  });
  const group = result.unlinkedByShow[0];
  check("unlinked files group under the Sonarr series", result.unlinkedByShow.length === 1 && group.files === 2 &&
    group.series?.id === 7 && group.show === "Reincarnated as a Sword", JSON.stringify(result.unlinkedByShow));
  check("the group carries the series' Sonarr tags by label", group.series.tags.join() === "airing");
}
{
  const result = run({
    torrents: [torrent("ok")],
    animeHashes: new Map([["ok", 9]]),
    series: [series(9, { title: "DAN DA DAN", tagIds: [1, 2] })],
    tags: new Map([[1, "anime"], [2, "keep"]])
  });
  const item = result.torrents.find(t => t.hash === "ok");
  check("a torrent carries its Sonarr series and tags", item.series?.title === "DAN DA DAN" &&
    item.series.tags.join() === "anime,keep", JSON.stringify(item.series));
}
{
  const result = run({ torrents: [torrent("k", { category: "Anime" })] });
  check("a torrent Sonarr never grabbed has no series", result.torrents[0].series === null);
}
{
  const result = run({ series: [series(1, { tagIds: [99] })], tags: new Map() , torrents: [torrent("x")], animeHashes: new Map([["x", 1]]) });
  check("a tag id Sonarr no longer knows is dropped, not shown as a number", result.torrents[0].series.tags.length === 0);
}
{
  // Gaikotsu Kishi-sama S2 was grabbed outside Sonarr, but Sonarr has the show under its English title.
  const result = run({
    torrents: [
      torrent("g", { category: "Anime", name: "[SubsPlease] Gaikotsu Kishi-sama, Tadaima Isekai e Odekakechuu S2 - 09 (1080p) [ABCD1234].mkv" }),
      torrent("m", { category: "Anime", name: "[ToonsHub] Mushoku Tensei Jobless Reincarnation S03E01 1080p BILI WEB-DL AAC2.0 H.264" }),
      torrent("j", { category: "Anime", name: "Iron Wok Jan S01E08 Malice 1080p CR WEB-DL AAC2.0 H.264-VARYG" })
    ],
    series: [
      series(5, { title: "Skeleton Knight in Another World", keys: ["skeleton knight in another world", "gaikotsu kishi sama tadaima isekai e odekakechuu"] }),
      series(6, { title: "Mushoku Tensei: Jobless Reincarnation", keys: ["mushoku tensei jobless reincarnation"] })
    ]
  });
  const by = hash => result.torrents.find(t => t.hash === hash);
  check("an outside grab is matched to its Sonarr series by alternate title",
    by("g").issue === "unmanaged" && by("g").seriesGuess?.id === 5, JSON.stringify(by("g").seriesGuess));
  check("an outside grab is matched by its main title", by("m").seriesGuess?.id === 6);
  check("a show Sonarr does not have stays unmatched", by("j").seriesGuess === null);
  check("a guessed series is not treated as Sonarr owning the download", by("g").series === null);
}
{
  check("no Sonarr tags at all is reported", run({}).sonarrTags === 0 && run({ tags: new Map([[1, "a"]]) }).sonarrTags === 1);
}

console.log("totals");

{
  const result = run({
    torrents: [
      torrent("m", { state: "missingFiles", category: "Anime", size: 10 }),
      torrent("d", { size: 20 }),
      torrent("k", { category: "Anime", size: 5 })
    ],
    animeHashes: new Map([["d", 344]])
  });
  check("totals count each issue", result.totals.missingFiles === 1 && result.totals.orphans === 1 &&
    result.totals.unmanaged === 1, JSON.stringify(result.totals));
  check("orphan bytes are summed", result.totals.orphanBytes === 20);
}

console.log("activity paging");

{
  const list = Array.from({ length: 23 }, (_, i) => ({ hash: `a${i}`, isAnime: true, active: i < 2, dlspeed: 5, upspeed: 1 }))
    .concat([{ hash: "tv", isAnime: false, active: true, dlspeed: 7, upspeed: 3 }, { hash: "idle", isAnime: false, active: false }]);
  const first = pageTorrents(list, {});
  check("defaults to anime, 10 per page", first.items.length === 10 && first.pageSize === 10 && first.pages === 3 && first.page === 1);
  check("the last page holds the rest", pageTorrents(list, { page: 3 }).items.length === 3);
  check("a page past the end lands on the last one", pageTorrents(list, { page: 99 }).page === 3);
  check("only the offered page sizes are accepted", pageTorrents(list, { size: 7 }).pageSize === 10 &&
    pageTorrents(list, { size: "25" }).pageSize === 25 && PAGE_SIZES.join() === "10,25,50");
  check("garbage paging falls back to defaults", pageTorrents(list, { page: "x", size: "-3" }).page === 1);
  const all = pageTorrents(list, { scope: "all", size: 50 });
  check("all adds active non-anime torrents but not idle ones", all.stats.total === 24 && !all.items.some(t => t.hash === "idle"));
  check("stats cover the whole scoped list, not the page", first.stats.total === 23 && first.stats.active === 2 &&
    first.stats.down === 10 && first.stats.up === 23 && first.stats.anime === 23);
  check("an empty list is one empty page", pageTorrents([], {}).pages === 1 && pageTorrents([], {}).items.length === 0);
}

if (failures > 0) {
  console.log(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
