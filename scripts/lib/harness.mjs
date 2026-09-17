import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Starts a real Hikari server as a child process, pointed at the fakes from fakes.mjs. The same
// recipe scripts/test-token.mjs uses -- spawn server/index.js with its state files in a temp
// directory -- with the service URLs filled in so every integration is on and none of them leaves
// the machine.
//
// Env names are the ones server/config.js reads. Anything passed in `env` wins, which is how a test
// restarts with ANILIST_ALLOW_WRITES=1 or the dev helper binds 0.0.0.0.

// The config reads `Number(PORT || 7997)`, so PORT=0 does not mean "any port" the way it does for
// listen(). Ask the kernel for a free one and hand that over instead. There is a window between
// closing this and the child binding it, but nothing else on 127.0.0.1 is racing for ports here.
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function startHikari({ env = {}, fakes, echo = false } = {}) {
  if (!fakes?.urls) throw new Error("startHikari needs the fakes: startFakes() first");

  const dir = mkdtempSync(join(tmpdir(), "hikari-integration-"));
  const port = env.PORT ? Number(env.PORT) : await freePort();
  const host = env.HOST || "127.0.0.1";
  // Readiness and the call helper always go over loopback, whatever the child was told to bind.
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ["server/index.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: host,
      AUTH_FILE: join(dir, "auth.json"),
      HIDDEN_FILE: join(dir, "hidden.json"),
      SETTINGS_FILE: join(dir, "settings.json"),
      CACHE_FILE: join(dir, "cache.json"),

      JELLYSEERR_URL: fakes.urls.jellyseerr,
      JELLYSEERR_API_KEY: "fake-jellyseerr-key",
      SONARR_URL: fakes.urls.sonarr,
      SONARR_API_KEY: "fake-sonarr-key",
      RADARR_URL: fakes.urls.radarr,
      RADARR_API_KEY: "fake-radarr-key",
      JELLYFIN_URL: fakes.urls.jellyfin,
      JELLYFIN_API_KEY: "fake-jellyfin-key",
      SHOKO_URL: fakes.urls.shoko,
      SHOKO_API_KEY: "fake-shoko-key",
      QBIT_URL: fakes.urls.qbit,
      QBIT_USER: "admin",
      QBIT_PASS: "fake-qbit-pass",
      ANILIST_URL: fakes.urls.anilist,
      // Any token switches the list integration on; the fake never checks it.
      ANILIST_TOKEN: "fake-anilist-token",

      // Explicit blanks, so a value in the invoking shell cannot change what the test observes.
      ANILIST_ALLOW_WRITES: "",
      HIKARI_TOKEN: "",
      AUTH: "0",
      // The sweep would run against the fakes on a timer and write to Shoko; nothing here wants that.
      AUTO_LINK: "0",
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let log = "";
  const collect = chunk => {
    log += chunk;
    if (echo) process.stdout.write(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const stop = () => {
    if (!exited) child.kill("SIGKILL");
  };

  // The port answering is the only readiness signal that matters. Liveness is used rather than
  // /api/auth because it is the route the container healthcheck polls, so this waits on the same
  // thing production does.
  let up = false;
  for (let attempt = 0; attempt < 100 && !up && !exited; attempt += 1) {
    try {
      const res = await fetch(`${base}/api/health/live`);
      up = res.ok;
    } catch {}
    if (!up) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!up) {
    stop();
    throw new Error(`hikari did not start on ${base}:\n${log}`);
  }

  // Sends what the browser would: an Origin for Hono's csrf() and a JSON Content-Type on anything
  // carrying a body. Without the Origin every mutating call is refused with a 403 before it reaches
  // a route.
  const call = (path, { method = "GET", body, token, cookie } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: base,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { "X-Hikari-Token": token } : {}),
        ...(method !== "GET" ? { "Content-Type": "application/json" } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  return { base, port, dir, child, call, stop, logs: () => log };
}
