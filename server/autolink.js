import { config, enabled } from "./config.js";
import { basename, hoursSince, withinADay } from "./dates.js";
import * as jellyfin from "./jellyfin.js";
import * as shoko from "./shoko.js";
import * as sonarr from "./sonarr.js";

// Keeps Shoko's episode links in step with what Sonarr has actually imported.
//
// Shoko links a file by asking AniDB for its ED2K hash. AniDB's file database is community
// maintained, so a fresh WEB-DL from ToonsHub or VARYG frequently has no entry at all, and
// Shoko has nothing to match against, and there is no filename fallback by design. The file
// then stays unlinked, which means Shokofin never puts it in the virtual file system, which
// means Jellyfin cannot see an episode that is sitting on the disk.
//
// This closes that gap without guessing: the file is only linked when Sonarr's own record of
// that exact file path pins it to one air date, and exactly one AniDB episode without a file
// aired on that date.
//
// It deliberately waits before acting. A file AniDB has not seen yet is often registered a few
// hours later, and an AniDB match carries better metadata than a hand link, so new files are
// left alone for the grace period first.

let last = { at: null, ran: 0, linked: [], skipped: [], errors: [], scanned: false };
let running = false;
let timer = null;
let pending = null;

export function status() {
  return {
    enabled: config.autoLink.enabled,
    intervalMinutes: config.autoLink.intervalMinutes,
    graceHours: config.autoLink.graceHours,
    maxPerRun: config.autoLink.maxPerRun,
    running,
    last
  };
}

// Called by the Sonarr webhook. Shoko's own watcher usually notices a new file on its own, but
// nudging it means the hash exists by the time the sweep runs.
//
// The sweep is then scheduled for when this import's grace period expires, rather than left to
// the hourly tick. Without that the hook only affected a log line, and an import a minute after
// a tick waited the best part of two hours.
export async function onImport() {
  if (!enabled.shoko) return { queued: false, sweepAt: null };
  await shoko.runAction("import-new").catch(() => null);
  return { queued: true, sweepAt: scheduleAfterGrace() };
}

function scheduleAfterGrace() {
  if (!config.autoLink.enabled) return null;

  // A batch import fires one hook per episode, so the timer is replaced rather than stacked.
  if (pending) clearTimeout(pending);
  const delay = config.autoLink.graceHours * 60 * 60 * 1000 + 5 * 60 * 1000;
  const at = new Date(Date.now() + delay).toISOString();

  pending = setTimeout(() => {
    pending = null;
    console.log("[hikari] auto-link: running after a Sonarr import");
    sweep().catch(err => console.error(`[hikari] auto-link failed: ${err.message}`));
  }, delay);
  pending.unref?.();

  return at;
}

// The decision that matters, kept pure so it can be tested without a live stack: which AniDB
// episode, if any, a Sonarr episode's file belongs to. Anything short of exactly one candidate
// is a refusal, because the alternative is linking a file to the wrong episode permanently.
export function resolveEpisode(sonarrEpisode, anidbEpisodes) {
  if (!sonarrEpisode) return { reason: "Sonarr has no episode with that file path" };
  if (!sonarrEpisode.airDate) {
    return { reason: `Sonarr has no air date for S${sonarrEpisode.seasonNumber}E${sonarrEpisode.episodeNumber}` };
  }

  const targets = (anidbEpisodes || []).filter(
    item => !item.hasFile && withinADay(item.airDate, sonarrEpisode.airDate)
  );

  if (targets.length === 0) return { reason: `no unfilled AniDB episode aired on ${sonarrEpisode.airDate}` };
  if (targets.length > 1) {
    return { reason: `${targets.length} unfilled AniDB episodes aired on ${sonarrEpisode.airDate}` };
  }
  if (!targets[0].shokoEpisodeId) return { reason: "Shoko reported no episode id" };

  return { episode: targets[0] };
}

async function plan(maxPerRun) {
  const index = await shoko.fileIndex();
  const candidates = index.unlinkedFiles.filter(file => hoursSince(file.created) >= config.autoLink.graceHours);

  if (candidates.length === 0) {
    return { unlinked: index.unlinked, waiting: index.unlinked, actions: [], skipped: [] };
  }

  // Sonarr's series folder is the first path segment Shoko records, which is what ties an
  // unlinked file back to the series that imported it.
  const [seriesList, shokoIndex] = await Promise.all([sonarr.series(), shoko.seriesIndex()]);
  const byFolder = new Map();
  for (const series of seriesList) byFolder.set(basename(series.path).toLowerCase(), series);

  const wanted = new Map();
  const skipped = [];

  for (const file of candidates) {
    const folder = (file.path || "").replace(/\\/g, "/").split("/").filter(Boolean)[0] || "";
    const series = byFolder.get(folder.toLowerCase());
    if (!series) {
      skipped.push({ fileId: file.fileId, reason: `no Sonarr series owns the folder ${folder}` });
      continue;
    }
    if (!wanted.has(series.id)) wanted.set(series.id, { series, files: [] });
    wanted.get(series.id).files.push(file);
  }

  const actions = [];

  for (const { series, files } of wanted.values()) {
    const shokoEntry = shokoIndex.byTvdb.get(Number(series.tvdbId));
    if (!shokoEntry) {
      // Nothing to link to. Shoko's series list only contains anime it has matched at least
      // one file for, so a show where every file failed has no local AniDB record and no
      // episodes to point at. Adding it needs an AniDB id, which only a title search could
      // supply, and guessing that is exactly what the id bridges exist to avoid.
      for (const file of files) {
        skipped.push({
          fileId: file.fileId,
          reason: `Shoko has no series for ${series.title}, so add it there once and this will link afterwards`
        });
      }
      continue;
    }

    const [episodes, detail] = await Promise.all([
      sonarr.episodes(series.id),
      shoko.fileDetail(shokoEntry.shokoId)
    ]);

    const byTail = new Map();
    for (const episode of episodes) {
      const tail = shoko.pathTail(episode.relativePath);
      if (tail) byTail.set(tail, episode);
    }

    for (const file of files) {
      const episode = byTail.get(shoko.pathTail(file.path));
      const resolved = resolveEpisode(episode, detail.episodes);

      if (!resolved.episode) {
        skipped.push({ fileId: file.fileId, reason: resolved.reason });
        continue;
      }
      // Two files claiming the same episode in one sweep means something is ambiguous, so
      // neither is linked.
      if (actions.some(action => action.episodeId === resolved.episode.shokoEpisodeId)) {
        skipped.push({ fileId: file.fileId, reason: "another file already claims that episode this run" });
        continue;
      }

      actions.push({
        fileId: file.fileId,
        episodeId: resolved.episode.shokoEpisodeId,
        series: series.title,
        sonarr: `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`,
        anidbEpisode: resolved.episode.episode,
        airDate: episode.airDate
      });
    }
  }

  return {
    unlinked: index.unlinked,
    waiting: index.unlinked - candidates.length,
    actions: actions.slice(0, maxPerRun),
    truncated: actions.length > maxPerRun,
    skipped
  };
}

export async function sweep({ apply = true, maxPerRun = config.autoLink.maxPerRun } = {}) {
  if (!enabled.shoko || !enabled.sonarr) {
    return { skipped: "Shoko and Sonarr are both required for automatic linking" };
  }
  if (running) return { skipped: "a sweep is already running" };

  running = true;
  try {
    const result = await plan(maxPerRun);
    const linked = [];
    const errors = [];

    if (apply) {
      for (const action of result.actions) {
        try {
          await shoko.linkFile(action.fileId, [action.episodeId]);
          linked.push(action);
        } catch (err) {
          errors.push({ fileId: action.fileId, error: err.message });
        }
      }
    }

    // Give AniDB another go at whatever is left, so the next sweep can prefer a real match over
    // a hand link. Gated twice over: a dry run must stay read-only, and this is AniDB's UDP API,
    // which bans clients that talk to it for no reason, and an idle collection would otherwise poke
    // it every hour forever.
    if (apply && result.unlinked > linked.length) {
      await shoko.runAction("refresh-anidb").catch(() => null);
    }

    // Linking alone changes nothing a viewer can see: Shokofin only exposes the file after
    // Jellyfin scans the library.
    let scanned = false;
    if (linked.length > 0 && enabled.jellyfin) {
      scanned = await jellyfin
        .refreshLibrary()
        .then(() => true)
        .catch(err => {
          errors.push({ error: `Jellyfin scan failed: ${err.message}` });
          return false;
        });
    }

    last = {
      at: new Date().toISOString(),
      ran: result.actions.length,
      unlinked: result.unlinked,
      waiting: result.waiting,
      // Without this a dry run reports a count and nothing else, which is not much use when
      // the whole point is to see what it would touch before letting it.
      actions: apply ? undefined : result.actions,
      truncated: Boolean(result.truncated),
      linked,
      skipped: result.skipped.slice(0, 20),
      skippedTotal: result.skipped.length,
      errors,
      scanned,
      applied: apply
    };

    if (linked.length > 0) {
      console.log(
        `[hikari] auto-link: ${linked.length} file(s) linked: ` +
          linked.map(item => `${item.series} ${item.sonarr}->ep ${item.anidbEpisode}`).join(", ")
      );
    }

    return last;
  } finally {
    running = false;
  }
}

export function start() {
  if (!config.autoLink.enabled || timer) return;
  if (!enabled.shoko || !enabled.sonarr) {
    console.log("[hikari] auto-link is on but needs both Shoko and Sonarr, so it stays idle");
    return;
  }

  const every = Math.max(config.autoLink.intervalMinutes, 5) * 60 * 1000;
  console.log(
    `[hikari] auto-link every ${config.autoLink.intervalMinutes}m, ` +
      `leaving files younger than ${config.autoLink.graceHours}h to AniDB`
  );

  const tick = () => sweep().catch(err => console.error(`[hikari] auto-link failed: ${err.message}`));

  // Not immediately on boot: a restart during an import would race Shoko's own hashing.
  setTimeout(tick, 2 * 60 * 1000).unref?.();
  timer = setInterval(tick, every);
  timer.unref?.();
}

export function stop() {
  if (timer) clearInterval(timer);
  if (pending) clearTimeout(pending);
  timer = null;
  pending = null;
}

// Settings can turn the sweep on, off, or change its interval while the server is running.
// Only the interval is rebuilt: a sweep already scheduled by a Sonarr import is left alone,
// because saving an unrelated setting used to cancel it and nothing rescheduled it.
export function restart() {
  if (timer) clearInterval(timer);
  timer = null;
  if (!config.autoLink.enabled && pending) {
    clearTimeout(pending);
    pending = null;
  }
  start();
}
