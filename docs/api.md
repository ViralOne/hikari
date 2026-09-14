# API

[Documentation index](README.md)

| Route | Purpose |
| --- | --- |
| `GET /api/health/live` | `{"ok":true}` as long as the process is serving. The only route the login never gates, because the container healthcheck cannot hold a cookie |
| `GET /api/health` | Per-service connectivity and detected versions |
| `GET /api/discover` | The Discover rows, annotated with library and progress |
| `GET /api/sequels` | Sequels to what you have finished, from your AniList list. Needs `ANILIST_TOKEN` |
| `GET /api/schedule?days=7` | Airing schedule, 1 to 14 days |
| `GET /api/search?q=&season=&year=&format=&genre=` | AniList search |
| `GET /api/anime/:anilistId` | Full detail: library match, watch progress, season list, request state, and `cours` when TMDB's seasons do not line up with Sonarr's |
| `POST /api/request` | `{ tmdbId, mediaType, seasons, forceAnime, anilistId, whole }`. Returns 409 if nothing is left to request. With `anilistId`, narrows Sonarr to the requested cour afterwards when the seasons are lumped; `whole: true` monitors every season instead |
| `POST /api/sonarr/series/:id/series-type` | Corrects Sonarr's series type |
| `POST /api/sonarr/narrow/:anilistId` | Sets which cours Sonarr fetches. Only writes when the body is `{"confirm":true}`; otherwise returns the plan. `mode` is `exclusive` (this cour only, the default), `add` (this cour as well) or `whole` (every season). `{ seasonNumber }` forces a season, without it the cour is resolved from air dates. 409 when it cannot be worked out, with Sonarr's season list to pick from |
| `POST /api/sonarr/missing/:anilistId` | Plans a search for aired episodes that are not on disk. Only searches when the body is `{"confirm":true}` |
| `POST /api/list/:anilistId` | `{ status, progress, score }`. Requires `ANILIST_ALLOW_WRITES=true` |
| `POST /api/shoko/rescan/:anilistId/:fileId` | Asks AniDB about an unmatched file again |
| `POST /api/shoko/link/:anilistId/:fileId` | Links an unmatched file to its AniDB episode |
| `POST /api/shoko/link-all/:anilistId` | Links every unmatched file of one title to its episode |
| `POST /api/shoko/action/:name` | `refresh-anidb`, `forget-deleted` or `import-new` |
| `POST /api/jellyfin/played/:anilistId` | Marks episodes played up to `{ upTo }`. Only searches after `{"confirm":true}` |
| `POST /api/jellyfin/refresh` | Scans the anime library so newly linked files appear |
| `GET /api/auth` | Whether a login is required and who is signed in. Readable while signed out |
| `POST /api/auth/login` | `{ username, password }`, checked against Jellyfin. `401` wrong credentials, `403` account not allowed, `429` throttled, `503` no Jellyfin configured |
| `POST /api/auth/logout` | Clears the cookie. `?everywhere=1` invalidates every session and needs a valid session or the token, else `401` |
| `GET /api/settings` | Every setting, its source, and whether a secret is set. Never returns a secret |
| `POST /api/settings` | Saves settings. An empty value clears the override |
| `POST /api/settings/test` | Probes one service, with unsaved values if you pass them |
| `POST /api/settings/token` | Generates the shared secret and returns it once. `409` if the login is off and no token is set |
| `DELETE /api/settings/token` | Removes it, handing the field back to `HIKARI_TOKEN`. Same `409` |
| `GET /api/autolink` | Automatic linking status and last run |
| `POST /api/autolink` | Runs a sweep. Dry run unless `{"confirm":true}` |
| `POST /api/hooks/sonarr` | Sonarr Connect webhook target |
| `GET /api/activity` | Sonarr queue, torrents, recent requests, and per-section errors |
| `GET /api/homepage` | Flat counters for a dashboard widget |

The settings routes need a Jellyfin administrator account when the login is on, or the shared token
when one is set. Everything else needs any signed-in account, and a signed-in session satisfies the
token check too, so the browser keeps working once a token exists. With the login off and no token,
the whole API is open, which is why the port belongs on a trusted network.

`POST /api/settings` refuses the `token` field with `400`: the secret is only settable through
`POST /api/settings/token`, which returns the generated value in `{"token": "..."}`. That is the only
response that ever carries it, so store it when you see it.

The two token routes take no body, but send `Content-Type: application/json` anyway. Without it the
CSRF check treats the request as form-like and compares the `Origin` header, which a plain `curl` does
not send, so you get `403` and a non-JSON body.
