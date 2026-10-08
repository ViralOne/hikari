import { createSignal } from "solid-js";
import { getAnime, type AnimeDetail } from "../../api";

// Keyed by token as well as id, so every mutating action misses rather than showing stale state.
const detailCache = new Map<string, { at: number; value: AnimeDetail }>();
const detailInflight = new Set<string>();
const DETAIL_STALE_MS = 30 * 1000;
const DETAIL_CACHE_MAX = 40;

function rememberDetail(key: string, value: AnimeDetail) {
  // Delete first: Map.set on an existing key keeps its original insertion position, which would
  // make the title you keep reopening the first one evicted.
  detailCache.delete(key);
  detailCache.set(key, { at: Date.now(), value });
  while (detailCache.size > DETAIL_CACHE_MAX) {
    const oldest = detailCache.keys().next().value;
    if (oldest === undefined) break;
    detailCache.delete(oldest);
  }
}

/**
 * Serves a cached detail immediately and refreshes it behind your back.
 *
 * The revision signal is how the refresh reaches the panel: the fetch is read through it, so bumping
 * it re-runs the memo and the fresh value replaces the stale one without a spinner.
 */
export function createDetailFetcher() {
  const [revision, setRevision] = createSignal(0);

  const fetchDetail = (id: number, token: number, _revision: number) => {
    const key = `${id}:${token}`;
    const hit = detailCache.get(key);
    if (!hit) return getAnime(id).then(value => (rememberDetail(key, value), value));

    // Guarded on staleness and in-flight, or the revision bump would re-enter and never settle.
    if (Date.now() - hit.at > DETAIL_STALE_MS && !detailInflight.has(key)) {
      detailInflight.add(key);
      getAnime(id)
        .then(value => {
          rememberDetail(key, value);
          setRevision(current => current + 1);
        })
        .catch(() => {})
        .finally(() => detailInflight.delete(key));
    }
    return Promise.resolve(hit.value);
  };

  return { revision, fetchDetail };
}
