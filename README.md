# Hikari

Anime discovery deck for your existing stack. AniList for discovery, Jellyseerr for requesting, Sonarr and
qBittorrent for truth about what you already have.

Hikari does **not** download anything itself and does not manage indexers. It is a nicer front door onto the
services you already run.

```
AniList  ──>  Hikari  ──>  Jellyseerr  ──>  Sonarr  ──>  qBittorrent
   ▲            │
   └── charts   └── reads Sonarr + qBittorrent to show what you already own
```

## What it gives you

- **Discover** — hero spotlight plus rails for airing this season, trending, next season, and all-time top.
  Every card is badged from your real Sonarr library (`In library`, `7/12 eps`, `Waiting`).
- **Schedule** — the next 3/7/14 days of airings grouped by day, with an "only my library" filter so you can
  see just the shows you actually follow.
- **Search** — AniList search plus season, year, format and genre filters.
- **Activity** — Sonarr queue, anime torrents in qBittorrent with progress and ratio, and recent Jellyseerr requests.
- **Request** — resolves the AniList entry to a TMDB id through Jellyseerr, guesses which TMDB season the entry
  maps to, locks seasons you already have, and posts the request. Jellyseerr's existing anime overrides
  (quality profile 7, root `/data/anime`, series type `anime`) apply automatically.

## Setup

```bash
npm install
cp .env.example .env      # fill in the URLs and API keys
npm run build
npm start                 # http://localhost:7997
```

Development, with hot reload on the frontend:

```bash
npm run dev               # api on :7997, vite on :5273
```

Docker:

```bash
docker compose up -d --build
```

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `JELLYSEERR_URL`, `JELLYSEERR_API_KEY` | yes | Resolving titles to TMDB and creating requests |
| `SONARR_URL`, `SONARR_API_KEY` | no | Library badges and the queue view |
| `QBIT_URL`, `QBIT_USER`, `QBIT_PASS` | no | Torrent activity view |
| `JELLYFIN_URL`, `JELLYFIN_API_KEY` | no | Watch progress: episodes seen, next up, last played |
| `JELLYFIN_USER_ID` | no | Which user's progress to read; falls back to the first admin |
| `JELLYSEERR_PUBLIC_URL` | no | Where to send the browser for "Open in Jellyseerr", when it differs from `JELLYSEERR_URL` |
| `ANIME_ROOT` | no | Save path prefix used to tag a torrent as anime (default `/data/anime`) |
| `ANILIST_TOKEN` | no | Optional AniList bearer token; unauthenticated works fine for discovery |
| `HIKARI_TOKEN` | no | Shared secret required on the state-changing routes. Unset = LAN-trusted |
| `HOST` | no | Bind address, default `0.0.0.0`. Use `127.0.0.1` to keep it local-only |
| `PORT` | no | Default `7997` |

Anything not configured is skipped rather than fatal — the sidebar shows a dot per service and
`GET /api/health` reports each one.

## API

| Route | Notes |
| --- | --- |
| `GET /api/health` | Per-service connectivity |
| `GET /api/discover` | Four rails, annotated with Sonarr matches |
| `GET /api/schedule?days=7` | Airing schedule, 1–14 days |
| `GET /api/search?q=&season=&year=&format=&genre=` | AniList search |
| `GET /api/anime/:anilistId` | Detail, Sonarr match, Jellyfin progress, Jellyseerr resolution, season list |
| `POST /api/request` | `{ tmdbId, mediaType, seasons, forceAnime? }`. Returns 409 if every season is already requested |
| `POST /api/sonarr/series/:id/series-type` | Repairs `seriesType` to `anime`, which Jellyseerr's API cannot set |
| `GET /api/activity` | Sonarr queue, qBittorrent torrents, recent requests, per-section errors |
| `GET /api/homepage` | Flat counters for a Homepage `customapi` widget |

AniList responses are cached in memory (10 min for rails, 1 h for detail, 6 h for the all-time chart) to stay
well inside AniList's 90 requests/minute limit. Sonarr's series list is cached for 2 minutes, and match results
are memoised per AniList id — without that, annotating 120 cards ran hundreds of thousands of string
comparisons per request. The cache is capped at 500 entries with expiry sweeping, because search keys come
from the query string.

## Not requesting the same thing twice

Jellyseerr's `mediaInfo.seasons` is frequently empty, so already-requested seasons have to be read from
`mediaInfo.requests[]` as well. Both are combined, and then:

- seasons that are pending, approved, processing, partial or available are shown as
  *already requested* / *already available* and cannot be ticked;
- "Select all available" and the request payload only ever contain the remaining seasons, so asking for
  S1 + S2 when S2 is already requested sends **S1 only**;
- when every season is taken the button is replaced by a link to the existing Jellyseerr request;
- the server re-checks and returns **409** regardless of what the client sends.

## Title matching

AniList and TMDB disagree about anime constantly, so matching is deliberately defensive:

- Titles are normalised with CJK preserved, and season/part/cour markers (`Season 2`, `2nd Season`, `第2期`)
  stripped, so `Kusuriya no Hitorigoto 2nd Season` and `The Apothecary Diaries` collapse to the same key.
- Comparisons need at least 3 meaningful characters on both sides. Without this a native title like
  `薬屋のひとりごと 第2期` reduces to `"2"` and matches everything.
- Substring shortcuts only apply when the shorter string is at least 60% of the longer one, so `Monster`
  no longer matches `Monogatari`.
- Sonarr matching is skipped for `MOVIE` entries, which live in Radarr.
- Season guessing prefers an explicit ordinal in the title, then the TMDB season whose air date is closest to
  the AniList start date (within ~13 months), then prequel count.

Confidence is shown in the panel. When it cannot find a confident match it says so instead of guessing.

## Homepage integration

`GET /api/homepage` returns flat counters for a [gethomepage](https://gethomepage.dev) `customapi`
widget. Everything it reads is already cached, so polling it does not hit AniList, Sonarr or
qBittorrent again.

```json
{
  "season": "Summer 2026",
  "airing": 50,
  "inLibrary": 9,
  "watching": 1,
  "unwatched": 8,
  "missing": 7,
  "queue": 31,
  "downloading": 0,
  "pendingRequests": 0
}
```

Add to Homepage's `services.yaml` (the `Anime & Maintenance` group fits your current layout):

```yaml
- Anime & Maintenance:
    - Hikari:
        href: http://YOUR-HOST:7997
        description: Seasonal anime discovery and requests
        icon: mdi-television-play
        widget:
          type: customapi
          url: http://YOUR-HOST:7997/api/homepage
          refreshInterval: 60000
          mappings:
            - field: airing
              label: Airing
            - field: inLibrary
              label: In library
            - field: missing
              label: Missing eps
            - field: unwatched
              label: Unwatched
```

`missing` counts episodes that have aired but are not on disk, so it doubles as a "did Sonarr
actually grab this week's episodes" alarm.

## Known limits

- Jellyseerr only knows about media *it* requested. A season you added straight in Sonarr still reads as
  "not requested", so Hikari cross-checks Sonarr and warns you in the request box before you re-grab something
  you already have.
- Nothing is preselected when the AniList → TMDB season mapping is ambiguous. That is intentional; pick the
  season yourself rather than have it request the wrong one.
- Movies resolve and request through Jellyseerr, but there is no Radarr library badge yet.
