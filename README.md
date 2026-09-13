# Hikari

A seasonal anime discovery deck for a self-hosted media stack.

Hikari shows you what is airing, what you already own, and how far through each show you are — then
sends new requests to Jellyseerr. It does not download anything itself, does not manage indexers, and
does not replace anything you already run.

```
AniList  ->  Hikari  ->  Jellyseerr  ->  Sonarr  ->  your download client
                |
                +- reads Sonarr, Jellyfin and qBittorrent to show what you already have
```

## Features

**Discover**
A spotlight banner plus four rows: airing this season, trending this week, next season, and the
highest rated of all time. Every card is badged from your real library, so you can tell at a glance
whether a show is already downloaded, partially downloaded, or waiting.

**Schedule**
The next 3, 7 or 14 days of episode airings grouped by day, with an "only my library" filter so you
can see just the shows you actually follow.

**Search**
AniList search with season, year, format and genre filters.

**Watch progress**
Pulled from Jellyfin: how many episodes you have watched, which episode is up next, and when you last
played something. Cards show a progress bar; the detail panel shows the numbers.

**AniList sync**
With writes enabled you can set the list status and step episode progress up or down, or copy
Jellyfin's count across in one click when it is ahead. Nothing is written unless
`ANILIST_ALLOW_WRITES=true`.

**Missing episodes, reconciled**
"3 missing" turns out to mean four different things, and only one of them is a download. Every
episode AniDB knows about but Shoko has no file for gets a row saying which it is:

| State | What it means | Offered fix |
| --- | --- | --- |
| not downloaded | Nothing on disk | Search Sonarr, after showing you the list |
| on disk, not linked to AniDB | Shoko hashed the file, AniDB never matched it | Rescan, or link it by hand |
| on disk, not scanned | The file exists, Shoko has not seen it | Points you at an import scan |
| not aired yet | Counted by AniDB, has not aired | Nothing to do |

Episodes are matched to Sonarr by **air date**, because AniDB numbers a split cour from 1 while
Sonarr keeps TVDB's numbering. Anything that does not resolve to exactly one Sonarr episode is
reported and left alone.

An unlinked file is invisible to Jellyfin, because Shokofin builds its virtual file system from
Shoko's *linked* files — so this is not only a wrong count, those episodes cannot be played. Link
all of a title's files in one click, retry AniDB across the whole collection, clear database rows
for files that no longer exist, then scan the anime library so Jellyfin picks them up.

**Keeping links up to date automatically**
Set `AUTO_LINK=true` and Hikari sweeps on a timer: it asks AniDB about everything it has no
record for, links whatever is still unmatched, and scans the anime library if anything changed.
Files newer than `AUTO_LINK_GRACE_HOURS` are left alone, because an AniDB match brings metadata a
hand link does not and unregistered releases are often added within a day.

A link only happens when the mapping is unambiguous: Sonarr's own record of that exact file path
pins it to one air date, and exactly one AniDB episode without a file aired on that date. Anything
else is reported and skipped. `GET /api/autolink` shows the last run, and `POST /api/autolink`
without `{"confirm":true}` is a dry run listing exactly what it would link.

To have it react to imports, add a Sonarr webhook (Settings, Connect, Webhook) pointing at
`http://hikari:7997/api/hooks/sonarr` on Import and Upgrade. Sonarr fires that before Shoko has
hashed the file, so it nudges Shoko to import and lets the next sweep do the linking.

One case it will not do for you: if Shoko has no series for a show at all — because every file
failed to match, so there is no local AniDB record to point at — add the series in Shoko once, and
the linking works from then on.

**Repairing watch state**
Jellyfin keys played flags to item ids, so when Shokofin rebuilds its virtual file system it
creates new items and the entire watch history is orphaned — a season you finished reads as 0.
When AniList is ahead of Jellyfin, Hikari offers to mark those episodes played again. It only ever
marks played, never unmarks, only up to the episode you name, and only when the Jellyfin match is
an exact id match so it cannot touch a whole multi-season series.

**Requesting**
Resolves an AniList entry to a TMDB id through Jellyseerr, works out which TMDB season the entry maps
to, and sends the request. Seasons you already requested are locked and excluded, so you cannot
create duplicates.

**Activity**
Your Sonarr queue, active and anime torrents with progress and ratio, and recent Jellyseerr requests.

**Phone layout**
Below 900px the sidebar is replaced by a slim top bar and a bottom tab bar, the detail drawer
becomes a bottom sheet, and tables scroll sideways with the name column pinned. The tab bar clears
the home indicator on a notched phone.

## Requirements

Only Jellyseerr is required. Everything else is optional and simply disables the features it powers.

| Service | Needed for | Without it |
| --- | --- | --- |
| Jellyseerr | Resolving titles and creating requests | Discovery still works, requesting does not |
| Sonarr | "In library" badges, episode counts, queue | No library badges |
| Jellyfin | Watch progress and next-up | No progress bars |
| Shoko | True episode counts from AniDB, missing episodes, release groups | Counts fall back to what is on disk |
| Radarr | Library badges for films | Films show no badge |
| qBittorrent | Torrent activity view | That section is empty |

You also need Docker, or Node 22+ if you want to run it directly.

## Quick start

**1. Get the config file**

```bash
cp .env.example .env
```

**2. Fill in your service URLs and API keys**

Use whatever address the machine running Hikari uses to reach each service — a hostname, a LAN IP, or
a Docker service name all work.

```ini
JELLYSEERR_URL=http://your-server:5055
JELLYSEERR_API_KEY=paste-from-jellyseerr-settings
```

Where to find each key:

- **Jellyseerr** — Settings, General, API Key
- **Sonarr** — Settings, General, API Key
- **Jellyfin** — Dashboard, API Keys, create a new key
- **qBittorrent** — your normal Web UI username and password

**3. Start it**

```bash
docker compose up -d --build
```

Open `http://localhost:7997`. The sidebar shows a status dot per service; hover one to see the
detected version or the error.

### Using the prebuilt image

Every push to `main` publishes a multi-architecture image to GitHub Container Registry, so you can
skip the build:

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

That file pulls `ghcr.io/viralone/hikari:latest`. Also available: `main`, `sha-<short>`, and a
version tag for each release. To update:

```bash
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

### Running it on the same host as your other services

If Sonarr, Jellyfin and the rest already run in Docker on one machine, put Hikari on the same
network so it can reach them by their internal addresses:

```yaml
services:
  hikari:
    build: .
    container_name: hikari
    restart: unless-stopped
    env_file: .env
    ports:
      - "7997:7997"
    volumes:
      - ./cache:/cache          # keeps the AniList cache across rebuilds
    networks:
      media_network:
        ipv4_address: 10.0.0.30 # a free address on that network

networks:
  media_network:
    external: true
    name: media_network         # the network your other containers already use
```

Then point `.env` at the internal addresses (`http://10.0.0.13:8989`) and set
`JELLYSEERR_PUBLIC_URL` to the address your *browser* uses, so "Open in Jellyseerr" links work.

### Running without Docker

```bash
npm install
npm run build
npm start
```

For frontend development with hot reload:

```bash
npm run dev      # API on 7997, Vite dev server on 5273
```

Checks:

```bash
npm run check      # typecheck
npm run test:unit  # title matcher unit cases, no services needed
npm run fixtures   # builds a labelled dataset by reading your stack (read-only)
npm test           # unit cases plus precision and recall floors, needs the fixtures
```

## Configuration

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
| `CACHE_FILE` | no | Path for the cache snapshot, so a restart does not re-fetch AniList |
| `HIKARI_TOKEN` | no | Shared secret required on the routes that change things. See Security |
| `HOST` | no | Bind address. Default `0.0.0.0`; use `127.0.0.1` for local-only |
| `PORT` | no | Default `7997` |

## Security

Hikari has no user accounts. It is built to sit on a trusted network alongside the services it talks
to, like the rest of a typical self-hosted stack.

What is already in place:

- Cross-origin requests to the API are rejected, so a random page you visit cannot make Hikari
  create requests on your behalf.
- Error responses never include the body returned by an upstream service, which would otherwise
  expose internal paths and versions.
- Your API keys stay on the server. The browser never receives them.

If the port is reachable from anywhere untrusted, do both of these:

```ini
HIKARI_TOKEN=some-long-random-string
HOST=127.0.0.1
```

`HOST=127.0.0.1` stops it listening on the network at all, which is the right setting if you reach it
through a reverse proxy on the same machine.

`HIKARI_TOKEN` makes the state-changing endpoints require `Authorization: Bearer <token>`. Be aware
of the trade-off: **the built-in web UI does not send this header**, so setting it turns the browser
into a read-only client and only scripted callers can request or update anything. If you need both a
protected port and a working UI, put authentication in your reverse proxy instead and leave
`HIKARI_TOKEN` unset.

### Where your AniList token comes from

If you already run the Ani-Sync Jellyfin plugin, it holds an AniList token you can reuse — no
separate OAuth app is needed. AniList issues a single scope, so that token can write as well as
read, which is why `ANILIST_ALLOW_WRITES` defaults to `false`.

## How requesting works

Anime is awkward because AniList, TMDB and Sonarr all disagree about what a "season" is. Hikari is
deliberately cautious about it.

**Season mapping.** AniList treats each cour as its own entry; TMDB usually groups them under one
show. Hikari guesses the matching TMDB season from an explicit ordinal in the title, then from the
air date, then from how many prequels exist. The guess is shown to you, and if it cannot work it out
it selects nothing and asks you to pick rather than requesting the wrong season.

**No duplicates.** Jellyseerr reports already-requested seasons inconsistently, so Hikari reads both
its season list and its open requests. Seasons that are pending, approved, downloading or available
are locked, excluded from the request, and labelled. If everything is already requested, the button
is replaced by a link to the existing request. The server checks again and refuses regardless of what
the browser sends.

**Anime settings actually get applied.** Jellyseerr only uses its anime quality profile and root
folder when TMDB has tagged a show with the anime keyword, which plenty of anime is missing. Since
everything in Hikari comes from AniList, it is anime by definition, so requests explicitly target
your anime profile and root folder. The detail panel shows where a request will land before you send
it.

**One thing Jellyseerr cannot do.** Sonarr's series type controls absolute episode numbering, and
Jellyseerr's API cannot set it. When a series is added as `standard`, Hikari detects it and offers a
button to correct it to `anime`.

## Watch progress

Progress comes from Jellyfin. Matching is done in this order:

1. AniList id, if your Jellyfin metadata provider records one
2. TVDB id
3. The Sonarr folder path
4. Title similarity

Only an AniList id match is guaranteed to refer to one specific entry. For the weaker matches,
Hikari counts what is on disk instead of the season length and tells you so, rather than showing a
number like "60 of 25" for a multi-season series.

When it does know the season length it also shows how many episodes have aired, and warns you when
aired episodes have not been downloaded yet.

## Homepage widget

`GET /api/homepage` returns flat counters for a [Homepage](https://gethomepage.dev) `customapi`
widget. The whole payload is cached, so polling it does not hit your services.

```json
{
  "season": "Summer 2026",
  "airing": 30,
  "inLibrary": 9,
  "watching": 1,
  "unwatched": 8,
  "missing": 7,
  "queue": 31,
  "downloading": 0,
  "pendingRequests": 0
}
```

The URL must be reachable **from Homepage's own container**, not from your browser. On a shared
Docker network use Hikari's address on that network; `localhost` will not work. If Homepage reports
`EHOSTUNREACH`, Hikari is not running at that address yet.

Add to `services.yaml`:

```yaml
- Media:
    - Hikari:
        href: http://your-server:7997
        description: Seasonal anime discovery and requests
        icon: mdi-television-play
        widget:
          type: customapi
          url: http://your-server:7997/api/homepage
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

`missing` counts episodes that have aired but are not on disk, which makes it a useful alarm for
"did my downloads actually happen this week".

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Per-service connectivity and detected versions |
| `GET /api/discover` | The four Discover rows, annotated with library and progress |
| `GET /api/schedule?days=7` | Airing schedule, 1 to 14 days |
| `GET /api/search?q=&season=&year=&format=&genre=` | AniList search |
| `GET /api/anime/:anilistId` | Full detail: library match, watch progress, season list, request state |
| `POST /api/request` | `{ tmdbId, mediaType, seasons, forceAnime }`. Returns 409 if nothing is left to request |
| `POST /api/sonarr/series/:id/series-type` | Corrects Sonarr's series type |
| `POST /api/sonarr/missing/:anilistId` | Plans a search for aired episodes that are not on disk. Only searches when the body is `{"confirm":true}` |
| `POST /api/list/:anilistId` | `{ status, progress, score }`. Requires `ANILIST_ALLOW_WRITES=true` |
| `POST /api/shoko/rescan/:anilistId/:fileId` | Asks AniDB about an unmatched file again |
| `POST /api/shoko/link/:anilistId/:fileId` | Links an unmatched file to its AniDB episode |
| `POST /api/shoko/link-all/:anilistId` | Links every unmatched file of one title to its episode |
| `POST /api/shoko/action/:name` | `refresh-anidb`, `forget-deleted` or `import-new` |
| `POST /api/jellyfin/played/:anilistId` | Marks episodes played up to `{ upTo }`. Only searches after `{"confirm":true}` |
| `POST /api/jellyfin/refresh` | Scans the anime library so newly linked files appear |
| `GET /api/autolink` | Automatic linking status and last run |
| `POST /api/autolink` | Runs a sweep. Dry run unless `{"confirm":true}` |
| `POST /api/hooks/sonarr` | Sonarr Connect webhook target |
| `GET /api/activity` | Sonarr queue, torrents, recent requests, and per-section errors |
| `GET /api/homepage` | Flat counters for a dashboard widget |

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

## Title matching

AniList and TMDB disagree constantly, so matching is defensive:

- Titles keep their Japanese characters during normalisation. Stripping them turned
  `薬屋のひとりごと 第2期` into just `2`, which then matched almost everything.
- Season markers are removed, so `Kusuriya no Hitorigoto 2nd Season` and `The Apothecary Diaries`
  reduce to the same key.
- Both sides need at least three meaningful characters to be compared at all.
- Substring shortcuts only count when the shorter title is at least 60% of the longer one, which
  stops `Monster` matching `Monogatari`.
- Movies are not matched against Sonarr, since they live in Radarr.

Match confidence is shown in the detail panel. When Hikari is not confident, it says so instead of
guessing.

## Troubleshooting

**A service dot is red.** Hover it for the error. The usual cause is a URL that Hikari cannot reach
from where it runs — inside Docker, `localhost` means the container, not your host.

**"No confident TMDB match".** TMDB has nothing close enough to the AniList title. Use the button to
open Jellyseerr and request it manually.

**A show says it is not in my library when it is.** Sonarr matching uses titles and alternate
titles. If a series folder is named after a release rather than the show, rename it in Sonarr.

**Watch progress is missing.** Check that `JELLYFIN_URL` and `JELLYFIN_API_KEY` are set, and that
`JELLYFIN_USER_ID` points at the account that actually watches things.

**Requests land in the wrong folder.** Set an anime quality profile and root folder on your
Jellyseerr Sonarr server. Without them, Hikari refuses to request rather than sending the show to
your regular TV folder.

## Limitations

- Jellyseerr only knows about media it requested itself, so a season you added directly in Sonarr can
  still read as "not requested". Hikari cross-checks Sonarr and warns you before you re-download
  something you already have.
- Movies can be resolved and requested, but there is no Radarr library badge yet.
- AniList writes are off by default. With `ANILIST_ALLOW_WRITES=true` you can set the status and
  edit episode progress from the detail panel; without it that section is read-only.

## Built with

Solid 2, Vite 8 and Hono on Node 22. No database — all state lives in the services it talks to.
