import { observe } from "./metrics.js";

export class UpstreamError extends Error {
  constructor(service, status, body, headers = null) {
    super(`${service} responded ${status}`);
    this.name = "UpstreamError";
    this.service = service;
    this.status = status;
    this.body = body;
    // Kept for the services that answer a refusal with instructions, like AniList's Retry-After.
    this.headers = headers;
  }
}

export async function request(service, url, options = {}) {
  // onHeaders sees every response, success or not, before the body is judged: AniList reports its
  // remaining rate limit on the calls that succeed, which is the only warning before the one that fails.
  const { timeout = 20000, onHeaders, ...rest } = options;
  const signal = AbortSignal.timeout(timeout);
  const started = performance.now();

  // One error scope for the connection and the body: a socket that dies mid-body is as much a
  // failed call as one that never connected, and both are recorded exactly once.
  let res;
  let text;
  try {
    res = await fetch(url, { ...rest, signal });
    text = await res.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    observe(service, performance.now() - started, message);
    throw new UpstreamError(service, 0, message);
  }

  let parsed = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  // Timed to the end of the body, not the first byte: a Jellyfin listing that streams for three
  // seconds is three seconds of waiting however quickly the headers arrived.
  observe(service, performance.now() - started, res.ok ? null : `responded ${res.status}`);
  onHeaders?.(res.headers);

  if (!res.ok) throw new UpstreamError(service, res.status, parsed, res.headers);
  return parsed;
}
