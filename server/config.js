const trim = (v, fallback = "") => (v ?? fallback).toString().trim().replace(/\/+$/, "");

export const config = {
  port: Number(process.env.PORT || 7997),
  host: (process.env.HOST || "0.0.0.0").trim(),
  token: (process.env.HIKARI_TOKEN || "").trim(),
  jellyseerr: {
    url: trim(process.env.JELLYSEERR_URL),
    key: (process.env.JELLYSEERR_API_KEY || "").trim(),
    // Where to send the browser. Set this when you reach Jellyseerr on a different
    // hostname than the server does (reverse proxy, Tailscale, Cloudflare).
    publicUrl: trim(process.env.JELLYSEERR_PUBLIC_URL) || trim(process.env.JELLYSEERR_URL)
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
  animeRoot: trim(process.env.ANIME_ROOT, "/data/anime"),
  // Links files Shoko hashed but AniDB never matched, so Jellyfin can see them. Off by default
  // because it writes to Shoko on its own.
  autoLink: {
    enabled: /^(1|true|yes)$/i.test((process.env.AUTO_LINK || "").trim()),
    intervalMinutes: Number(process.env.AUTO_LINK_INTERVAL_MINUTES || 60),
    // How long a file is left for AniDB before Hikari links it by hand. An AniDB match brings
    // metadata a hand link does not, and unregistered releases are often added within a day.
    graceHours: Number(process.env.AUTO_LINK_GRACE_HOURS || 6),
    maxPerRun: Number(process.env.AUTO_LINK_MAX_PER_RUN || 20)
  }
};

export const enabled = {
  jellyseerr: Boolean(config.jellyseerr.url && config.jellyseerr.key),
  sonarr: Boolean(config.sonarr.url && config.sonarr.key),
  radarr: Boolean(config.radarr.url && config.radarr.key),
  qbit: Boolean(config.qbit.url),
  jellyfin: Boolean(config.jellyfin.url && config.jellyfin.key),
  shoko: Boolean(config.shoko.url && config.shoko.key),
  anilistList: Boolean(config.anilist.token),
  anilist: true
};
