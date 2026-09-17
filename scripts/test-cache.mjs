import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two things here are easy to break silently. The composed "hikari:" entries are only correct
// because every invalidate() sweeps them: a mutation path that invalidates its own prefix would
// otherwise leave a stale detail body that outlives the fresh parts it was built from. And the
// snapshot allowlist is the only thing keeping whatever a browser put in ?genre= or ?q= off the
// disk. Run: npm test

process.env.CACHE_FILE = join(mkdtempSync(join(tmpdir(), "hikari-cache-")), "cache.json");

const { cached, invalidate, saveSnapshot } = await import("../server/cache.js");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const MINUTE = 60 * 1000;
const producer = value => {
  let calls = 0;
  const fn = () => {
    calls += 1;
    return value;
  };
  fn.calls = () => calls;
  return fn;
};

console.log("composed entries");

const composed = producer("body");
const upstream = producer("seerr");
const unrelated = producer("shoko");

await cached("hikari:anime:1", MINUTE, composed);
await cached("seerr:tv:99", MINUTE, upstream);
await cached("shoko:series:5", MINUTE, unrelated);
await cached("hikari:anime:1", MINUTE, composed);
check("a composed entry is served from cache while fresh", composed.calls() === 1);

invalidate("seerr:tv:");
await cached("hikari:anime:1", MINUTE, composed);
await cached("shoko:series:5", MINUTE, unrelated);
check("invalidating an upstream prefix also drops the composed entry", composed.calls() === 2);
check("but leaves unrelated upstream entries alone", unrelated.calls() === 1);

invalidate("hikari:anime:1");
await cached("seerr:tv:99", MINUTE, upstream);
check("invalidating a composed entry does not cascade back to its upstreams", upstream.calls() === 2);

console.log("\nsnapshot allowlist");

await cached("anilist:discover:{\"sort\":[\"TRENDING_DESC\"]}", MINUTE, producer("row"));
await cached("anilist:page:{\"genre\":\"<script>\",\"sort\":[\"POPULARITY_DESC\"]}", MINUTE, producer("filtered"));
await cached("anilist:page:{\"search\":\"typed\"}", MINUTE, producer("searched"));
await cached("anilist:media:1", MINUTE, producer("media"));
await cached("seerr:tv:99", MINUTE, producer("requested"));
await cached("hikari:anime:1", MINUTE, producer("composed"));

saveSnapshot();
const keys = Object.keys(JSON.parse(readFileSync(process.env.CACHE_FILE, "utf8")).entries);

check("discover rows are persisted", keys.some(key => key.startsWith("anilist:discover:")));
check("so is AniList media", keys.includes("anilist:media:1"));
check("a filtered search page is not, even without a search term", !keys.some(key => key.includes("genre")), keys.join(" "));
check("a typed search is not", !keys.some(key => key.includes("search")));
check("Jellyseerr request state is not", !keys.some(key => key.startsWith("seerr:")));
check("composed bodies are not", !keys.some(key => key.startsWith("hikari:")));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
