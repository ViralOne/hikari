import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "./http.js";

// An AniList id -> TMDB id table, so the request matcher can stop guessing from titles.
//
// Titles are a bad key and there is no fixing that from this side. TMDB carries live-action remakes
// under the identical name ("Link Click", 2026), files a franchise under its base title while
// AniList names the arc ("Bleach" vs "BLEACH: Thousand-Year Blood War - The Calamity"), numbers side
// stories into the main run so AniList's season 3 is TMDB's season 4, and sometimes carries a
// placeholder entry that outranks the real one. Every one of those was a real wrong match here.
//
// Fribb/anime-lists is generated from AniDB's cross-reference lists and is keyed on anilist_id
// directly, carrying the TMDB id, the media type and the TMDB season number. On a 234-entry sweep of
// a real list it covered 86% of entries and was right on every case the title matcher got wrong,
// bar one class -- see trustworthy() in jellyseerr.js.
//
// Advisory, never required: Hikari works exactly as before when this is missing, stale, or the
// download fails. Nothing waits on it.

const SOURCE = (
  process.env.ANIME_MAPPING_URL || "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json"
).trim();

const FILE = (process.env.ANIME_MAPPING_FILE || "/cache/hikari-anime-mapping.json").trim();

// The upstream is regenerated a few times a week. Checking weekly keeps a new season's mapping
// arriving within days without pulling 7 MB on a schedule nobody benefits from.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The raw file is ~7 MB of fields Hikari does not read. Only the projection is persisted, which is
// both far smaller and a narrower thing to trust on the way back in.
const SCHEMA = 1;

// anilistId -> { mediaType, tmdbId, season }
let index = new Map();
let fetchedAt = 0;
let refreshing = null;

export function lookup(anilistId) {
  return index.get(Number(anilistId)) || null;
}

export function status() {
  return {
    entries: index.size,
    fetchedAt: fetchedAt || null,
    stale: index.size === 0 || Date.now() - fetchedAt > MAX_AGE_MS,
    path: FILE,
    source: SOURCE
  };
}

// themoviedb_id is { tv: <number> } or { movie: [<number>, ...] }, never both, and anilist_id is
// unique across the file -- all three verified against the live dataset rather than assumed.
export function project(rows) {
  if (!Array.isArray(rows)) throw new Error("expected a JSON array");

  const entries = [];
  for (const row of rows) {
    const anilistId = Number(row?.anilist_id);
    if (!Number.isInteger(anilistId) || anilistId <= 0) continue;

    const tmdb = row.themoviedb_id;
    if (!tmdb || typeof tmdb !== "object") continue;

    const tv = Number(tmdb.tv);
    const movie = Array.isArray(tmdb.movie) ? Number(tmdb.movie[0]) : NaN;

    let mediaType = null;
    let tmdbId = null;
    if (Number.isInteger(tv) && tv > 0) {
      mediaType = "tv";
      tmdbId = tv;
    } else if (Number.isInteger(movie) && movie > 0) {
      mediaType = "movie";
      tmdbId = movie;
    } else {
      continue;
    }

    const season = Number(row.season?.tmdb);
    entries.push([anilistId, { mediaType, tmdbId, season: Number.isInteger(season) && season > 0 ? season : null }]);
  }

  if (entries.length === 0) throw new Error("no usable rows");
  return entries;
}

function adopt(entries, at) {
  index = new Map(entries);
  fetchedAt = at;
}

function persist(entries) {
  const dir = dirname(FILE);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temp = `${FILE}.tmp`;
  writeFileSync(temp, JSON.stringify({ schema: SCHEMA, source: SOURCE, fetchedAt, entries }), { mode: 0o600 });
  renameSync(temp, FILE);
}

// Read whatever is on disk. Like the cache snapshot this is untrusted input from a writable volume,
// so a bad file is dropped rather than trusted, and a wrong schema is dropped rather than guessed at.
export function load() {
  try {
    if (!existsSync(FILE)) return { loaded: false, path: FILE, entries: 0 };

    const parsed = JSON.parse(readFileSync(FILE, "utf8"));
    if (parsed?.schema !== SCHEMA) return { loaded: false, path: FILE, entries: 0, reason: "schema changed" };

    const entries = (Array.isArray(parsed.entries) ? parsed.entries : []).filter(
      entry =>
        Array.isArray(entry) &&
        Number.isInteger(entry[0]) &&
        Number.isInteger(entry[1]?.tmdbId) &&
        (entry[1].mediaType === "tv" || entry[1].mediaType === "movie")
    );
    if (entries.length === 0) return { loaded: false, path: FILE, entries: 0, reason: "no usable entries" };

    adopt(entries, Number(parsed.fetchedAt) || 0);
    return { loaded: true, path: FILE, entries: index.size, fetchedAt };
  } catch (err) {
    console.error(`[hikari] could not read ${FILE}: ${err.message}`);
    return { loaded: false, path: FILE, entries: 0, error: err.message };
  }
}

// One download at a time, and the old table keeps serving until a new one has parsed. A failed
// refresh is a warning, not an error: the title matcher is still there.
export function refresh({ force = false } = {}) {
  if (!force && index.size > 0 && Date.now() - fetchedAt <= MAX_AGE_MS) {
    return Promise.resolve({ refreshed: false, entries: index.size, reason: "still fresh" });
  }
  if (refreshing) return refreshing;

  refreshing = (async () => {
    try {
      const rows = await request("anime-lists", SOURCE, { timeout: 60000 });
      const entries = project(rows);
      const at = Date.now();
      adopt(entries, at);
      persist(entries);
      console.log(`[hikari] anime id mapping: ${entries.length} entries from ${SOURCE}`);
      return { refreshed: true, entries: entries.length };
    } catch (err) {
      console.warn(`[hikari] anime id mapping refresh failed, falling back to title matching: ${err.message}`);
      return { refreshed: false, entries: index.size, error: err.message };
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}
