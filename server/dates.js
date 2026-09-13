// AniDB air dates are Japan-local calendar dates and Sonarr's are UTC, so the same broadcast
// can be recorded a day apart. A weekly series has seven days between episodes, so a one-day
// window is generous enough to survive the timezone and tight enough not to reach a neighbour.
export function withinADay(left, right) {
  if (!left || !right) return false;
  const diff = Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`));
  return Number.isFinite(diff) && diff <= 24 * 60 * 60 * 1000;
}

export function hoursSince(timestamp) {
  if (!timestamp) return Infinity;
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return Infinity;
  return (Date.now() - then) / (60 * 60 * 1000);
}

export function basename(path) {
  if (!path) return "";
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "";
}
