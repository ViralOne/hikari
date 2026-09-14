// Fixed-window counters, kept in memory because this is a single process and a limiter that
// needs its own datastore is a limiter nobody turns on.
//
// Login gets an escalating lockout on top: five wrong guesses a minute is generous for a person
// and useless for a script, and each further lockout doubles the wait, so a patient attacker is
// slowed to a crawl without ever locking a real user out for long.

const buckets = new Map();
const strikes = new Map();

const now = () => Date.now();

export function hit(key, { max, windowMs }) {
  const bucket = buckets.get(key);
  const time = now();

  if (!bucket || time >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: time + windowMs });
    return { allowed: true, remaining: max - 1, retryIn: 0 };
  }

  bucket.count += 1;
  if (bucket.count > max) {
    return { allowed: false, remaining: 0, retryIn: Math.ceil((bucket.resetAt - time) / 1000) };
  }
  return { allowed: true, remaining: max - bucket.count, retryIn: 0 };
}

// Separate from hit() so a successful login can clear the penalty without clearing the window.
export function penalise(key, { baseMs, maxMs }) {
  const record = strikes.get(key) ?? { count: 0, until: 0 };
  record.count += 1;
  record.until = now() + Math.min(baseMs * 2 ** (record.count - 1), maxMs);
  strikes.set(key, record);
  return Math.ceil((record.until - now()) / 1000);
}

export function lockedFor(key) {
  const record = strikes.get(key);
  if (!record || record.until <= now()) return 0;
  return Math.ceil((record.until - now()) / 1000);
}

export function forgive(key) {
  strikes.delete(key);
  buckets.delete(key);
}

// Without this every address that ever knocked stays in memory for the life of the process.
export function sweep() {
  const time = now();
  for (const [key, bucket] of buckets) if (time >= bucket.resetAt) buckets.delete(key);
  for (const [key, record] of strikes) if (time >= record.until + 60 * 60 * 1000) strikes.delete(key);
  return { buckets: buckets.size, strikes: strikes.size };
}

setInterval(sweep, 5 * 60 * 1000).unref?.();
