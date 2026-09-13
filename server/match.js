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

export function searchTitle(title) {
  if (!title) return "";
  const out = title
    .replace(/第\s*\d+\s*(?:期|季|シーズン)/g, " ")
    .replace(/シーズン\s*\d+/g, " ")
    .replace(/\b(?:the\s+)?(?:final|second|third|fourth|fifth)\s+season\b/gi, " ")
    .replace(/\bseason\s*\d+\b/gi, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, " ")
    .replace(/\b(?:part|cour)\s*\d+\b/gi, " ")
    .replace(/\s*[:\-–—]\s*$/, "");
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

export function scoreCandidate(anime, candidate) {
  const candidateTitle = candidate.name || candidate.title || "";
  const candidateDate = candidate.firstAirDate || candidate.releaseDate || "";
  const candidateYear = Number(candidateDate.slice(0, 4)) || null;

  const titleScore = Math.max(
    similarity(anime.title.romaji, candidateTitle),
    similarity(anime.title.english, candidateTitle),
    similarity(anime.title.native, candidateTitle)
  );

  const wantsMovie = anime.format === "MOVIE";
  const typeMatch = wantsMovie ? candidate.mediaType === "movie" : candidate.mediaType === "tv";

  let score = titleScore;
  if (!typeMatch) score -= 0.35;

  const animeYear = anime.startDate?.year || anime.seasonYear;
  if (animeYear && candidateYear) {
    const gap = Math.abs(animeYear - candidateYear);
    if (gap === 0) score += 0.12;
    else if (gap === 1) score += 0.04;
    else if (gap > 4) score -= 0.12;
  }

  if (candidate.mediaInfo) score += 0.03;
  return { score, titleScore, typeMatch, candidateYear };
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

export function guessSeasonNumber(anime, seasons) {
  const real = (seasons || []).filter(s => s.seasonNumber > 0);
  if (real.length === 0) return null;
  if (real.length === 1) return real[0].seasonNumber;

  const ordinal = seasonOrdinal(anime.title.romaji) || seasonOrdinal(anime.title.english);
  if (ordinal && real.some(s => s.seasonNumber === ordinal)) return ordinal;

  const target = anime.startDate?.year
    ? Date.UTC(anime.startDate.year, (anime.startDate.month || 1) - 1, anime.startDate.day || 1)
    : null;

  if (target) {
    let closest = null;
    for (const season of real) {
      if (!season.airDate) continue;
      const gap = Math.abs(new Date(`${season.airDate}T00:00:00Z`).getTime() - target);
      if (!closest || gap < closest.gap) closest = { gap, seasonNumber: season.seasonNumber };
    }
    if (closest && closest.gap < 400 * 24 * 3600 * 1000) return closest.seasonNumber;
  }

  if (anime.prequelCount > 0 && real.some(s => s.seasonNumber === anime.prequelCount + 1)) {
    return anime.prequelCount + 1;
  }
  return null;
}
