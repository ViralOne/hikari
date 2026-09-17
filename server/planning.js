import { byIds, gqlAuthed } from "./anilist.js";
import { cached } from "./cache.js";
import { enabled } from "./config.js";
import { viewer } from "./anilist-list.js";

// "Ready to start": things on your AniList plan that you could begin tonight, because the whole
// run is sitting in your library or because it has finished airing and nothing is left to wait
// for. The plan list is where good intentions go to be forgotten; this is the part of it that has
// stopped being an intention.
//
// planned() fetches the list and the media; readyToStart() is the pure half that decides, from the
// annotated media, what counts as ready and in which order. It is tested without a network.

const STATUSES = ["PLANNING"];

const COLLECTION = `
  query ($userId: Int, $statuses: [MediaListStatus]) {
    MediaListCollection(userId: $userId, type: ANIME, status_in: $statuses) {
      lists {
        entries {
          updatedAt
          media { id }
        }
      }
    }
  }
`;

// Every PLANNING entry, shaped, newest addition first, with when it was planned attached. Not yet
// filtered: whether something is "ready" depends on the library, which index.js annotates after.
export function planned({ limit = 60 } = {}) {
  if (!enabled.anilistList) return Promise.resolve([]);

  // Saving to the list invalidates this. The cap keeps the byIds fan-out to two AniList pages
  // even for a plan list in the hundreds.
  return cached("anilist:planning", 30 * 60 * 1000, async () => {
    const me = await viewer();
    if (!me) return [];

    const data = await gqlAuthed(COLLECTION, { userId: me.id, statuses: STATUSES });
    const entries = (data.MediaListCollection?.lists || []).flatMap(list => list?.entries || []);
    const plannedAt = new Map();
    for (const entry of entries) {
      const id = entry?.media?.id;
      if (id) plannedAt.set(id, entry.updatedAt ?? 0);
    }
    if (plannedAt.size === 0) return [];

    const ids = [...plannedAt.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, limit);
    const media = await byIds(ids);
    return media.filter(Boolean).map(item => ({ ...item, plannedAt: plannedAt.get(item.id) ?? 0 }));
  }, { staleFor: 30 * 60 * 1000 });
}

// Whether every episode is on disk, by whichever source knows. Sonarr's and Radarr's own `complete`
// flags first; then Jellyfin's count against AniList's total, but only for a match scoped to this
// exact title (AniList or AniDB id). A title or path match can be a whole multi-season Jellyfin
// series, whose item count would call a season you do not have "complete".
function wholeRunOnDisk(item) {
  if (item.library?.complete || item.movie?.complete) return true;
  if (!item.watch?.scoped) return false;
  const total = item.episodes ?? null;
  const onDisk = item.watch.onDisk ?? 0;
  return Boolean(total) && onDisk >= total;
}

/**
 * From annotated PLANNING media, the ones you could start now, each with a `note` for the card.
 * Something you have already begun in Jellyfin is left out: it belongs to "continue", not "start".
 */
export function readyToStart(media) {
  return media
    .filter(item => item && !item.watch?.started)
    .map(item => {
      const owned = wholeRunOnDisk(item);
      const finished = item.status === "FINISHED";
      if (!owned && !finished) return null;
      return {
        ...item,
        ready: { owned, finished },
        note: owned ? (finished ? "Complete in your library" : "All aired episodes on disk") : "Finished airing"
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Owned first: it costs nothing to start. Then most recently planned, then popularity.
      if (a.ready.owned !== b.ready.owned) return a.ready.owned ? -1 : 1;
      const byPlanned = (b.plannedAt ?? 0) - (a.plannedAt ?? 0);
      if (byPlanned !== 0) return byPlanned;
      return (b.popularity ?? 0) - (a.popularity ?? 0);
    });
}
