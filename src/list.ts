export type ListPayload = { status: string; progress?: number };

/**
 * What "Mark as watched" sends for a title that is not on your AniList list yet.
 *
 * Progress is only included when AniList knows how long the thing is. A series that is still airing
 * has no episode count, and writing a made-up number there would put a wrong figure on a real
 * account that nothing here can undo — completed with no progress is the honest version of that.
 */
export function watchedPayload(anime: { episodes: number | null }): ListPayload {
  const episodes = anime.episodes;
  if (!Number.isInteger(episodes) || (episodes as number) <= 0) return { status: "COMPLETED" };
  return { status: "COMPLETED", progress: episodes as number };
}
