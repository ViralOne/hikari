export class UpstreamError extends Error {
  constructor(service, status, body) {
    super(`${service} responded ${status}`);
    this.name = "UpstreamError";
    this.service = service;
    this.status = status;
    this.body = body;
  }
}

export async function request(service, url, options = {}) {
  const { timeout = 20000, ...rest } = options;
  const signal = AbortSignal.timeout(timeout);

  let res;
  try {
    res = await fetch(url, { ...rest, signal });
  } catch (err) {
    throw new UpstreamError(service, 0, err instanceof Error ? err.message : String(err));
  }

  const text = await res.text();
  let parsed = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) throw new UpstreamError(service, res.status, parsed);
  return parsed;
}
