import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { invalidate } from "./cache.js";

// Titles you have said you are not interested in. Discover, the schedule and the Homepage widget
// stop showing them; search and the detail panel do not, because a title you typed the name of is
// one you asked to see, and the panel is where it can be brought back.
//
// Kept in its own file rather than the settings file on purpose. Settings are the administrator's
// and hold API keys; this is a view preference anyone signed in may change, and it should survive a
// browser switch, which is why it is not in localStorage like the row order.

const FILE = (process.env.HIDDEN_FILE || "/cache/hikari-hidden.json").trim();

// A hard ceiling, because the ids arrive from the browser and a script could fill the file for ever.
const MAX_HIDDEN = 2000;

// id -> { title, at }
let hidden = new Map();

export function load() {
  try {
    if (!existsSync(FILE)) return { loaded: false, path: FILE, count: 0 };
    const parsed = JSON.parse(readFileSync(FILE, "utf8"));
    const entries = Array.isArray(parsed?.hidden) ? parsed.hidden : [];
    hidden = new Map();
    for (const entry of entries.slice(0, MAX_HIDDEN)) {
      const id = Number(entry?.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      hidden.set(id, { title: typeof entry.title === "string" ? entry.title.slice(0, 200) : "", at: Number(entry.at) || 0 });
    }
    return { loaded: true, path: FILE, count: hidden.size };
  } catch (err) {
    console.error(`[hikari] could not read ${FILE}: ${err.message}`);
    return { loaded: false, path: FILE, count: 0, error: err.message };
  }
}

function persist() {
  const dir = dirname(FILE);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temp = `${FILE}.tmp`;
  writeFileSync(temp, JSON.stringify({ hidden: list() }, null, 2), { mode: 0o600 });
  renameSync(temp, FILE);
}

export function list() {
  return [...hidden.entries()]
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.at - a.at);
}

export function isHidden(id) {
  return hidden.has(Number(id));
}

export class HiddenError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "HiddenError";
    // What app.onError() reads to pick the response status.
    this.httpStatus = status;
  }
}

function validId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HiddenError("id must be a positive integer");
  return id;
}

// Memory follows the file, not the other way round: a write that fails (a read-only volume, a full
// disk) rolls the map back, so what the browser is told matches what a restart will read.
function commit(id, previous) {
  try {
    persist();
  } catch (err) {
    if (previous === undefined) hidden.delete(id);
    else hidden.set(id, previous);
    throw new HiddenError(`could not write ${FILE}: ${err.message}`, 500);
  }
  // The Homepage snapshot is composed with this list applied, so it is rebuilt rather than showing
  // the title until its TTL runs out.
  invalidate("hikari:");
}

export function hide(rawId, title = "") {
  const id = validId(rawId);
  if (!hidden.has(id) && hidden.size >= MAX_HIDDEN) throw new HiddenError(`no more than ${MAX_HIDDEN} titles can be hidden`, 409);
  const previous = hidden.get(id);
  hidden.set(id, { title: String(title || "").slice(0, 200), at: Date.now() });
  commit(id, previous);
  return { id, hidden: true, count: hidden.size };
}

export function show(rawId) {
  const id = validId(rawId);
  const previous = hidden.get(id);
  if (previous !== undefined) {
    hidden.delete(id);
    commit(id, previous);
  }
  return { id, hidden: false, count: hidden.size };
}

// Drops hidden titles from a list of media, or from a list of anything with a `.media.id` when
// `pick` says where the media is (the schedule's entries wrap theirs).
export function filter(items, pick = item => item) {
  if (hidden.size === 0) return items;
  return items.filter(item => !hidden.has(Number(pick(item)?.id)));
}
