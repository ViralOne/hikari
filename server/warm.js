import { config } from "./config.js";
import { refreshAhead } from "./cache.js";

// Keeps the Discover page warm. Two halves:
//
//   boot     build the page once so the first open after a restart is answered from memory. With a
//            snapshot this mostly means refreshing what was restored; without one it is the full
//            AniList fan-out, paid once by nobody rather than by the first person to open a tab.
//
//   timer    every few minutes, refresh the entries behind the page that are about to expire, so
//            they roll over before a request lands on them. Only while the deck is in use: an
//            instance nobody has opened for a day stops asking AniList and Jellyfin for anything.
//
// The cost while active is a refresh of each entry roughly once per TTL (once per tick for the
// ones whose TTL is shorter than a tick): about the traffic one person browsing continuously would
// cause, and a fraction of AniList's limit. refreshAhead() only touches entries that already exist
// and are still inside their grace, so a fresh instance with no traffic warms the discover pages
// and then goes quiet once ACTIVE_FOR has passed.

const INTERVAL_MS = 4 * 60 * 1000;
// Entries expiring before the next tick plus a margin are refreshed now.
const HORIZON_MS = INTERVAL_MS + 30 * 1000;
// How long after the last Discover request the timer keeps working.
const ACTIVE_FOR_MS = 12 * 60 * 60 * 1000;

// What the Discover page reads. Composed and per-title entries are left out: they are cheap to
// rebuild from these and short-lived by design.
const PREFIXES = [
  "anilist:discover:",
  "anilist:sequels",
  "anilist:list",
  "anilist:viewer",
  "jellyfin:series",
  "sonarr:series",
  "radarr:movies",
  "shoko:series",
  "shoko:files:index"
];

// Boot counts as activity, so a restart at night still keeps the page fresh into the morning.
let lastActivity = Date.now();
let timer = null;
let builder = null;

export function noteActivity() {
  lastActivity = Date.now();
}

export function isActive() {
  return Date.now() - lastActivity < ACTIVE_FOR_MS;
}

export function start(build) {
  if (!config.cacheWarm) {
    console.log("[hikari] cache warming is off (CACHE_WARM=0)");
    return;
  }

  builder = build;
  rebuild("warmed");

  timer = setInterval(() => {
    if (!isActive()) return;
    const started = refreshAhead(PREFIXES, HORIZON_MS);
    if (started > 0) console.log(`[hikari] refreshing ${started} cache entr${started === 1 ? "y" : "ies"} ahead of expiry`);
  }, INTERVAL_MS);
  timer.unref();
}

// Settings saves wipe the whole cache, so the page is rebuilt straight after one rather than by
// whoever opens Discover next.
export function rebuild(verb = "rebuilt") {
  if (!builder) return;
  const began = Date.now();
  builder()
    .then(() => console.log(`[hikari] discover ${verb} in ${Date.now() - began}ms`))
    .catch(err => console.warn(`[hikari] discover warm-up failed: ${err.message}`));
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}
