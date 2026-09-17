const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

const CJK = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uff66-\\uff9f";
const KEEP = new RegExp(`[^a-z0-9'${CJK} ]+`, "g");
const MEANINGFUL = new RegExp(`[a-z${CJK}]`, "g");

const NOISE = [
  // Sonarr and Shokofin disambiguate remakes with a trailing year, which AniList titles never
  // carry. Leaving it in cost real matches, e.g. "Koukaku Kidoutai" vs "Koukaku Kidoutai (2026)".
  /\s*\((?:19|20)\d{2}\)\s*$/g,
  /第\s*\d+\s*(?:期|季|シーズン)/g,
  /シーズン\s*\d+/g,
  /\b(?:the\s+)?(?:final|second|third|fourth|fifth)\s+season\b/g,
  /\bseason\s*\d+\b/g,
  /\bpart\s*\d+\b/g,
  /\b(?:cour|kuur)\s*\d+\b/g,
  /\b\d+(?:st|nd|rd|th)\s+season\b/g,
  /\btv\b/g,
  // A trailing roman numeral is a season marker too, so "Youjo Senki II", "Youjo Senki 2"
  // and "Youjo Senki 2nd Season" all reduce to the same key. Kept last so the patterns above
  // have already removed the spelled-out forms.
  /\s+(?:i{1,3}|iv|vi{0,3}|ix|x)\s*$/g
];

export function normalize(title) {
  if (!title) return "";
  return memo(NORMALIZE_CACHE, title, input => {
    let out = input.toLowerCase().replace(/[‘’“”]/g, "'").replace(/&/g, " and ");
    for (const pattern of NOISE) out = out.replace(pattern, " ");
    out = out.replace(KEEP, " ");
    return out.replace(/\s+/g, " ").trim();
  });
}

// A trailing sequel number with nothing spelling out what it means. TMDB files sequels as seasons
// of the base title and returns nothing at all for the numbered form, so "Dagashi Kashi 2",
// "Tsugumomo2" and "KENGAN ASHURA Part I" all found zero candidates. Widening the query is safe
// because scoring still compares the full titles: searching "Steins;Gate" returns both entries and
// "Steins;Gate 0" still matches itself exactly.
const BARE_SEQUEL = /(?:\s+(?:i{1,3}|iv|vi{0,3}|ix|x)|\s*\d{1,2})$/i;

// Guard against eating the whole title. "86" and "5" are shows, not season two of something.
const SEQUEL_STRIP_FLOOR = 3;

export function searchTitle(title) {
  if (!title) return "";
  let out = title
    .replace(/第\s*\d+\s*(?:期|季|シーズン)/g, " ")
    .replace(/シーズン\s*\d+/g, " ")
    .replace(/\b(?:the\s+)?(?:final|second|third|fourth|fifth)\s+season\b/gi, " ")
    .replace(/\bseason\s*\d+\b/gi, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, " ")
    .replace(/\b(?:part|cour)\s*(?:\d+|i{1,3}|iv|vi{0,3}|ix|x)\b/gi, " ")
    .replace(/\s*[:\-–—]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  const stripped = out.replace(BARE_SEQUEL, "").trim();
  if ((stripped.toLowerCase().match(MEANINGFUL) || []).length >= SEQUEL_STRIP_FLOOR) out = stripped;

  return out.replace(/\s+/g, " ").trim();
}

export function usable(normalized) {
  return (normalized.match(MEANINGFUL) || []).length >= 3;
}

export function seasonOrdinal(title) {
  if (!title) return null;
  const lower = title.toLowerCase();

  const numeric = lower.match(/(?:season|part|cour)\s*(\d+)/) || lower.match(/(\d+)(?:st|nd|rd|th)\s+season/);
  if (numeric) return Number(numeric[1]);

  const roman = lower.match(/\s(i{1,3}|iv|vi{0,3}|ix|x)\s*$/);
  if (roman && ROMAN[roman[1]]) return ROMAN[roman[1]];

  if (/\bfinal\s+season\b/.test(lower)) return null;
  return null;
}

// Card annotation compares every AniList title against every Sonarr/Jellyfin key, so the same
// strings get bigrammed thousands of times per request. Memoise both stages.
const NORMALIZE_CACHE = new Map();
const BIGRAM_CACHE = new Map();
const CACHE_LIMIT = 20000;

function memo(cache, key, produce) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = produce(key);
  if (cache.size > CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

function bigrams(value) {
  return memo(BIGRAM_CACHE, value, input => {
    const set = new Set();
    for (let i = 0; i < input.length - 1; i += 1) set.add(input.slice(i, i + 2));
    return set;
  });
}

export function similarity(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (!usable(left) || !usable(right)) return 0;
  if (left === right) return 1;

  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  if (shorter.length >= 6 && shorter.length / longer.length >= 0.6 && longer.includes(shorter)) {
    return 0.9;
  }

  const first = bigrams(left);
  const second = bigrams(right);
  let shared = 0;
  for (const gram of first) if (second.has(gram)) shared += 1;
  return (2 * shared) / (first.size + second.size || 1);
}

// TMDB's Animation genre. Everything on AniList is animated, so a candidate TMDB classifies
// with genres that do not include this one is a live-action adaptation sharing the title.
export const ANIMATION_GENRE_ID = 16;

// A sequel's AniList start year describes the season, while a TMDB series carries the year the
// *first* season aired. Comparing the two is meaningless, and worse than meaningless: it rewards
// unrelated same-year entries and penalises the real parent series.
export function isSequel(anime) {
  if (seasonOrdinal(anime.title?.romaji) || seasonOrdinal(anime.title?.english)) return true;
  return Number.isInteger(anime.prequelDepth) && anime.prequelDepth > 0;
}

// AniList's format says how something was released; TMDB's media type says how TMDB chose to file
// it. Only TV and MOVIE line up reliably. A one-off OVA, ONA, special or music video is a TMDB
// movie far more often than a one-episode series -- "Bubble", "Tokyo Ghoul: [JACK]", "Shelter" --
// while a multi-episode ONA like Link Click is a series. Treating everything that was not MOVIE as
// a series cost those matches 0.35 for being filed correctly.
const SERIES_FORMATS = new Set(["TV", "TV_SHORT"]);

export function expectedType(anime) {
  if (anime.format === "MOVIE") return "movie";
  if (SERIES_FORMATS.has(anime.format)) return "tv";

  // For the release-shaped formats the episode count decides. Where AniList does not know it yet,
  // neither type is evidence, so nothing is penalised rather than guessing.
  if (anime.episodes === 1) return "movie";
  if (Number.isInteger(anime.episodes) && anime.episodes > 1) return "tv";
  return null;
}

export function scoreCandidate(anime, candidate) {
  const candidateTitle = candidate.name || candidate.title || "";
  const candidateDate = candidate.firstAirDate || candidate.releaseDate || "";
  const candidateYear = Number(candidateDate.slice(0, 4)) || null;

  const titleScore = Math.max(
    similarity(anime.title.romaji, candidateTitle),
    similarity(anime.title.english, candidateTitle),
    similarity(anime.title.native, candidateTitle)
  );

  const expected = expectedType(anime);
  const typeMatch = expected === null || candidate.mediaType === expected;

  let score = titleScore;
  if (!typeMatch) score -= 0.35;

  // Live-action remakes carry the same title and are the only entry for their year, so without
  // this they outscore the series they were adapted from: TMDB 314364 "Link Click" (2026) is the
  // Japanese remake of the 2021 donghua, and it won. Weighted like a type mismatch, because it is
  // one. An empty genre list means TMDB has not classified the entry, which says nothing.
  const genres = Array.isArray(candidate.genreIds) ? candidate.genreIds : [];
  const animated = genres.length === 0 ? null : genres.includes(ANIMATION_GENRE_ID);
  if (animated === false) score -= 0.35;

  const animeYear = anime.startDate?.year || anime.seasonYear;
  if (animeYear && candidateYear && !isSequel(anime)) {
    const gap = Math.abs(animeYear - candidateYear);
    if (gap === 0) score += 0.12;
    else if (gap === 1) score += 0.04;
    else if (gap > 4) score -= 0.12;
  }

  if (candidate.mediaInfo) score += 0.03;
  return { score, titleScore, typeMatch, animated, candidateYear };
}

export function pickBest(anime, candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (candidate.mediaType !== "tv" && candidate.mediaType !== "movie") continue;
    const scored = scoreCandidate(anime, candidate);
    if (!best || scored.score > best.score) best = { ...scored, candidate };
  }
  if (!best || best.titleScore < 0.5) return null;
  return best;
}

const DAY_MS = 24 * 3600 * 1000;

// A premiere within three weeks of the AniList start date is the same season, allowing for TMDB
// recording a regional or streaming date. Anything looser is a coincidence, not evidence.
const SAME_PREMIERE_MS = 21 * DAY_MS;

function closestByAirDate(anime, seasons) {
  const target = anime.startDate?.year
    ? Date.UTC(anime.startDate.year, (anime.startDate.month || 1) - 1, anime.startDate.day || 1)
    : null;
  if (!target) return null;

  let closest = null;
  for (const season of seasons) {
    if (!season.airDate) continue;
    const gap = Math.abs(new Date(`${season.airDate}T00:00:00Z`).getTime() - target);
    if (!closest || gap < closest.gap) closest = { gap, seasonNumber: season.seasonNumber };
  }
  return closest;
}

export function guessSeasonNumber(anime, seasons) {
  const real = (seasons || []).filter(s => s.seasonNumber > 0);
  if (real.length === 0) return null;
  if (real.length === 1) return real[0].seasonNumber;

  const closest = closestByAirDate(anime, real);

  // Air date first, but only when it is all but exact. TMDB numbers side stories into the main
  // run, which offsets everything after them: "Link Click: Bridon Arc" is TMDB season 3, so
  // AniList's Season 3 is TMDB season 4. The ordinal cannot see that; a shared premiere date can.
  if (closest && closest.gap <= SAME_PREMIERE_MS) return closest.seasonNumber;

  const ordinal = seasonOrdinal(anime.title.romaji) || seasonOrdinal(anime.title.english);
  if (ordinal && real.some(s => s.seasonNumber === ordinal)) return ordinal;

  // Same evidence, now as a fallback: too loose to outrank the ordinal, still better than nothing.
  if (closest && closest.gap < 400 * DAY_MS) return closest.seasonNumber;

  // The length of the prequel chain, not the number of direct edges: a third season has one
  // PREQUEL edge but two seasons before it. anilist.prequelDepth walks the chain and returns null
  // when it cannot, which must not be read as zero.
  const depth = Number.isInteger(anime.prequelDepth) ? anime.prequelDepth : null;
  if (depth !== null && depth > 0 && real.some(s => s.seasonNumber === depth + 1)) {
    return depth + 1;
  }
  return null;
}
