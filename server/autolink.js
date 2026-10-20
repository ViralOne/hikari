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
// aired on that date. When several did (a double premiere), the episode title has to match
// exactly one of them instead. And once AniDB has matched any file of the season by hash, that
// match fixes how the two sides number it, and the number decides instead of the date.
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
//
// `offset`, when known, is how AniDB numbers this season relative to Sonarr, proven by files AniDB
// itself matched (see numberingOffset). It wins over the air date, because TVDB and AniDB dates
// for the same episode can sit a week apart, and then the date picks the wrong episode outright.
export function resolveEpisode(sonarrEpisode, anidbEpisodes, { offset = null } = {}) {
  if (!sonarrEpisode) return { reason: "Sonarr has no episode with that file path" };

  if (Number.isInteger(offset)) {
    const number = sonarrEpisode.episodeNumber + offset;
    const target = (anidbEpisodes || []).find(item => item.episode === number);
    if (!target) return { reason: `AniDB has no episode ${number} for S${sonarrEpisode.seasonNumber}E${sonarrEpisode.episodeNumber}` };
    if (target.hasFile) return { reason: `AniDB episode ${number} already has a file` };
    if (!target.shokoEpisodeId) return { reason: "Shoko reported no episode id" };
    return { episode: target, via: "numbering" };
  }

  if (!sonarrEpisode.airDate) {
    return { reason: `Sonarr has no air date for S${sonarrEpisode.seasonNumber}E${sonarrEpisode.episodeNumber}` };
  }

  const targets = (anidbEpisodes || []).filter(
    item => !item.hasFile && withinADay(item.airDate, sonarrEpisode.airDate)
  );

  if (targets.length === 0) return { reason: `no unfilled AniDB episode aired on ${sonarrEpisode.airDate}` };

  let target = targets[0];
  if (targets.length > 1) {
    // A double premiere or a batch drop puts several episodes on one date. The air date alone
    // cannot split them, but an episode title both sides agree on exactly can.
    target = pickByTitle(sonarrEpisode.title, targets, item => item.titles);
    if (!target) {
      return {
        reason: `${targets.length} unfilled AniDB episodes aired on ${sonarrEpisode.airDate} and no title matches exactly`
      };
    }
  }
  if (!target.shokoEpisodeId) return { reason: "Shoko reported no episode id" };

  return { episode: target, via: "air date" };
}

// Anchors are the episodes of one Sonarr season whose files AniDB matched by hash:
// { episodeNumber, shokoSeriesId, shokoEpisodeId }. They settle two things the ids and dates
// cannot.
//
// Which Shoko series the season is. AniDB gives every season its own entry and does not always
// record a TVDB id for it, and when it does, every season of the show shares that one id.
export function anchorSeries(anchors) {
  const ids = new Set(anchors.map(anchor => anchor.shokoSeriesId).filter(id => id != null));
  return ids.size === 1 ? [...ids][0] : null;
}

// And how AniDB numbers the season against Sonarr: AniDB episode minus Sonarr episode, which must
// be the same for every anchor. One disagreeing anchor (a split cour, a recap AniDB skips) and
// the numbering is not trusted at all.
export function numberingOffset(anchors, anidbEpisodes) {
  const byId = new Map((anidbEpisodes || []).map(item => [item.shokoEpisodeId, item.episode]));
  const offsets = new Set();
  for (const anchor of anchors) {
    const number = byId.get(anchor.shokoEpisodeId);
    if (!Number.isInteger(number)) return null;
    offsets.add(number - anchor.episodeNumber);
  }
  return offsets.size === 1 ? [...offsets][0] : null;
}

// Case, punctuation and spacing only. Anything fuzzier would let "Part 1" claim "Part 2".
export function episodeTitleKey(title) {
  if (!title) return "";
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Placeholders say nothing about which episode is which, and "Episode 1" means something else
// on each side when AniDB and TVDB number a season differently.
const PLACEHOLDER = /^(?:episode|ep|tba|tbd|untitled)(?: \d+)?$/;

// The one candidate whose title matches exactly, or null. `titles` is one title or several (an
// AniDB episode's languages). A title that matches more than one candidate, or a placeholder,
// is no better than the air date it is meant to settle.
export function pickByTitle(titles, candidates, titlesOf) {
  const keys = new Set(
    [titles].flat().map(episodeTitleKey).filter(key => key && !PLACEHOLDER.test(key))
  );
  if (keys.size === 0) return null;
  const hits = candidates.filter(item => [titlesOf(item)].flat().some(other => keys.has(episodeTitleKey(other))));
  return hits.length === 1 ? hits[0] : null;
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
    const episodes = await sonarr.episodes(series.id);
    const byTail = new Map();
    for (const episode of episodes) {
      const tail = shoko.pathTail(episode.relativePath);
      if (tail) byTail.set(tail, episode);
    }

    // Seasons are resolved one at a time, because each is its own series in Shoko.
    const seasons = new Map();
    for (const file of files) {
      const episode = byTail.get(shoko.pathTail(file.path));
      if (!episode) {
        skipped.push({ fileId: file.fileId, reason: "Sonarr has no episode with that file path" });
        continue;
      }
      if (!seasons.has(episode.seasonNumber)) seasons.set(episode.seasonNumber, []);
      seasons.get(episode.seasonNumber).push({ file, episode });
    }

    for (const [seasonNumber, items] of seasons) {
      const anchors = [];
      for (const episode of episodes) {
        if (episode.seasonNumber !== seasonNumber || !episode.relativePath) continue;
        const known = index.byTail.get(shoko.pathTail(episode.relativePath));
        for (const link of known?.links || []) {
          if (!link.verified) continue;
          for (const shokoEpisodeId of link.shokoEpisodeIds) {
            anchors.push({ episodeNumber: episode.episodeNumber, shokoSeriesId: link.shokoSeriesId, shokoEpisodeId });
          }
        }
      }

      // A file AniDB matched in this very season beats the TVDB bridge, which is missing for
      // some seasons and shared by all of them for others.
      const shokoId = anchorSeries(anchors) ?? shokoIndex.byTvdb.get(Number(series.tvdbId))?.shokoId ?? null;
      if (!shokoId) {
        // Nothing to link to. Shoko's series list only contains anime it has matched at least
        // one file for, so a show where every file failed has no local AniDB record and no
        // episodes to point at. Adding it needs an AniDB id, which only a title search could
        // supply, and guessing that is exactly what the id bridges exist to avoid.
        for (const { file } of items) {
          skipped.push({
            fileId: file.fileId,
            reason: `Shoko has no series for ${series.title}, so add it there once and this will link afterwards`
          });
        }
        continue;
      }

      const detail = await shoko.fileDetail(shokoId);
      const offset = numberingOffset(anchors.filter(anchor => anchor.shokoSeriesId === shokoId), detail.episodes);

      for (const { file, episode } of items) {
        const resolved = resolveEpisode(episode, detail.episodes, { offset });

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
          airDate: episode.airDate,
          via: resolved.via
        });
      }
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
