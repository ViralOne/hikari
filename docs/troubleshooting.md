# Troubleshooting

[Documentation index](README.md)

**A service dot is red.** Hover it for the error. The usual cause is a URL that Hikari cannot reach
from where it runs. Inside Docker, `localhost` means the container, not your host.

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
