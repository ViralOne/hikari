import { config, enabled } from "./config.js";
import * as qbit from "./qbit.js";
import * as radarr from "./radarr.js";
import * as sonarr from "./sonarr.js";

// The fake release guard.
//
// Public trackers carry uploads named exactly like a real episode ("Show S01E05 Title 1080p WEB
// H264-GROUP") that contain an installer instead of a video. Nothing can tell them apart before
// downloading: the indexer only shows the name, and the name is copied. qBittorrent's excluded
// file names keep the executable off the disk, but the download then sits in Sonarr's queue as
// "No files found are eligible for import", forever, and Sonarr never looks for the real release.
// Seen with VisionQuest: four of eight episodes stuck like that for weeks.
//
// So every few minutes each queued download's file list is checked. One that has no real video and
// carries an executable or a bare archive is removed, blocklisted, and Sonarr or Radarr search again at once. If the
// real release is not out yet, their normal RSS sync grabs it when it appears.

const VIDEO = /\.(mkv|mp4|m4v|avi|ts|m2ts|webm|mov|wmv)$/i;
const DANGEROUS = /\.(exe|scr|lnk|bat|cmd|msi|com|pif|vbs|js|jse|wsf|ps1|jar|apk|dll|hta|reg)$/i;
// Fakes sometimes add a short clip so the torrent "has a video". Anything this small is not an episode.
const SAMPLE_BYTES = 80 * 1024 * 1024;

// Episodes do not come zipped. A zip, 7z or iso in place of the video is the other common fake (two
// different shows "released" as archives of exactly 1341.8 MB), and Sonarr cannot import it either
// way. RAR is left out on purpose: scene releases still ship as .rar/.r00 sets.
const ARCHIVE = /\.(zip|7z|iso|img)$/i;

// Pure, so it can be tested: is this file list a fake release?
export function isFakeRelease(files) {
  if (!Array.isArray(files) || files.length === 0) return { fake: false, reason: "no file list yet" };
  const videos = files.filter(file => VIDEO.test(file.name) && !DANGEROUS.test(file.name) && file.size >= SAMPLE_BYTES);
  if (videos.length > 0) return { fake: false, reason: "has a real video" };
  const bad = files.filter(file => DANGEROUS.test(file.name) || ARCHIVE.test(file.name));
  if (bad.length === 0) return { fake: false, reason: "no executable or archive" };
  return { fake: true, reason: `no video, only ${bad.map(file => file.name.split("/").pop()).slice(0, 2).join(", ")}` };
}

let last = { at: null, checked: 0, rejected: [], errors: [] };
const history = [];
let timer = null;
let running = false;

export function status() {
  return { enabled: config.fakeGuard.enabled, intervalMinutes: config.fakeGuard.intervalMinutes, running, last, recent: history.slice(-20) };
}

async function sweepApp(app, records) {
  const rejected = [];
  const errors = [];
  let checked = 0;
  for (const record of records) {
    // Only qBittorrent downloads; the download id is the torrent hash.
    if (record.protocol !== "torrent" || !record.downloadId) continue;
    checked += 1;
    try {
      const verdict = isFakeRelease(await qbit.files(record.downloadId.toLowerCase()));
      if (!verdict.fake) continue;
      await (app === "sonarr" ? sonarr : radarr).rejectQueueItem(record.id);
      const item = { app, title: record.title, reason: verdict.reason, at: new Date().toISOString() };
      rejected.push(item);
      history.push(item);
      console.log(`[hikari] fake release removed (${app}): ${record.title}: ${verdict.reason}`);
    } catch (err) {
      // A torrent qBittorrent no longer has answers 404; that is Sonarr's to notice, not ours.
      if (err.status !== 404) errors.push({ app, title: record.title, error: err.message });
    }
  }
  return { rejected, errors, checked };
}

export async function sweep() {
  if (running || !enabled.qbit) return last;
  running = true;
  try {
    const results = [];
    if (enabled.sonarr) results.push(await sweepApp("sonarr", await sonarr.queueRecords().catch(() => [])));
    if (enabled.radarr) results.push(await sweepApp("radarr", await radarr.queueRecords().catch(() => [])));
    last = {
      at: new Date().toISOString(),
      checked: results.reduce((sum, r) => sum + r.checked, 0),
      rejected: results.flatMap(r => r.rejected),
      errors: results.flatMap(r => r.errors)
    };
    history.splice(0, Math.max(0, history.length - 100));
    return last;
  } finally {
    running = false;
  }
}

export function start() {
  if (!config.fakeGuard.enabled || timer || !enabled.qbit || !(enabled.sonarr || enabled.radarr)) return;
  const every = config.fakeGuard.intervalMinutes * 60 * 1000;
  console.log(`[hikari] fake release guard every ${config.fakeGuard.intervalMinutes}m`);
  const tick = () => sweep().catch(err => console.error(`[hikari] fake release guard failed: ${err.message}`));
  setTimeout(tick, 60 * 1000).unref?.();
  timer = setInterval(tick, every);
  timer.unref?.();
}
