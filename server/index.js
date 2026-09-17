import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
import * as sequels from "./sequels.js";
import * as planning from "./planning.js";
import * as autolink from "./autolink.js";
import * as warm from "./warm.js";
import * as hidden from "./hidden.js";
import * as reconcile from "./reconcile.js";
import * as settings from "./settings.js";
import * as auth from "./auth.js";
import { withinADay } from "./dates.js";
import { request } from "./http.js";
import { hit as rateHit } from "./ratelimit.js";
import { upstreamStats } from "./metrics.js";

const app = new Hono();

// The socket address is the reverse proxy when there is one, so the forwarded header is only
// believed if you say there is a proxy in front. Otherwise anyone could spoof it and walk around
// the per-address limits.
const clientAddress = c => {
  if (config.trustProxy) {
    // The RIGHTMOST entry, not the leftmost. A proxy appends the peer it actually spoke to, so the
    // left of the list is whatever the client sent: reading it let anyone mint a fresh rate-limit
    // bucket per request, and pin a lockout on someone else's address.
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return c.env?.incoming?.socket?.remoteAddress || "unknown";
};

// Headers that cost nothing and remove whole categories of problem: no sniffing, no framing, no
// referrer leaking the address of a private instance, and a policy tight enough that an injected
// script has nowhere to send anything.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // AniList serves every cover and banner. data: covers the inline SVG icons.
      "img-src 'self' data: https://s4.anilist.co https://img.anili.st",
      // Vite injects the stylesheet and the app sets style attributes.
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "script-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'"
    ].join("; ")
  );
});

// A blunt ceiling per address. High enough that the UI polling health every 60s and opening
// panels never notices, low enough that scraping or a guessing loop hits a wall.
app.use("/api/*", async (c, next) => {
  const check = rateHit(`api:${clientAddress(c)}`, { max: config.rateLimit, windowMs: 60 * 1000 });
  if (!check.allowed) {
    c.header("Retry-After", String(check.retryIn));
    return c.json({ error: `too many requests, try again in ${check.retryIn}s` }, 429);
  }
  return next();
});

// Nothing this API accepts is large, and an unbounded body is free memory for anyone who asks.
// Hono's own middleware measures the stream rather than trusting Content-Length, which a chunked
// request simply omits.
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 64 * 1024,
    onError: c => c.json({ error: "request body too large" }, 413)
  })
);

// Hono's c.req.json() parses the body regardless of Content-Type, so a cross-origin
// <form enctype="text/plain"> is a simple request that would reach the mutating routes.
// The origin check blocks that. A caller that sends application/json is let through whatever its
// origin, because a browser cannot send that cross-origin without a preflight nobody answers, so
// this is not a substitute for authenticating a route.
app.use("/api/*", csrf());

// Without an explicit directive browsers may heuristically cache these GETs, which showed a
// season as still requestable after it had already been requested.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// The shared secret, wherever a request may carry one instead of a cookie.
const bearerToken = c => c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || c.req.header("x-hikari-token");
const hasToken = c => {
  const provided = bearerToken(c);
  return Boolean(config.token && provided && sameSecret(provided, config.token));
};

const sessionFor = c => auth.verify(auth.readCookie(c.req.header("cookie")));

// A Jellyfin-backed session, when it is switched on. Everything under /api is gated except the
// auth routes, which have to be reachable to sign in, and the webhook when a token protects it.
app.use("/api/*", async (c, next) => {
  if (!config.auth.enabled) return next();

  const path = c.req.path;
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return next();
  // The container healthcheck is a bare fetch with no cookie and no token, so turning the login on
  // used to mark the container unhealthy for as long as it stayed on. Liveness is exempt because it
  // says nothing beyond "the process is answering". The detailed /api/health is not, because it
  // names every configured service and its version.
  if (path === "/api/health/live") return next();
  // Sonarr's Connect cannot hold a cookie, so the webhook is exempt, but only when the shared
  // secret is actually set. Exempting it unconditionally left it open on a login-only install.
  if (path.startsWith("/api/hooks/") && config.token) return next();

  // Deliberately not gated on enabled.jellyfin. Clearing or rotating the Jellyfin key used to turn
  // the whole gate off and silently make a private instance public; a security control should fail
  // closed. The recovery is documented: remove the auth block from the settings file and restart.
  if (!enabled.jellyfin) {
    if (hasToken(c)) return next();
    return c.json({ error: "login is switched on but Jellyfin is not configured, so nobody can sign in" }, 503);
  }

  if (sessionFor(c)) return next();

  // A script with the shared secret is still allowed through: automation cannot hold a cookie.
  if (hasToken(c)) return next();

  return c.json({ error: "sign in required" }, 401);
});

// Only trust the forwarded protocol when a proxy is declared, for the same reason as the address.
const isHttps = c =>
  (config.trustProxy && c.req.header("x-forwarded-proto") === "https") ||
  new URL(c.req.url).protocol === "https:";

// Optional shared secret for the state-changing routes. Unset = LAN-trusted, which is the
// same posture as the rest of the stack, but the port must then stay off the internet.
app.use("/api/request", requireToken);
app.use("/api/sonarr/*", requireToken);
app.use("/api/list/*", requireToken);
app.use("/api/shoko/*", requireToken);
app.use("/api/jellyfin/*", requireToken);
app.use("/api/autolink", requireToken);
app.use("/api/hooks/*", requireToken);
app.use("/api/hidden/*", requireToken);
app.use("/api/settings", requireToken);
app.use("/api/settings/*", requireToken);

// The settings hold every service address and can point Jellyfin itself somewhere else, which would
// send the next person's password to a host of the attacker's choosing. So when login is on, they
// belong to Jellyfin administrators, not to everyone in the household with an account.
app.use("/api/settings", requireAdmin);
app.use("/api/settings/*", requireAdmin);

async function requireAdmin(c, next) {
  if (!config.auth.enabled || !enabled.jellyfin) return next();
  // A caller holding the shared secret is automation the owner set up, not a household account.
  if (hasToken(c)) return next();

  const session = sessionFor(c);
  if (!session) return c.json({ error: "sign in required" }, 401);
  if (!session.admin) return c.json({ error: "only Jellyfin administrators can change the settings" }, 403);
  return next();
}

async function requireToken(c, next) {
  if (!config.token) return next();
  // Reads are exempt except for the settings, which describe every service address, the
  // qBittorrent username and the last four characters of every key. That is a network map, not
  // an anime catalogue.
  if (c.req.method === "GET" && !c.req.path.startsWith("/api/settings")) return next();

  // A signed-in session satisfies this too. The token exists to authenticate callers that cannot
  // hold a cookie; a verified Jellyfin login is a stronger credential than a shared secret, not a
  // weaker one, and without this the browser UI went read-only the moment a token existed, which
  // made the token and the login mutually exclusive. Settings stay administrator-only regardless,
  // because requireAdmin runs on top of this.
  if (config.auth.enabled && sessionFor(c)) return next();

  // A query token is accepted on the webhook only, because Sonarr's Connect cannot send custom
  // headers. Everywhere else it would just be a token in your access logs and Referer headers
  // for no benefit.
  const fromQuery = c.req.path.startsWith("/api/hooks/") ? c.req.query("token") : undefined;
  const provided =
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || c.req.header("x-hikari-token") || fromQuery;
  if (!sameSecret(provided, config.token)) return c.json({ error: "unauthorized" }, 401);
  return next();
}

// Length is compared first because timingSafeEqual throws on a mismatch, and the length of a
// shared secret is not what anyone is trying to keep quiet. Byte length, not string length: one
// multi-byte character otherwise reached timingSafeEqual and threw, giving a 500 instead of a 401.
function sameSecret(provided, expected) {
  if (typeof provided !== "string") return false;
  const given = Buffer.from(provided, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

app.onError((err, c) => {
  // csrf() and other middleware throw HTTPException with their own status/response.
  if (typeof err.getResponse === "function") {
    console.error(`[hikari] ${c.req.method} ${c.req.path} -> ${err.status ?? "?"} ${err.message}`);
    return err.getResponse();
  }

  const status = err.httpStatus ?? (err.name === "UpstreamError" ? 502 : 500);
  // Upstream bodies carry internal paths, versions and config; log them, never return them.
  console.error(`[hikari] ${c.req.method} ${c.req.path} -> ${err.message}`, err.body ?? "");
  return c.json({ error: err.message, service: err.service ?? null }, status);
});

// Collects per-service failures so a broken integration is reported rather than rendering as
// an empty library. /api/activity already did this; the annotate path did not.
async function annotate(media, problems = {}) {
  const list = Array.isArray(media) ? media : [media];
  const note = (service, err) => {
    if (!problems[service]) problems[service] = err.message;
    return null;
  };

  const listIndex = await anilistList.listIndex().catch(err => {
    note("anilistList", err);
    return new Map();
  });
  const enriched = await Promise.all(
    list.map(async item => {
      if (!item) return item;

      // Shoko first: it supplies the TvDB id that makes the Sonarr match exact. Its index is
      // one cached call for the whole library, so the extra await costs nothing per item.
      const shokoInfo = await shoko.infoFor(item).catch(err => note("shoko", err));

      const [library, movie] = await Promise.all([
        sonarr.findMatch(item, shokoInfo).catch(err => note("sonarr", err)),
        radarr.findMatch(item).catch(err => note("radarr", err))
      ]);

      const watch = await jellyfin.progressFor(item, library, shokoInfo).catch(err => note("jellyfin", err));

      return { ...item, library, movie, shoko: shokoInfo, watch, list: listIndex.get(item.id) || null };
    })
  );
  return Array.isArray(media) ? enriched : enriched[0];
}

// Liveness, not readiness: it answers as long as the process is serving, and deliberately reveals
// nothing about the configuration. This is what the container healthcheck polls, so an upstream
// service being down is never a reason to restart Hikari.
app.get("/api/health/live", c => c.json({ ok: true }));

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
    probe("sonarr", enabled.sonarr, () => sonarr.version()),
    probe("radarr", enabled.radarr, () => radarr.version()),
    probe("qbittorrent", enabled.qbit, () => qbit.version()),
    // Deliberately cheap: seriesIndex() is a full recursive Jellyfin listing and health is
    // polled every 60s, which would re-index forever from a single idle tab.
    probe("jellyfin", enabled.jellyfin, async () => `v${(await jellyfin.systemInfo()).Version}`),
    probe("shoko", enabled.shoko, () => shoko.version()),
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
  // The probes say whether a service answers; the cache and latency figures say how the app has
  // been getting on with them since boot, which is the half of "is it healthy" a green dot hides.
  // The snapshot path stays out of the response: it is a filesystem detail the boot log already has.
  const { snapshot, ...cache } = cacheStats();
  return c.json({
    ok: Object.values(checks).every(x => x.ok || !x.configured),
    checks,
    uptimeSeconds: Math.round(process.uptime()),
    cache: { ...cache, persisted: Boolean(snapshot) },
    upstream: upstreamStats()
  });
});

app.get("/api/discover", async c => {
  warm.noteActivity();
  return c.json(await buildDiscover());
});

// The Discover page as one object. Split from the route because the warmer calls it too: once on
// boot so the first open answers from memory, and afterwards to keep the entries behind it fresh.
async function buildDiscover() {
  const now = anilist.currentSeason();
  const next = anilist.shiftSeason(now, 1);

  const problems = {};

  const [airing, trending, upcoming, top, continuing, plannedMedia] = await Promise.all([
    anilist.page({ season: now.season, seasonYear: now.year, sort: ["POPULARITY_DESC"], perPage: 30 }, undefined, { persist: true }),
    anilist.page({ sort: ["TRENDING_DESC"], perPage: 30 }, undefined, { persist: true }),
    anilist.page({ season: next.season, seasonYear: next.year, sort: ["POPULARITY_DESC"], perPage: 30 }, undefined, { persist: true }),
    anilist.page({ sort: ["SCORE_DESC"], perPage: 30 }, 6 * 60 * 60 * 1000, { persist: true }),
    // Needs your list, so it is empty without a token, and a failure here must not cost you the
    // whole page: the other four rows do not depend on it.
    sequels.sequels().catch(err => {
      problems.anilistList = err.message;
      return [];
    }),
    planning.planned().catch(err => {
      problems.anilistList = err.message;
      return [];
    })
  ]);

  const rows = await Promise.all(
    [
      // First when there is anything in it. A sequel to something you finished beats anything a
      // popularity sort can offer, which is the whole reason the row exists.
      { id: "continuing", title: "Continue the story", media: continuing },
      // Which planned titles are ready depends on the library, so this row is filtered after
      // annotate rather than before like the others.
      { id: "planning", title: "Ready to start", media: plannedMedia, ready: true },
      { id: "airing", title: `Airing now · ${label(now)}`, media: airing.media },
      { id: "trending", title: "Trending this week", media: trending.media },
      { id: "upcoming", title: `Coming next · ${label(next)}`, media: upcoming.media },
      { id: "top", title: "Highest rated of all time", media: top.media }
    ].map(async ({ ready, ...row }) => {
      const annotated = await annotate(hidden.filter(row.media), problems);
      return { ...row, media: ready ? planning.readyToStart(annotated) : annotated };
    })
  );

  return { season: now, rows, errors: problems };
}

// The same row Discover shows, on its own, so it can be polled or read without paying for the
// other four rows.
app.get("/api/sequels", async c => {
  if (!enabled.anilistList) {
    return c.json({ configured: false, media: [], detail: "Needs an AniList token to read your list" });
  }
  const problems = {};
  const media = await annotate(hidden.filter(await sequels.sequels()), problems);
  return c.json({ configured: true, media, errors: problems });
});

// "Not interested". Anyone signed in may hide a title; it is a view preference, not configuration,
// so it is not behind the administrator gate the settings are.
app.get("/api/hidden", c => c.json({ hidden: hidden.list() }));

app.post("/api/hidden/:id", async c => {
  const body = await c.req.json().catch(() => ({}));
  const title = typeof body?.title === "string" ? body.title : "";
  return c.json(hidden.hide(c.req.param("id"), title));
});

app.delete("/api/hidden/:id", c => c.json(hidden.show(c.req.param("id"))));

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

  const items = hidden.filter(await anilist.schedule(from, to), entry => entry.media);
  const problems = {};
  const annotated = await annotate(items.map(x => x.media), problems);

  return c.json({
    from,
    to,
    errors: problems,
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

  const problems = {};
  const annotated = await annotate(result.media, problems);
  return c.json({ total: result.total, media: annotated, errors: problems });
});

// The composed body sits on top of seerr's own detail cache, so the two TTLs add up: a request
// state changed in Jellyseerr directly (which no invalidate() can see) is visible after at most
// seerr.DETAIL_TTL_MS plus this. Half of seerr's TTL keeps that worst case at 45s. Changes made
// through Hikari clear this entry immediately: invalidate() sweeps composed "hikari:" entries
// whenever any upstream it was built from is invalidated.
const ANIME_DETAIL_TTL_MS = seerr.DETAIL_TTL_MS / 2;

app.get("/api/anime/:id", async c => {
  // A non-integer id becomes NaN, which JSON.stringify turns into a null GraphQL variable.
  // AniList then drops the id filter entirely and returns an arbitrary title.
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "id must be a positive integer" }, 400);

  const composed = await cached(`hikari:anime:${id}`, ANIME_DETAIL_TTL_MS, () => composeAnime(id));
  if (!composed) return c.json({ error: "not found" }, 404);

  // `narrowing` is the detached post-request correction, which finishes long after the request
  // response and is read live rather than composed, because the panel polls this route to follow it.
  const narrowing = reconcile.statusFor(id);
  const inspection = composed.inspection;
  const cours = inspection || narrowing ? { ...(inspection || {}), narrowing } : null;

  // Read live rather than composed: hiding is the one edit that must show on the very next read.
  return c.json({ ...composed.body, cours, hidden: hidden.isHidden(id) });
});

async function composeAnime(id) {
  const anime = await anilist.byId(id);
  if (!anime) return null;

  const [shokoInfo, request] = await Promise.all([
    shoko.infoFor(anime).catch(() => null),
    enabled.jellyseerr ? seerr.resolve(anime).catch(err => ({ matched: false, error: err.message })) : Promise.resolve(null)
  ]);

  // Sonarr's match only needs shokoInfo, so it joins the fan-out rather than holding a round trip
  // of its own in front of it.
  const [library, movie, listEntry, files] = await Promise.all([
    sonarr.findMatch(anime, shokoInfo).catch(() => null),
    radarr.findMatch(anime, request?.tmdbId).catch(() => null),
    anilistList.entryFor(anime.id).catch(() => null),
    shokoInfo ? shoko.fileDetail(shokoInfo.shokoId).catch(() => null) : Promise.resolve(null)
  ]);

  const [report, routing, watch, inspection] = await Promise.all([
    // Reconciled here rather than behind a button: "3 missing" on its own sent me looking for a
    // download that had already happened. Everything it needs is cached by this point, which is
    // also why it can run alongside the rest instead of ahead of them.
    shokoInfo && files?.missing?.length ? missingReport(id).catch(() => null) : Promise.resolve(null),
    describeRouting(request).catch(() => null),
    jellyfin.progressFor(anime, library, shokoInfo).catch(() => null),
    // Whether TMDB has folded several of Sonarr's seasons into one, which is what makes a plain
    // Jellyseerr season request unable to express the cour that was asked for.
    request?.matched && request.mediaType === "tv"
      ? reconcile.inspect({ anime, tmdbSeasons: request.seasons, library }).catch(() => null)
      : Promise.resolve(null)
  ]);

  const episodes = watch ? await jellyfin.episodeProgress(watch.ids).catch(() => null) : null;

  return {
    inspection,
    body: {
      ...anime,
      library,
      movie,
      shoko: shokoInfo ? { ...shokoInfo, files, report: report?.error ? null : report } : null,
      list: listEntry,
      request,
      routing,
      watch: watch ? { ...watch, episodes } : null,
      links: seerr.links(anime, request)
    }
  };
}

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

  // TMDB folds several of Sonarr's seasons into one for a lot of anime, so the season number just
  // sent cannot say which cour was meant. Correct Sonarr once Jellyseerr has added the series.
  // Detached: it waits on Sonarr and on the download queue, which takes far longer than a request
  // should. The result is reported through the detail route.
  let narrowing = null;
  if (mediaType === "tv" && body.anilistId && enabled.sonarr) {
    const anime = await anilist.byId(Number(body.anilistId)).catch(() => null);
    const detail = await seerr.tvDetail(tmdbId).catch(() => null);

    // The library match matters: without Sonarr's episodes, inspect can only see seasons TMDB has
    // folded together and misses the opposite case entirely -- AniList splitting a cour that Sonarr
    // keeps whole, like Slime's second season. That case has no season-count discrepancy to spot,
    // only a cour that covers half a Sonarr season.
    const library = anime ? await sonarr.findMatch(anime, null).catch(() => null) : null;
    const inspection = anime
      ? await reconcile.inspect({ anime, tmdbSeasons: detail?.seasons, library }).catch(() => null)
      : null;

    // `whole` is the user saying the cour logic does not apply: they want the series. Jellyseerr
    // still only monitors the one TMDB season it was given, so this needs correcting too -- in the
    // opposite direction, by monitoring everything.
    if (anime && (inspection?.lumped || body.whole === true)) {
      reconcile.startNarrowing({ anime, tmdbId, whole: body.whole === true });
      narrowing = { started: true, whole: body.whole === true };
    }
  }

  return c.json({
    ok: true,
    requestId: created.id,
    status: created.status,
    media: created.media?.status ?? null,
    forcedAnime: forced,
    narrowing
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

// Narrow Sonarr to the episodes one AniList entry actually covers. Runs automatically after a
// request for a show whose TMDB seasons are lumped; this route is how a season picked by hand gets
// applied, and how a narrowing that could not decide gets retried.
//
// Season is optional: without it the cour is resolved from air dates, which is what the automatic
// path does. With it, the choice is taken as given.
app.post("/api/sonarr/narrow/:anilistId", async c => {
  const anilistId = Number(c.req.param("anilistId"));
  if (!Number.isInteger(anilistId) || anilistId <= 0) {
    return c.json({ error: "anilistId must be a positive integer" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const seasonNumber = body.seasonNumber === undefined || body.seasonNumber === null ? null : Number(body.seasonNumber);

  if (seasonNumber !== null && (!Number.isInteger(seasonNumber) || seasonNumber < 1)) {
    return c.json({ error: "seasonNumber must be a positive integer" }, 400);
  }

  const mode = body.mode || "exclusive";
  if (!["exclusive", "add", "whole"].includes(mode)) {
    return c.json({ error: "mode must be exclusive, add or whole" }, 400);
  }

  const anime = await anilist.byId(anilistId);
  if (!anime) return c.json({ error: "not found" }, 404);

  const shokoInfo = await shoko.infoFor(anime).catch(() => null);
  const library = await sonarr.findMatch(anime, shokoInfo).catch(() => null);

  if (!library) {
    return c.json(
      {
        error:
          "Sonarr has no series for this title yet, so there is nothing to narrow. Request it first, or add it in Sonarr.",
        service: "sonarr"
      },
      409
    );
  }

  // Two steps, the same as POST /api/sonarr/missing/:anilistId: without confirm nothing is written
  // and the response is the plan. This route unmonitors episodes and deletes downloads, so it is
  // worth being able to read what it intends first.
  const result =
    mode === "whole"
      ? await reconcile.monitorWholeSeries({ anime, series: library, apply: body.confirm === true })
      : await reconcile.narrowSeries({
          anime,
          series: library,
          seasonNumber,
          mode,
          apply: body.confirm === true
        });

  // Jellyseerr's search can still be running when a cour is narrowed by hand, so keep sweeping in
  // the background here as well rather than only on the automatic path.
  const { guardWith, ...response } = result;
  if (result.applied && guardWith) reconcile.watchQueue(anilistId, guardWith);

  // not-confirmed is a plan, not a failure, so it answers 200.
  if (response.reason === "not-confirmed") return c.json({ ok: true, ...response });
  if (!response.applied) return c.json({ ok: false, ...response }, 409);
  return c.json({ ok: true, ...response });
});

// Episodes AniDB says have aired but that are not on disk. AniDB numbers a split cour from 1
// while Sonarr keeps TVDB's numbering, so episode numbers cannot be compared directly. The
// air date is the only field both sides agree on. Anything that does not match a single Sonarr
// episode without a file is reported and left alone rather than guessed at.
const MAX_SEARCH_EPISODES = 24;

// One row per episode AniDB says exists but Shoko has no file for, each carrying the reason.
// "Missing" turns out to mean four different things and only one of them is a download:
//
//   not-aired            AniDB knows about it, it has not aired
//   not-downloaded       nothing on disk -> Sonarr can search for it
//   on-disk-unlinked     Shoko hashed the file but AniDB never matched it -> rescan or link
//   on-disk-not-hashed   the file exists but Shoko has not seen it -> needs an import scan
//   unresolved           the air date does not tie to exactly one Sonarr episode
export async function missingReport(anilistId) {
  const anime = await anilist.byId(anilistId);
  if (!anime) return { error: "not found", status: 404 };

  const shokoInfo = await shoko.infoFor(anime).catch(() => null);
  if (!shokoInfo) {
    return { error: "Shoko has no entry for this title, so Hikari cannot tell which episodes are missing", status: 409 };
  }

  const files = await shoko.fileDetail(shokoInfo.shokoId).catch(() => null);
  if (!files) return { error: "Shoko did not return an episode list", status: 502 };

  const library = await sonarr.findMatch(anime, shokoInfo).catch(() => null);
  const [catalogue, fileIndex] = await Promise.all([
    library ? sonarr.episodes(library.id).catch(() => []) : Promise.resolve([]),
    shoko.fileIndex().catch(() => ({ total: 0, unlinked: 0, byTail: new Map() }))
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  for (const episode of files.episodes) {
    if (episode.hasFile) continue;

    const row = {
      episode: episode.episode,
      shokoEpisodeId: episode.shokoEpisodeId,
      airDate: episode.airDate,
      state: "unresolved",
      detail: null,
      sonarr: null,
      shokoFile: null
    };

    if (!episode.airDate) {
      row.detail = "AniDB has no air date for it";
      rows.push(row);
      continue;
    }
    if (episode.airDate > today) {
      row.state = "not-aired";
      rows.push(row);
      continue;
    }

    // Air date, not episode number: AniDB numbers a split cour from 1 while Sonarr keeps
    // TVDB's numbering, so the numbers legitimately disagree.
    const sameDay = catalogue.filter(item => withinADay(item.airDate, episode.airDate));

    if (sameDay.length === 0) {
      row.detail = library ? "no Sonarr episode airs on that date" : "not in Sonarr";
      rows.push(row);
      continue;
    }
    if (sameDay.length > 1) {
      row.detail = `${sameDay.length} Sonarr episodes share that air date, so the match is ambiguous`;
      rows.push(row);
      continue;
    }

    const match = sameDay[0];
    row.sonarr = {
      id: match.id,
      seasonNumber: match.seasonNumber,
      episodeNumber: match.episodeNumber,
      title: match.title,
      hasFile: match.hasFile,
      monitored: match.monitored,
      size: match.size,
      relativePath: match.relativePath
    };

    if (!match.hasFile) {
      row.state = "not-downloaded";
      rows.push(row);
      continue;
    }

    const known = fileIndex.byTail.get(shoko.pathTail(match.relativePath));
    if (known && !known.linked) {
      row.state = "on-disk-unlinked";
      row.shokoFile = { fileId: known.fileId, size: known.size, path: known.path };
    } else if (known && known.linked) {
      // Shoko has the file and considers it linked, yet not to this episode. Left alone.
      row.detail = "Shoko has this file linked to a different episode";
      row.shokoFile = { fileId: known.fileId, size: known.size, path: known.path };
    } else {
      row.state = "on-disk-not-hashed";
    }
    rows.push(row);
  }

  const searchable = rows.filter(row => row.state === "not-downloaded");

  return {
    series: library ? { id: library.id, title: library.title, via: library.via } : null,
    collection: { files: fileIndex.total, unlinked: fileIndex.unlinked },
    rows,
    counts: {
      notAired: rows.filter(row => row.state === "not-aired").length,
      notDownloaded: searchable.length,
      onDiskUnlinked: rows.filter(row => row.state === "on-disk-unlinked").length,
      onDiskNotHashed: rows.filter(row => row.state === "on-disk-not-hashed").length,
      unresolved: rows.filter(row => row.state === "unresolved").length
    },
    matched: searchable.slice(0, MAX_SEARCH_EPISODES).map(row => ({
      anidbEpisode: row.episode,
      airDate: row.airDate,
      id: row.sonarr.id,
      seasonNumber: row.sonarr.seasonNumber,
      episodeNumber: row.sonarr.episodeNumber,
      title: row.sonarr.title,
      monitored: row.sonarr.monitored
    })),
    truncated: searchable.length > MAX_SEARCH_EPISODES
  };
}

app.post("/api/sonarr/missing/:anilistId", async c => {
  const anilistId = Number(c.req.param("anilistId"));
  if (!Number.isInteger(anilistId) || anilistId <= 0) {
    return c.json({ error: "anilistId must be a positive integer" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const plan = await missingReport(anilistId);
  if (plan.error) return c.json({ error: plan.error }, plan.status);

  // The browser never sends episode ids: it asks for a plan, shows it, then confirms. That
  // keeps "what gets downloaded" a server-side decision.
  if (body.confirm !== true) return c.json({ ...plan, planned: true, executed: false });
  if (plan.matched.length === 0) return c.json({ ...plan, executed: false, error: "nothing to search" }, 409);

  const ids = plan.matched.map(item => item.id);
  const unmonitored = plan.matched.filter(item => !item.monitored).map(item => item.id);

  const monitored = await sonarr.monitorEpisodes(unmonitored);
  const command = await sonarr.searchEpisodes(ids);

  console.log(`[hikari] sonarr search for ${ids.length} episode(s) of ${plan.series.title}: ${ids.join(",")}`);
  return c.json({ ...plan, executed: true, monitored: monitored.changed, command });
});

// Shoko repair. Both routes take the AniList id as well as the file, and re-derive the report
// server-side, so a stale tab or a hand-rolled call cannot link an arbitrary file to an
// arbitrary episode.
async function repairTarget(anilistId, fileId) {
  const report = await missingReport(anilistId);
  if (report.error) return { error: report.error, status: report.status };

  // The state matters, not just the file: missingReport also attaches shokoFile to rows it
  // deliberately left alone because Shoko has that file linked to a different episode. Without
  // this check a hand-rolled call would steal the file from that episode.
  const row = report.rows.find(
    item => item.state === "on-disk-unlinked" && item.shokoFile?.fileId === Number(fileId)
  );
  if (!row) {
    return { error: "That file is not one of this title's unmatched episodes", status: 409 };
  }
  return { row };
}

// Everything the login screen needs, and nothing else: it has to be readable while signed out.
app.get("/api/auth", c => {
  const state = auth.status();
  const session = state.enabled ? auth.verify(auth.readCookie(c.req.header("cookie"))) : null;
  return c.json({
    enabled: state.enabled,
    configured: state.configured,
    // Switched on but with no Jellyfin to ask is not signed in: nobody can be, and the login screen
    // says so rather than the app rendering over an API that refuses everything.
    signedIn: Boolean(session) || !state.enabled,
    user: session ? { name: session.name, admin: session.admin } : null
  });
});

app.post("/api/auth/login", async c => {
  const body = await c.req.json().catch(() => ({}));
  // Behind a reverse proxy the socket address is the proxy, so prefer the forwarded one for the
  // per-address throttle.
  const address = clientAddress(c);

  let result;
  try {
    result = await auth.login({ username: body.username, password: body.password, address });
  } catch (err) {
    // A brute force attempt has to be visible in the log, or the throttle is the only thing that
    // ever knows it happened. onError logs the message but neither the name tried nor the caller.
    const tried = typeof body.username === "string" ? body.username.slice(0, 64) : "";
    console.warn(`[hikari] failed login for "${tried}" from ${address}: ${err.message}`);
    throw err;
  }

  c.header("Set-Cookie", auth.cookieHeader(result.token, { secure: isHttps(c) }));
  console.log(`[hikari] ${result.user.name} signed in from ${address}`);
  return c.json({ ok: true, user: { name: result.user.name, admin: result.user.admin } });
});

app.post("/api/auth/logout", c => {
  // Clearing your own cookie needs no proof of anything. Revoking everyone's does: this route is
  // exempt from the session gate so the login screen can reach it, and unauthenticated it was a
  // one-line denial of service, since every call invalidates every session ever issued.
  if (c.req.query("everywhere") === "1") {
    if (!sessionFor(c) && !hasToken(c)) return c.json({ error: "sign in required" }, 401);
    const generation = auth.revokeAll();
    console.log(`[hikari] all sessions revoked from ${clientAddress(c)}, generation ${generation}`);
  }
  c.header("Set-Cookie", auth.clearCookieHeader({ secure: isHttps(c) }));
  return c.json({ ok: true });
});

app.get("/api/settings", c => c.json({ ...settings.describe(), configured: settings.isConfigured() }));

app.post("/api/settings", async c => {
  const body = await c.req.json().catch(() => null);
  const result = settings.update(body);

  // A newly enabled sweep should start without a restart, and a disabled one should stop.
  autolink.restart();
  // The save emptied the cache; fill the Discover page back in before anyone opens it.
  if (result.changed.length > 0) warm.rebuild();

  return c.json({ ok: true, ...result, ...settings.describe(), configured: settings.isConfigured() });
});

// The shared secret, minted server side. Guarded by requireToken and requireAdmin like the rest of
// /api/settings, which between them cover every case but one: with the login off *and* no token set,
// both stand aside, so an unauthenticated caller on the LAN could mint the secret and lock the owner
// out of their own instance. That gap is the only thing this refuses.
//
// Deliberately not gated on the login alone. Once a token exists, requireToken has already demanded
// it, so the caller is the owner by definition and may rotate or remove it whether the login is on or
// not. Refusing them would have been a trap: turning the login off after generating a token left the
// browser unable to save (no session to fall back on) and the token holder unable to remove it, with
// hand-editing the settings file as the only way out.
function tokenGuard(c) {
  if (!config.auth.enabled && !config.token) {
    return c.json(
      {
        error:
          "turn the login on first. Until Hikari knows who you are, anyone who can reach this port could generate a token, so there is nobody to trust with one yet"
      },
      409
    );
  }
  return null;
}

// Reachable by a Jellyfin administrator, or by a caller already holding the current token, since
// requireAdmin stands aside for the shared secret. Both are the owner; neither is a passer-by.
app.post("/api/settings/token", c => {
  const refused = tokenGuard(c);
  if (refused) return refused;

  const token = settings.generateToken();
  console.log(`[hikari] API token generated by ${sessionFor(c)?.name ?? "a token holder"} from ${clientAddress(c)}`);
  // The only time the value is ever sent to a browser. Every read after this is masked, so the
  // screen tells you to copy it now.
  return c.json({ ok: true, token, ...settings.describe(), configured: settings.isConfigured() });
});

app.delete("/api/settings/token", c => {
  const refused = tokenGuard(c);
  if (refused) return refused;

  const result = settings.clearToken();
  console.log(`[hikari] API token removed by ${sessionFor(c)?.name ?? "a token holder"} from ${clientAddress(c)}`);
  return c.json({ ok: true, ...result, ...settings.describe(), configured: settings.isConfigured() });
});

// Probes a service with values that have not been saved yet, so the setup screen can tell you a
// key is wrong before you commit it. Nothing is stored and nothing is cached.
app.post("/api/settings/test", async c => {
  const body = await c.req.json().catch(() => ({}));
  const service = String(body.service || "");
  const submitted = String(body.url || "").replace(/\/+$/, "");
  const stored = Object.hasOwn(config, service) ? (config[service] ?? {}) : {};
  const storedUrl = String(stored.url || "");

  // The stored key is only ever sent to the stored URL. Falling back to it for any submitted
  // address turned this route into a key exfiltration primitive: POST a URL you control and
  // Hikari hands over the real API key in a header, one service at a time.
  const sameTarget = !submitted || submitted === storedUrl;
  if (!sameTarget && !body.key) {
    return c.json({ ok: false, error: "testing a different URL needs its own key" }, 400);
  }

  const url = submitted || storedUrl;
  const key = String(body.key || (sameTarget ? stored.key : "") || "");

  const probes = {
    jellyseerr: { path: "/api/v1/status", headers: { "X-Api-Key": key }, version: b => `v${b.version}` },
    sonarr: { path: "/api/v3/system/status", headers: { "X-Api-Key": key }, version: b => `v${b.version}` },
    radarr: { path: "/api/v3/system/status", headers: { "X-Api-Key": key }, version: b => `v${b.version}` },
    jellyfin: {
      path: "/System/Info",
      headers: { Authorization: `MediaBrowser Token="${key}"` },
      version: b => `v${b.Version}`
    },
    shoko: { path: "/api/v3/Init/Status", headers: { apikey: key }, version: b => b.State || "reachable" }
  };

  // hasOwn, not a plain lookup: probes.constructor is truthy and would have sent a request to
  // `${url}undefined` on any host the caller named.
  const probe = Object.hasOwn(probes, service) ? probes[service] : null;
  if (!probe) return c.json({ error: `cannot test ${service || "an unnamed service"}` }, 400);
  if (!url) return c.json({ ok: false, error: "a URL is required" }, 400);

  // Same validation the persisted values get, so this route cannot reach somewhere a saved
  // setting could not.
  try {
    settings.coerce({ key: "url", type: "url" }, url);
  } catch (err) {
    return c.json({ ok: false, error: err.message.replace(/^url /, "") }, 400);
  }

  try {
    const body2 = await request(service, `${url}${probe.path}`, {
      headers: { ...probe.headers, Accept: "application/json" },
      timeout: 10000
    });
    return c.json({ ok: true, detail: probe.version(body2) });
  } catch (err) {
    // The upstream body is deliberately not returned, same as everywhere else.
    return c.json({ ok: false, error: err.message });
  }
});

app.get("/api/autolink", c => c.json(autolink.status()));

// Manual run. Defaults to a dry run so you can see what it would link before it does.
app.post("/api/autolink", async c => {
  const body = await c.req.json().catch(() => ({}));
  const result = await autolink.sweep({ apply: body.confirm === true });
  return c.json(result);
});

// Sonarr's Connect webhook. Sonarr fires this the moment an import finishes, which is before
// Shoko has hashed the file, so this only nudges Shoko to import and marks the next sweep as
// worth running. The linking itself still waits for the grace period.
app.post("/api/hooks/sonarr", async c => {
  const body = await c.req.json().catch(() => ({}));
  const event = body.eventType || "unknown";

  if (event === "Test") return c.json({ ok: true, event, note: "webhook reachable" });
  if (!["Download", "DownloadFolderImported", "Rename", "Upgrade"].includes(event)) {
    return c.json({ ok: true, event, ignored: true });
  }

  const result = await autolink.onImport();
  console.log(`[hikari] sonarr hook: ${event} ${body.series?.title ?? ""}`.trim());
  return c.json({ ok: true, event, ...result });
});

app.post("/api/jellyfin/refresh", async c => {
  if (!enabled.jellyfin) return c.json({ error: "Jellyfin is not configured" }, 503);
  const result = await jellyfin.refreshLibrary();
  console.log("[hikari] queued a Jellyfin library scan");
  return c.json({ ok: true, ...result });
});

// Collection-wide Shoko maintenance. The per-file buttons fix one episode; these fix the class.
app.post("/api/shoko/action/:name", async c => {
  if (!enabled.shoko) return c.json({ error: "Shoko is not configured" }, 503);

  const name = c.req.param("name");
  if (!shoko.actionLabel(name)) return c.json({ error: `unknown action ${name}` }, 400);

  const result = await shoko.runAction(name);
  console.log(`[hikari] queued shoko action ${name}`);
  return c.json({ ok: true, ...result });
});

app.post("/api/shoko/rescan/:anilistId/:fileId", async c => {
  const target = await repairTarget(Number(c.req.param("anilistId")), Number(c.req.param("fileId")));
  if (target.error) return c.json({ error: target.error }, target.status);

  const result = await shoko.rescanFile(target.row.shokoFile.fileId);
  return c.json({ ok: true, episode: target.row.episode, ...result });
});

// One click per episode is fine for one show and tedious across a season. Same verified mapping
// as the single-file route, applied to every unlinked row this title has.
app.post("/api/shoko/link-all/:anilistId", async c => {
  const anilistId = Number(c.req.param("anilistId"));
  if (!Number.isInteger(anilistId) || anilistId <= 0) {
    return c.json({ error: "anilistId must be a positive integer" }, 400);
  }

  const report = await missingReport(anilistId);
  if (report.error) return c.json({ error: report.error }, report.status);

  const targets = report.rows.filter(
    row => row.state === "on-disk-unlinked" && row.shokoFile?.fileId && row.shokoEpisodeId
  );
  if (targets.length === 0) return c.json({ error: "nothing to link" }, 409);

  const linked = [];
  const failed = [];

  for (const row of targets.slice(0, 50)) {
    try {
      await shoko.linkFile(row.shokoFile.fileId, [row.shokoEpisodeId]);
      linked.push(row.episode);
    } catch (err) {
      failed.push({ episode: row.episode, error: err.message });
    }
  }

  console.log(`[hikari] linked ${linked.length} file(s) for anilist ${anilistId}: ${linked.join(",")}`);
  return c.json({ ok: failed.length === 0, linked, failed });
});

app.post("/api/shoko/link/:anilistId/:fileId", async c => {
  const target = await repairTarget(Number(c.req.param("anilistId")), Number(c.req.param("fileId")));
  if (target.error) return c.json({ error: target.error }, target.status);

  const { row } = target;
  if (!row.shokoEpisodeId) {
    return c.json({ error: "Shoko did not report an episode id to link this file to" }, 409);
  }

  const result = await shoko.linkFile(row.shokoFile.fileId, [row.shokoEpisodeId]);
  console.log(`[hikari] linked shoko file ${row.shokoFile.fileId} to episode ${row.shokoEpisodeId} (ep ${row.episode})`);
  return c.json({ ok: true, episode: row.episode, ...result });
});

// Repairs Jellyfin's watch state from AniList. A Shokofin VFS rebuild creates new item ids and
// Jellyfin keys played flags to item ids, so a rebuild silently orphans the whole history,
// which is why a season watched to episode 8 reads as 0 of 14.
//
// Only ever marks episodes played, never unmarks, and only up to the episode you name.
app.post("/api/jellyfin/played/:anilistId", async c => {
  const anilistId = Number(c.req.param("anilistId"));
  if (!Number.isInteger(anilistId) || anilistId <= 0) {
    return c.json({ error: "anilistId must be a positive integer" }, 400);
  }
  if (!enabled.jellyfin) return c.json({ error: "Jellyfin is not configured" }, 503);

  const body = await c.req.json().catch(() => ({}));
  const anime = await anilist.byId(anilistId);
  if (!anime) return c.json({ error: "not found" }, 404);

  const shokoInfo = await shoko.infoFor(anime).catch(() => null);
  const library = await sonarr.findMatch(anime, shokoInfo).catch(() => null);
  const watch = await jellyfin.progressFor(anime, library, shokoInfo).catch(() => null);

  if (!watch) return c.json({ error: "No Jellyfin item matches this title" }, 409);
  // A tvdb, path or title match can be a whole multi-season series, and marking "the first 8
  // episodes" of that is not the same thing at all.
  if (!watch.scoped) {
    return c.json(
      { error: `The Jellyfin match is by ${watch.via}, which can cover more than this entry, so this is refused` },
      409
    );
  }

  const listEntry = await anilistList.entryFor(anilistId).catch(() => null);
  const requested = body.upTo ?? listEntry?.progress ?? null;
  if (!Number.isInteger(requested) || requested <= 0) {
    return c.json({ error: "upTo must be a positive integer, or AniList must have progress to copy" }, 400);
  }

  const items = await jellyfin.episodeItems(watch.ids);
  if (items.length === 0) return c.json({ error: "Jellyfin lists no episodes for this item" }, 409);

  // Counted by position, not episode number: absolute numbering, split cours and missing files
  // all make "episode 8" ambiguous, while "the first 8 of this item" is not.
  const upTo = Math.min(requested, items.length);
  const target = items.slice(0, upTo).filter(item => !item.played);

  const plan = {
    item: watch.name,
    via: watch.via,
    upTo,
    total: items.length,
    alreadyPlayed: upTo - target.length,
    episodes: target.map(item => ({ id: item.id, season: item.season, episode: item.episode, name: item.name }))
  };

  if (body.confirm !== true) return c.json({ ...plan, planned: true, executed: false });
  if (target.length === 0) return c.json({ ...plan, executed: false, error: "nothing left to mark" }, 409);

  // Per item, because failing on episode 5 of 8 used to throw away the fact that 4 were already
  // marked and report nothing but a 502.
  const marked = [];
  const failed = [];
  for (const item of target) {
    try {
      await jellyfin.markPlayed(item.id);
      marked.push(item.episode);
    } catch (err) {
      failed.push({ episode: item.episode, error: err.message });
    }
  }

  console.log(`[hikari] marked ${marked.length} episode(s) played in Jellyfin for ${watch.name}`);
  return c.json({ ...plan, executed: true, marked: marked.length, failed });
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
  // Homepage polls this on a timer; answering stale and refreshing behind keeps the widget instant.
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

    const airing = season ? await annotate(hidden.filter(season.media)).catch(() => hidden.filter(season.media)) : [];
    const downloading = torrents.filter(torrent => torrent.active);

    return snapshotBody(now, airing, queue, downloading, requests);
  }, { staleFor: 2 * 60 * 1000 });
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

  // Vite copies public/ to the root of dist, so the icons and the web manifest sit beside
  // index.html rather than under /assets. Without this they fell through to the SPA fallback and
  // came back as HTML, which a favicon request cannot do anything with.
  const rootFiles = serveStatic({
    root: "./dist",
    // A week: these change names only when the artwork does, but they are not content-hashed the
    // way the bundle is, so they cannot be immutable.
    onFound: (_path, c) => c.header("Cache-Control", "public, max-age=604800")
  });
  app.use("/*", (c, next) => {
    // index.html is handled below so it keeps its no-cache, and /api is never a file.
    if (c.req.path === "/" || c.req.path.startsWith("/api/")) return next();
    return rootFiles(c, next);
  });

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

// Before the snapshot, because settings decide which services exist and a snapshot restored
// under the wrong configuration would hand back answers from a service you just replaced.
const settingsFile = settings.load();
const authFile = auth.load();
const hiddenFile = hidden.load();

const restored = loadSnapshot();

// Persist on the way out and periodically, so a restart or crash keeps the AniList data.
let saving = false;
const flush = async () => {
  if (saving) return;
  saving = true;
  try {
    await saveSnapshot();
  } finally {
    saving = false;
  }
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
  if (hiddenFile.count > 0) console.log(`[hikari]   ${hiddenFile.count} hidden title${hiddenFile.count === 1 ? "" : "s"} (${hiddenFile.path})`);
  if (settingsFile.loaded) {
    console.log(`[hikari]   settings ${settingsFile.path} (${settingsFile.fields} overrides)`);
  } else if (!settings.isConfigured()) {
    console.log("[hikari]   nothing configured yet, open the app and it will walk you through setup");
  }
  if (config.auth.enabled && enabled.jellyfin) {
    console.log(`[hikari]   Jellyfin login required (key ${authFile.path})`);
  } else if (config.auth.enabled) {
    console.warn(
      "[hikari]   login is on but Jellyfin is not configured, so nobody can sign in. Remove the auth block from the settings file to open it again."
    );
  }
  autolink.start();
  warm.start(buildDiscover);
});
