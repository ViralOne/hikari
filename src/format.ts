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
