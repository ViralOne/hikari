import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const store = new Map();

// Search keys are caller-controlled (?q=, ?genre=), so the map needs a hard ceiling and
// real eviction. Without it a script issuing unique queries grows RSS until OOM.
const MAX_ENTRIES = 2000;

// A fan-out like /api/discover mints ~240 short-lived per-item entries. Those must not be
// able to evict the expensive long-lived AniList pages that produced them.
const PROTECTED_PREFIXES = ["anilist:", "seerr:", "shoko:series", "jellyfin:series", "sonarr:series"];

// Restarts used to drop every entry, which is how a rebuild loop hit AniList's rate limit.
// anilist:page: keys embed the query variables, which for /api/search come straight from the
// query string (q, genre, season, ...), so they are never persisted. The discover rows ask for
// anilist:discover: instead, which only the fixed shapes in /api/discover ever produce.
// anilist:prequel-depth: costs one AniList query per season in the chain and only changes when a
// sequel is announced, so it is the least worth re-fetching of anything here. The key holds a
// numeric id only, so no user input reaches the snapshot.
//
// seerr:tv: and seerr:movie: used to be persisted, and must not be: they carry mediaInfo, so a
// restart restored a stale "already requested" for whatever had been deleted in Jellyseerr
// meanwhile. Their TTL is now seconds, which makes persisting them pointless as well as wrong.
const PERSIST_PREFIXES = [
  "anilist:media:",
  "anilist:schedule:",
  "anilist:prequel-depth:",
  "anilist:franchise:",
  "anilist:discover:"
];
const PERSIST_DENY = ["\"search\":"];

// Upstreams that rate-limit stay angry for a while, so hold the stale value rather than
// re-asking on every request.
const STALE_RETRY_MS = 30 * 1000;

// A snapshot is untrusted input: it lives on a writable volume and is read at boot.
const MAX_RESTORED_TTL_MS = 24 * 60 * 60 * 1000;

const snapshotPath = (process.env.CACHE_FILE || "").trim();

// Since boot. A hit is an unexpired entry; a miss ran the producer and made the caller wait; stale
// is a producer failure answered with the last good value; revalidated is a stale-but-in-grace entry
// answered at once while the producer ran behind it.
const counters = { hits: 0, misses: 0, stale: 0, revalidated: 0 };

function sweep() {
  const now = Date.now();
  for (const [key, entry] of store) {
    // An entry past its TTL but inside its grace is still worth its slot: it is what lets the next
    // caller be answered at once.
    if (staleUntil(entry) <= now) store.delete(key);
  }
}

const staleUntil = entry => entry.staleUntil ?? entry.expires;

function evictOldest() {
  const overflow = store.size - MAX_ENTRIES;
  if (overflow <= 0) return;

  const disposable = [...store.entries()]
    .filter(([key]) => !PROTECTED_PREFIXES.some(prefix => key.startsWith(prefix)))
    .sort((a, b) => a[1].expires - b[1].expires);

  for (let i = 0; i < overflow && i < disposable.length; i += 1) store.delete(disposable[i][0]);
}

// `staleFor` opts a key into stale-while-revalidate: for that long after the TTL, a caller gets
// the old value at once and the producer runs behind it, so the first open after a quiet spell is
// as fast as the second. It is opt-in because for some keys an old answer is a wrong one -- a
// Jellyseerr request state, a Sonarr episode list mid-download -- and those keep blocking on
// the producer. Entries with no grace behave exactly as before.
export function cached(key, ttlMs, producer, { staleFor = 0 } = {}) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) {
    counters.hits += 1;
    // Entries restored from the snapshot arrive without a producer; the first caller lends its own,
    // so refreshAhead() can keep them fresh from then on.
    // Assumes one producer per key, which holds: every key embeds whatever its producer varies on.
    if (!hit.producer) Object.assign(hit, { producer, ttlMs, staleFor });
    return hit.value;
  }

  if (hit && hit.settled !== undefined && staleUntil(hit) > now) {
    counters.revalidated += 1;
    if (!hit.refreshing) {
      hit.refreshing = true;
      revalidate(key, hit, ttlMs, staleFor, producer);
    }
    return hit.value;
  }

  counters.misses += 1;

  const previous = hit?.settled;

  // Identity matters: a slow producer must never mutate or delete a newer entry that replaced
  // its own after the TTL rolled over.
  // The producer is kept on the entry so refreshAhead() can run it again without the caller.
  // `refreshing` while the producer runs, so a refreshAhead() tick does not start a second one.
  const entry = {
    value: undefined,
    expires: now + ttlMs,
    staleUntil: now + ttlMs + staleFor,
    settled: previous,
    producer,
    ttlMs,
    staleFor,
    refreshing: true
  };

  entry.value = Promise.resolve()
    .then(producer)
    .then(result => {
      if (store.get(key) === entry) {
        entry.settled = result;
        entry.refreshing = false;
      }
      return result;
    })
    .catch(err => {
      if (store.get(key) !== entry) throw err;

      // Keep the last good value available instead of deleting the entry that holds it,
      // which would make every following request re-hit the failing upstream.
      if (previous !== undefined) {
        counters.stale += 1;
        console.warn(`[hikari] ${key}: ${err.message}, serving stale value`);
        store.set(key, {
          value: Promise.resolve(previous),
          expires: Date.now() + STALE_RETRY_MS,
          staleUntil: Date.now() + STALE_RETRY_MS,
          settled: previous,
          producer,
          ttlMs,
          staleFor
        });
        return previous;
      }

      store.delete(key);
      throw err;
    });

  store.set(key, entry);

  if (store.size > MAX_ENTRIES) {
    sweep();
    evictOldest();
  }

  return entry.value;
}

// The background half of stale-while-revalidate. The stale entry stays in place until the producer
// has a result, and is only replaced if it is still the entry in the store: an invalidate() that
// landed meanwhile means the fresh value was built from something already known to be out of date,
// so it is dropped rather than resurrected.
function revalidate(key, stale, ttlMs, staleFor, producer) {
  Promise.resolve()
    .then(producer)
    .then(result => {
      if (store.get(key) !== stale) return;
      const now = Date.now();
      store.set(key, {
        value: Promise.resolve(result),
        expires: now + ttlMs,
        staleUntil: now + ttlMs + staleFor,
        settled: result,
        producer,
        ttlMs,
        staleFor
      });
    })
    .catch(err => {
      if (store.get(key) !== stale) return;
      // Hold the stale value and stop retrying for a moment, exactly as a failed foreground refresh
      // does. The grace still bounds how long it can be served.
      counters.stale += 1;
      console.warn(`[hikari] ${key}: ${err.message}, keeping stale value`);
      // Never shortens a still-fresh entry: refreshAhead() starts refreshes before the TTL is up.
      stale.expires = Math.min(Math.max(stale.expires, Date.now() + STALE_RETRY_MS), staleUntil(stale));
      stale.refreshing = false;
    });
}

// Refreshes, in the background, every live entry under one of the prefixes that will expire within
// `withinMs`. The warmer calls this on a timer, so the entries behind the Discover page roll over
// before a request lands on a stale one. Only entries that exist and are still inside their grace
// are touched: nothing is fetched that nobody has asked for, and a key that has gone cold stays
// cold rather than being kept alive for ever. Returns how many were started.
export function refreshAhead(prefixes, withinMs) {
  const now = Date.now();
  let started = 0;
  for (const [key, entry] of store) {
    if (!prefixes.some(prefix => key.startsWith(prefix))) continue;
    if (!entry.producer || entry.settled === undefined || entry.refreshing) continue;
    if (staleUntil(entry) <= now) continue;
    if (entry.expires - now > withinMs) continue;
    entry.refreshing = true;
    revalidate(key, entry, entry.ttlMs, entry.staleFor, entry.producer);
    started += 1;
  }
  return started;
}

// Entries composed from several upstreams. They cannot be invalidated by the prefix of any one
// upstream, so every invalidation of anything else sweeps them: they are cheap to rebuild and
// short-lived, and a stale composed body would otherwise outlive the fresh parts it was built from.
const COMPOSED_PREFIX = "hikari:";

export function invalidate(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }

  if (prefix.startsWith(COMPOSED_PREFIX)) return;
  for (const key of store.keys()) {
    if (key.startsWith(COMPOSED_PREFIX)) store.delete(key);
  }
}

export function stats() {
  const lookups = counters.hits + counters.misses;
  return {
    entries: store.size,
    limit: MAX_ENTRIES,
    snapshot: snapshotPath || null,
    hits: counters.hits,
    misses: counters.misses,
    stale: counters.stale,
    revalidated: counters.revalidated,
    hitRate: lookups === 0 ? null : counters.hits / lookups
  };
}

function persistable(key) {
  if (PERSIST_DENY.some(needle => key.includes(needle))) return false;
  return PERSIST_PREFIXES.some(prefix => key.startsWith(prefix));
}

export function loadSnapshot() {
  if (!snapshotPath) return 0;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`[hikari] ignoring cache snapshot: ${err.message}`);
    return 0;
  }

  if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") return 0;

  const now = Date.now();
  let restored = 0;

  for (const [key, entry] of Object.entries(parsed.entries)) {
    if (!persistable(key)) continue;
    if (!entry || typeof entry !== "object" || typeof entry.expires !== "number") continue;
    // Restored while inside the grace, not only the TTL: an old discover page answers the first
    // open after a restart at once and refreshes behind it, which is the whole point of keeping it.
    const grace = typeof entry.staleUntil === "number" ? entry.staleUntil : entry.expires;
    if (entry.settled === undefined || grace <= now) continue;

    const expires = Math.min(entry.expires, now + MAX_RESTORED_TTL_MS);
    const staleUntil = Math.min(grace, now + MAX_RESTORED_TTL_MS);
    store.set(key, { value: Promise.resolve(entry.settled), expires, staleUntil, settled: entry.settled });
    restored += 1;
  }
  return restored;
}

export function saveSnapshot() {
  if (!snapshotPath) return 0;

  const entries = {};
  for (const [key, entry] of store) {
    if (!persistable(key) || entry.settled === undefined) continue;
    entries[key] = { expires: entry.expires, staleUntil: staleUntil(entry), settled: entry.settled };
  }

  const count = Object.keys(entries).length;

  try {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    // Write-then-rename so a crash mid-write cannot truncate the existing snapshot.
    const temp = `${snapshotPath}.tmp`;
    writeFileSync(temp, JSON.stringify({ savedAt: Date.now(), entries }), { mode: 0o600 });
    renameSync(temp, snapshotPath);
  } catch (err) {
    console.warn(`[hikari] could not write cache snapshot: ${err.message}`);
    return 0;
  }
  return count;
}
