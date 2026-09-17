import { config, enabled } from "./config.js";
import { cached, invalidate } from "./cache.js";
import { gqlAuthed } from "./anilist.js";

export const STATUSES = ["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED", "REPEATING"];

export const STATUS_LABELS = {
  CURRENT: "Watching",
  PLANNING: "Planning",
  COMPLETED: "Completed",
  PAUSED: "Paused",
  DROPPED: "Dropped",
  REPEATING: "Rewatching"
};

export function viewer() {
  if (!enabled.anilistList) return Promise.resolve(null);
  return cached("anilist:viewer", 60 * 60 * 1000, async () => {
    const data = await gqlAuthed("query { Viewer { id name siteUrl } }");
    return data.Viewer;
  });
}

const COLLECTION = `
  query ($userId: Int) {
    MediaListCollection(userId: $userId, type: ANIME) {
      lists {
        status
        entries {
          id
          status
          progress
          score
          repeat
          updatedAt
          media { id episodes }
        }
      }
    }
  }
`;

// One call covers the whole list, which is what makes this cheap enough to annotate every card.
export function listIndex() {
  if (!enabled.anilistList) return Promise.resolve(new Map());

  return cached("anilist:list", 5 * 60 * 1000, async () => {
    const me = await viewer();
    if (!me) return new Map();

    const data = await gqlAuthed(COLLECTION, { userId: me.id });
    const index = new Map();

    for (const list of data.MediaListCollection?.lists || []) {
      for (const entry of list.entries || []) {
        const total = entry.media?.episodes ?? null;
        index.set(entry.media.id, {
          entryId: entry.id,
          status: entry.status,
          statusLabel: STATUS_LABELS[entry.status] || entry.status,
          progress: entry.progress ?? 0,
          total,
          score: entry.score ?? 0,
          repeat: entry.repeat ?? 0,
          updatedAt: entry.updatedAt ?? null,
          caughtUp: Boolean(total) && (entry.progress ?? 0) >= total
        });
      }
    }
    return index;
  }, { staleFor: 10 * 60 * 1000 });
}

export async function entryFor(anilistId) {
  const index = await listIndex().catch(() => new Map());
  return index.get(Number(anilistId)) || null;
}

const SAVE = `
  mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $score: Float) {
    SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, score: $score) {
      id
      status
      progress
      score
    }
  }
`;

export class ListWriteError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ListWriteError";
    this.httpStatus = status;
  }
}

export async function saveEntry({ mediaId, status, progress, score }) {
  if (!enabled.anilistList) throw new ListWriteError("No AniList token configured", 503);
  if (!config.anilist.allowWrites) {
    throw new ListWriteError("AniList writes are disabled. Set ANILIST_ALLOW_WRITES=true to enable them.", 403);
  }
  if (status && !STATUSES.includes(status)) {
    throw new ListWriteError(`status must be one of ${STATUSES.join(", ")}`, 400);
  }

  // These land on a real account and cannot be undone. Number("") is 0, which would silently
  // reset watch progress, and Number("abc") is NaN, which JSON.stringify sends as null.
  if (progress !== undefined && progress !== null) {
    if (!Number.isInteger(progress) || progress < 0 || progress > 10000) {
      throw new ListWriteError("progress must be a non-negative integer", 400);
    }
  }
  if (score !== undefined && score !== null) {
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new ListWriteError("score must be a number between 0 and 100", 400);
    }
  }

  const variables = { mediaId: Number(mediaId) };
  if (status) variables.status = status;
  if (progress !== undefined && progress !== null) variables.progress = progress;
  if (score !== undefined && score !== null) variables.score = score;

  const data = await gqlAuthed(SAVE, variables);
  invalidate("anilist:list");
  // Adding something to the list means it is no longer a discovery, so the sequel row is stale too.
  invalidate("anilist:sequels");
  invalidate("anilist:planning");
  return data.SaveMediaListEntry;
}
