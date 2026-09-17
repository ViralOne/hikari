# Getting started

[Documentation index](README.md)

## Requirements

Only Jellyseerr is required. Everything else is optional and simply disables the features it powers.

| Service | Needed for | Without it |
| --- | --- | --- |
| Jellyseerr | Resolving titles and creating requests | Discovery still works, requesting does not |
| Sonarr | "In library" badges, episode counts, queue | No library badges |
| Jellyfin | Watch progress and next-up | No progress bars |
| Shoko | True episode counts from AniDB, missing episodes, release groups, automatic episode linking | Counts fall back to what is on disk |
| Radarr | Library badges for films | Films show no badge |
| qBittorrent | Torrent activity view | That section is empty |

You also need Docker, or Node 22+ if you want to run it directly. No configuration file is
necessary. Everything can be set in the app.

## Quick start

```bash
docker compose up -d --build
```

Open `http://localhost:7997`. There is nothing to edit first: the app opens a welcome screen, you
paste in your service addresses and keys, and each one has a **Test connection** button so you find
out a key is wrong before you save it. Only Jellyseerr is required; the rest can be filled in later
from **Settings**.

Where to find each key:

- **Jellyseerr**: Settings, General, API Key
- **Sonarr** and **Radarr**: Settings, General, API Key
- **Jellyfin**: Dashboard, API Keys, create a new key
- **Shoko**: Settings, API Keys
- **qBittorrent**: your normal Web UI username and password

Use whatever address the machine running Hikari uses to reach each service. A hostname, a LAN IP or
a Docker service name all work. Inside Docker, `localhost` means the container, not your host.

What you save is written to `/cache/hikari-settings.json` at mode 600, which is why the compose file
mounts `./cache`. Keep that volume and your setup survives rebuilds.

The sidebar shows a status dot per service; hover one to see the detected version or the error.

### Configuring by file instead

Every setting also has an environment variable, so `.env` still works and is the fallback for
anything the UI has not overridden:

```bash
cp .env.example .env
```

Precedence is simple: a value saved in the app wins, otherwise the environment variable, otherwise
the built-in default. Clearing a field in the UI hands it back to the environment. Nothing Hikari
writes ever touches your `.env`.

`PORT` and `HOST` are environment-only on purpose, because both need a restart to mean anything.

`HIKARI_TOKEN` is a special case: it cannot be typed into the settings form, but once the login is on
a Jellyfin administrator can **generate** one under Settings → API token. Letting anyone who can
reach the port choose the secret that guards the network-facing routes would defeat the point of
having one, so the value is always minted by the server and never chosen by the caller. See
[Security](security.md).

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

### Checks

```bash
npm run check             # typecheck
npm run test:unit         # session, rate limit, matcher and auto-link cases, no services needed
npm run test:integration  # the whole server against in-process fakes of every service, no network
npm run fixtures          # builds a labelled dataset by reading your stack (read-only)
npm test                  # all of the above plus precision and recall floors, needs the fixtures
```

The integration test (`scripts/test-integration.mjs`) starts a real Hikari against fake Jellyseerr,
Sonarr, Radarr, Jellyfin, Shoko, AniList and qBittorrent servers (`scripts/lib/fakes.mjs`) and walks
the discover, detail, request and list flows end to end, checking what reached each fake as well as
what came back. The same fakes can be run behind the UI for manual or browser testing:

```bash
npm run build && npm run dev:fakes   # http://localhost:7998, PORT to change it
```
