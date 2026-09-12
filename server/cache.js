const store = new Map();

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
  return { entries: store.size, limit: MAX_ENTRIES };
}
