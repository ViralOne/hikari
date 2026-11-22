// AniList covers and banners, served from Hikari's own address.
//
// The browser used to fetch every image from AniList's CDN directly. Two things made that slow: the
// cards asked for the 460px cover whatever their size, and a cover few people look at is often not
// in that CDN's cache, which costs a second on the first view. Served from here instead:
//
//   - a copy is kept on disk (IMAGE_CACHE_DIR, /cache/img by default), so after the first fetch
//     AniList is not involved at all, and the Discover rows' covers are fetched ahead of time;
//   - every response says it never changes (AniList puts a hash in each file name), so the browser
//     keeps it, and a CDN in front of Hikari such as Cloudflare keeps it at the edge near you.
//
// Only AniList's anime covers and banners can be fetched, by an exact path pattern on one fixed
// host, so this cannot be used to fetch anything else. The images are public, which is why this
// route sits outside the login: a CDN can only cache what it may hand to everyone.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ORIGIN = "https://s4.anilist.co/file/anilistcdn/";
// cover/large is AniList's "extraLarge" (460px), cover/medium "large" (230px), cover/small "medium" (100px).
const PATH = /^media\/anime\/(?:cover\/(?:large|medium|small)|banner)\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp|gif)$/;
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export const IMMUTABLE = "public, max-age=31536000, immutable";

const defaultDir = () => {
  if (process.env.IMAGE_CACHE_DIR !== undefined) return process.env.IMAGE_CACHE_DIR.trim();
  const snapshot = (process.env.CACHE_FILE || "").trim();
  return snapshot ? join(dirname(snapshot), "img") : "";
};
let dir = defaultDir();
let limitBytes = Math.max(Number(process.env.IMAGE_CACHE_MB) || 1024, 50) * 1024 * 1024;
const inflight = new Map();
const stats = { hits: 0, fetched: 0, failed: 0 };

export function configure({ directory, limitMb } = {}) {
  if (directory !== undefined) dir = directory;
  if (limitMb !== undefined) limitBytes = limitMb * 1024 * 1024;
}

export function allowed(path) {
  return typeof path === "string" && PATH.test(path);
}

// The path Hikari serves an AniList image at, or the URL unchanged when it is not one of AniList's.
export function localPath(url) {
  if (typeof url !== "string" || !url.startsWith(ORIGIN)) return url;
  const rest = url.slice(ORIGIN.length);
  return allowed(rest) ? `/img/anilist/${rest}` : url;
}

const fileFor = path => {
  const extension = path.split(".").pop().toLowerCase();
  return join(dir, `${createHash("sha256").update(path).digest("hex").slice(0, 40)}.${extension}`);
};
const typeFor = path => TYPES[path.split(".").pop().toLowerCase()] || "application/octet-stream";

// { body, type } for an allowed path, from disk or AniList; null when AniList has no such image.
export async function get(path) {
  if (!allowed(path)) return null;
  if (dir) {
    const file = fileFor(path);
    try {
      const body = readFileSync(file);
      stats.hits += 1;
      // Last use, for pruning. Cheap, and a failure here changes nothing.
      try { const now = new Date(); utimesSync(file, now, now); } catch {}
      return { body, type: typeFor(path) };
    } catch {}
  }
  if (inflight.has(path)) return inflight.get(path);
  const job = fetchAndStore(path).finally(() => inflight.delete(path));
  inflight.set(path, job);
  return job;
}

async function fetchAndStore(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(ORIGIN + path, { signal: controller.signal, redirect: "error" });
    if (response.status === 404) return null;
    const type = response.headers.get("content-type") || "";
    if (!response.ok || !type.startsWith("image/")) throw new Error(`AniList answered ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0 || body.length > MAX_BYTES) throw new Error("unexpected image size");
    stats.fetched += 1;
    if (dir) {
      try {
        mkdirSync(dir, { recursive: true });
        const file = fileFor(path);
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, body);
        renameSync(temp, file);
      } catch {}
    }
    return { body, type: typeFor(path) };
  } catch (err) {
    stats.failed += 1;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Fetches images ahead of time, a few at a time, skipping the ones already on disk. For the covers
// of the Discover rows, so even the first view of a card is answered from the NAS.
export async function prewarm(urls, { concurrency = 4 } = {}) {
  if (!dir) return 0;
  const paths = [...new Set(urls.map(localPath).filter(path => typeof path === "string" && path.startsWith("/img/anilist/")))]
    .map(path => path.slice("/img/anilist/".length))
    .filter(path => !existsSync(fileFor(path)));
  let done = 0;
  const queue = [...paths];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const path = queue.shift();
      try { if (await get(path)) done += 1; } catch {}
    }
  }));
  return done;
}

// Deletes the least recently used files once the folder is over its size limit, down to 90% of it.
export function prune() {
  if (!dir) return { removed: 0 };
  let entries;
  try {
    entries = readdirSync(dir).filter(name => !name.endsWith(".tmp")).map(name => {
      const file = join(dir, name);
      const stat = statSync(file);
      return { file, size: stat.size, used: stat.mtimeMs };
    });
  } catch {
    return { removed: 0 };
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= limitBytes) return { removed: 0, bytes: total };
  let removed = 0;
  for (const entry of entries.sort((a, b) => a.used - b.used)) {
    if (total <= limitBytes * 0.9) break;
    try { unlinkSync(entry.file); total -= entry.size; removed += 1; } catch {}
  }
  return { removed, bytes: total };
}

export function status() {
  return { dir: dir || null, limitMb: Math.round(limitBytes / 1024 / 1024), ...stats };
}

let timer = null;
export function start() {
  if (timer || !dir) return;
  timer = setInterval(prune, 60 * 60 * 1000);
  timer.unref?.();
  prune();
}
