// Episode titles, read out of release and file names, compared with Sonarr's.
//
// Most releases carry the episode title: "LINK.CLICK.S04E07.Chinatown.Investigation.1080p.CR.WEB-DL",
// and Sonarr renames files to "Show - S04E07 - Chinatown Investigation WEBDL-1080p.mkv". That title is
// the one thing that still names the right episode when the numbers lie: a spin-off grabbed for the
// main show ("Bridon Arc S01E02 Prelude" imported as "The Caged Beast"), or a season TVDB renumbered
// (Link Click's season moved from 4 to 3 and back, and Sonarr attached files to the wrong episodes).
// No show names are involved anywhere; it is the same comparison for every series.

const QUALITY = /\b(2160p|1080[pi]|720p|576p|480p|4k|uhd|web[ ._-]?(dl|rip)?|webdl|bluray|blu[ ._-]?ray|bdrip|brrip|hdtv|dvdrip|remux|repack\d*|proper|internal|multi|dual|hevc|x26[45]|h[ ._]?26[45]|avc|av1|aac|ddp?\d|dts|atmos|10bit|cr|nf|amzn|dsnp|hulu|atvp|hmax|bili|bsite|ita|eng|vostfr)\b/i;
const PLACEHOLDER = /^(?:episode|ep|tba|tbd|untitled|part)(?: \d+)?$/;

export function titleKey(title) {
  return (title || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The episode title in a release or file name, or null when the name does not carry one.
export function episodeTitleFrom(name) {
  if (!name) return null;
  const base = name.split("/").pop().replace(/\.(mkv|mp4|avi|m4v|ts)$/i, "");
  const marker = /\bS\d{1,2}E\d{1,3}(?:-?E\d{1,3})*\b/i.exec(base);
  if (!marker) return null;
  let rest = base.slice(marker.index + marker[0].length).replace(/[._]+/g, " ").replace(/^\s*[-–]\s*/, " ");
  rest = rest.split(/[[({]/)[0];
  const cut = QUALITY.exec(rest);
  if (cut) rest = rest.slice(0, cut.index);
  const key = titleKey(rest);
  // A year ("Dollhouse S01E10 2009") or the show's own name with a number ("Reincarnated as a Sword 5")
  // is not an episode title.
  if (!key || PLACEHOLDER.test(key) || key.length < 3 || /^(19|20)\d\d$/.test(key)) return null;
  const show = titleKey(base.slice(0, marker.index).replace(/[._]+/g, " ").replace(/\[[^\]]*\]/g, ""));
  if (show && key.replace(/\s*\d+$/, "") === show) return null;
  return rest.trim().replace(/\s+-\s*$/, "");
}

// The show part of a release name (before SxxEyy), without group tags and years.
export function showPartFrom(name) {
  const base = (name || "").split("/").pop();
  const marker = /\bS\d{1,2}E\d{1,3}\b/i.exec(base);
  if (!marker) return null;
  const key = titleKey(base.slice(0, marker.index).replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/[._]+/g, " ")).replace(/\b(19|20)\d\d\b/g, "").replace(/\s+/g, " ").trim();
  return key || null;
}

// True when a release names a different show than the series: "Link Click Bridon Arc" for "Link Click".
// The series name must be there (so it is not an unrelated alias) with words added around it.
export function namesAnotherShow(name, seriesTitles) {
  const show = showPartFrom(name);
  if (!show) return false;
  const keys = (seriesTitles || []).map(titleKey).map(key => key.replace(/\b(19|20)\d\d\b/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (keys.some(key => key === show)) return false;
  return keys.some(key => show.includes(key) && words(show.replace(key, " ")).size > 0);
}

// Small words carry no identity: "The Caged Beast" and "The Forgotten Past" share nothing that matters.
const STOP = new Set(["the", "and", "for", "with", "you", "your", "are", "was", "his", "her", "its", "from", "that", "this", "but", "not", "who", "what", "how", "all", "into", "out", "one", "has", "have"]);
const words = key => new Set(key.split(" ").filter(word => (word.length > 2 || /\d/.test(word)) && !STOP.has(word)));

// "match", "mismatch", or "unknown" when either side has no usable title. A mismatch needs the two to
// share no meaningful word at all, so a shortened or differently punctuated title is never one.
export function compareTitles(fromName, sonarrTitle) {
  const a = titleKey(fromName);
  const b = titleKey(sonarrTitle);
  if (!a || !b || PLACEHOLDER.test(a) || PLACEHOLDER.test(b)) return "unknown";
  if (a === b || a.includes(b) || b.includes(a)) return "match";
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return "unknown";
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  if (shared === 0) return "mismatch";
  return shared / Math.min(left.size, right.size) >= 0.6 ? "match" : "unknown";
}

// The one episode of a series whose title matches, or null (none, or more than one).
export function episodeByTitle(title, episodes) {
  const hits = episodes.filter(episode => compareTitles(title, episode.title) === "match");
  return hits.length === 1 ? hits[0] : null;
}
