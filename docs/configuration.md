# Configuration

[Documentation index](README.md)

Every variable goes in `.env`. Anything left blank disables its feature rather than causing an error.

| Variable | Required | Purpose |
| --- | --- | --- |
| `JELLYSEERR_URL` | yes | Base URL of your Jellyseerr instance |
| `JELLYSEERR_API_KEY` | yes | Jellyseerr API key |
| `JELLYSEERR_PUBLIC_URL` | no | Where to send your browser for "Open in Jellyseerr", if that differs from the URL the server uses |
| `SONARR_URL` | no | Base URL of Sonarr |
| `SONARR_API_KEY` | no | Sonarr API key |
| `JELLYFIN_URL` | no | Base URL of Jellyfin |
| `JELLYFIN_API_KEY` | no | Jellyfin API key |
| `JELLYFIN_USER_ID` | no | Whose watch progress to show. Defaults to the first administrator |
| `JELLYFIN_LIBRARY_ID` | no | Which library the "scan anime library" action targets. Detected automatically if unset |
| `QBIT_URL` | no | Base URL of the qBittorrent Web UI |
| `QBIT_USER` | no | qBittorrent username |
| `QBIT_PASS` | no | qBittorrent password |
| `ANIME_ROOT` | no | Library path used to recognise a torrent as anime. Default `/data/anime` |
| `ANILIST_TOKEN` | no | AniList token. Discovery works without one; this adds your list status and progress |
| `ANILIST_ALLOW_WRITES` | no | Default `false`. Set `true` to let Hikari change your AniList status and progress |
| `AUTO_LINK` | no | Default `false`. Links files Shoko hashed but AniDB never matched, on a timer |
| `AUTO_LINK_INTERVAL_MINUTES` | no | Default 60, minimum 5 |
| `AUTO_LINK_GRACE_HOURS` | no | Default 6. How long a new file is left for AniDB first |
| `AUTO_LINK_MAX_PER_RUN` | no | Default 20 |
| `SETTINGS_FILE` | no | Where settings saved in the app are written. Default `/cache/hikari-settings.json` |
| `CACHE_FILE` | no | Path for the cache snapshot, so a restart does not re-fetch AniList |
| `HIKARI_TOKEN` | no | Shared secret required on the routes that change things. See Security |
| `HOST` | no | Bind address. Default `0.0.0.0`; use `127.0.0.1` for local-only |
| `PORT` | no | Default `7997` |

## Performance

Responses are cached in memory, so normal browsing serves in single-digit milliseconds:

| Data | Cached for |
| --- | --- |
| Discover rows | 10 minutes |
| Airing schedule | 15 minutes |
| Anime detail | 1 hour |
| All-time top chart | 6 hours |
| Sonarr series list | 2 minutes |
| Jellyfin series index | 1 minute |
| Queue and torrents | 15 seconds |
| Homepage counters | 1 minute |

The cache is capped and sweeps expired entries, because search keys come from the query string. If an
upstream service fails or rate-limits, the last good value is served instead of an error page.
AniList allows 90 requests per minute; Hikari stays well inside that and backs off if it gets a 429.
