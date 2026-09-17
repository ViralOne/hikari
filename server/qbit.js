import { config, enabled } from "./config.js";
import { cached } from "./cache.js";
import { UpstreamError } from "./http.js";
import { timed } from "./metrics.js";

let session = { cookie: null, expires: 0 };

async function login() {
  if (session.cookie && session.expires > Date.now()) return session.cookie;

  const body = new URLSearchParams({ username: config.qbit.user, password: config.qbit.pass });
  // qBittorrent bypasses http.request() because of its cookie login, so its calls are timed here to
  // keep it in the same latency table as everything else. The body read and the status check sit
  // inside the timed block so a rejected login counts as a failed call, not a fast success.
  const res = await timed("qbittorrent", async () => {
    const response = await fetch(`${config.qbit.url}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: config.qbit.url },
      body,
      signal: AbortSignal.timeout(15000)
    });
    const text = (await response.text()).trim();
    if (!response.ok || (text && text !== "Ok.")) {
      throw new UpstreamError("qbittorrent", response.status, text || "login rejected");
    }
    return response;
  });

  const cookie = (res.headers.getSetCookie?.() || [])
    .map(value => value.split(";")[0])
    .find(value => /^(?:QBT_)?SID/i.test(value));

  if (!cookie) throw new UpstreamError("qbittorrent", res.status, "no session cookie returned");

  session = { cookie, expires: Date.now() + 25 * 60 * 1000 };
  return cookie;
}

async function api(path) {
  const cookie = await login();
  return timed("qbittorrent", async () => {
    const res = await fetch(`${config.qbit.url}/api/v2${path}`, {
      headers: { Cookie: cookie, Referer: config.qbit.url },
      signal: AbortSignal.timeout(20000)
    });

    if (res.status === 403) {
      session = { cookie: null, expires: 0 };
      throw new UpstreamError("qbittorrent", 403, "session expired");
    }
    if (!res.ok) throw new UpstreamError("qbittorrent", res.status, await res.text());
    return res.json();
  });
}

const ACTIVE = new Set(["downloading", "metaDL", "stalledDL", "queuedDL", "forcedDL", "checkingDL", "allocating"]);

export function version() {
  return cached("qbit:version", 5 * 60 * 1000, async () => {
    const cookie = await login();
    return timed("qbittorrent", async () => {
      const res = await fetch(`${config.qbit.url}/api/v2/app/version`, {
        headers: { Cookie: cookie, Referer: config.qbit.url },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new UpstreamError("qbittorrent", res.status, await res.text());
      return (await res.text()).trim();
    });
  });
}

export function torrents() {
  if (!enabled.qbit) return Promise.resolve([]);
  return cached("qbit:torrents", 15 * 1000, async () => {
    const list = await api("/torrents/info?sort=added_on&reverse=true&limit=200");
    return list.map(t => ({
      hash: t.hash,
      name: t.name,
      category: t.category || null,
      tags: (t.tags || "").split(",").map(x => x.trim()).filter(Boolean),
      state: t.state,
      active: ACTIVE.has(t.state),
      progress: t.progress,
      size: t.size,
      downloaded: t.downloaded,
      dlspeed: t.dlspeed,
      upspeed: t.upspeed,
      ratio: Number((t.ratio ?? 0).toFixed(3)),
      eta: t.eta,
      savePath: t.save_path,
      addedOn: t.added_on,
      isAnime: (t.save_path || "").includes(config.animeRoot) || (t.category || "").toLowerCase().includes("anime")
    }));
  });
}
