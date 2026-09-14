import { randomBytes } from "node:crypto";
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
  {
    key: "auth.enabled",
    env: "AUTH",
    type: "boolean",
    group: "auth",
    label: "Require a Jellyfin login",
    hint: "Checked against your Jellyfin server. Hikari keeps no accounts of its own"
  },
  {
    key: "auth.adminsOnly",
    env: "AUTH_ADMINS_ONLY",
    type: "boolean",
    group: "auth",
    label: "Administrators only"
  },
  {
    key: "auth.users",
    env: "AUTH_USERS",
    type: "list",
    group: "auth",
    label: "Allowed usernames",
    hint: "Comma separated. Blank allows any Jellyfin account"
  },
  { key: "auth.sessionDays", env: "AUTH_SESSION_DAYS", type: "number", min: 1, max: 365, group: "auth", label: "Stay signed in for (days)" },
  {
    key: "token",
    env: "HIKARI_TOKEN",
    type: "secret",
    group: "token",
    label: "API token",
    managed: true,
    hint: "For Homepage, scripts and the Sonarr webhook, which cannot hold a session cookie"
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
const MAX_LENGTH = 2048;

export function coerce(field, raw) {
  if (raw === null || raw === undefined) return null;

  // An empty field means "stop overriding this", for every type. Number("") is 0, so without
  // this a cleared grace period became 0 hours, which is not "unset" but "link brand new
  // files before AniDB has had any chance to match them".
  if (typeof raw === "string" && raw.trim() === "") return null;

  if (typeof raw === "string") {
    if (raw.length > MAX_LENGTH) throw new SettingsError(`${field.key} is too long`);
    // Checked before the type switch: the URL parser strips CR and LF before parsing, so
    // "http://host:8989\r\nX-Evil: 1" used to validate and then be stored verbatim.
    if (/[\r\n\t]/.test(raw)) throw new SettingsError(`${field.key} must not contain line breaks`);
  }

  if (field.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    return /^(1|true|yes|on)$/i.test(String(raw).trim());
  }

  if (field.type === "list") {
    const items = (Array.isArray(raw) ? raw : String(raw).split(","))
      .map(item => String(item).trim())
      .filter(Boolean);
    if (items.some(item => /[\r\n\t,]/.test(item))) throw new SettingsError(`${field.key} has an invalid entry`);
    return items.length === 0 ? null : items;
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
    // 169.254.0.0/16 carries the cloud metadata service, which is never a media server and is
    // the classic target when a URL field can be pointed anywhere. Loopback and private ranges
    // are deliberately allowed: they are where a self-hosted stack actually lives.
    if (/^169\.254\./.test(parsed.hostname)) {
      throw new SettingsError(`${field.key} must not point at the link-local range`);
    }
    return text.replace(/\/+$/, "");
  }

  return text;
}

// Which secret travels to which URL. Changing an address without supplying the matching secret
// is refused, because otherwise repointing a URL is enough to have the server deliver a stored
// key to an address of your choosing on its next poll, with no need to ever read the key back.
const SECRET_FOR_URL = new Map([
  ["jellyseerr.url", "jellyseerr.key"],
  ["sonarr.url", "sonarr.key"],
  ["radarr.url", "radarr.key"],
  ["jellyfin.url", "jellyfin.key"],
  ["shoko.url", "shoko.key"],
  ["qbit.url", "qbit.pass"]
]);

// What the environment and the built-in defaults said, captured before anything is applied.
// Without it, clearing a field left the last saved value in `config` until a restart while the
// settings screen reported the source as the environment. Wrong, and silently so.
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

  // Refused here rather than filtered out, so a caller trying to set the shared secret through the
  // ordinary patch gets told no instead of a silent success that changed nothing.
  const managed = Object.keys(patch).filter(key => BY_KEY.get(key).managed);
  if (managed.length) {
    throw new SettingsError(`${managed.join(", ")} cannot be set here, it has its own generate button`);
  }

  // Validated in full before anything is written. Coercing straight into `overrides` left the
  // values from before a mid-loop rejection sitting in memory, to be persisted silently by the
  // next unrelated save and absent from `changed`.
  const staged = Object.entries(patch).map(([key, raw]) => [key, coerce(BY_KEY.get(key), raw)]);

  for (const [key, value] of staged) {
    const secretKey = SECRET_FOR_URL.get(key);
    if (!secretKey || value === null) continue;
    if (value === read(config, key)) continue;
    // A blank secret is fine: there is nothing to leak. One that is set has to be re-entered.
    if (!read(config, secretKey)) continue;
    if (staged.some(([other, otherValue]) => other === secretKey && otherValue !== null)) continue;

    throw new SettingsError(
      `changing ${key} also needs ${secretKey} in the same save, so a stored secret is never sent to a new address`
    );
  }

  const changed = [];
  for (const [key, value] of staged) {
    // Null means "stop overriding this", which is how a field is handed back to the environment.
    if (value === null) {
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

// Rolled back if the write fails, for the same reason `update` stages its values before writing any
// of them. A token left in `overrides` after a failed persist is invisible to everyone, because the
// value was never returned to the caller, and the next unrelated save would persist and activate it.
// Every token-authenticated client would then start getting 401 against a secret nobody has seen.
function setOverride(key, value) {
  const previous = read(overrides, key);
  write(overrides, key, value);
  try {
    persist();
  } catch (err) {
    write(overrides, key, previous);
    throw err;
  }
  apply();
}

// 32 bytes, the same size as the session signing key. base64url so it survives a header, a YAML
// file and a query string without anything having to be escaped.
export function generateToken() {
  const value = randomBytes(32).toString("base64url");
  setOverride("token", value);

  // Deliberately no invalidate(): the token is not a service address, so nothing that is cached was
  // produced by the old value.
  console.log("[hikari] a new API token was generated");
  return value;
}

// Removing the override hands the field back to HIKARI_TOKEN, exactly like clearing any other one.
// So this is "stop using the generated token", not necessarily "there is now no token".
export function clearToken() {
  const had = read(overrides, "token") !== undefined;
  if (had) {
    setOverride("token", undefined);
    console.log("[hikari] the generated API token was removed");
  }
  return { cleared: had, fromEnv: Boolean(config.token) };
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
        // The browser has to know not to render this as an editable input, since saving one would
        // be refused. It gets its own control instead.
        managed: Boolean(field.managed),
        hint: field.hint ?? null,
        placeholder: field.placeholder ?? null,
        min: field.min ?? null,
        max: field.max ?? null,
        source,
        // Secrets report whether they are set and their last four characters, never the value.
        // A list is sent as the comma-separated string the input shows, so the browser does not
        // have to know the field is really an array.
        value:
          field.type === "secret"
            ? null
            : field.type === "list"
              ? (effective ?? []).join(", ")
              : (effective ?? null),
        preview: field.type === "secret" ? mask(effective) : null,
        // Boolean([]) is true, so an empty list has to be asked about its length or every unset
        // list reports itself as set.
        set:
          field.type === "boolean" || field.type === "number"
            ? true
            : field.type === "list"
              ? (effective ?? []).length > 0
              : Boolean(effective)
      };
    }),
    enabled: { ...enabled }
  };
}

export function isConfigured() {
  return Boolean(config.jellyseerr.url || config.sonarr.url || config.jellyfin.url || config.shoko.url);
}
