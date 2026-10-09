/** An error carrying the server's "come back in N seconds", as api.ts throws for a 503. */
type MaybeRateLimited = { status?: number; retryIn?: number };

/**
 * Runs `load`, and when the server says AniList is rate limiting, waits the time it quoted and tries
 * again with the skeleton still up.
 *
 * Only for that one answer: any other failure is shown at once, because waiting will not fix it. A
 * quoted wait longer than `maxWaitS` is shown at once too, since that long behind a skeleton reads as
 * broken, and the message says when to try.
 */
export async function retryWhenRateLimited<T>(
  load: () => Promise<T>,
  {
    wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    attempts = 2,
    maxWaitS = 30
  }: { wait?: (ms: number) => Promise<void>; attempts?: number; maxWaitS?: number } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (err) {
      const { status, retryIn } = (err ?? {}) as MaybeRateLimited;
      const retryable = status === 503 && Number.isFinite(retryIn) && retryIn! > 0 && retryIn! <= maxWaitS;
      if (!retryable || attempt >= attempts) throw err;
      await wait(retryIn! * 1000);
    }
  }
}
