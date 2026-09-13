import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config, enabled, recompute } from "./config.js";
import { invalidate } from "./cache.js";

// Runtime configuration, so a fresh install can be set up in the browser instead of in a file
// you have to shell in to edit.
//
// Environment variables still work and are the fallback for every field, which keeps existing
// deployments working untouched. What the UI saves is an override layer: it is written to disk
// on its own, so nothing here ever rewrites your .env.
//
// PORT, HOST and HIKARI_TOKEN are deliberately not settable. The first two need a restart to
// mean anything, and letting the network set the shared secret that protects the network-facing
// routes would defeat the point of having one.

const FILE = (process.env.SETTINGS_FILE || "/cache/hikari-settings.json").trim();

export const FIELDS = [
  { key: "jellyseerr.url", env: "JELLYSEERR_URL", type: "url", group: "jellyseerr", label: "Base URL", placeholder: "http://192.168.1.10:5055" },
  { key: "jellyseerr.key", env: "JELLYSEERR_API_KEY", type: "secret", group: "jellyseerr", label: "API key" },
  {
    key: "jellyseerr.publicUrl",
    env: "JELLYSEERR_PUBLIC_URL",
    type: "url",
    group: "jellyseerr",
    label: "Public URL",
    hint: "Only if your browser reaches Jellyseerr on a different address than Hikari does"
  },
  { key: "sonarr.url", env: "SONARR_URL", type: "url", group: "sonarr", label: "Base URL", placeholder: "http://192.168.1.10:8989" },
  { key: "sonarr.key", env: "SONARR_API_KEY", type: "secret", group: "sonarr", label: "API key" },
  { key: "radarr.url", env: "RADARR_URL", type: "url", group: "radarr", label: "Base URL", placeholder: "http://192.168.1.10:7878" },
  { key: "radarr.key", env: "RADARR_API_KEY", type: "secret", group: "radarr", label: "API key" },
  { key: "jellyfin.url", env: "JELLYFIN_URL", type: "url", group: "jellyfin", label: "Base URL", placeholder: "http://192.168.1.10:8096" },
  { key: "jellyfin.key", env: "JELLYFIN_API_KEY", type: "secret", group: "jellyfin", label: "API key" },
  {
    key: "jellyfin.userId",
    env: "JELLYFIN_USER_ID",
    type: "text",
    group: "jellyfin",
    label: "User id",
    hint: "Whose watch progress to show. Blank uses the first administrator"
  },
  {
    key: "jellyfin.libraryId",
    env: "JELLYFIN_LIBRARY_ID",
    type: "text",
    group: "jellyfin",
    label: "Anime library id",
    hint: "Blank detects it from the Shokofin virtual file system"
  },
  { key: "qbit.url", env: "QBIT_URL", type: "url", group: "qbit", label: "Web UI URL", placeholder: "http://192.168.1.10:8080" },
  { key: "qbit.user", env: "QBIT_USER", type: "text", group: "qbit", label: "Username" },
  { key: "qbit.pass", env: "QBIT_PASS", type: "secret", group: "qbit", label: "Password" },
  { key: "shoko.url", env: "SHOKO_URL", type: "url", group: "shoko", label: "Base URL", placeholder: "http://192.168.1.10:8111" },
  { key: "shoko.key", env: "SHOKO_API_KEY", type: "secret", group: "shoko", label: "API key" },
  {
    key: "anilist.token",
    env: "ANILIST_TOKEN",
    type: "secret",
    group: "anilist",
    label: "Access token",
    hint: "Optional. Adds your list status and progress. The Ani-Sync Jellyfin plugin holds one you can reuse"
  },
  {
    key: "anilist.allowWrites",
    env: "ANILIST_ALLOW_WRITES",
    type: "boolean",
    group: "anilist",
    label: "Allow writing to my list"
  },
  {
    key: "animeRoot",
    env: "ANIME_ROOT",
    type: "text",
    group: "general",
    label: "Anime library path",
    hint: "Used to recognise a torrent as anime"
  },
  { key: "autoLink.enabled", env: "AUTO_LINK", type: "boolean", group: "autolink", label: "Link unmatched files automatically" },
  { key: "autoLink.intervalMinutes", env: "AUTO_LINK_INTERVAL_MINUTES", type: "number", min: 5, max: 1440, group: "autolink", label: "Every (minutes)" },
  { key: "autoLink.graceHours", env: "AUTO_LINK_GRACE_HOURS", type: "number", min: 0, max: 168, group: "autolink", label: "Leave new files to AniDB for (hours)" },
  { key: "autoLink.maxPerRun", env: "AUTO_LINK_MAX_PER_RUN", type: "number", min: 1, max: 200, group: "autolink", label: "Maximum links per run" }
];

const BY_KEY = new Map(FIELDS.map(field => [field.key, field]));

let overrides = {};
let loadedFrom = null;

function read(target, key) {
  return key.split(".").reduce((node, part) => (node == null ? node : node[part]), target);
}

function write(target, key, value) {
  const parts = key.split(".");
  const last = parts.pop();
  const parent = parts.reduce((node, part) => (node[part] ??= {}), target);
  parent[last] = value;
}

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "SettingsError";
    this.httpStatus = 400;
  }
}

// Values arrive from a browser, so every one is validated before it can reach an outbound
// request. A URL that is not a URL would otherwise surface as a confusing fetch failure much
// later, and a NaN interval would spin the sweep timer.
function coerce(field, raw) {
  if (raw === null || raw === undefined) return null;

  // An empty field means "stop overriding this", for every type. Number("") is 0, so without
  // this a cleared grace period became 0 hours — which is not "unset", it is "link brand new
  // files before AniDB has had any chance to match them".
  if (typeof raw === "string" && raw.trim() === "") return null;

  if (field.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    return /^(1|true|yes|on)$/i.test(String(raw).trim());
  }

  if (field.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new SettingsError(`${field.key} must be a number`);
    const rounded = Math.round(value);
    if (field.min != null && rounded < field.min) throw new SettingsError(`${field.key} must be at least ${field.min}`);
    if (field.max != null && rounded > field.max) throw new SettingsError(`${field.key} must be at most ${field.max}`);
    return rounded;
  }

  const text = String(raw).trim();
  if (text === "") return "";

  if (field.type === "url") {
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      throw new SettingsError(`${field.key} must be a URL, for example http://192.168.1.10:8989`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new SettingsError(`${field.key} must be http or https`);
    }
    return text.replace(/\/+$/, "");
  }

  // Secrets and free text: a stray newline from a copy and paste breaks a header.
  if (/[\r\n]/.test(text)) throw new SettingsError(`${field.key} must not contain line breaks`);
  return text;
}

// What the environment and the built-in defaults said, captured before anything is applied.
// Without it, clearing a field left the last saved value in `config` until a restart while the
// settings screen reported the source as the environment — wrong, and silently so.
const baseline = new Map(FIELDS.map(field => [field.key, read(config, field.key)]));

// Applied as a whole layer rather than field by field, so removing an override restores the
// baseline in the same pass.
export function apply() {
  for (const field of FIELDS) {
    const override = read(overrides, field.key);
    const value = override === undefined || override === null ? baseline.get(field.key) : override;
    write(config, field.key, value);
  }
  recompute();
}

export function load() {
  try {
    if (!existsSync(FILE)) return { loaded: false, path: FILE };
    const parsed = JSON.parse(readFileSync(FILE, "utf8"));
    overrides = parsed && typeof parsed === "object" ? parsed : {};
    loadedFrom = FILE;
    apply();
    return { loaded: true, path: FILE, fields: FIELDS.filter(f => read(overrides, f.key) != null).length };
  } catch (err) {
    console.error(`[hikari] could not read ${FILE}: ${err.message}`);
    return { loaded: false, path: FILE, error: err.message };
  }
}

function persist() {
  const dir = dirname(FILE);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Written 0600 through a temp file: this holds every API key you own, and a half-written
  // file on a crash would lock you out of your own settings.
  const temp = `${FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(overrides, null, 2), { mode: 0o600 });
  renameSync(temp, FILE);
  loadedFrom = FILE;
}

export function update(patch) {
  if (!patch || typeof patch !== "object") throw new SettingsError("expected an object of settings");

  const unknown = Object.keys(patch).filter(key => !BY_KEY.has(key));
  if (unknown.length) throw new SettingsError(`unknown setting${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);

  const changed = [];
  for (const [key, raw] of Object.entries(patch)) {
    const field = BY_KEY.get(key);
    const value = coerce(field, raw);

    // An empty string means "stop overriding this", which is how you hand a field back to the
    // environment. Deleting rather than storing "" is what makes that work.
    if (value === "" || value === null) {
      if (read(overrides, key) !== undefined) {
        write(overrides, key, undefined);
        changed.push(key);
      }
      continue;
    }
    if (read(overrides, key) === value) continue;
    write(overrides, key, value);
    changed.push(key);
  }

  if (changed.length === 0) return { changed: [] };

  persist();
  apply();

  // Every cached response was produced by the old configuration, including per-service version
  // probes and every match keyed to a service that may now be a different server.
  invalidate("");

  console.log(`[hikari] settings updated: ${changed.join(", ")}`);
  return { changed };
}

const mask = value => {
  if (!value) return null;
  const text = String(value);
  return text.length <= 4 ? "••••" : `••••${text.slice(-4)}`;
};

// Never returns a secret. The browser has no reason to read one back, and this response is the
// thing most likely to end up in a screenshot or a bug report.
export function describe() {
  return {
    path: loadedFrom,
    writable: true,
    fields: FIELDS.map(field => {
      const overridden = read(overrides, field.key);
      const envValue = process.env[field.env];
      const effective = read(config, field.key);
      const source = overridden != null ? "settings" : envValue ? "env" : "default";

      return {
        key: field.key,
        env: field.env,
        type: field.type,
        group: field.group,
        label: field.label,
        hint: field.hint ?? null,
        placeholder: field.placeholder ?? null,
        min: field.min ?? null,
        max: field.max ?? null,
        source,
        // Secrets report whether they are set and their last four characters, never the value.
        value: field.type === "secret" ? null : (effective ?? null),
        preview: field.type === "secret" ? mask(effective) : null,
        set: field.type === "boolean" || field.type === "number" ? true : Boolean(effective)
      };
    }),
    enabled: { ...enabled }
  };
}

export function isConfigured() {
  return Boolean(config.jellyseerr.url || config.sonarr.url || config.jellyfin.url || config.shoko.url);
}
