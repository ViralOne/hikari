import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The API token is the credential that guards every state-changing route, and it can now be minted
// from the browser. That makes two things worth pinning: who is allowed to mint one, and that the
// value never comes back out again afterwards. Both are tested against a real server, because the
// guard is spread across middleware and a route handler and reading it is not the same as running it.
//
// Jellyfin is never contacted. It only has to look configured for the login gate to engage, so the
// URL points at a closed port, and sessions are forged with the signing key the server just wrote,
// exactly as test-auth.mjs does. Run: npm test

const dir = mkdtempSync(join(tmpdir(), "hikari-token-"));
const AUTH_FILE = join(dir, "auth.json");
const SETTINGS_FILE = join(dir, "settings.json");
const PORT = 7991;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

// ---------------------------------------------------------------------------------------------
// The settings module on its own: generate, mask, refuse, clear.
// ---------------------------------------------------------------------------------------------

console.log("the token in the settings layer");

process.env.SETTINGS_FILE = SETTINGS_FILE;
process.env.HIKARI_TOKEN = "from-the-environment";

const settings = await import("../server/settings.js");
const { config } = await import("../server/config.js");

const field = () => settings.describe().fields.find(f => f.key === "token");

check("the token is reported as managed, so the form does not render it as an input", field().managed === true);
check("with only the environment set, the source is the environment", field().source === "env" && field().set === true);

const first = settings.generateToken();
check("a generated token is 32 bytes of base64url", /^[A-Za-z0-9_-]{43}$/.test(first), `${first.length} chars`);
check("generating overrides the environment", config.token === first && field().source === "settings");

// The whole point of a masked read: the browser gets enough to tell which token is stored and
// nothing it could authenticate with.
const described = field();
check("describe never returns the value", described.value === null && !JSON.stringify(settings.describe()).includes(first));
check("describe returns the last four characters", described.preview === `••••${first.slice(-4)}`);

const second = settings.generateToken();
check("regenerating produces a different token", second !== first && config.token === second);

let refused = null;
try {
  settings.update({ token: "a-token-of-my-choosing" });
} catch (err) {
  refused = err;
}
check("the ordinary settings patch refuses the token", refused?.name === "SettingsError" && config.token === second, refused?.message);

check("the settings file is written 0600", (statSync(SETTINGS_FILE).mode & 0o777) === 0o600);

// A failed write must leave nothing behind. Otherwise a token nobody has ever seen sits in the
// override layer until the next unrelated save persists it and activates it, at which point every
// token-authenticated client gets 401 against a secret that was never returned to anyone. Made to
// fail by taking write permission off the directory, which is what a read-only /cache volume looks
// like from here.
const beforeFailure = field().preview;
chmodSync(dir, 0o500);
let persistError = null;
try {
  settings.generateToken();
} catch (err) {
  persistError = err;
} finally {
  chmodSync(dir, 0o700);
}
check("a write that cannot be persisted throws", persistError !== null, persistError?.code);
check(
  "and the token it staged is rolled back, not left for the next save to activate",
  field().preview === beforeFailure && config.token === second
);

const cleared = settings.clearToken();
check(
  "clearing hands the field back to the environment",
  cleared.cleared === true && cleared.fromEnv === true && config.token === "from-the-environment"
);
check("the source reads as the environment again", field().source === "env");

// ---------------------------------------------------------------------------------------------
// The live guard: who may mint one.
// ---------------------------------------------------------------------------------------------

console.log("\nwho may generate one");

const server = spawn(process.execPath, ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    AUTH_FILE,
    HIDDEN_FILE: join(dir, "hidden.json"),
    SETTINGS_FILE: join(dir, "live-settings.json"),
    CACHE_FILE: join(dir, "cache.json"),
    // Configured, not reachable. enabled.jellyfin is derived from the url and key being present,
    // which is all the login gate needs to engage rather than fail closed with a 503.
    JELLYFIN_URL: "http://127.0.0.1:1",
    JELLYFIN_API_KEY: "not-a-real-key",
    JELLYSEERR_URL: "http://127.0.0.1:1",
    JELLYSEERR_API_KEY: "not-a-real-key",
    AUTH: "1",
    HIKARI_TOKEN: "",
    AUTO_LINK: "0",
    // Nothing here should reach AniList; the warm-up would.
    CACHE_WARM: "0"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverLog = "";
server.stdout.on("data", chunk => (serverLog += chunk));
server.stderr.on("data", chunk => (serverLog += chunk));

const stop = () => {
  server.kill("SIGKILL");
};

try {
  // The port answering is the only readiness signal that matters.
  let up = false;
  for (let attempt = 0; attempt < 100 && !up; attempt += 1) {
    try {
      await fetch(`${BASE}/api/auth`);
      up = true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!up) throw new Error(`the server did not start:\n${serverLog}`);

  // Forged the same way the server signs them, which is the only way to hold a session without a
  // Jellyfin to log in against.
  const secret = JSON.parse(readFileSync(AUTH_FILE, "utf8")).secret;
  const b64 = value => Buffer.from(value).toString("base64url");
  const cookieFor = ({ admin }) => {
    const payload = b64(
      JSON.stringify({
        u: admin ? "milu" : "guest",
        id: admin ? "admin-id" : "guest-id",
        admin,
        g: 1,
        exp: Math.floor(Date.now() / 1000) + 3600
      })
    );
    return `hikari_session=${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  };

  const adminCookie = cookieFor({ admin: true });
  const guestCookie = cookieFor({ admin: false });

  const call = (path, { method = "GET", cookie, token, body } = {}) =>
    fetch(`${BASE}${path}`, {
      method,
      headers: {
        // Hono's csrf() checks the origin on anything that is not a read.
        Origin: BASE,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { "X-Hikari-Token": token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

  // A caller that is not a browser sends no Origin at all. The routes take no body, so without an
  // explicit Content-Type the CSRF check treats them as form-like and refuses with 403 and a body
  // that is not JSON, which is a confusing way for a rotation script to fail.
  const scripted = await fetch(`${BASE}/api/settings/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  check("a caller with no Origin header is not mistaken for CSRF", scripted.status !== 403, `got ${scripted.status}`);

  const anonymous = await call("/api/settings/token", { method: "POST" });
  check("an unauthenticated caller cannot generate one", anonymous.status === 401, `got ${anonymous.status}`);

  // The container healthcheck holds no credential of any kind, so the login gate turning it into a
  // 401 made Docker report the container unhealthy the moment the login went on. Liveness answers
  // anyway; the detailed probe, which lists every configured service, still does not.
  const liveness = await call("/api/health/live");
  check("liveness answers with no credential, so the healthcheck passes", liveness.status === 200, `got ${liveness.status}`);
  const livenessBody = await liveness.text();
  check("and it reveals nothing about the configuration", livenessBody === '{"ok":true}', livenessBody);
  const detailed = await call("/api/health");
  check("the detailed probe still requires a session or a token", detailed.status === 401, `got ${detailed.status}`);

  const asGuest = await call("/api/settings/token", { method: "POST", cookie: guestCookie });
  check("a signed-in non-administrator cannot generate one", asGuest.status === 403, `got ${asGuest.status}`);

  const asAdmin = await call("/api/settings/token", { method: "POST", cookie: adminCookie });
  const minted = await asAdmin.json();
  check("an administrator can generate one", asAdmin.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(minted.token ?? ""));

  // ---------------------------------------------------------------------------------------------
  console.log("\nwhat happens once one exists");

  const read = await call("/api/settings", { cookie: adminCookie });
  const body = await read.text();
  check("reading the settings back never carries the value", read.status === 200 && !body.includes(minted.token));
  check(
    "it reads back masked and sourced to the settings file",
    JSON.parse(body).fields.find(f => f.key === "token")?.preview === `••••${minted.token.slice(-4)}`
  );

  const patched = await call("/api/settings", {
    method: "POST",
    cookie: adminCookie,
    body: { token: "a-token-of-my-choosing" }
  });
  check("the settings patch still refuses the token over HTTP", patched.status === 400, `got ${patched.status}`);

  // The regression this whole change exists to prevent: before it, a token being set turned the
  // browser into a read-only client, so a generated token locked the owner out of the screen that
  // generated it.
  const saveAsAdmin = await call("/api/settings", {
    method: "POST",
    cookie: adminCookie,
    body: { animeRoot: "/data/anime" }
  });
  check("an administrator can still save settings with a token set", saveAsAdmin.status === 200, `got ${saveAsAdmin.status}`);

  const saveAnonymous = await call("/api/settings", { method: "POST", body: { animeRoot: "/data/anime" } });
  check("an unauthenticated save is still refused", saveAnonymous.status === 401, `got ${saveAnonymous.status}`);

  const withToken = await call("/api/settings", {
    method: "POST",
    token: minted.token,
    body: { animeRoot: "/data/anime" }
  });
  check("the token itself still works, so scripts keep running", withToken.status === 200, `got ${withToken.status}`);

  const wrongToken = await call("/api/settings", {
    method: "POST",
    token: "not-the-token",
    body: { animeRoot: "/data/anime" }
  });
  check("a wrong token is refused", wrongToken.status === 401, `got ${wrongToken.status}`);

  // Regenerating from the browser has to keep working, or the button is a one-shot lockout.
  const again = await call("/api/settings/token", { method: "POST", cookie: adminCookie });
  const regenerated = await again.json();
  check(
    "an administrator can regenerate while a token is already set",
    again.status === 200 && regenerated.token !== minted.token
  );

  const stale = await call("/api/settings", {
    method: "POST",
    token: minted.token,
    body: { animeRoot: "/data/anime" }
  });
  check("the previous token stops working at once", stale.status === 401, `got ${stale.status}`);

  const removed = await call("/api/settings/token", { method: "DELETE", cookie: adminCookie });
  const after = await removed.json();
  check("an administrator can remove it", removed.status === 200 && after.cleared === true && after.fromEnv === false);
  check(
    "with no token left, the field reads as unset",
    after.fields.find(f => f.key === "token")?.set === false
  );

  // Homepage's actual call, which is what started all this.
  const widget = await call("/api/homepage");
  check("the Homepage endpoint still needs the login when no token is set", widget.status === 401, `got ${widget.status}`);
} finally {
  stop();
}

// ---------------------------------------------------------------------------------------------
// With the login off there is nobody to trust, so the button must not be offered at all.
// ---------------------------------------------------------------------------------------------

console.log("\nwith the login switched off");

const open = spawn(process.execPath, ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(PORT + 1),
    HOST: "127.0.0.1",
    AUTH_FILE: join(dir, "auth-open.json"),
    SETTINGS_FILE: join(dir, "open-settings.json"),
    CACHE_FILE: join(dir, "cache-open.json"),
    JELLYSEERR_URL: "http://127.0.0.1:1",
    JELLYSEERR_API_KEY: "not-a-real-key",
    AUTH: "0",
    HIKARI_TOKEN: "",
    AUTO_LINK: "0",
    // Nothing here should reach AniList; the warm-up would.
    CACHE_WARM: "0"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let openLog = "";
open.stdout.on("data", chunk => (openLog += chunk));
open.stderr.on("data", chunk => (openLog += chunk));

try {
  let up = false;
  for (let attempt = 0; attempt < 100 && !up; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT + 1}/api/auth`);
      up = true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!up) throw new Error(`the server did not start:\n${openLog}`);

  // This is the case the guard exists for. The login is off and no token is set, so nothing else in
  // the stack is standing in the way: without the explicit refusal, anyone who could reach the port
  // could mint the secret and lock the owner out of their own instance.
  const response = await fetch(`http://127.0.0.1:${PORT + 1}/api/settings/token`, {
    method: "POST",
    headers: { Origin: `http://127.0.0.1:${PORT + 1}` }
  });
  check("generating is refused outright when the login is off", response.status === 409, `got ${response.status}`);
  const explained = await response.json();
  // It must point at the login, and must not send you to HIKARI_TOKEN: a settings-file override wins
  // over the environment in apply(), so that advice would be inert once a token had ever been saved.
  check(
    "and it says to turn the login on",
    /login/i.test(explained.error) && !/HIKARI_TOKEN/.test(explained.error),
    explained.error
  );

  const del = await fetch(`http://127.0.0.1:${PORT + 1}/api/settings/token`, {
    method: "DELETE",
    headers: { Origin: `http://127.0.0.1:${PORT + 1}` }
  });
  check("so is removing one", del.status === 409, `got ${del.status}`);
} finally {
  open.kill("SIGKILL");
}

// ---------------------------------------------------------------------------------------------
// The trap this must not be: generate a token, then turn the login off. With no session to fall back
// on the browser cannot save, so if the token holder were also refused, hand-editing the settings
// file would be the only way out of a screen that offered the button in the first place.
// ---------------------------------------------------------------------------------------------

console.log("\nwith a token set but the login off");

const lockedDir = join(dir, "locked");
const lockedSettings = join(lockedDir, "settings.json");
mkdirSync(lockedDir, { recursive: true });
writeFileSync(lockedSettings, JSON.stringify({ token: "a-previously-generated-token" }), { mode: 0o600 });

const locked = spawn(process.execPath, ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(PORT + 2),
    HOST: "127.0.0.1",
    AUTH_FILE: join(lockedDir, "auth.json"),
    SETTINGS_FILE: lockedSettings,
    CACHE_FILE: join(lockedDir, "cache.json"),
    JELLYSEERR_URL: "http://127.0.0.1:1",
    JELLYSEERR_API_KEY: "not-a-real-key",
    AUTH: "0",
    HIKARI_TOKEN: "",
    AUTO_LINK: "0",
    // Nothing here should reach AniList; the warm-up would.
    CACHE_WARM: "0"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let lockedLog = "";
locked.stdout.on("data", chunk => (lockedLog += chunk));
locked.stderr.on("data", chunk => (lockedLog += chunk));

const lockedBase = `http://127.0.0.1:${PORT + 2}`;
try {
  let up = false;
  for (let attempt = 0; attempt < 100 && !up; attempt += 1) {
    try {
      await fetch(`${lockedBase}/api/auth`);
      up = true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!up) throw new Error(`the server did not start:\n${lockedLog}`);

  const holder = (path, method) =>
    fetch(`${lockedBase}${path}`, {
      method,
      headers: {
        Origin: lockedBase,
        "Content-Type": "application/json",
        "X-Hikari-Token": "a-previously-generated-token"
      }
    });

  const rotated = await holder("/api/settings/token", "POST");
  check("the token holder can still rotate it", rotated.status === 200, `got ${rotated.status}`);
  const next = (await rotated.json()).token;

  const removed = await fetch(`${lockedBase}/api/settings/token`, {
    method: "DELETE",
    headers: { Origin: lockedBase, "Content-Type": "application/json", "X-Hikari-Token": next }
  });
  check("and can remove it, so turning the login off is not a trap", removed.status === 200, `got ${removed.status}`);

  // The guard still has to hold in the state it exists for, which this install is now in.
  const stranger = await fetch(`${lockedBase}/api/settings/token`, {
    method: "POST",
    headers: { Origin: lockedBase, "Content-Type": "application/json" }
  });
  check("but with the token gone, a stranger still cannot mint one", stranger.status === 409, `got ${stranger.status}`);
} finally {
  locked.kill("SIGKILL");
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
