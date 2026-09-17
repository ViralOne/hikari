import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two things here are easy to break silently. The composed "hikari:" entries are only correct
// because every invalidate() sweeps them: a mutation path that invalidates its own prefix would
// otherwise leave a stale detail body that outlives the fresh parts it was built from. And the
// snapshot allowlist is the only thing keeping whatever a browser put in ?genre= or ?q= off the
// disk. Run: npm test

process.env.CACHE_FILE = join(mkdtempSync(join(tmpdir(), "hikari-cache-")), "cache.json");

const { cached, invalidate, loadSnapshot, saveSnapshot, stats } = await import("../server/cache.js");

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

console.log("\ncounters");

{
  const before = stats();
  const counted = producer("v");
  await cached("count:1", MINUTE, counted);
  await cached("count:1", MINUTE, counted);
  await cached("count:1", MINUTE, counted);
  const after = stats();
  check("a miss then two hits are counted as such", after.misses - before.misses === 1 && after.hits - before.hits === 2, JSON.stringify(after));
  check("the hit rate is a fraction of all lookups", after.hitRate > 0 && after.hitRate < 1, `${after.hitRate}`);

  // A producer that fails after a good value was cached is answered with that value and counted
  // as stale, so the sidebar can say how often an upstream has been papered over.
  let fails = false;
  const flaky = () => {
    if (fails) throw new Error("upstream down");
    return "good";
  };
  await cached("count:flaky", 1, flaky);
  await new Promise(resolve => setTimeout(resolve, 5));
  fails = true;
  const served = await cached("count:flaky", 1, flaky);
  check("a failed refresh serves the last good value", served === "good");
  check("and is counted as stale", stats().stale - before.stale === 1, `${stats().stale}`);
}

console.log("\nstale-while-revalidate");

{
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  let version = 1;
  let calls = 0;
  const slow = () =>
    new Promise(resolve => {
      calls += 1;
      const mine = version;
      setTimeout(() => resolve(`v${mine}`), 20);
    });

  const first = await cached("swr:a", 1, slow, { staleFor: MINUTE });
  check("the first call waits for the producer", first === "v1" && calls === 1);

  await tick();
  version = 2;
  const second = await cached("swr:a", 1, slow, { staleFor: MINUTE });
  check("inside the grace the old value is answered at once", second === "v1", second);
  check("and the producer is running behind it", calls === 2);

  const third = await cached("swr:a", 1, slow, { staleFor: MINUTE });
  check("a second caller during the refresh does not start another", third === "v1" && calls === 2, `${calls} calls`);

  await new Promise(resolve => setTimeout(resolve, 40));
  const fourth = await cached("swr:a", 1, slow, { staleFor: MINUTE });
  check("once the refresh lands the new value is served", fourth === "v2", fourth);
  check("revalidations are counted", stats().revalidated >= 2, `${stats().revalidated}`);

  // No grace: the old blocking behaviour, so keys that must not answer stale do not.
  let blockingCalls = 0;
  const blocking = () => {
    blockingCalls += 1;
    return `b${blockingCalls}`;
  };
  await cached("swr:none", 1, blocking);
  await tick();
  const fresh = await cached("swr:none", 1, blocking);
  check("without a grace an expired entry blocks on the producer", fresh === "b2");

  // Past the grace it blocks too: stale has a bound.
  await cached("swr:short", 1, blocking, { staleFor: 1 });
  await tick();
  const bounded = await cached("swr:short", 1, blocking, { staleFor: 1 });
  check("past the grace the caller waits for a fresh value", bounded === "b4", bounded);

  // A background refresh that fails keeps the stale value and does not surface an error anywhere.
  let fail = false;
  const flaky = async () => {
    if (fail) throw new Error("refresh failed");
    return "good";
  };
  const before = stats().stale;
  await cached("swr:flaky", 1, flaky, { staleFor: MINUTE });
  await tick();
  fail = true;
  let rejected = false;
  process.once("unhandledRejection", () => (rejected = true));
  const kept = await cached("swr:flaky", 1, flaky, { staleFor: MINUTE });
  await tick();
  check("a failed background refresh keeps serving the old value", kept === "good" && !rejected);
  check("and is counted as a stale serve", stats().stale - before === 1, `${stats().stale - before}`);
  const again = await cached("swr:flaky", 1, flaky, { staleFor: MINUTE });
  check("the failure backs off rather than retrying on every call", again === "good");

  // An invalidate() while a refresh is in flight wins: the refresh result is dropped, because the
  // invalidation says whatever produced it is already known to be out of date.
  version = 3;
  await cached("swr:inv", 1, slow, { staleFor: MINUTE });
  await tick();
  cached("swr:inv", 1, slow, { staleFor: MINUTE });
  invalidate("swr:inv");
  await new Promise(resolve => setTimeout(resolve, 40));
  version = 4;
  const afterInvalidate = await cached("swr:inv", 1, slow, { staleFor: MINUTE });
  check("a refresh overtaken by invalidate() does not resurrect the key", afterInvalidate === "v4", afterInvalidate);
}

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

// An entry past its TTL but inside its grace is worth restoring: it answers the first open after
// a restart at once and refreshes behind, which is exactly what the snapshot is for.
await cached("anilist:discover:{\"grace\":true}", 1, producer("old-page"), { staleFor: MINUTE });
await new Promise(resolve => setTimeout(resolve, 5));
saveSnapshot();
const saved = JSON.parse(readFileSync(process.env.CACHE_FILE, "utf8")).entries["anilist:discover:{\"grace\":true}"];
check("the snapshot records the grace alongside the TTL", saved && saved.staleUntil > saved.expires && saved.expires <= Date.now(), JSON.stringify(saved && { expires: saved.expires, staleUntil: saved.staleUntil }));

invalidate("anilist:discover:");
const restored = loadSnapshot();
const fresher = producer("new-page");
const fromSnapshot = await cached("anilist:discover:{\"grace\":true}", MINUTE, fresher, { staleFor: MINUTE });
check("an expired-but-in-grace entry is restored and answered at once", restored >= 1 && fromSnapshot === "old-page", `${restored} restored, got ${fromSnapshot}`);
check("while a refresh runs behind it", fresher.calls() === 1);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
