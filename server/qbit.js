import { config, enabled } from "./config.js";
import { cached, invalidate } from "./cache.js";
import { UpstreamError } from "./http.js";
import { timed } from "./metrics.js";
import { isAnimeTorrent } from "./health.js";

const NO_HASHES = new Map();

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

// A qBittorrent restart invalidates the cached session, so the first call afterwards answers 403.
// One fresh login and one retry, so that call does not fail just because the client restarted.
async function api(path, form = null) {
  try {
    return await call(path, form);
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 403) return call(path, form);
    throw err;
  }
}

async function call(path, form) {
  const cookie = await login();
  return timed("qbittorrent", async () => {
    const res = await fetch(`${config.qbit.url}/api/v2${path}`, {
      method: form ? "POST" : "GET",
      headers: {
        Cookie: cookie,
        Referer: config.qbit.url,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
      },
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.timeout(20000)
    });

    if (res.status === 403) {
      session = { cookie: null, expires: 0 };
      throw new UpstreamError("qbittorrent", 403, "session expired");
    }
    if (!res.ok) throw new UpstreamError("qbittorrent", res.status, await res.text());
    // Write endpoints answer 200 with an empty body.
    return form ? null : res.json();
  });
}

// Drops torrents from the client WITHOUT touching their data. Only ever called for torrents
// whose data is already gone (health.CLEARABLE_STATES), and the caller re-checks that against
// a fresh list first, so a stale page cannot remove a torrent that has since recovered.
// Batched so a long list does not blow the form size. A failure part-way is reported with how many
// were already removed, because those are gone either way and the caller has to say so.
export async function removeEntries(hashes) {
  if (!enabled.qbit) throw new Error("qBittorrent is not configured");
  let removed = 0;
  try {
    for (let i = 0; i < hashes.length; i += 50) {
      const batch = hashes.slice(i, i + 50);
      await api("/torrents/delete", { hashes: batch.join("|"), deleteFiles: "false" });
      removed += batch.length;
    }
    return { removed, error: null };
  } catch (err) {
    return { removed, error: err.message };
  } finally {
    invalidate("qbit:torrents");
  }
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
    // 200 cut off a third of a real 305-torrent client, which hid most of what needed cleaning.
    const list = await api("/torrents/info?sort=added_on&reverse=true&limit=1000");
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
      contentPath: t.content_path,
      addedOn: t.added_on,
      // The same rule the health panel uses, minus Sonarr's grab history (index.js adds that).
      isAnime: isAnimeTorrent({ hash: t.hash, category: t.category, savePath: t.save_path }, NO_HASHES, config.animeRoot)
    }));
  });
}
