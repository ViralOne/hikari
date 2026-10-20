# Setting up Sonarr for anime

How to set Sonarr, qBittorrent and Shoko up so anime arrives once, with subtitles you can read, and
shows up in Jellyfin. Every rule here comes from something that went wrong on a real library: French-only
fansubs, "Multi-Subs" releases with no subtitles in them, second copies of episodes nobody could remove,
and preferred groups rejected by an overly broad rule.

Hikari's **Activity → Anime health** panel checks most of this for you. This page is what to set so it has
less to find.

## How a file should travel

```
Sonarr search ──► qBittorrent (category "tv", saves to /data/downloads)
                       │  finished
                       ▼
Sonarr import ──► hardlink + rename into /data/anime/<Series>/Season N/
                       │
                       ▼
Shoko hashes it ──► AniDB match ──► Shokofin ──► Jellyfin
                       │ no match (new release AniDB does not know)
                       ▼
Hikari auto-link, or Activity → Anime health → Link… (you confirm)
```

Two rules keep this working, and nearly every duplicate traced back to breaking one of them:

1. **Nothing saves a torrent into the library.** Torrents live in `/data/downloads`; only Sonarr writes to
   `/data/anime`, and it does so with hardlinks, so seeding costs no extra space. A torrent added by hand
   (qBittorrent's web UI, nzb360, LunaSea, any app with the qBittorrent password) with a save path inside a
   series folder becomes a second copy that Sonarr does not track and nothing ever removes.
2. **Anime is grabbed through Sonarr.** To pick a release yourself, use Sonarr's interactive search on
   the episode, not a tracker website. Sonarr then tracks the file, replaces it on an upgrade, and deletes it
   with the series.

## Sonarr

### Series

| Setting | Value | Why |
|---|---|---|
| Series type | **Anime** | Absolute numbering and anime naming. |
| Root folder | `/data/anime` | One root, the one Shoko imports from and Hikari's `ANIME_ROOT` points at. |
| Quality profile | **Anime 720p-1080p** (below) | |

### Media management

| Setting | Value | Why |
|---|---|---|
| Rename episodes | on | One predictable name per episode is what lets Hikari match Sonarr's file to Shoko's. |
| Anime episode format | `{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}` | |
| Use hardlinks instead of copy | on | Seeding and the library share one file on disk. |
| Recycling bin | `/data/.recycle`, 14 days | Every deletion Sonarr makes is recoverable for two weeks. This has already undone one bad import. |
| Delete empty folders | on | |
| Propers and repacks | Prefer and upgrade | |

### Download client

qBittorrent with **category `tv`**, completed download handling on. Leave qBittorrent's category save
paths empty or pointing inside `/data/downloads`, never at the library.

### Quality profile: Anime 720p-1080p

- Allowed: HDTV-720p, HDTV-1080p, WEB 720p, WEB 1080p, Bluray-720p, Bluray-1080p. Cutoff: **WEB 1080p**.
- Upgrades allowed. **Minimum custom format score −500**, so anything carrying a −10000 rule is rejected
  outright. Upgrade until score 0.
- **Minimum upgrade score 100.** At 1, Sonarr re-grabbed an episode for every release a few points better, and
  the losers piled up in the queue as "Not a Custom Format upgrade".

### Custom formats

All are *Release Title* conditions, case-insensitive regular expressions.

| Score | Name | Matches | Why |
|---:|---|---|---|
| +300 | Preferred Anime Groups (subbed) | `\b(SubsPlease\|Erai[ ._-]?raws\|VARYG\|DKB\|ASW)\b` | Groups that reliably ship English subtitles. |
| +250 | Dolby Atmos | `\b(atmos)\b` | |
| +150 | Anime Multi-Sub | `\b(multi[ ._-]?subs?\|multisub)\b` | A hint, not a promise (see BSITE). |
| +150 | TrueHD | `\b(true[ .-]?hd)\b` | |
| +100 | Anime Dual Audio | `\b(dual[ ._-]?audio)\b` | |
| +100 | DD+ / EAC3 | `\b(dd[p+]\|eac3\|e-?ac-?3)\b` | |
| −50 | AC3 2.0 stereo | `\bac3\b.*\b2\.0\b\|\b2\.0\b.*\bac3\b` | |
| −100 | WEBRip | `\b(web[ .-]?rip)\b` | Re-encodes; WEB-DL preferred. |
| −10000 | Anime RAW (no subs) | `(?<!erai[ ._-]?)\b(raw\|raws)\b` | Raws have no subtitles. The look-behind matters: without it **Erai-raws**, a preferred subbed group, was rejected too. |
| −10000 | Anime Foreign Subs Only | `\b(VOSTFR\|SUBFRENCH\|CHS\|CHT\|BIG5\|GB_?JP)\b\|简\|繁\|字幕组\|字幕組\|\bTsundere[ ._-]?Raws\b` | French-only (VOSTFR, Tsundere-Raws) and Chinese-only (CHS/CHT/BIG5, 字幕组 fansubs) releases. Add your own language's markers if you watch something other than English. |
| −10000 | Anime BSITE (subs missing) | `\bBSITE\b` | Bilibili site rips (ToonsHub "BSITE") arrive with no subtitle track even when the name says "Multi-Subs". BILI (the app) rips are fine. |
| −10000 | Anime English Dub | `\b(dubbed\|english[ ._-]?dub(bed)?\|eng[ ._-]?dub\|dual[ ._-]?audio[ ._-]?dub)\b` | Dub-only releases. Remove this rule if you watch dubs. |
| −10000 | Anime AMZN (audio only, no subs) | `\bAMZN\b` | |
| −10000 | Bad Source (CAM/TS/LINE/DCP) | `\b(cam(rip)?\|ts\|telesync\|telecine\|tc\|line[ .-]?audio\|dcp)\b` | |

Score the −10000 rules in **every** profile, not only the anime one: a series accidentally left on
HD-1080p would otherwise grab them.

Check a release name against your rules with Sonarr's parser:
`GET /api/v3/parse?title=<release name>` returns the custom formats it matched and the score.

### Delay profile

**60 minute torrent delay** on the default delay profile. Fansub groups often post a v2 or a better encode
shortly after the first upload; with no delay Sonarr grabbed the first, then again for each improvement. With
the delay it waits an hour after a release appears and grabs the best one. "Bypass if highest quality" stays on,
so a Bluray-1080p release is still grabbed at once.

## qBittorrent

| Setting | Value | Why |
|---|---|---|
| Default save path | `/data/downloads`, incomplete in `/data/downloads/incomplete` | Never the library. |
| Categories | `tv` (Sonarr), `radarr` (Radarr); save path empty | An empty category path means the default, inside downloads. |
| Excluded file names | `*.exe *.scr *.lnk *.bat *.cmd *.msi *.com *.pif *.vbs *.js *.ps1 *.jar` | Fake "episodes" that are installers never land on disk. |
| Share limits | ratio 1.0 or 7 days, then **stop** | Without a limit, Sonarr's "remove completed" never fires and the client grows forever. |
| Web UI password | only Sonarr, Radarr and Hikari should have it | Every app holding it can add torrents anywhere, including into the library. |

## Shoko

- **AniDB login and AVDump key** set (Settings → AniDB). Without the AVDump key, "Send to AniDB" cannot
  submit files AniDB does not know.
- The import folder is `/data/anime` (the same files Sonarr wrote; Shoko only reads them).
- New releases are often unknown to AniDB for hours or days. Shoko leaves them unlinked and Jellyfin cannot
  see them. Hikari handles this:
  - **Auto-link** (Settings → Auto-link) links files it can prove: one AniDB episode on the same air date, or
    the numbering a hash-matched file in the same season already confirmed.
  - **Anime health → Not in Jellyfin → Link…** shows everything else with a guess filled in and the reason
    for it. You confirm; it links and rescans Jellyfin. Hand links can be undone there.

## Season numbering

Release groups and TVDB do not always agree on what a season is. Netflix splits shows into "parts" that
groups call seasons (Money Heist: releases S1–S5, TVDB S1–S3), and AniDB gives every cour its own entry.
When Sonarr shows the wrong episodes in a season, compare the release's episode titles with Sonarr's before
importing; use **Manual Import** and pick the episodes yourself. Never let Sonarr import a pack whose season
number it had to guess.

## What Hikari checks

**Activity → Anime health**:

| Box | Means | Fix |
|---|---|---|
| Not in Jellyfin | Shoko could not match the file on AniDB | **Link…**, or Send to AniDB and wait |
| Broken torrents | qBittorrent lost the data | Clear entries (files untouched) |
| Orphaned torrents | Sonarr grabbed it, the series or file is gone | Remove in qBittorrent with files |
| Not managed by Sonarr | anime torrents Sonarr never grabbed | Import the folder in Sonarr or remove |
| Folders Sonarr does not manage | folders under the anime root with no series | Import or delete |
| **Extra copies** | a second file for an episode, in a series folder, that Sonarr does not track | **Remove copy** (file and torrent; never a file Sonarr tracks) |
| **No eng subtitles or audio** | Sonarr's media scan found no track you can follow | **Find better**: Sonarr searches and grabs a release that scores higher |

The languages that count as watchable are set with `WATCH_LANGUAGES` (default `eng`; e.g. `eng,rum`).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Episode on disk, missing in Jellyfin | Unlinked in Shoko: Anime health → Link… |
| Only some episodes of a new season show | Same; often AniDB matched one release and not the others |
| Two files for one episode | A torrent saved into the library; Extra copies → Remove copy |
| Subtitles in the wrong language or none | Release name lied; No subtitles → Find better. Add the group's marker to *Anime Foreign Subs Only* |
| A preferred group is never grabbed | A negative rule matches its name: check with `/api/v3/parse` (the Erai-raws case) |
| Sonarr says "Not a Custom Format upgrade" for a better release | The file it has scores higher; the negative rule for what is wrong with it is missing |
| The same episode downloads again and again | Upgrade churn: check the minimum upgrade score (100) and the 60 minute delay |
