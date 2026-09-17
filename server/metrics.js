// Per-service latency, kept in memory since boot. Answers "why is the panel slow" from the sidebar
// rather than from a log: every upstream call goes through http.request() (qBittorrent's raw
// fetches report here too), so a service that has started taking two seconds shows up as such.
//
// A short ring of recent samples per service rather than a running total: the question is always
// what a service is doing now, not what it averaged over the last week.

const WINDOW = 100;

const services = new Map();

function slot(service) {
  let entry = services.get(service);
  if (!entry) {
    entry = { samples: [], calls: 0, errors: 0, lastAt: null, lastMs: null, lastError: null };
    services.set(service, entry);
  }
  return entry;
}

export function observe(service, ms, error = null) {
  const entry = slot(service);
  entry.calls += 1;
  entry.lastAt = Date.now();
  entry.lastMs = Math.round(ms);
  if (error) {
    entry.errors += 1;
    entry.lastError = String(error).slice(0, 200);
  }
  entry.samples.push(entry.lastMs);
  if (entry.samples.length > WINDOW) entry.samples.shift();
}

// Times a promise-returning call and records it, whatever the outcome. Rethrows unchanged so the
// caller's error handling is untouched.
export async function timed(service, fn) {
  const started = performance.now();
  try {
    const result = await fn();
    observe(service, performance.now() - started);
    return result;
  } catch (err) {
    observe(service, performance.now() - started, err?.message || err);
    throw err;
  }
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function upstreamStats() {
  const out = {};
  for (const [service, entry] of services) {
    const sorted = [...entry.samples].sort((a, b) => a - b);
    out[service] = {
      calls: entry.calls,
      errors: entry.errors,
      // Over the recent window only; calls and errors are since boot.
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      lastMs: entry.lastMs,
      lastAt: entry.lastAt,
      lastError: entry.lastError
    };
  }
  return out;
}

// Tests only: the module is a singleton, so a run that spawns nothing still needs a clean slate.
export function resetMetrics() {
  services.clear();
}
