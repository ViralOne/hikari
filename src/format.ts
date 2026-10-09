const FORMAT_LABEL: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "Short",
  MOVIE: "Movie",
  SPECIAL: "Special",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Music"
};

const STATUS_LABEL: Record<string, string> = {
  RELEASING: "Airing",
  FINISHED: "Finished",
  NOT_YET_RELEASED: "Unreleased",
  CANCELLED: "Cancelled",
  HIATUS: "Hiatus"
};

export const formatLabel = (value: string | null) => (value ? FORMAT_LABEL[value] || value : "—");
export const statusLabel = (value: string | null) => (value ? STATUS_LABEL[value] || value : "—");

export const seasonLabel = (season: string | null, year: number | null) => {
  if (!season) return year ? String(year) : "—";
  return `${season.charAt(0)}${season.slice(1).toLowerCase()} ${year ?? ""}`.trim();
};

export function bytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled.toFixed(scaled >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function speed(value: number) {
  return value > 0 ? `${bytes(value)}/s` : "—";
}

export function countdown(seconds: number) {
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function eta(seconds: number) {
  if (!seconds || seconds >= 8640000) return "—";
  return countdown(seconds);
}

export function clockTime(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function dayKey(unix: number) {
  const date = new Date(unix * 1000);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayLabel(unix: number) {
  const date = new Date(unix * 1000);
  const today = new Date();
  const diff = Math.round((date.setHours(12, 0, 0, 0) - today.setHours(12, 0, 0, 0)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return new Date(unix * 1000).toLocaleDateString(undefined, { weekday: "long" });
}

export function dateLabel(unix: number) {
  return new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}


export function latency(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return null;
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${rounded} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function percent(fraction: number | null | undefined) {
  if (fraction === null || fraction === undefined) return null;
  return `${Math.round(fraction * 100)}%`;
}

export type StateTone = "ok" | "busy" | "idle" | "warn" | "bad";
export type StateLabel = { label: string; tone: StateTone; hint: string };

// qBittorrent's internal state names ("queuedUP", "stalledDL") mean nothing to most people. Each
// gets a plain label, a tone for the status dot, and a one-line hint shown on hover together with
// the raw name, which is kept for anyone matching it against qBittorrent itself.
const TORRENT_STATES: Record<string, StateLabel> = {
  uploading: { label: "Seeding", tone: "ok", hint: "Finished and sharing with other peers." },
  forcedUP: { label: "Seeding (forced)", tone: "ok", hint: "Finished and seeding regardless of queue limits." },
  stalledUP: { label: "Seeding, no peers", tone: "idle", hint: "Finished and ready to share, but nobody is downloading it right now." },
  queuedUP: { label: "Waiting to seed", tone: "idle", hint: "Finished. Queued behind other torrents for an upload slot." },
  pausedUP: { label: "Finished", tone: "idle", hint: "Downloaded and stopped; not seeding." },
  stoppedUP: { label: "Finished", tone: "idle", hint: "Downloaded and stopped; not seeding." },
  checkingUP: { label: "Checking files", tone: "busy", hint: "Verifying the downloaded data." },
  downloading: { label: "Downloading", tone: "busy", hint: "Receiving data from peers." },
  forcedDL: { label: "Downloading (forced)", tone: "busy", hint: "Downloading regardless of queue limits." },
  metaDL: { label: "Getting details", tone: "busy", hint: "Fetching the torrent's file list from peers before it can start." },
  queuedDL: { label: "Waiting to download", tone: "idle", hint: "Queued behind other downloads." },
  stalledDL: { label: "Stuck, no peers", tone: "warn", hint: "Not finished and nobody is sharing it. It may never complete." },
  pausedDL: { label: "Paused", tone: "warn", hint: "Not finished and stopped." },
  stoppedDL: { label: "Paused", tone: "warn", hint: "Not finished and stopped." },
  checkingDL: { label: "Checking files", tone: "busy", hint: "Verifying what has been downloaded so far." },
  checkingResumeData: { label: "Starting up", tone: "busy", hint: "qBittorrent is loading this torrent after a restart." },
  allocating: { label: "Preparing disk", tone: "busy", hint: "Reserving disk space before downloading." },
  moving: { label: "Moving files", tone: "busy", hint: "Moving the data to its final folder." },
  missingFiles: { label: "Files missing", tone: "bad", hint: "qBittorrent cannot find the data. It was usually deleted, or the drive is offline." },
  error: { label: "Error", tone: "bad", hint: "qBittorrent hit a disk or file error with this torrent." }
};

export const torrentState = (state: string): StateLabel =>
  TORRENT_STATES[state] ?? { label: state, tone: "idle", hint: "A state Hikari does not know yet." };

// Sonarr's queue states, same idea. trackedDownloadState is the more specific one when present.
const QUEUE_STATES: Record<string, StateLabel> = {
  downloading: { label: "Downloading", tone: "busy", hint: "Sonarr is waiting for the download client to finish." },
  importPending: { label: "Waiting to import", tone: "warn", hint: "Downloaded, but Sonarr needs something before importing. See the message." },
  importBlocked: { label: "Import blocked", tone: "bad", hint: "Downloaded, but Sonarr refused to import it. See the message." },
  importing: { label: "Importing", tone: "busy", hint: "Copying or hardlinking into the library." },
  imported: { label: "Imported", tone: "ok", hint: "In the library." },
  failedPending: { label: "Failed, retrying", tone: "warn", hint: "The download failed; Sonarr is looking for another release." },
  failed: { label: "Failed", tone: "bad", hint: "The download failed." },
  ignored: { label: "Ignored", tone: "idle", hint: "Removed from the queue without importing." },
  queued: { label: "Queued", tone: "idle", hint: "Waiting in the download client." },
  paused: { label: "Paused", tone: "warn", hint: "Paused in the download client." },
  completed: { label: "Downloaded", tone: "ok", hint: "Finished downloading." },
  warning: { label: "Needs attention", tone: "warn", hint: "Sonarr reported a problem. See the message." },
  delay: { label: "Delayed", tone: "idle", hint: "Held back by a delay profile, waiting for a better release." }
};

export const queueState = (state: string | null): StateLabel =>
  (state && QUEUE_STATES[state]) || { label: state ?? "—", tone: "idle", hint: "" };
