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

  const value = Promise.resolve()
    .then(producer)
    .catch(err => {
      store.delete(key);
      throw err;
    });

  store.set(key, { value, expires: now + ttlMs });

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
