# Requesting

[Documentation index](README.md)

Anime is awkward because AniList, TMDB and Sonarr all disagree about what a "season" is. Hikari is
deliberately cautious about it.

**Finding the series.** Matched by id where possible. Hikari downloads
[Fribb/anime-lists](https://github.com/Fribb/anime-lists) on start and refreshes it weekly, which
maps an AniList id straight to a TMDB id, media type and season number. Titles are a poor key and no
amount of tuning fixes that: TMDB carries live-action remakes under the identical name (searching
"Link Click" finds the 2026 Japanese remake before the donghua it was adapted from), files a
franchise under its base title while AniList names the arc ("Bleach" against "BLEACH: Thousand-Year
Blood War - The Calamity"), and occasionally carries a placeholder entry that outranks the real one.

The download is optional and nothing waits on it. When there is no mapping for an entry — mostly
OVAs, shorts and specials TMDB does not carry at all — Hikari falls back to matching by title, and
the request box says which of the two decided it. One exception is deliberate: the list descends from
AniDB's cross-reference data, which files a film under its parent series rather than giving it an
entry of its own, so for an AniList entry that is a film pointed at a TMDB series the title match is
used instead. Without that, "Dragon Ball Super: Broly" resolves to the Dragon Ball Super series and
"The End of Evangelion" to the Evangelion series.

**Season mapping.** AniList treats each cour as its own entry; TMDB usually groups them under one
show. Where the mapping names a TMDB season, that is used, but only if TMDB really has it — the list
sometimes names a season of a show TMDB files as one flat run. Otherwise Hikari guesses: from a
shared premiere date first, then an explicit ordinal in the title, then a looser air-date match, then
how long the prequel chain is. Air date leads because TMDB numbers side stories into the main run,
which offsets everything after them — "Link Click: Bridon Arc" is TMDB season 3, so AniList's
Season 3 is TMDB season 4. The guess is shown to you, and if it cannot work it out it selects nothing
and asks you to pick rather than requesting the wrong season.

**When a season number cannot say what you mean.** Sometimes the mapping is not merely hard, it is
impossible, because the three sources disagree about how many seasons exist. Both directions happen:

- *TMDB folds seasons together.* The Apothecary Diaries is one 48-episode "Season 1" on TMDB and
  three seasons on TVDB, which is what Sonarr uses. Jellyseerr speaks TMDB, so the only season it
  can offer is 1 — and requesting it monitors Sonarr's first cour no matter which one you wanted.
- *AniList splits a season Sonarr keeps whole.* Slime's second season is two twelve-episode entries
  on AniList and a single 24-episode season 2 on TVDB. Requesting that season fetches twice what
  the entry covers.

Neither can be expressed as a season number, so Hikari sends the Jellyseerr request as normal and
then corrects Sonarr: it works out which episodes the AniList entry actually covers, monitors
exactly those, unmonitors the rest, removes anything Jellyseerr already grabbed for a season you did
not ask for, and searches only what is wanted. The request box says this is going to happen before
you press the button, and reports what was narrowed afterwards.

**Racing Jellyseerr's search.** Jellyseerr starts a Sonarr search the moment it adds the series, and
that search long outlives the request. Three things about it were learned the hard way:

- Sonarr refuses to cancel a search that has already started, answering 409. Cancelling is a head
  start for a queued search and never the defence.
- Unmonitoring the episodes does not stop it. The command fixed its episode list when it started.
- It does not grab as it goes. One measured `MissingEpisodeSearch` ran for eleven minutes and then
  pushed eight grabs in a fourteen-second burst at the very end, long after a fifty-second sweep had
  finished and reported success.

So the download queue cannot be swept on a timer. Hikari sweeps immediately, then keeps sweeping in
the background for as long as Sonarr is still searching that series, plus a grace period once it
clears, capped at twenty minutes. The panel says while this is still happening, because a removal can
legitimately arrive minutes after the narrowing was reported done. Anything grabbed for a season you
did not ask for is removed from Sonarr and from the download client without blocklisting, so those
releases can still be fetched if you request that season later.

The match is anchored on air date — the one field all three sources agree on — by finding the Sonarr
episode that aired on the AniList entry's start date and taking that entry's episode count forward.
Within three weeks, which is tight enough that it can never reach the neighbouring cour. If there is
no air date to go on it counts the prequel chain instead, and only accepts that when the episode
count agrees. Failing both, it monitors nothing and asks you to pick a season: a wrong season costs
a whole download, a refusal costs a click.

Seasons that already have files on disk are left completely alone, including their downloads in
progress. They predate the request, so narrowing one cour never disturbs another. Episodes that have
not aired are monitored but not searched, because there is nothing to find yet.

**Asking for more than one cour.** A request for a lumped show leaves Jellyseerr believing the whole
show is requested, because as far as TMDB is concerned it is. Jellyseerr can then add nothing more, so
its request button is a dead end for every other cour. Once Sonarr holds the series the panel stops
asking Jellyseerr and shows Sonarr's own cours instead, with what each one is actually monitoring, and
three things you can do: fetch this cour as well, fetch only this cour, or fetch the whole series.
Those are monitoring changes, not requests, which is why they work when Jellyseerr has nothing left to
give.

The same choice appears before a first request too: narrowing to one cour is right most of the time,
but it would actively undo a request for a whole series, so "just this cour" and "the whole series"
are offered up front rather than one being assumed.

**A season TVDB has not published yet.** Requesting a cour before it airs often finds a single
placeholder episode, because that is all TVDB lists. Hikari monitors the season itself, not just the
episodes it can see, so the rest are picked up as TVDB fills the list in.

Narrowing by hand goes through `POST /api/sonarr/narrow/:anilistId`, which only writes when you send
`{"confirm":true}` and otherwise answers with exactly what it would do. It unmonitors episodes and
removes downloads, so it follows the same plan-then-confirm shape as the missing-episode search.

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

## Ready to start

The plan list is where good intentions go to be forgotten. This row is the part of your AniList
**Planning** list that has stopped being an intention: every episode is already in your library
(Sonarr reports the series complete, or Jellyfin holds as many episodes as AniList counts), or the
show has finished airing so there is nothing left to wait for. Each card says which.

"In your library" trusts Sonarr's and Radarr's own completeness, or Jellyfin's episode count when the
match is by AniList or AniDB id; a Jellyfin match by title alone is not trusted for the count, since it
may be a whole multi-season series. Owned titles come first, because starting one costs nothing; then
the most recently planned (the 60 most recent plan entries are considered). Anything
you have already begun in Jellyfin is left out, since it belongs to your progress rather than to a
list of things to start. Titles still airing with episodes missing are not ready and do not appear.

Needs `ANILIST_TOKEN`, like Continue the story. Cached for 30 minutes and cleared as soon as you
change a list entry from inside Hikari.

## Choosing which rows you see

The **Rows** button above the rails hides rows you do not use and moves the ones you do to the top.
It is stored in your browser, not on the server, so each device can differ and it does not need an
administrator account when the login is on. A row added by a later version of Hikari appears
automatically rather than staying hidden.
