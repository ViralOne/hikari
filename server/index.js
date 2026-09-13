import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { csrf } from "hono/csrf";

import { config, enabled } from "./config.js";
import { cached, loadSnapshot, saveSnapshot, stats as cacheStats } from "./cache.js";
import * as anilist from "./anilist.js";
import * as seerr from "./jellyseerr.js";
import * as sonarr from "./sonarr.js";
import * as qbit from "./qbit.js";
import * as jellyfin from "./jellyfin.js";
import * as radarr from "./radarr.js";
import * as shoko from "./shoko.js";
import * as anilistList from "./anilist-list.js";

const app = new Hono();

// Hono's c.req.json() parses the body regardless of Content-Type, so a cross-origin
// <form enctype="text/plain"> is a simple request that would reach the mutating routes.
// The origin check blocks that; requests without an Origin header (curl) still pass.
app.use("/api/*", csrf());

// Without an explicit directive browsers may heuristically cache these GETs, which showed a
// season as still requestable after it had already been requested.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// Optional shared secret for the state-changing routes. Unset = LAN-trusted, which is the
// same posture as the rest of the stack, but the port must then stay off the internet.
app.use("/api/request", requireToken);
app.use("/api/sonarr/*", requireToken);
app.use("/api/list/*", requireToken);

async function requireToken(c, next) {
  if (c.req.method === "GET" || !config.token) return next();

  const provided = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || c.req.header("x-hikari-token");
  if (provided !== config.token) return c.json({ error: "unauthorized" }, 401);
  return next();
}

app.onError((err, c) => {
  // csrf() and other middleware throw HTTPException with their own status/response.
  if (typeof err.getResponse === "function") {
    console.error(`[hikari] ${c.req.method} ${c.req.path} -> ${err.status ?? "?"} ${err.message}`);
    return err.getResponse();
  }

  const status = err.name === "UpstreamError" ? 502 : 500;
  // Upstream bodies carry internal paths, versions and config; log them, never return them.
  console.error(`[hikari] ${c.req.method} ${c.req.path} -> ${err.message}`, err.body ?? "");
  return c.json({ error: err.message, service: err.service ?? null }, status);
});

async function annotate(media) {
  const list = Array.isArray(media) ? media : [media];
  const listIndex = await anilistList.listIndex().catch(() => new Map());
  const enriched = await Promise.all(
    list.map(async item => {
      if (!item) return item;

      const [library, shokoInfo] = await Promise.all([
        sonarr.findMatch(item),
        shoko.infoFor(item).catch(() => null)
      ]);

      const [watch, movie] = await Promise.all([
        jellyfin.progressFor(item, library, shokoInfo).catch(() => null),
        radarr.findMatch(item).catch(() => null)
      ]);

      return { ...item, library: library || movie, isMovie: Boolean(movie), shoko: shokoInfo, watch, list: listIndex.get(item.id) || null };
    })
  );
  return Array.isArray(media) ? enriched : enriched[0];
}

app.get("/api/health", async c => {
  const checks = {};

  const probe = async (name, isEnabled, fn) => {
    if (!isEnabled) return { configured: false, ok: false, detail: "not configured" };
    try {
      return { configured: true, ok: true, detail: await fn() };
    } catch (err) {
      return { configured: true, ok: false, detail: err.message };
    }
  };

  const [jellyseerr, sonarrCheck, radarrCheck, qbitCheck, jellyfinCheck, shokoCheck, listCheck, anilistCheck] = await Promise.all([
    probe("jellyseerr", enabled.jellyseerr, async () => `v${(await seerr.status()).version}`),
    probe("sonarr", enabled.sonarr, async () => `${(await sonarr.series()).length} series`),
    probe("radarr", enabled.radarr, () => radarr.version()),
    probe("qbittorrent", enabled.qbit, () => qbit.version()),
    // Deliberately cheap: seriesIndex() is a full recursive Jellyfin listing and health is
    // polled every 60s, which would re-index forever from a single idle tab.
    probe("jellyfin", enabled.jellyfin, async () => `v${(await jellyfin.systemInfo()).Version}`),
    probe("shoko", enabled.shoko, async () => `${(await shoko.seriesIndex()).byAnidb.size} series`),
    probe("anilist list", enabled.anilistList, async () => (await anilistList.viewer()).name),
    probe("anilist", true, async () => `${(await anilist.page({ sort: ["TRENDING_DESC"], perPage: 1 })).media.length} ok`)
  ]);

  Object.assign(checks, {
    jellyseerr,
    sonarr: sonarrCheck,
    radarr: radarrCheck,
    qbittorrent: qbitCheck,
    jellyfin: jellyfinCheck,
    shoko: shokoCheck,
    anilistList: listCheck,
    anilist: anilistCheck
  });
  return c.json({ ok: Object.values(checks).every(x => x.ok || !x.configured), checks });
});

app.get("/api/discover", async c => {
  const now = anilist.currentSeason();
  const next = anilist.shiftSeason(now, 1);

  const [airing, trending, upcoming, top] = await Promise.all([
    anilist.page({ season: now.season, seasonYear: now.year, sort: ["POPULARITY_DESC"], perPage: 30 }),
    anilist.page({ sort: ["TRENDING_DESC"], perPage: 30 }),
    anilist.page({ season: next.season, seasonYear: next.year, sort: ["POPULARITY_DESC"], perPage: 30 }),
    anilist.page({ sort: ["SCORE_DESC"], perPage: 30 }, 6 * 60 * 60 * 1000)
  ]);

  const rows = await Promise.all(
    [
      { id: "airing", title: `Airing now · ${label(now)}`, media: airing.media },
      { id: "trending", title: "Trending this week", media: trending.media },
      { id: "upcoming", title: `Coming next · ${label(next)}`, media: upcoming.media },
      { id: "top", title: "Highest rated of all time", media: top.media }
    ].map(async row => ({ ...row, media: await annotate(row.media) }))
  );

  return c.json({ season: now, rows });
});

app.get("/api/schedule", async c => {
  const requested = Number(c.req.query("days") ?? 7);
  // NaN survives Math.min/Math.max and would send an unbounded window to AniList while
  // minting a permanent cache entry, so reject it before clamping.
  const days = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 14) : 7;

  // Bucket the window to 15 minutes. A per-second `from` made the cache key unique on every
  // request, so the schedule was refetched from AniList every single time.
  const bucket = 15 * 60;
  const from = Math.floor(Date.now() / 1000 / bucket) * bucket - 3600;
  const to = from + days * 86400;

  const items = await anilist.schedule(from, to);
  const annotated = await annotate(items.map(x => x.media));

  return c.json({
    from,
    to,
    items: items.map((entry, index) => ({ episode: entry.episode, airingAt: entry.airingAt, media: annotated[index] }))
  });
});

app.get("/api/search", async c => {
  const q = (c.req.query("q") || "").trim();
  const season = c.req.query("season") || undefined;
  const year = c.req.query("year") ? Number(c.req.query("year")) : undefined;
  const format = c.req.query("format") || undefined;
  const genre = c.req.query("genre") || undefined;

  if (!q && !season && !year && !genre && !format) return c.json({ media: [] });

  const result = await anilist.page(
    {
      search: q || undefined,
      season,
      seasonYear: year,
      genre,
      format_in: format ? [format] : undefined,
      sort: q ? ["SEARCH_MATCH"] : ["POPULARITY_DESC"],
      perPage: 40
    },
    5 * 60 * 1000
  );

  return c.json({ total: result.total, media: await annotate(result.media) });
});

app.get("/api/anime/:id", async c => {
  // A non-integer id becomes NaN, which JSON.stringify turns into a null GraphQL variable.
  // AniList then drops the id filter entirely and returns an arbitrary title.
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "id must be a positive integer" }, 400);

  const anime = await anilist.byId(id);
  if (!anime) return c.json({ error: "not found" }, 404);

  const [library, request] = await Promise.all([
    sonarr.findMatch(anime),
    enabled.jellyseerr ? seerr.resolve(anime).catch(err => ({ matched: false, error: err.message })) : Promise.resolve(null)
  ]);

  const shokoInfo = await shoko.infoFor(anime, request?.tmdbId).catch(() => null);
  const [movie, listEntry, files] = await Promise.all([
    radarr.findMatch(anime, request?.tmdbId).catch(() => null),
    anilistList.entryFor(anime.id).catch(() => null),
    shokoInfo ? shoko.fileDetail(shokoInfo.shokoId).catch(() => null) : Promise.resolve(null)
  ]);

  const [routing, watch] = await Promise.all([
    describeRouting(request).catch(() => null),
    jellyfin.progressFor(anime, library, shokoInfo).catch(() => null)
  ]);

  const episodes = watch ? await jellyfin.episodeProgress(watch.ids).catch(() => null) : null;

  return c.json({
    ...anime,
    library: library || movie,
    isMovie: Boolean(movie),
    shoko: shokoInfo ? { ...shokoInfo, files } : null,
    list: listEntry,
    request,
    routing,
    watch: watch ? { ...watch, episodes } : null,
    links: seerr.links(anime, request)
  });
});

app.post("/api/request", async c => {
  const body = await c.req.json();
  const { tmdbId, mediaType } = body;
  let seasons = body.seasons;

  if (!tmdbId || !mediaType) return c.json({ error: "tmdbId and mediaType are required" }, 400);
  if (mediaType !== "tv" && mediaType !== "movie") return c.json({ error: "mediaType must be tv or movie" }, 400);
  if (mediaType === "tv" && seasons !== "all" && !Array.isArray(seasons)) {
    return c.json({ error: "seasons must be 'all' or an array of season numbers" }, 400);
  }

  // Drop seasons Jellyseerr already tracks, so a stale UI or a direct API call cannot create
  // a duplicate request. "all" is expanded here for the same reason.
  if (mediaType === "tv") {
    const detail = await seerr.tvDetail(tmdbId).catch(() => null);
    if (detail) {
      const taken = seerr.takenSeasons(detail);

      const requestedSeasons =
        seasons === "all"
          ? (detail.seasons || []).filter(season => season.seasonNumber > 0).map(season => season.seasonNumber)
          : seasons.map(Number);

      const fresh = requestedSeasons.filter(number => !taken.has(number));

      if (fresh.length === 0) {
        return c.json(
          {
            error: `Already requested in Jellyseerr: season${taken.size === 1 ? "" : "s"} ${[...taken.keys()].sort((a, b) => a - b).join(", ")}. Nothing new to request.`,
            service: "jellyseerr",
            alreadyRequested: [...taken.keys()].sort((a, b) => a - b)
          },
          409
        );
      }

      seasons = fresh;
    }
  }

  // TMDB does not tag every anime with keyword 210024. When it has not, Jellyseerr would
  // apply the standard TV profile and root folder, so send the anime targets explicitly.
  let overrides;
  let forced = null;
  if (body.forceAnime && mediaType === "tv") {
    const servers = await seerr.sonarrServers();
    const server = servers.find(s => s.isDefault && !s.is4k) || servers[0];

    // Refuse rather than silently fall back: without the override this request lands in the
    // standard TV root with the standard profile, which is the failure being prevented.
    if (!server || !server.activeAnimeProfileId || !server.activeAnimeDirectory) {
      return c.json(
        {
          error:
            "Anime override required but Jellyseerr has no anime profile or root folder configured on its Sonarr server. Set them in Jellyseerr, or request from Jellyseerr directly.",
          service: "jellyseerr"
        },
        409
      );
    }

    overrides = {
      serverId: server.id,
      profileId: server.activeAnimeProfileId,
      rootFolder: server.activeAnimeDirectory,
      ...((server.animeTags || []).length > 0 ? { tags: server.animeTags } : {})
    };
    forced = { profileId: overrides.profileId, rootFolder: overrides.rootFolder };
  }

  const created = await seerr.createRequest({ tmdbId, mediaType, seasons, overrides });
  return c.json({
    ok: true,
    requestId: created.id,
    status: created.status,
    media: created.media?.status ?? null,
    forcedAnime: forced
  });
});

app.get("/api/list", async c => {
  const me = await anilistList.viewer();
  if (!me) return c.json({ configured: false, entries: [] });

  const index = await anilistList.listIndex();
  const status = c.req.query("status");

  const entries = [...index.entries()]
    .map(([anilistId, entry]) => ({ anilistId, ...entry }))
    .filter(entry => (status ? entry.status === status : true))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return c.json({ configured: true, user: me, writable: config.anilist.allowWrites, entries });
});

app.post("/api/list/:anilistId", async c => {
  const anilistId = Number(c.req.param("anilistId"));
  if (!Number.isInteger(anilistId) || anilistId <= 0) {
    return c.json({ error: "anilistId must be a positive integer" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const saved = await anilistList.saveEntry({
    mediaId: anilistId,
    status: body.status,
    progress: body.progress,
    score: body.score
  });

  return c.json({ ok: true, entry: saved });
});

// Sonarr's seriesType cannot be set through Jellyseerr, so it is repaired here.
app.post("/api/sonarr/series/:id/series-type", async c => {
  const body = await c.req.json().catch(() => ({}));
  const seriesType = body.seriesType || "anime";

  if (!["anime", "standard", "daily"].includes(seriesType)) {
    return c.json({ error: "seriesType must be anime, standard or daily" }, 400);
  }

  const result = await sonarr.setSeriesType(Number(c.req.param("id")), seriesType);
  return c.json({ ok: true, ...result });
});

app.get("/api/activity", async c => {
  // An unreachable service must not look like "nothing to show", so each section carries
  // its own error instead of collapsing to an empty array.
  const section = async (isEnabled, fn) => {
    if (!isEnabled) return { data: [], error: null, configured: false };
    try {
      return { data: await fn(), error: null, configured: true };
    } catch (err) {
      return { data: [], error: err.message, configured: true };
    }
  };

  const [queueSection, torrentSection, requestSection] = await Promise.all([
    section(enabled.sonarr, () => sonarr.queue()),
    section(enabled.qbit, () => qbit.torrents()),
    section(enabled.jellyseerr, () => seerr.requests(25))
  ]);

  const queue = queueSection.data;
  const torrents = torrentSection.data;
  const requests = requestSection.data;

  return c.json({
    errors: {
      queue: queueSection.error,
      torrents: torrentSection.error,
      requests: requestSection.error
    },
    queue,
    torrents: torrents.filter(t => t.isAnime || t.active).slice(0, 60),
    requests: requests.map(r => ({
      id: r.id,
      status: r.status,
      mediaType: r.type,
      tmdbId: r.media?.tmdbId ?? null,
      mediaStatus: seerr.STATUS[r.media?.status] || "unknown",
      seasons: (r.seasons || []).map(s => s.seasonNumber),
      requestedBy: r.requestedBy?.displayName || null,
      createdAt: r.createdAt
    }))
  });
});

// Flat counters for a gethomepage customapi widget. Deliberately shallow and cheap:
// everything here is already cached, so Homepage polling it does not hit upstreams.
app.get("/api/homepage", async c => c.json(await homepageSnapshot()));

// Homepage polls this on a fixed interval, so the whole payload is cached for longer than
// the underlying TTLs. Otherwise a 60s poll misses the 15s Sonarr/qBittorrent caches every
// time and permanently loads all four upstreams.
function homepageSnapshot() {
  return cached("hikari:homepage", 60 * 1000, async () => {
    const now = anilist.currentSeason();

    const [season, queue, torrents, requests] = await Promise.all([
      // Same shape as /api/discover's "airing" row so they share one AniList cache entry.
      anilist
        .page({ season: now.season, seasonYear: now.year, sort: ["POPULARITY_DESC"], perPage: 30 })
        .catch(() => null),
      enabled.sonarr ? sonarr.queue().catch(() => []) : [],
      enabled.qbit ? qbit.torrents().catch(() => []) : [],
      enabled.jellyseerr ? seerr.requests(25).catch(() => []) : []
    ]);

    const airing = season ? await annotate(season.media).catch(() => season.media) : [];
    const downloading = torrents.filter(torrent => torrent.active);

    return snapshotBody(now, airing, queue, downloading, requests);
  });
}

function snapshotBody(now, airing, queue, downloading, requests) {
  return {
    season: `${now.season.charAt(0)}${now.season.slice(1).toLowerCase()} ${now.year}`,
    airing: airing.length,
    inLibrary: airing.filter(item => item.library).length,
    watching: airing.filter(item => item.watch?.started && !item.watch?.finished).length,
    unwatched: airing.reduce((sum, item) => sum + (item.watch?.unplayed ?? 0), 0),
    missing: airing.reduce((sum, item) => {
      const gap = (item.watch?.aired ?? 0) - (item.watch?.onDisk ?? 0);
      return sum + (item.watch && gap > 0 ? gap : 0);
    }, 0),
    queue: queue.length,
    downloading: downloading.length,
    pendingRequests: requests.filter(request => request.status === 1).length
  };
}

const distDir = new URL("../dist/", import.meta.url);
const hasBuild = existsSync(new URL("index.html", distDir));

if (hasBuild) {
  // Vite content-hashes these, so they are immutable. serveStatic sets no headers by default,
  // which made every navigation revalidate them.
  app.use(
    "/assets/*",
    serveStatic({
      root: "./dist",
      onFound: (_path, c) => c.header("Cache-Control", "public, max-age=31536000, immutable")
    })
  );

  app.get("*", async c => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
    const html = await readFile(new URL("index.html", distDir), "utf8");
    c.header("Cache-Control", "no-cache");
    return c.html(html);
  });
}

function label({ season, year }) {
  return `${season.charAt(0)}${season.slice(1).toLowerCase()} ${year}`;
}

// Predicts where Jellyseerr will actually send this request. Jellyseerr only applies its
// anime overrides when TMDB carries keyword 210024, so a title TMDB has not tagged lands
// in the regular TV profile and root folder instead.
async function describeRouting(request) {
  if (!enabled.jellyseerr || !request?.matched || request.mediaType !== "tv") return null;

  const [servers, profiles, clients] = await Promise.all([
    seerr.sonarrServers(),
    enabled.sonarr ? sonarr.qualityProfiles().catch(() => ({})) : {},
    enabled.sonarr ? sonarr.downloadClients().catch(() => []) : []
  ]);

  const server = servers.find(s => s.isDefault && !s.is4k) || servers[0];
  if (!server) return null;

  const treatedAsAnime = request.animeKeyword === true;

  // Everything Hikari lists comes from AniList, so it is anime regardless of TMDB's keyword.
  // Requests always target the anime profile and root; the flag only says whether an override
  // was needed to get there.
  const profileId = server.activeAnimeProfileId;
  const rootFolder = server.activeAnimeDirectory;

  return {
    server: server.name,
    treatedAsAnime,
    overridden: !treatedAsAnime,
    animeKeyword: request.animeKeyword,
    profileId,
    profileName: profiles[profileId] ?? null,
    rootFolder,
    seriesType: server.animeSeriesType || "anime",
    // Sonarr sets the qBittorrent category per download client, not per series.
    categories: clients.map(client => ({ client: client.name, category: client.category, tags: client.tags })),
    animeTagsConfigured: (server.animeTags || []).length > 0
  };
}

const restored = loadSnapshot();

// Persist on the way out and periodically, so a restart or crash keeps the AniList data.
let saving = false;
const flush = async () => {
  if (saving) return;
  saving = true;
  await saveSnapshot();
  saving = false;
};
setInterval(flush, 5 * 60 * 1000).unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    const saved = await saveSnapshot();
    console.log(`[hikari] saved ${saved} cache entries, exiting`);
    process.exit(0);
  });
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
  console.log(`[hikari] api on http://0.0.0.0:${info.port}${hasBuild ? " (serving dist/)" : " (dev: run vite separately)"}`);
  for (const [name, on] of Object.entries(enabled)) {
    console.log(`[hikari]   ${on ? "on " : "off"} ${name}`);
  }
  const snapshot = cacheStats().snapshot;
  if (snapshot) console.log(`[hikari]   cache snapshot ${snapshot} (${restored} entries restored)`);
});
