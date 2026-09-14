# Library, watch progress and Shoko links

How Hikari works out what you already have, how far through it you are, and how it repairs the two
places that habitually disagree.

[Documentation index](README.md)

## Missing episodes, reconciled

"3 missing" turns out to mean four different things, and only one of them is a download. Every
episode AniDB knows about but Shoko has no file for gets a row saying which it is:

| State | What it means | Offered fix |
| --- | --- | --- |
| not downloaded | Nothing on disk | Search Sonarr, after showing you the list |
| downloaded, not linked in Shoko | Shoko hashed the file, AniDB never matched it | Rescan, link it by hand, or let the sweep do it |
| downloaded, Shoko has not scanned it | The file exists, Shoko has not seen it | Points you at an import scan |
| not aired yet | Counted by AniDB, has not aired | Nothing to do |

Episodes are matched to Sonarr by **air date**, because AniDB numbers a split cour from 1 while
Sonarr keeps TVDB's numbering. Anything that does not resolve to exactly one Sonarr episode is
reported and left alone.

An unlinked file is invisible to Jellyfin, because Shokofin builds its virtual file system from
Shoko's *linked* files, so this is not only a wrong count: those episodes cannot be played. Link
all of a title's files in one click, retry AniDB across the whole collection, clear database rows
for files that no longer exist, then scan the anime library so Jellyfin picks them up.

## Keeping links up to date automatically

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

One case it will not do for you: if Shoko has no series for a show at all, because every file
failed to match and there is no local AniDB record to point at. Add the series in Shoko once, and
the linking works from then on.

## Repairing watch state

Jellyfin keys played flags to item ids, so when Shokofin rebuilds its virtual file system it
creates new items and the entire watch history is orphaned, so a season you finished reads as 0.
When AniList is ahead of Jellyfin, Hikari offers to mark those episodes played again. It only ever
marks played, never unmarks, only up to the episode you name, and only when the Jellyfin match is
an exact id match so it cannot touch a whole multi-season series.

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
