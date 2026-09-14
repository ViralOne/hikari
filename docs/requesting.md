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

## Continue the story

The row at the top of Discover is built from your own AniList list rather than from a popularity
sort. For every show you have completed, or are at least halfway through, Hikari follows AniList's
`SEQUEL` relations and keeps the ones that are not already on your list.

Order is deliberate: what is airing now first, then sequels that have finished and you could watch
tonight, then what is still coming, soonest first. Within a group the show whose predecessor you
rated highest wins, which is why each card says which show it follows and what you gave it.

Deliberately excluded: sequels to anything you dropped or paused, anything already on your list in
any status including Planning, manga continuations, and side stories. Only the next unwatched step in
a chain appears, so finishing season one surfaces season two and not season three.

Needs `ANILIST_TOKEN`. Without it the row does not appear. Cached for 30 minutes, and cleared as soon
as you change a list entry from inside Hikari.

## Choosing which rows you see

The **Rows** button above the rails hides rows you do not use and moves the ones you do to the top.
It is stored in your browser, not on the server, so each device can differ and it does not need an
administrator account when the login is on. A row added by a later version of Hikari appears
automatically rather than staying hidden.
