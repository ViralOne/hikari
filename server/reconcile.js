import * as anilist from "./anilist.js";
import * as sonarr from "./sonarr.js";
import { courEpisodes, narrowingKind } from "./cours.js";
import { enabled } from "./config.js";

// Jellyseerr can only ask for what TMDB knows about, and for a lot of anime TMDB knows about one
// season where Sonarr has three. Requesting "season 1" of The Apothecary Diaries then monitors the
// first cour, whatever cour was actually wanted. See cours.js for why that cannot be fixed by
// picking a better season number.
//
// So the request goes through Jellyseerr as normal -- that is what keeps the request list and the
// duplicate checks working -- and this module immediately corrects Sonarr afterwards:
//
//   1. wait for Jellyseerr to add the series
//   2. work out which episodes the AniList entry actually means
//   3. monitor exactly those, unmonitor the rest, and narrow season monitoring to match
//   4. remove anything Jellyseerr already grabbed for a season nobody asked for
//   5. search for the episodes that were wanted
//
// Step 4 exists because Jellyseerr starts a search the moment it adds the series, so a wrong-season
// grab can be in flight before step 3 lands. It is the only place Hikari deletes anything.

// Jellyseerr's search does not finish when the request response does. Observed on a real request:
// twelve season-1 grabs landed across a 44-second window, and the MissingEpisodeSearch behind them
// was still running two minutes in. A single sweep four seconds after the monitoring change removed
// the grabs that existed at that instant, reported "removed 12", and left everything that arrived
// afterwards -- so the queue has to be swept repeatedly, and the search cancelled at the source.
const QUEUE_SETTLE_MS = 4000;
// 4s + 9 x 5s covers a little over the 44-second grab window that was actually observed. The wanted
// episodes are searched only after the last pass, so our own search is never cancelled by a sweep.
const QUEUE_SWEEP_PASSES = 5;
const QUEUE_SWEEP_INTERVAL_MS = 5000;

// Exported so a test can pin it: shrinking the initial sweep is how the "removed 12, twelve still
// downloading" bug returns.
export const QUEUE_SWEEP_WINDOW_MS = QUEUE_SETTLE_MS + (QUEUE_SWEEP_PASSES - 1) * QUEUE_SWEEP_INTERVAL_MS;

// No fixed window is enough, and this was learned the hard way twice. Sonarr's MissingEpisodeSearch
// does not grab as it goes: one measured run started at 14:00:43, ran for eleven minutes, and pushed
// eight grabs in a fourteen-second burst at the end -- long after a fifty-second sweep had finished
// and reported success. Unmonitoring the episodes does not stop it either, because the command fixed
// its episode list when it started.
//
// So the sweep cannot be timed, it has to be tied to the thing causing it: keep sweeping while a
// search for this series is running, and for a short grace period after it clears. The cap exists
// only so this cannot run forever.
const GUARD_INTERVAL_MS = 5000;
const GUARD_GRACE_CHECKS = 4;
export const GUARD_MAX_MS = 20 * 60 * 1000;

export async function narrowAfterRequest({ anime, tmdbId, tvdbId, whole = false }) {
  if (!enabled.sonarr) return { applied: false, reason: "sonarr-not-configured" };

  const series = await sonarr.waitForSeries({
    tmdbId,
    tvdbId,
    // Sonarr does not always record a tmdbId, so fall back to the title matcher the rest of Hikari
    // uses. Without this those series skip narrowing and keep whatever season Jellyseerr chose.
    fallback: () => sonarr.findMatch(anime, null)
  });
  if (!series) return { applied: false, reason: "series-not-in-sonarr" };

  // Jellyseerr only monitors the TMDB season it was given, which on a lumped show is one of several
  // Sonarr seasons. Asking for the whole series still needs correcting, just in the other direction.
  return whole ? monitorWholeSeries({ anime, series }) : narrowSeries({ anime, series });
}

// Waiting for Sonarr to add the series takes up to 25 seconds and the queue needs a few more to
// settle, which is far too long to hold the request response open. So the narrowing runs detached
// and reports through here; the detail route carries the result back on the next poll.
//
// Bounded because it is keyed by AniList id from a request body. Entries are read once by the UI
// and are worthless after that.
const RUNS = new Map();
const MAX_RUNS = 50;
const RUN_TTL_MS = 10 * 60 * 1000;

export function statusFor(anilistId) {
  const run = RUNS.get(Number(anilistId));
  if (!run) return null;
  if (Date.now() - run.at > RUN_TTL_MS) {
    RUNS.delete(Number(anilistId));
    return null;
  }
  // guardWith holds Sets of Sonarr ids for the background sweep. They serialise as {} and are of no
  // use to a client, so they never leave the server.
  const { guardWith: _internal, ...result } = run.result || {};
  return { ...run, result: run.result ? result : undefined };
}

export function startNarrowing({ anime, tmdbId, tvdbId, whole = false }) {
  const key = Number(anime.id);

  if (RUNS.size >= MAX_RUNS) {
    const oldest = [...RUNS.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) RUNS.delete(oldest[0]);
  }

  RUNS.set(key, { state: "running", at: Date.now() });

  narrowAfterRequest({ anime, tmdbId, tvdbId, whole })
    .then(result => {
      RUNS.set(key, { state: "done", at: Date.now(), result, guard: result.guardWith ? "watching" : null });
      if (result.guardWith) watchQueue(key, result.guardWith);
    })
    .catch(err => RUNS.set(key, { state: "failed", at: Date.now(), error: err.message }));

  return { started: true };
}

// Jellyseerr's search can push grabs minutes after the narrowing finished, so the run record keeps
// being updated after it is first reported as done. The panel reads the same record, so a late
// removal shows up on its next poll rather than being lost.
export function watchQueue(key, guardWith) {
  guardQueue({
    ...guardWith,
    onRemoved: items => {
      const run = RUNS.get(key);
      if (!run?.result) return;
      run.result.removedFromQueue = [...(run.result.removedFromQueue || []), ...items];
      run.at = Date.now();
    }
  })
    .then(outcome => {
      const run = RUNS.get(key);
      if (run) {
        run.guard = outcome;
        run.at = Date.now();
      }
    })
    .catch(() => {
      const run = RUNS.get(key);
      if (run) run.guard = "failed";
    });
}

// Split out so the season picker can reuse everything except the season decision.
//
// `apply` follows the convention POST /api/sonarr/missing/:anilistId already uses in this codebase:
// without it nothing is written and the return value describes exactly what would be. Anything that
// unmonitors episodes and deletes downloads should be inspectable before it runs.
// `mode` is what the user actually meant:
//
//   exclusive  this cour and nothing else. Unmonitors the rest, cancels Jellyseerr's search and
//              sweeps the queue, because anything else in flight is unwanted. The default, and what
//              a fresh request for one cour needs.
//   add        this cour as well. Touches nothing that is already monitored, and does not go near
//              the queue: nothing in it is unwanted, so there is nothing to delete.
//
// Requesting a second cour of a lumped show has to be `add`, and cannot go through Jellyseerr at all:
// Jellyseerr already counts the whole show as requested, so it has nothing left to offer.
export async function narrowSeries({ anime, series, seasonNumber = null, apply = true, mode = "exclusive" }) {
  const episodes = await sonarr.episodes(series.id);
  if (episodes.length === 0) return { applied: false, reason: "no-episodes-yet", seriesId: series.id };

  const withDepth = { ...anime, prequelDepth: await anilist.prequelDepth(anime.id).catch(() => null) };

  const target = seasonNumber === null ? courEpisodes(withDepth, episodes) : forceSeason(episodes, seasonNumber);

  if (!target) {
    return {
      applied: false,
      reason: "cannot-map-cour",
      seriesId: series.id,
      seriesTitle: series.title,
      seasons: describeSeasons(episodes)
    };
  }

  const additive = mode === "add";

  const wanted = new Set(target.matched.map(episode => episode.id));
  const rest = episodes.filter(episode => episode.seasonNumber > 0 && !wanted.has(episode.id));

  // Seasons that already have files are left alone. They predate this request, so switching their
  // monitoring off would be a side effect of asking for a different cour -- and the wrong-season
  // download risk this flow exists to stop only applies to seasons with nothing in them.
  const held = new Set(
    episodes
      .filter(episode => episode.hasFile && episode.seasonNumber > 0)
      .map(episode => episode.seasonNumber)
      .filter(number => number !== target.seasonNumber)
  );

  // Episodes already on disk are left monitored: unmonitoring them is what makes Sonarr forget it
  // has them. Episodes in a season the user is already managing are left alone for the same reason
  // the season itself is.
  const toUnmonitor = rest
    .filter(episode => episode.monitored && !episode.hasFile && !held.has(episode.seasonNumber))
    .map(episode => episode.id);

  // Searching for an episode that has not aired spends an indexer call to find nothing. Sonarr will
  // pick them up from its own RSS sync once they air, which is what monitoring them is for.
  const today = new Date().toISOString().slice(0, 10);
  const searchable = target.matched
    .filter(episode => episode.airDate && episode.airDate <= today && !episode.hasFile)
    .map(episode => episode.id);

  const numbers = target.matched.map(episode => episode.absoluteEpisodeNumber ?? episode.episodeNumber);
  const plan = {
    mode,
    seriesId: series.id,
    seriesTitle: series.title,
    seasonNumber: target.seasonNumber,
    via: target.via,
    confidence: target.confidence,
    episodes: {
      count: target.matched.length,
      first: Math.min(...numbers),
      last: Math.max(...numbers),
      label: `S${String(target.seasonNumber).padStart(2, "0")}E${String(target.matched[0].episodeNumber).padStart(2, "0")}-E${String(target.matched[target.matched.length - 1].episodeNumber).padStart(2, "0")}`
    },
    clamped: target.clamped,
    wholeSeason: target.wholeSeason,
    keptSeasons: [...held].sort((a, b) => a - b),
    unmonitoredEpisodes: additive ? 0 : toUnmonitor.length,
    searchable: searchable.length
  };

  if (!apply) {
    const wouldRemove = additive ? [] : await unwantedQueueItems(series.id, target.seasonNumber, wanted, held);
    return {
      applied: false,
      reason: "not-confirmed",
      plan: {
        ...plan,
        // Derived from the episode list rather than series.seasons, which the shape callers hold
        // does not carry. A season counts as monitored when any of its episodes is.
        unmonitoredSeasons: additive
          ? []
          : [
              ...new Set(
                rest
                  .filter(
                    episode =>
                      episode.monitored && episode.seasonNumber > 0 && !held.has(episode.seasonNumber)
                  )
                  .map(episode => episode.seasonNumber)
              )
            ].sort((a, b) => a - b),
        removedFromQueue: wouldRemove.map(describeQueueItem)
      }
    };
  }

  // Adding a cour has nothing to fight: no search to stop, nothing unwanted in the queue.
  const searches = additive ? { stopped: [], stillRunning: [] } : await cancelSearches(series.id);

  // Order matters. Season monitoring is narrowed first because it is what Sonarr's own searches
  // read: leaving other seasons monitored lets Sonarr pull them in later regardless of what the
  // episode flags say. seriesType rides along in the same PUT so the two cannot clobber each other.
  const seasons = additive
    ? await sonarr.addSeason(series.id, target.seasonNumber, { seriesType: "anime" })
    : await sonarr.keepOnlySeason(series.id, target.seasonNumber, { keep: [...held], seriesType: "anime" });

  if (!additive) await sonarr.setEpisodeMonitoring(toUnmonitor, false);
  await sonarr.setEpisodeMonitoring([...wanted], true);

  const removed = additive ? [] : await cleanQueue(series.id, target.seasonNumber, wanted, held);

  const search = searchable.length
    ? await sonarr.searchEpisodes(searchable).catch(err => ({ commandId: null, error: err.message }))
    : { commandId: null, skipped: "nothing-aired-yet" };

  return {
    applied: true,
    ...plan,
    unmonitoredSeasons: seasons.unmonitored,
    seriesType: seasons.seriesType,
    // Everything the queue guard needs to carry on sweeping after this returns. The initial sweep
    // only covers the first twenty seconds; Jellyseerr's search can grab minutes later.
    guardWith: additive
      ? null
      : { seriesId: series.id, seasonNumber: target.seasonNumber, wantedIds: wanted, heldSeasons: held },
    cancelledSearches: searches.stopped,
    // A search Sonarr would not cancel keeps running, but it stops grabbing once the episodes are
    // unmonitored. Reported so the panel does not have to pretend it was stopped.
    searchesStillRunning: searches.stillRunning,
    removedFromQueue: removed,
    search
  };
}

// Keeps sweeping until Sonarr is no longer searching this series and the queue has stayed clean for
// a few checks. Runs detached: it can legitimately take many minutes, which is far longer than any
// request should be held open, so progress is reported through the run record instead.
export async function guardQueue({ seriesId, seasonNumber, wantedIds, heldSeasons, onRemoved }) {
  const deadline = Date.now() + GUARD_MAX_MS;
  let clearChecks = 0;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, GUARD_INTERVAL_MS));

    const running = await sonarr.runningSearchesFor(seriesId).catch(() => []);
    if (running.length > 0) {
      // Still only a head start -- Sonarr refuses to cancel a started search -- but a search that is
      // merely queued can be stopped here before it ever grabs anything.
      await cancelSearches(seriesId);
      clearChecks = 0;
    } else {
      clearChecks += 1;
    }

    const unwanted = await unwantedQueueItems(seriesId, seasonNumber, wantedIds, heldSeasons).catch(() => []);
    if (unwanted.length > 0) {
      await sonarr.removeQueueItems(unwanted.map(item => item.id)).catch(() => null);
      onRemoved(unwanted.map(describeQueueItem));
      clearChecks = 0;
    }

    if (running.length === 0 && clearChecks >= GUARD_GRACE_CHECKS) return "settled";
  }

  return "timed-out";
}

// Cancelling is safe to repeat: a search that has already finished is simply not in the list.
//
// Only queued commands can actually be cancelled -- Sonarr answers 409 for one that has started, and
// the search Jellyseerr fires has invariably started by the time Hikari gets here. So this is a
// best-effort head start, not the defence: the repeated queue sweep is what actually holds the line,
// and only searches that really stopped are reported as stopped.
async function cancelSearches(seriesId) {
  const running = await sonarr.runningSearchesFor(seriesId).catch(() => []);
  const stopped = [];

  for (const command of running) {
    const result = await sonarr.cancelCommand(command.id);
    if (result.cancelled) stopped.push(command.name);
  }

  return { stopped, stillRunning: running.filter(c => !stopped.includes(c.name)).map(c => c.name) };
}

// The whole series, deliberately skipping every cour decision. Used when the answer to "which cour"
// is "all of them", which the narrowing would otherwise actively undo.
//
// Nothing is unmonitored and nothing is deleted, so there is no queue sweep and no search to cancel:
// everything Jellyseerr grabbed is wanted. Specials stay however the user had them.
export async function monitorWholeSeries({ anime, series, apply = true }) {
  const episodes = await sonarr.episodes(series.id);
  if (episodes.length === 0) return { applied: false, reason: "no-episodes-yet", seriesId: series.id };

  const real = episodes.filter(episode => episode.seasonNumber > 0);
  const today = new Date().toISOString().slice(0, 10);
  const searchable = real.filter(e => e.airDate && e.airDate <= today && !e.hasFile).map(e => e.id);
  const seasonNumbers = [...new Set(real.map(e => e.seasonNumber))].sort((a, b) => a - b);

  const plan = {
    mode: "whole",
    seriesId: series.id,
    seriesTitle: series.title,
    seasonNumber: null,
    via: "whole-series",
    confidence: 1,
    episodes: {
      count: real.length,
      first: Math.min(...real.map(e => e.absoluteEpisodeNumber ?? e.episodeNumber)),
      last: Math.max(...real.map(e => e.absoluteEpisodeNumber ?? e.episodeNumber)),
      label: `every season (${seasonNumbers.join(", ")})`
    },
    clamped: false,
    wholeSeason: true,
    keptSeasons: [],
    unmonitoredSeasons: [],
    unmonitoredEpisodes: 0,
    searchable: searchable.length,
    removedFromQueue: []
  };

  if (!apply) return { applied: false, reason: "not-confirmed", plan };

  const seasons = await sonarr.monitorAllSeasons(series.id, { seriesType: "anime" });
  await sonarr.setEpisodeMonitoring(real.map(e => e.id), true);

  const search = searchable.length
    ? await sonarr.searchEpisodes(searchable).catch(err => ({ commandId: null, error: err.message }))
    : { commandId: null, skipped: "nothing-aired-yet" };

  return {
    applied: true,
    ...plan,
    monitoredSeasons: seasons.monitored,
    seriesType: seasons.seriesType,
    cancelledSearches: [],
    searchesStillRunning: [],
    search
  };
}

// A season the user picked by hand. Still routed through the same code so the result is described
// the same way, but the air date no longer gets a say.
function forceSeason(episodes, seasonNumber) {
  const season = episodes.filter(episode => episode.seasonNumber === Number(seasonNumber));
  if (season.length === 0) return null;

  return {
    seasonNumber: Number(seasonNumber),
    matched: season,
    via: "chosen",
    confidence: 1,
    clamped: false,
    wholeSeason: true
  };
}

// Everything Jellyseerr grabbed for a season that was not asked for. This function deletes real
// downloads, so it is deliberately narrow about what counts as unwanted:
//
//   - an item whose episode Sonarr cannot identify has no season number, so there is no evidence
//     against it and it is left alone
//   - an item for a season the user already holds files for is theirs, not something this request
//     started, so it is left alone too
async function unwantedQueueItems(seriesId, seasonNumber, wantedIds, heldSeasons) {
  const queue = await sonarr.queueForSeries(seriesId).catch(() => []);
  return queue.filter(
    item =>
      item.seasonNumber !== null &&
      item.seasonNumber !== seasonNumber &&
      !heldSeasons.has(item.seasonNumber) &&
      !(item.episodeId && wantedIds.has(item.episodeId))
  );
}

function describeQueueItem(item) {
  return { season: item.seasonNumber, episode: item.episodeNumber, title: item.title };
}

// Swept repeatedly rather than once, because grabs keep arriving for as long as Sonarr is still
// searching. Each pass also re-cancels: Sonarr can start a fresh search of its own between passes,
// and one that begins after the first cancellation would otherwise refill the queue unopposed.
//
// Bounded by design. If something is still grabbing after the last pass it is reported rather than
// chased forever, because this function deletes downloads and must not run unattended.
async function cleanQueue(seriesId, seasonNumber, wantedIds, heldSeasons) {
  const removed = [];
  const seen = new Set();

  for (let pass = 0; pass < QUEUE_SWEEP_PASSES; pass += 1) {
    await new Promise(resolve => setTimeout(resolve, pass === 0 ? QUEUE_SETTLE_MS : QUEUE_SWEEP_INTERVAL_MS));

    if (pass > 0) await cancelSearches(seriesId);

    const unwanted = await unwantedQueueItems(seriesId, seasonNumber, wantedIds, heldSeasons);
    if (unwanted.length === 0) continue;

    await sonarr.removeQueueItems(unwanted.map(item => item.id)).catch(() => null);

    for (const item of unwanted) {
      // The same episode can be grabbed twice from different releases, so dedupe on the queue id.
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      removed.push(describeQueueItem(item));
    }
  }

  return removed;
}

function describeSeasons(episodes) {
  const bySeason = new Map();

  for (const episode of episodes) {
    if (episode.seasonNumber <= 0) continue;
    const entry = bySeason.get(episode.seasonNumber) || { seasonNumber: episode.seasonNumber, episodes: [] };
    entry.episodes.push(episode);
    bySeason.set(episode.seasonNumber, entry);
  }

  return [...bySeason.values()]
    .sort((a, b) => a.seasonNumber - b.seasonNumber)
    .map(entry => {
      const sorted = entry.episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
      return {
        seasonNumber: entry.seasonNumber,
        episodeCount: sorted.length,
        firstAirDate: sorted.find(episode => episode.airDate)?.airDate ?? null,
        onDisk: sorted.filter(episode => episode.hasFile).length,
        // What Sonarr will actually fetch. This is the real state of a request for a lumped show,
        // where Jellyseerr can only ever say "season 1 is requested" about the whole thing.
        monitored: sorted.filter(episode => episode.monitored).length
      };
    });
}

// Whether a request for this entry needs the narrowing at all. Answered before the request is sent
// so the UI can say what is about to happen.
//
// The Sonarr side is the better signal but is only available once the series exists, so a show
// being requested for the first time falls back to the prequel chain: TMDB offering one season for
// something AniList calls a third season is lumped by definition.
export async function inspect({ anime, tmdbSeasons, library }) {
  if (!enabled.sonarr) return null;

  let episodes = [];
  if (library?.id) episodes = await sonarr.episodes(library.id).catch(() => []);

  const depth = await anilist.prequelDepth(anime.id).catch(() => null);
  const target = episodes.length > 0 ? courEpisodes({ ...anime, prequelDepth: depth }, episodes) : null;

  const kind = narrowingKind({ tmdbSeasons, sonarrEpisodes: episodes, prequelDepth: depth, target });
  if (!kind) return null;

  return {
    lumped: true,
    // Which disagreement this is, so the UI can explain the right one.
    kind,
    tmdbSeasons: (tmdbSeasons || []).filter(season => season.seasonNumber > 0).length,
    sonarrSeasons: episodes.length > 0 ? new Set(episodes.map(e => e.seasonNumber).filter(n => n > 0)).size : null,
    prequelDepth: depth,
    // Null when the series is not in Sonarr yet, which is normal for a first request: the target is
    // resolved after Jellyseerr adds it.
    target: target
      ? {
          seasonNumber: target.seasonNumber,
          via: target.via,
          episodeCount: target.matched.length,
          wholeSeason: target.wholeSeason
        }
      : null,
    seasons: episodes.length > 0 ? describeSeasons(episodes) : null,
    // Whether Sonarr already holds the series decides what the panel can offer: once it does,
    // another cour is a monitoring change rather than a Jellyseerr request, which Jellyseerr would
    // refuse anyway now that it counts the whole show as requested.
    inSonarr: episodes.length > 0
  };
}
