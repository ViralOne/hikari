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
| `ANILIST_TOKEN` | no | AniList token. Discovery works without one; this adds your list status and progress, and the **Continue the story** row |
| `ANILIST_ALLOW_WRITES` | no | Default `false`. Set `true` to let Hikari change your AniList status and progress |
| `AUTO_LINK` | no | Default `false`. Links files Shoko hashed but AniDB never matched, on a timer |
| `AUTO_LINK_INTERVAL_MINUTES` | no | Default 60, minimum 5 |
| `AUTO_LINK_GRACE_HOURS` | no | Default 6. How long a new file is left for AniDB first |
| `AUTO_LINK_MAX_PER_RUN` | no | Default 20 |
| `RATE_LIMIT_PER_MINUTE` | no | Default 600, clamped to 30-100000. API requests per address per minute |
| `TRUST_PROXY` | no | Default `false`. Believe the rightmost `X-Forwarded-For` entry. Only set this when a proxy really is in front |
| `AUTH` | no | Default `false`. Require a Jellyfin login. See [Security](security.md) |
| `AUTH_SESSION_DAYS` | no | Default 30, clamped to 1-365 |
| `AUTH_ADMINS_ONLY` | no | Default `false`. Only Jellyfin administrators may sign in |
| `AUTH_USERS` | no | Comma-separated allowlist. Blank allows any Jellyfin account |
| `AUTH_FILE` | no | Where the session signing key lives. Default `/cache/hikari-auth.json` |
| `SETTINGS_FILE` | no | Where settings saved in the app are written. Default `/cache/hikari-settings.json` |
| `CACHE_FILE` | no | Path for the cache snapshot, so a restart does not re-fetch AniList |
| `CACHE_WARM` | no | Default on. Builds the Discover page on boot and, while the deck has been opened in the last 12 hours, refreshes the entries behind it shortly before they expire. `0` to stay idle until asked |
| `HIKARI_TOKEN` | no | Shared secret required on the routes that change things. Generate one under Settings instead, once the login is on. See [Security](security.md) |
| `HOST` | no | Bind address. Default `0.0.0.0`; use `127.0.0.1` for local-only |
| `PORT` | no | Default `7997` |

## Performance

Responses are cached in memory, so normal browsing serves in single-digit milliseconds:

| Data | Fresh for | Served stale while refreshing for a further |
| --- | --- | --- |
| Discover rows | 10 minutes | 30 minutes |
| Continue the story | 30 minutes | 30 minutes |
| Airing schedule | 15 minutes | 45 minutes |
| Anime detail (AniList) | 1 hour | 1 hour |
| All-time top chart | 6 hours | 18 hours |
| Sonarr series list | 2 minutes | 8 minutes |
| Jellyfin series index | 1 minute | 4 minutes |
| Shoko series index | 5 minutes | 20 minutes |
| Queue and torrents | 15 seconds | — |
| Jellyseerr request state | 30 seconds | — |
| Homepage counters | 1 minute | 2 minutes |

On boot the Discover page is built before anyone asks for it, and while the deck is in use its
entries are refreshed a few minutes before they would expire, so in practice the first column is
what you see and the second is a safety net (`CACHE_WARM=0` turns this off).

The third column is stale-while-revalidate: once the fresh window has passed, the next request is
answered from the old value immediately and the refresh runs behind it, so the first open after a
quiet spell is as fast as the second. Data where an old answer would be a wrong one, such as
Jellyseerr's request state or a Sonarr episode list mid-download, has no grace and always waits for
the upstream. Anything you change through Hikari clears the affected entries at once regardless.

The cache is capped and sweeps expired entries, because search keys come from the query string. If an
upstream service fails or rate-limits, the last good value is served instead of an error page.
AniList allows 90 requests per minute; Hikari stays well inside that and backs off if it gets a 429.
