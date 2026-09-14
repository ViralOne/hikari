# Requesting

[Documentation index](README.md)

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
