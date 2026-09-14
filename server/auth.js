import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config, enabled } from "./config.js";
import { request } from "./http.js";
import { forgive, hit, lockedFor, penalise } from "./ratelimit.js";

// Login against Jellyfin, so Hikari has no accounts of its own to manage or leak. Jellyfin
// checks the password; Hikari only ever sees whether the answer was yes.
//
// The session is a signed token in an HttpOnly cookie rather than a row in a table. Nothing to
// store means nothing to lose, and a restart does not sign you out because the signing key is
// persisted. The trade-off is that an individual session cannot be revoked, so "sign out
// everywhere" bumps a generation counter that invalidates every token issued before it.

const FILE = (process.env.AUTH_FILE || "/cache/hikari-auth.json").trim();
const COOKIE = "hikari_session";

let state = { secret: null, generation: 1 };

function persist() {
  const dir = dirname(FILE);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temp = `${FILE}.tmp`;
  // 0600: this key is the difference between a cookie and a forged cookie.
  writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temp, FILE);
}

export function load() {
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, "utf8"));
      if (typeof parsed?.secret === "string" && parsed.secret.length >= 32) {
        state = { secret: parsed.secret, generation: Number(parsed.generation) || 1 };
        return { loaded: true, path: FILE };
      }
    }
  } catch (err) {
    console.error(`[hikari] could not read ${FILE}: ${err.message}`);
  }

  // Generated on demand rather than shipped or derived from a config value, so two installs
  // never share one and nobody has to think about it.
  state = { secret: randomBytes(32).toString("base64url"), generation: 1 };
  try {
    persist();
    return { loaded: false, created: true, path: FILE };
  } catch (err) {
    // A read-only cache directory means sessions stop surviving restarts, which is worth a
    // warning but not worth refusing to start over.
    console.error(`[hikari] could not write ${FILE}: ${err.message}. Sessions will not survive a restart.`);
    return { loaded: false, created: false, path: FILE, error: err.message };
  }
}

export function revokeAll() {
  state.generation += 1;
  try {
    persist();
  } catch (err) {
    console.error(`[hikari] could not persist the new session generation: ${err.message}`);
  }
  return state.generation;
}

const b64 = value => Buffer.from(value).toString("base64url");
const sign = payload => createHmac("sha256", state.secret).update(payload).digest("base64url");

function issue(user, days) {
  const payload = b64(
    JSON.stringify({
      u: user.name,
      id: user.id,
      admin: Boolean(user.admin),
      g: state.generation,
      exp: Math.floor(Date.now() / 1000) + Math.round(days * 24 * 60 * 60)
    })
  );
  return `${payload}.${sign(payload)}`;
}

export function verify(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, signature] = token.split(".", 2);
  if (!payload || !signature) return null;

  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!claims || typeof claims !== "object") return null;
  if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
  // Anything issued before the last "sign out everywhere" is dead, even if still in date.
  if (claims.g !== state.generation) return null;

  return { name: claims.u, id: claims.id, admin: Boolean(claims.admin), expires: claims.exp };
}

// Brute force is the only attack a login form invites, and this one may sit on a LAN where the
// attacker already knows the usernames. Five a minute per username and per address, then an
// escalating lockout, because a fixed window alone just means waiting for the next one.
const LOGIN = { max: 5, windowMs: 60 * 1000, baseMs: 60 * 1000, maxMs: 60 * 60 * 1000 };

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.httpStatus = status;
  }
}

export async function login({ username, password, address }) {
  if (!enabled.jellyfin) throw new AuthError("Jellyfin is not configured, so there is nothing to log in against", 503);
  if (typeof username !== "string" || typeof password !== "string" || !username.trim()) {
    throw new AuthError("a username and password are required", 400);
  }

  const keys = [`login:u:${username.toLowerCase()}`, `login:a:${address || "unknown"}`];

  for (const key of keys) {
    const locked = lockedFor(key);
    if (locked > 0) throw new AuthError(`too many attempts, try again in ${locked}s`, 429);
  }
  for (const key of keys) {
    const check = hit(key, LOGIN);
    if (!check.allowed) {
      // Each burst that exhausts the window doubles the penalty, so guessing gets slower the
      // longer it goes on.
      const wait = Math.max(...keys.map(k => penalise(k, LOGIN)));
      throw new AuthError(`too many attempts, try again in ${wait}s`, 429);
    }
  }

  let body;
  try {
    body = await request("jellyfin", `${config.jellyfin.url}/Users/AuthenticateByName`, {
      method: "POST",
      headers: {
        // Jellyfin requires this header even to authenticate, and it is what shows up in its
        // dashboard as the device that logged in.
        Authorization: 'MediaBrowser Client="Hikari", Device="Hikari", DeviceId="hikari-web", Version="0.1.0"',
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ Username: username, Pw: password }),
      timeout: 15000
    });
  } catch (err) {
    // 401 is a wrong password; anything else is Jellyfin having a problem, and saying which is
    // the difference between "I typo'd" and "the server is down".
    if (err.status === 401 || err.status === 403) throw new AuthError("that username and password did not work");
    throw new AuthError(`Jellyfin could not be reached: ${err.message}`, 502);
  }

  const user = {
    id: body?.User?.Id ?? null,
    name: body?.User?.Name ?? username,
    admin: Boolean(body?.User?.Policy?.IsAdministrator)
  };
  if (!user.id) throw new AuthError("Jellyfin accepted the login but returned no user", 502);

  // An allowlist is the difference between "anyone with a Jellyfin account" and "me". Empty
  // means any Jellyfin user, which is the sane default for a household.
  const allowed = config.auth.users;
  if (allowed.length > 0 && !allowed.some(name => name.toLowerCase() === user.name.toLowerCase())) {
    throw new AuthError("that account is not allowed to use Hikari", 403);
  }
  if (config.auth.adminsOnly && !user.admin) {
    throw new AuthError("only Jellyfin administrators may use Hikari", 403);
  }

  for (const key of keys) forgive(key);
  return { user, token: issue(user, config.auth.sessionDays) };
}

export function cookieHeader(token, { secure }) {
  const maxAge = Math.round(config.auth.sessionDays * 24 * 60 * 60);
  const parts = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    // Lax rather than Strict: Strict drops the cookie when you arrive from a link in Homepage,
    // which is exactly how this app gets opened.
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookieHeader({ secure }) {
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

export function status() {
  return {
    // Enabled but unusable is worth surfacing rather than locking the door on an empty room.
    enabled: config.auth.enabled && enabled.jellyfin,
    configured: enabled.jellyfin,
    sessionDays: config.auth.sessionDays,
    adminsOnly: config.auth.adminsOnly,
    users: config.auth.users
  };
}
