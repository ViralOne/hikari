# API

[Documentation index](README.md)

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
| `GET /api/settings` | Every setting, its source, and whether a secret is set. Never returns a secret |
| `POST /api/settings` | Saves settings. An empty value clears the override |
| `POST /api/settings/test` | Probes one service, with unsaved values if you pass them |
| `GET /api/autolink` | Automatic linking status and last run |
| `POST /api/autolink` | Runs a sweep. Dry run unless `{"confirm":true}` |
| `POST /api/hooks/sonarr` | Sonarr Connect webhook target |
| `GET /api/activity` | Sonarr queue, torrents, recent requests, and per-section errors |
| `GET /api/homepage` | Flat counters for a dashboard widget |
