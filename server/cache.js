import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const store = new Map();

// Restarts used to drop every entry, which is how a rebuild loop hit AniList's rate limit.
// Only long-lived AniList data is worth persisting; live queues would be stale on load.
const PERSIST_PREFIXES = ["anilist:page:", "anilist:media:", "anilist:schedule:", "seerr:tv:", "seerr:movie:"];
const snapshotPath = (process.env.CACHE_FILE || "").trim();

// Search keys are caller-controlled (?q=, ?genre=), so the map needs a hard ceiling and
// real eviction. Without it a script issuing unique queries grows RSS until OOM.
const MAX_ENTRIES = 500;

function sweep() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expires <= now) store.delete(key);
  }
}

function evictOldest() {
  const overflow = store.size - MAX_ENTRIES;
  if (overflow <= 0) return;

  const byExpiry = [...store.entries()].sort((a, b) => a[1].expires - b[1].expires);
  for (let i = 0; i < overflow; i += 1) store.delete(byExpiry[i][0]);
}

export function cached(key, ttlMs, producer) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) return hit.value;

  const previous = hit?.settled;

  const value = Promise.resolve()
    .then(producer)
    .then(result => {
      const entry = store.get(key);
      if (entry) entry.settled = result;
      return result;
    })
    .catch(err => {
      store.delete(key);
      // Serving the last good value beats blanking the page when an upstream rate-limits or
      // blips. AniList in particular answers 429 for a full minute.
      if (previous !== undefined) {
        console.warn(`[hikari] ${key}: ${err.message} — serving stale value`);
        return previous;
      }
      throw err;
    });

  store.set(key, { value, expires: now + ttlMs, settled: previous });

  if (store.size > MAX_ENTRIES) {
    sweep();
    evictOldest();
  }

  return value;
}

export function invalidate(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function stats() {
  return { entries: store.size, limit: MAX_ENTRIES, snapshot: snapshotPath || null };
}

function persistable(key) {
  return PERSIST_PREFIXES.some(prefix => key.startsWith(prefix));
}

export function loadSnapshot() {
  if (!snapshotPath) return 0;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch {
    return 0;
  }

  const now = Date.now();
  let restored = 0;

  for (const [key, entry] of Object.entries(parsed.entries || {})) {
    if (!persistable(key) || entry.expires <= now) continue;
    store.set(key, { value: Promise.resolve(entry.settled), expires: entry.expires, settled: entry.settled });
    restored += 1;
  }
  return restored;
}

export async function saveSnapshot() {
  if (!snapshotPath) return 0;

  const entries = {};
  for (const [key, entry] of store) {
    if (!persistable(key) || entry.settled === undefined) continue;
    entries[key] = { expires: entry.expires, settled: entry.settled };
  }

  try {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({ savedAt: Date.now(), entries }));
  } catch (err) {
    console.warn(`[hikari] could not write cache snapshot: ${err.message}`);
    return 0;
  }
  return Object.keys(entries).length;
}
