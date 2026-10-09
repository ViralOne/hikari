// Paging for the Activity torrent table. A library with a thousand anime torrents used to be cut
// at 60 rows (hiding the rest) or, uncut, would ship and render all of them every 15 seconds. The
// server now filters and counts the whole list but sends one page.

export const PAGE_SIZES = [10, 25, 50];
const DEFAULT_SIZE = 10;

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// "anime": anime only. "all": anime plus anything currently downloading, as the page always showed.
export function scopeTorrents(torrents, scope) {
  return scope === "all" ? torrents.filter(t => t.isAnime || t.active) : torrents.filter(t => t.isAnime);
}

// Totals for the "Right now" line, over the whole scoped list rather than the visible page, so
// the speeds and counts do not change as you page.
export function torrentStats(scoped, everything) {
  const active = scoped.filter(t => t.active);
  return {
    total: scoped.length,
    active: active.length,
    down: active.reduce((sum, t) => sum + (t.dlspeed || 0), 0),
    up: scoped.reduce((sum, t) => sum + (t.upspeed || 0), 0),
    anime: everything.filter(t => t.isAnime).length
  };
}

export function pageTorrents(torrents, { scope = "anime", page, size } = {}) {
  const scoped = scopeTorrents(torrents, scope);
  const pageSize = PAGE_SIZES.includes(toInt(size, DEFAULT_SIZE)) ? toInt(size, DEFAULT_SIZE) : DEFAULT_SIZE;
  const pages = Math.max(1, Math.ceil(scoped.length / pageSize));
  // A page past the end (the list shrank while you were on the last page) lands on the last page.
  const current = Math.min(toInt(page, 1), pages);
  return {
    items: scoped.slice((current - 1) * pageSize, current * pageSize),
    page: current,
    pageSize,
    pages,
    stats: torrentStats(scoped, torrents)
  };
}
