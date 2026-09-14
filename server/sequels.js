import { cached } from "./cache.js";
import { byIds, gqlAuthed } from "./anilist.js";
import { enabled } from "./config.js";
import { viewer } from "./anilist-list.js";

// The most common reason to want an anime is that you finished the one before it. AniList already
// stores that graph, so this walks your own list rather than guessing from genres: no model, no
// similarity scoring, and the only judgement it makes is "you liked the previous one".
//
// Two pure functions do the work and are tested without a network: candidates() decides what counts
// as a sequel worth showing, rank() decides the order once the media has been fetched.

// A sequel is worth suggesting if you finished the parent, or if you are far enough into it that the
// next season is a reasonable thing to line up. Dropped and paused are deliberately not sources: a
// sequel to something you abandoned is noise.
const SOURCE_STATUSES = ["COMPLETED", "CURRENT", "REPEATING"];

const COLLECTION = `
  query ($userId: Int, $statuses: [MediaListStatus]) {
    MediaListCollection(userId: $userId, type: ANIME, status_in: $statuses, forceSingleCompletedList: true) {
      lists {
        entries {
          status
          score
          progress
          media {
            id
            episodes
            title { romaji english }
            relations {
              edges {
                relationType
                node { id type format status isAdult }
              }
            }
          }
        }
      }
    }
  }
`;

// Halfway is the line for a show you are still watching. Earlier than that and every long-runner you
// sampled would put its sequels in the row.
function finishedEnough(entry) {
  if (entry.status === "COMPLETED") return true;
  const total = entry.media?.episodes ?? null;
  const progress = entry.progress ?? 0;
  if (!total) return progress >= 1;
  return progress >= Math.ceil(total / 2);
}

/**
 * Reduces a MediaListCollection to the sequels not already on the list.
 * Returns a Map of media id to the reason it is being suggested, so a card can say why.
 */
export function candidates(collection, { owned = new Set() } = {}) {
  const entries = (collection?.lists || []).flatMap(list => list?.entries || []);

  // Everything on your list is "owned" whatever its status, including PLANNING: if you have already
  // written it down you do not need to discover it.
  const onList = new Set(owned);
  for (const entry of entries) {
    if (entry?.media?.id) onList.add(entry.media.id);
  }

  const found = new Map();

  for (const entry of entries) {
    if (!entry?.media || !SOURCE_STATUSES.includes(entry.status)) continue;
    if (!finishedEnough(entry)) continue;

    const parent = {
      id: entry.media.id,
      title: entry.media.title?.english || entry.media.title?.romaji || "something you watched",
      score: entry.score ?? 0,
      status: entry.status
    };

    for (const edge of entry.media.relations?.edges || []) {
      if (edge?.relationType !== "SEQUEL") continue;
      const node = edge.node;
      if (!node?.id || node.id === entry.media.id) continue;
      // Relations cross media types, so a manga continuation would otherwise end up in an anime row.
      if (node.type !== "ANIME" || node.isAdult) continue;
      if (onList.has(node.id)) continue;

      // A sequel can follow more than one thing you watched. Keep the parent you rated highest, so
      // the reason shown is the strongest one and the ranking below uses it.
      const existing = found.get(node.id);
      if (!existing || parent.score > existing.because.score) {
        found.set(node.id, { id: node.id, status: node.status ?? null, because: parent });
      }
    }
  }

  return found;
}

const BUCKETS = { RELEASING: 0, FINISHED: 1, NOT_YET_RELEASED: 2 };

/** Airing now first, then what you could watch tonight, then what is still coming. */
function bucket(status) {
  return BUCKETS[status] ?? 3;
}

function startsAt(media) {
  const date = media.startDate;
  if (!date?.year) return Number.MAX_SAFE_INTEGER;
  return Date.UTC(date.year, (date.month ?? 1) - 1, date.day ?? 1);
}

/**
 * Orders hydrated media and attaches the reason. Not folded into candidates() because the fields it
 * sorts on, the air date and popularity, only exist once the media has actually been fetched.
 */
export function rank(media, reasons) {
  return media
    .filter(item => item && reasons.has(item.id))
    .map(item => ({ ...item, because: reasons.get(item.id).because }))
    .sort((a, b) => {
      const byBucket = bucket(a.status) - bucket(b.status);
      if (byBucket !== 0) return byBucket;

      // Within "still coming", the soonest is the most useful. Everywhere else, how much you liked
      // the previous one decides.
      if (bucket(a.status) === BUCKETS.NOT_YET_RELEASED) {
        const byDate = startsAt(a) - startsAt(b);
        if (byDate !== 0) return byDate;
      }

      const byScore = (b.because.score ?? 0) - (a.because.score ?? 0);
      if (byScore !== 0) return byScore;
      return (b.popularity ?? 0) - (a.popularity ?? 0);
    });
}

export function sequels({ limit = 24 } = {}) {
  if (!enabled.anilistList) return Promise.resolve([]);

  return cached("anilist:sequels", 30 * 60 * 1000, async () => {
    const me = await viewer();
    if (!me) return [];

    const data = await gqlAuthed(COLLECTION, { userId: me.id, statuses: SOURCE_STATUSES });
    const reasons = candidates(data.MediaListCollection);
    if (reasons.size === 0) return [];

    const media = await byIds([...reasons.keys()]);
    return rank(media, reasons).slice(0, limit);
  });
}
