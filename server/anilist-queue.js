import { AsyncLocalStorage } from "node:async_hooks";

// The one gate every AniList call goes through.
//
// AniList limits by IP across everything Hikari does at once: the Discover warm-up, card annotation,
// the franchise and prequel walks, and the panel someone is waiting on. It is also currently degraded
// to 30 requests a minute from its usual 90. Without a shared gate those callers burst independently,
// all hit 429 together, retry together on a fixed schedule far shorter than the Retry-After AniList
// sends, and the panel that was clicked comes back as a 502.
//
// So this is a token bucket shared by all of them, with two lanes:
//
//   user        something a person is waiting on. Always served first, may use the whole budget,
//               and refused at once with a RateLimitedError when it would wait longer than
//               userWaitMs -- a skeleton that sits there for thirty seconds is worse than a message.
//   background  warm-ups and refreshes. Waits as long as it has to, and only runs while a third of
//               the budget is left over, so a click never arrives to an empty bucket.
//
// The bucket starts at the conservative limit and is corrected by AniList's own headers on every
// response: X-RateLimit-Limit when the degraded state ends, X-RateLimit-Remaining because AniList
// counts calls this process cannot see (another app on the same network, a script run by hand).

export class RateLimitedError extends Error {
  constructor(retryIn) {
    super(`AniList is rate limiting requests. Try again in ${retryIn}s.`);
    this.name = "RateLimitedError";
    this.service = "anilist";
    this.httpStatus = 503;
    this.retryIn = retryIn;
  }
}

// Which lane the current async work belongs to. Carried by the async context rather than passed
// down, because the AniList call sits several layers below whatever decided it was background work.
const laneStore = new AsyncLocalStorage();

export function inBackground(fn) {
  return laneStore.run("background", fn);
}

export function currentLane() {
  return laneStore.getStore() ?? "user";
}

const MINUTE_MS = 60 * 1000;
// What a 429 without a usable Retry-After is taken to mean: AniList's limits are per minute.
const DEFAULT_PAUSE_S = 60;

export function createQueue({
  limit = 30,
  now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms).unref?.()),
  userWaitMs = 8000
} = {}) {
  let capacity = limit;
  let tokens = limit;
  let refilledAt = now();
  let pausedUntil = 0;

  const lanes = { user: [], background: [] };
  let pumping = false;
  // Resolved to wake a pump that is asleep, so a click does not sleep through a background wait.
  let wake = () => {};

  const perMs = () => capacity / MINUTE_MS;
  const reserve = () => Math.ceil(capacity / 3);

  const refill = () => {
    const time = now();
    tokens = Math.min(capacity, tokens + (time - refilledAt) * perMs());
    refilledAt = time;
  };

  // How long until `needed` tokens are available, including any pause AniList asked for.
  const delayUntil = needed => {
    refill();
    const pause = Math.max(0, pausedUntil - now());
    const deficit = Math.max(0, needed - tokens);
    return Math.max(pause, deficit / perMs());
  };

  const needs = lane => (lane === "user" ? 1 : 1 + reserve());

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (lanes.user.length > 0 || lanes.background.length > 0) {
        const lane = lanes.user.length > 0 ? "user" : "background";
        const delay = delayUntil(needs(lane));
        if (delay > 0) {
          await Promise.race([wait(Math.ceil(delay)), new Promise(resolve => (wake = resolve))]);
          continue;
        }
        const job = lanes[lane].shift();
        tokens -= 1;
        // Started, not awaited: the bucket paces when calls go out, and a slow response should not
        // hold up the next one.
        Promise.resolve().then(job.task).then(job.resolve, job.reject);
      }
    } finally {
      pumping = false;
    }
  }

  function run(task, { lane = currentLane() } = {}) {
    const name = lane === "background" ? "background" : "user";

    if (name === "user") {
      // Everyone already queued in the user lane takes a token before this one does.
      const waitMs = delayUntil(lanes.user.length + 1);
      if (waitMs > userWaitMs) return Promise.reject(new RateLimitedError(Math.ceil(waitMs / 1000)));
    }

    return new Promise((resolve, reject) => {
      lanes[name].push({ task, resolve, reject });
      wake();
      pump();
    });
  }

  // Called with what AniList's headers say. Only ever corrects downwards on the count: AniList knows
  // about calls this process did not make, but a stale header must not hand back tokens already spent.
  function observe({ limit: reported, remaining } = {}) {
    if (Number.isInteger(reported) && reported > 0 && reported !== capacity) {
      capacity = reported;
      tokens = Math.min(tokens, capacity);
    }
    if (Number.isFinite(remaining) && remaining >= 0) {
      refill();
      tokens = Math.min(tokens, remaining);
    }
  }

  // A 429. Everything stops for as long as AniList asked, and a later, shorter answer cannot cut a
  // longer pause short.
  function throttled(retryAfterSeconds) {
    const seconds = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : DEFAULT_PAUSE_S;
    pausedUntil = Math.max(pausedUntil, now() + seconds * 1000);
    refill();
    tokens = 0;
  }

  function snapshot() {
    refill();
    return {
      limit: capacity,
      tokens,
      pausedFor: Math.max(0, pausedUntil - now()),
      queued: { user: lanes.user.length, background: lanes.background.length }
    };
  }

  return { run, observe, throttled, snapshot };
}

// AniList's headers, as numbers. Missing or malformed values come back as NaN, which observe() and
// throttled() both ignore.
export function readLimits(headers) {
  const number = name => {
    const raw = headers?.get?.(name);
    return raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
  };
  return {
    limit: number("x-ratelimit-limit"),
    remaining: number("x-ratelimit-remaining"),
    retryAfter: number("retry-after")
  };
}
