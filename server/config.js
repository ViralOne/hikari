const trim = (v, fallback = "") => (v ?? fallback).toString().trim().replace(/\/+$/, "");

// The settings UI validates numbers; the environment does not. AUTO_LINK_INTERVAL_MINUTES=60m
// parsed as NaN, and setInterval(fn, NaN) fires about every millisecond, so a typo turned the
// sweep into a busy loop against Shoko.
const num = (raw, fallback, min, max) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    if (raw !== undefined && String(raw).trim() !== "") {
      console.warn(`[hikari] ignoring "${raw}" as a number, using ${fallback}`);
    }
    return fallback;
  }
  return Math.min(Math.max(Math.round(value), min), max);
};

export const config = {
  port: Number(process.env.PORT || 7997),
  host: (process.env.HOST || "0.0.0.0").trim(),
  token: (process.env.HIKARI_TOKEN || "").trim(),
  jellyseerr: {
    url: trim(process.env.JELLYSEERR_URL),
    key: (process.env.JELLYSEERR_API_KEY || "").trim(),
    // Where to send the browser. Set this when you reach Jellyseerr on a different
    // hostname than the server does (reverse proxy, Tailscale, Cloudflare). Kept separate
    // from the resolved value so changing the server URL cannot leave a stale derived one.
    publicUrl: trim(process.env.JELLYSEERR_PUBLIC_URL),
    browserUrl: ""
  },
  sonarr: {
    url: trim(process.env.SONARR_URL),
    key: (process.env.SONARR_API_KEY || "").trim()
  },
  radarr: {
    url: trim(process.env.RADARR_URL),
    key: (process.env.RADARR_API_KEY || "").trim()
  },
  qbit: {
    url: trim(process.env.QBIT_URL),
    user: (process.env.QBIT_USER || "").trim(),
    pass: process.env.QBIT_PASS || ""
  },
  jellyfin: {
    url: trim(process.env.JELLYFIN_URL),
    key: (process.env.JELLYFIN_API_KEY || "").trim(),
    userId: (process.env.JELLYFIN_USER_ID || "").trim(),
    // Which library to scan. Left empty it is detected: the Shokofin VFS library if there is
    // one, else a library named "anime". Set it to skip the guess.
    libraryId: (process.env.JELLYFIN_LIBRARY_ID || "").trim()
  },
  shoko: {
    url: trim(process.env.SHOKO_URL),
    key: (process.env.SHOKO_API_KEY || "").trim()
  },
  anilist: {
    token: (process.env.ANILIST_TOKEN || "").trim(),
    // Writing to your AniList list stays off unless you ask for it.
    allowWrites: /^(1|true|yes)$/i.test((process.env.ANILIST_ALLOW_WRITES || "").trim())
  },
  // Only believe X-Forwarded-For when you have actually put a proxy in front, otherwise it is a
  // free way around every per-address limit.
  trustProxy: /^(1|true|yes)$/i.test((process.env.TRUST_PROXY || "").trim()),
  rateLimit: num(process.env.RATE_LIMIT_PER_MINUTE, 600, 30, 100000),
  animeRoot: trim(process.env.ANIME_ROOT, "/data/anime"),
  // Login is checked against Jellyfin, so Hikari keeps no accounts of its own. Off by default:
  // turning it on without a reachable Jellyfin would lock the door on an empty room.
  auth: {
    enabled: /^(1|true|yes)$/i.test((process.env.AUTH || "").trim()),
    sessionDays: num(process.env.AUTH_SESSION_DAYS, 30, 1, 365),
    adminsOnly: /^(1|true|yes)$/i.test((process.env.AUTH_ADMINS_ONLY || "").trim()),
    // Empty means any Jellyfin account.
    users: (process.env.AUTH_USERS || "")
      .split(",")
      .map(name => name.trim())
      .filter(Boolean)
  },
  // Links files Shoko hashed but AniDB never matched, so Jellyfin can see them. Off by default
  // because it writes to Shoko on its own.
  autoLink: {
    enabled: /^(1|true|yes)$/i.test((process.env.AUTO_LINK || "").trim()),
    intervalMinutes: num(process.env.AUTO_LINK_INTERVAL_MINUTES, 60, 5, 1440),
    // How long a file is left for AniDB before Hikari links it by hand. An AniDB match brings
    // metadata a hand link does not, and unregistered releases are often added within a day.
    graceHours: num(process.env.AUTO_LINK_GRACE_HOURS, 6, 0, 168),
    maxPerRun: num(process.env.AUTO_LINK_MAX_PER_RUN, 20, 1, 200)
  }
};

// Mutated in place rather than replaced, because every module holds a reference to this object
// and reads it at call time. Settings saved from the UI land in `config` and then call this.
export const enabled = {
  jellyseerr: false,
  sonarr: false,
  radarr: false,
  qbit: false,
  jellyfin: false,
  shoko: false,
  anilistList: false,
  anilist: true
};

export function recompute() {
  enabled.jellyseerr = Boolean(config.jellyseerr.url && config.jellyseerr.key);
  enabled.sonarr = Boolean(config.sonarr.url && config.sonarr.key);
  enabled.radarr = Boolean(config.radarr.url && config.radarr.key);
  enabled.qbit = Boolean(config.qbit.url);
  enabled.jellyfin = Boolean(config.jellyfin.url && config.jellyfin.key);
  enabled.shoko = Boolean(config.shoko.url && config.shoko.key);
  enabled.anilistList = Boolean(config.anilist.token);

  config.jellyseerr.browserUrl = config.jellyseerr.publicUrl || config.jellyseerr.url;
  return enabled;
}

recompute();
