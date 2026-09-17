import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The AniList -> TMDB mapping, and the one case it is not trusted on.
//
// The bug this exists to stop: matching a request by title. TMDB carries live-action remakes under
// the same name, files a franchise under its base title while AniList names the arc, and numbers
// side stories into the main run. "Link Click Season 3" matched TMDB 314364, the Japanese live-action
// remake, which would have put a live-action drama in the anime root folder.
//
// The row shapes below are the real ones, copied from Fribb/anime-lists rather than invented:
// themoviedb_id.tv is a bare number, themoviedb_id.movie is always an array, and no row carries both.

const dir = mkdtempSync(join(tmpdir(), "hikari-mapping-"));
process.env.ANIME_MAPPING_FILE = join(dir, "mapping.json");

const { project, load, lookup, status } = await import("../server/mapping.js");
const { trustworthy } = await import("../server/jellyseerr.js");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("projection");

const rows = [
  // Link Click Season 3: the entry that started this. Season 4 on TMDB, because TMDB numbers the
  // Bridon Arc side story as season 3.
  { type: "ONA", anilist_id: 191832, themoviedb_id: { tv: 123542 }, tvdb_id: 402033, season: { tvdb: 4, tmdb: 4 } },
  // A film, where movie is an array.
  { type: "ONA", anilist_id: 142455, themoviedb_id: { movie: [912598] } },
  // Bleach TYBW: the franchise is one TMDB series and the arc is a season of it, which no amount of
  // title similarity can work out from "Bleach".
  { type: "TV", anilist_id: 185874, themoviedb_id: { tv: 30984 }, tvdb_id: 74796, season: { tvdb: 17, tmdb: 2 } },
  // Rows that carry nothing usable. Two thirds of the file looks like this.
  { type: "TV", anilist_id: 999001 },
  { type: "TV", anilist_id: 999002, themoviedb_id: {} },
  { type: "TV", themoviedb_id: { tv: 555 } },
  { type: "TV", anilist_id: 0, themoviedb_id: { tv: 556 } }
];

const projected = new Map(project(rows));
check("only rows with an anilist id and a TMDB id survive", projected.size === 3, `${projected.size} of ${rows.length}`);
check(
  "a series keeps its TMDB season",
  projected.get(191832)?.mediaType === "tv" && projected.get(191832)?.tmdbId === 123542 && projected.get(191832)?.season === 4,
  JSON.stringify(projected.get(191832))
);
check(
  "a film takes the first id from the array and has no season",
  projected.get(142455)?.mediaType === "movie" && projected.get(142455)?.tmdbId === 912598 && projected.get(142455)?.season === null,
  JSON.stringify(projected.get(142455))
);
check("an arc maps to its season of the franchise", projected.get(185874)?.season === 2, JSON.stringify(projected.get(185874)));

let threw = false;
try {
  project({ not: "an array" });
} catch {
  threw = true;
}
check("a response that is not an array is refused, not indexed", threw);

threw = false;
try {
  project([{ type: "TV", anilist_id: 1 }]);
} catch {
  threw = true;
}
// Otherwise a mangled download would replace a good table with an empty one and every match would
// quietly fall back to titles.
check("a file with no usable rows is refused", threw);

console.log("\nreading it back");

// The file lives on a writable volume and is read at boot, so it is untrusted input the same way the
// cache snapshot is.
const write = body => writeFileSync(process.env.ANIME_MAPPING_FILE, JSON.stringify(body));

write({ schema: 1, fetchedAt: Date.now(), entries: [...projected] });
check("a good file loads", load().entries === 3 && lookup(191832)?.tmdbId === 123542);

write({ schema: 99, fetchedAt: Date.now(), entries: [...projected] });
check("a file from a future schema is dropped rather than guessed at", load().loaded === false, load().reason);

write({ schema: 1, fetchedAt: Date.now(), entries: [["x", { tmdbId: "y", mediaType: "book" }], [1, null]] });
check("entries that are not id/type/number are dropped", load().loaded === false);

check("a missing id is simply absent", lookup(424242) === null);
check("status reports the table it is serving", status().entries >= 0 && status().path === process.env.ANIME_MAPPING_FILE);

console.log("\nwhere the mapping is not trusted");

// The mapping descends from AniDB's cross-reference lists, which file a film under its parent series.
// On a 234-entry sweep of a real list this was the only shape the title matcher did better on, and it
// covered every such case: Dragon Ball Super: Broly mapped to the Dragon Ball Super series, and
// The End of Evangelion to the Evangelion series.
const film = { format: "MOVIE" };
check("a film pointed at a series falls back to the title matcher", trustworthy(film, { mediaType: "tv" }) === false);
check("a film pointed at a film is trusted", trustworthy(film, { mediaType: "movie" }) === true);
check("a series pointed at a series is trusted", trustworthy({ format: "TV" }, { mediaType: "tv" }) === true);
// Link Click is an ONA and maps to a series. Widening the exception to every non-TV format would have
// handed it back to the title matcher, which is what got it wrong in the first place.
check("a multi-episode ONA pointed at a series is trusted", trustworthy({ format: "ONA" }, { mediaType: "tv" }) === true);
check("a special pointed at a series is trusted", trustworthy({ format: "SPECIAL" }, { mediaType: "tv" }) === true);

console.log(`\n${failures === 0 ? "all mapping cases passed" : `${failures} mapping case(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
