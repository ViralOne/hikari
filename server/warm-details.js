// Warms the detail panel for the first cards of every Discover row, so the first open is fast.
//
// What is worth warming is not the composed panel, which lives for 45 seconds because request state
// has to be current, but the slow parts underneath it that live much longer: the Jellyseerr/TMDB
// title search (30 minutes) and AniList's franchise and prequel walks (a day). Running the panel's
// own composition fills all of them, and the fast local reads it also makes are simply cheap.
//
// It runs in the background lane (the caller wraps it), one title at a time, so a person browsing
// is never queued behind it and the services it reads are never hit with a burst.

/**
 * The titles to warm, in the order to warm them: across every row before deeper into any, because
 * the leftmost cards are the ones on screen without scrolling. A title in several rows is warmed
 * once, where it first appears.
 */
export function detailTargets(rows, perRow) {
  const lists = (rows || []).map(row => (Array.isArray(row?.media) ? row.media.slice(0, perRow) : []));
  const seen = new Set();
  const order = [];
  const depth = Math.max(0, ...lists.map(list => list.length));

  for (let position = 0; position < depth; position += 1) {
    for (const list of lists) {
      const id = Number(list[position]?.id);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
  }
  return order;
}

// Under the 30 minutes the Jellyseerr search entries live, so a deck in use keeps them warm, and far
// over the minute or two that would only repeat the fast calls for nothing.
export const WARM_INTERVAL_MS = 25 * 60 * 1000;

export function createDetailWarmer({ warm, now = Date.now, minIntervalMs = WARM_INTERVAL_MS }) {
  let running = false;
  let lastRun = -Infinity;

  async function run(rows, perRow) {
    if (running) return { skipped: "running" };
    if (now() - lastRun < minIntervalMs) return { skipped: "recent" };

    running = true;
    lastRun = now();
    let warmed = 0;
    let failed = 0;
    try {
      // Sequential on purpose: background work, against services someone may be using right now.
      for (const id of detailTargets(rows, perRow)) {
        try {
          await warm(id);
          warmed += 1;
        } catch {
          // One title that cannot be composed (an upstream down, a bad match) is not a reason to
          // stop warming the others. Opening it will report the real error.
          failed += 1;
        }
      }
    } finally {
      running = false;
    }
    return { warmed, failed };
  }

  return { run };
}
