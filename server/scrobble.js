import * as anilist from "./anilist.js";
import * as anilistList from "./anilist-list.js";
import * as jellyfin from "./jellyfin.js";
import * as shoko from "./shoko.js";
import { invalidate } from "./cache.js";
import { config, enabled } from "./config.js";

// Jellyfin's Webhook plugin telling Hikari an episode was finished, turned into AniList progress.
// The same two pieces the "mark played" button already relies on, run the other way round: the
// Jellyfin series is mapped to exactly one AniList entry, and the episode is read as a number that
// entry counts (see numbersAsProgress in jellyfin.js for when that is its own number and when it
// falls back to its position in the run).
//
// It refuses rather than guesses. Only a series scoped to one AniList entry is written -- a
// Shokofin item carrying an AniList or AniDB id -- because a series matched by TvDB id or title can
// hold several AniList seasons, and "episode 3 of that" is not a number AniList understands.
// Progress only ever moves forward, so a rewatch or a duplicate webhook cannot undo anything.
//
// Off unless both `anilist.allowWrites` and `anilist.scrobble` are on. Also guarded by the hook
// token like /api/hooks/sonarr, and by the Jellyfin user: only the user Hikari reads progress for
// counts, so a household member's viewing does not land on your list.

// The Webhook plugin sends whatever template the user pasted. This is the one the Settings screen
// hands out; the reader below is lenient about the casing the plugin's own variables use.
export const TEMPLATE = {
  event: "{{NotificationType}}",
  itemType: "{{ItemType}}",
  itemId: "{{ItemId}}",
  seriesId: "{{SeriesId}}",
  seriesName: "{{SeriesName}}",
  season: "{{SeasonNumber}}",
  episode: "{{EpisodeNumber}}",
  playedToCompletion: "{{PlayedToCompletion}}",
  played: "{{Played}}",
  saveReason: "{{SaveReason}}",
  userId: "{{UserId}}",
  username: "{{NotificationUsername}}"
};

const pick = (body, ...names) => {
  for (const name of names) {
    if (body?.[name] !== undefined && body[name] !== null && body[name] !== "") return body[name];
  }
  return undefined;
};

const truthy = value => value === true || /^(true|1|yes)$/i.test(String(value ?? ""));

// Reads the payload into one shape whatever the template's casing. Unknown or partial payloads
// come back with what could be read and are refused later with a reason, not a crash.
export function parsePayload(body) {
  return {
    event: String(pick(body, "event", "NotificationType", "notificationType") ?? "").trim(),
    itemType: String(pick(body, "itemType", "ItemType") ?? "").trim(),
    itemId: String(pick(body, "itemId", "ItemId") ?? "").trim(),
    seriesId: String(pick(body, "seriesId", "SeriesId") ?? "").trim(),
    seriesName: String(pick(body, "seriesName", "SeriesName") ?? "").trim(),
    userId: String(pick(body, "userId", "UserId") ?? "").trim(),
    playedToCompletion: truthy(pick(body, "playedToCompletion", "PlayedToCompletion")),
    played: truthy(pick(body, "played", "Played")),
    saveReason: String(pick(body, "saveReason", "SaveReason") ?? "").trim()
  };
}

// Which events mean "this episode is now watched". PlaybackStop only when the plugin says it ran to
// the end; UserDataSaved when it was the played flag being set (Jellyfin's own "mark played").
export function finishedEpisode(payload) {
  if (payload.itemType && payload.itemType !== "Episode") return false;
  if (payload.event === "PlaybackStop") return payload.playedToCompletion;
  if (payload.event === "UserDataSaved" || payload.event === "ItemMarkedPlayed") {
    return payload.played && (!payload.saveReason || payload.saveReason === "TogglePlayed");
  }
  return false;
}

// One AniList entry for a Jellyfin series, or null with the reason. Provider ids only.
async function anilistFor(seriesId) {
  const index = await jellyfin.seriesIndex();
  const entry = index.byId.get(seriesId);
  if (!entry) return { anime: null, reason: "series-not-in-jellyfin-index" };

  if (entry.anilistId) {
    const anime = await anilist.byId(entry.anilistId);
    return anime ? { anime, via: "anilist" } : { anime: null, reason: "anilist-id-unknown" };
  }

  if (entry.anidbId && enabled.shoko) {
    const shokoIndex = await shoko.seriesIndex();
    const series = shokoIndex.byAnidb.get(entry.anidbId);
    const mal = series?.malIds?.[0];
    if (mal) {
      const anime = await anilist.byMalId(mal);
      if (anime) return { anime, via: "anidb" };
    }
    return { anime: null, reason: "anidb-id-has-no-anilist-entry" };
  }

  // A TvDB or title match can be a whole multi-season series; refused for the same reason the
  // mark-played route refuses it.
  return { anime: null, reason: "series-not-scoped-to-one-entry" };
}

// Serialised per series: Jellyfin can fire PlaybackStop and UserDataSaved for the same episode a
// moment apart, and two saves racing would both read the old progress.
const inflight = new Map();

export async function handle(body) {
  const payload = parsePayload(body);
  const base = { event: payload.event || "unknown", itemId: payload.itemId || null, seriesId: payload.seriesId || null };

  if (payload.event === "Test" || (!payload.event && !payload.itemId)) {
    return { ok: true, ...base, note: "webhook reachable", scrobbling: config.anilist.scrobble && config.anilist.allowWrites };
  }
  if (!finishedEpisode(payload)) return { ok: true, ...base, ignored: true, reason: "not-a-finished-episode" };

  if (!config.anilist.scrobble) return { ok: true, ...base, ignored: true, reason: "scrobbling-off" };
  if (!config.anilist.allowWrites) return { ok: true, ...base, ignored: true, reason: "anilist-writes-off" };
  if (!enabled.anilistList) return { ok: true, ...base, ignored: true, reason: "anilist-token-missing" };
  if (!enabled.jellyfin) return { ok: true, ...base, ignored: true, reason: "jellyfin-not-configured" };
  if (!payload.seriesId || !payload.itemId) return { ok: true, ...base, ignored: true, reason: "no-series-or-item-id" };

  const key = payload.seriesId;
  const previous = inflight.get(key) || Promise.resolve();
  // A failed earlier save must not take the next event down with it.
  const run = previous
    .catch(() => {})
    .then(() => scrobble(payload, base))
    .finally(() => {
    if (inflight.get(key) === run) inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

async function scrobble(payload, base) {
  // Only the user Hikari reads progress for. The plugin sends the watcher's id on every playback
  // event; one without it cannot be attributed, so it is not written either.
  if (!payload.userId) return { ok: true, ...base, ignored: true, reason: "no-jellyfin-user" };
  const user = await jellyfin.userId();
  if (payload.userId !== user) return { ok: true, ...base, ignored: true, reason: "another-jellyfin-user" };

  const { anime, via, reason } = await anilistFor(payload.seriesId);
  if (!anime) return { ok: true, ...base, ignored: true, reason };

  // The play just happened, so whatever Jellyfin progress is cached is already wrong.
  invalidate("jellyfin:");
  const items = await jellyfin.episodeItems([payload.seriesId]);
  // The item's own episode number where it can be read as AniList's, its position in the run where
  // it cannot. Position alone reads a season whose first files are missing short by exactly the
  // gap, which then refuses every later episode as already-past.
  const progress = jellyfin.progressForItem(items, payload.itemId, anime.episodes);
  if (progress === null) return { ok: true, ...base, anilistId: anime.id, ignored: true, reason: "episode-not-in-series-run" };

  const entry = await anilistList.entryFor(anime.id);
  const current = entry?.progress ?? 0;
  if (progress <= current) {
    return { ok: true, ...base, anilistId: anime.id, title: anime.title.display, via, ignored: true, reason: "already-at-or-past", progress: current };
  }

  const finished = Boolean(anime.episodes) && progress >= anime.episodes;
  // A rewatch stays a rewatch; anything else that is being watched is CURRENT until the last one.
  const status = finished ? "COMPLETED" : entry?.status === "REPEATING" ? "REPEATING" : "CURRENT";

  const saved = await anilistList.saveEntry({ mediaId: anime.id, progress, status });
  console.log(`[hikari] jellyfin hook: ${anime.title.display} -> AniList progress ${progress}${finished ? ", completed" : ""} (via ${via})`);
  return {
    ok: true,
    ...base,
    anilistId: anime.id,
    title: anime.title.display,
    via,
    updated: true,
    from: current,
    progress: saved.progress,
    status: saved.status
  };
}
