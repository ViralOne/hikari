import { config } from "./config.js";
import { cached } from "./cache.js";
import { request } from "./http.js";

// Overridable only so the integration tests can point it at an in-process fake (scripts/lib/fakes.mjs).
const ENDPOINT = (process.env.ANILIST_URL || "https://graphql.anilist.co").trim();

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  description(asHtml: false)
  coverImage { extraLarge large color }
  bannerImage
  format
  status
  episodes
  duration
  season
  seasonYear
  genres
  averageScore
  popularity
  startDate { year month day }
  isAdult
  nextAiringEpisode { episode airingAt timeUntilAiring }
  studios(isMain: true) { nodes { name } }
  relations { edges { relationType node { id title { romaji } format } } }
  siteUrl
`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function gql(query, variables, attempt = 0) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (config.anilist.token) headers.Authorization = `Bearer ${config.anilist.token}`;

  let body;
  try {
    body = await request("anilist", ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      timeout: 25000
    });
  } catch (err) {
    // AniList allows 90 requests/minute and answers 429 once that is exceeded. One backoff
    // covers a burst; a sustained limit falls through to the cache's stale value.
    const retryable = err.status === 429 || (err.status >= 500 && err.status < 600);
    if (retryable && attempt < 2) {
      await sleep(attempt === 0 ? 1500 : 4000);
      return gql(query, variables, attempt + 1);
    }
    throw err;
  }

  if (body.errors?.length) {
    throw new Error(`AniList: ${body.errors.map(e => e.message).join("; ")}`);
  }
  return body.data;
}

// Same transport, but requires the token. Used for list reads and writes.
export async function gqlAuthed(query, variables) {
  if (!config.anilist.token) throw new Error("No AniList token configured");
  return gql(query, variables);
}

export function currentSeason(date = new Date()) {
  const month = date.getUTCMonth();
  const season = month < 3 ? "WINTER" : month < 6 ? "SPRING" : month < 9 ? "SUMMER" : "FALL";
  return { season, year: date.getUTCFullYear() };
}

export function shiftSeason({ season, year }, steps) {
  const order = ["WINTER", "SPRING", "SUMMER", "FALL"];
  const index = order.indexOf(season) + steps;
  return {
    season: order[((index % 4) + 4) % 4],
    year: year + Math.floor(index / 4)
  };
}

const PAGE_QUERY = `
  query ($page: Int, $perPage: Int, $sort: [MediaSort], $season: MediaSeason, $seasonYear: Int, $search: String, $format_in: [MediaFormat], $genre: String, $status: MediaStatus) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage total }
      media(
        type: ANIME
        isAdult: false
        sort: $sort
        season: $season
        seasonYear: $seasonYear
        search: $search
        format_in: $format_in
        genre: $genre
        status: $status
      ) { ${MEDIA_FIELDS} }
    }
  }
`;

// `persist` opts a page into the restart snapshot. Only the fixed discover shapes should ask for
// it: /api/search builds its variables from the query string, and those must not reach a file on
// disk. The opt-in is a key prefix rather than a flag so the cache can allowlist by prefix alone.
export function page(variables, ttlMs = 10 * 60 * 1000, { persist = false } = {}) {
  const key = `${persist ? "anilist:discover:" : "anilist:page:"}${JSON.stringify(variables)}`;
  return cached(key, ttlMs, async () => {
    const data = await gql(PAGE_QUERY, { page: 1, perPage: 30, ...variables });
    return {
      total: data.Page.pageInfo.total,
      hasNextPage: data.Page.pageInfo.hasNextPage,
      media: data.Page.media.map(shape)
    };
  });
}

const SCHEDULE_QUERY = `
  query ($from: Int, $to: Int, $page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
        episode
        airingAt
        media { ${MEDIA_FIELDS} }
      }
    }
  }
`;

export function schedule(fromUnix, toUnix) {
  const key = `anilist:schedule:${fromUnix}:${toUnix}`;
  return cached(key, 15 * 60 * 1000, async () => {
    const items = [];
    for (let p = 1; p <= 4; p += 1) {
      const data = await gql(SCHEDULE_QUERY, { from: fromUnix, to: toUnix, page: p });
      for (const entry of data.Page.airingSchedules) {
        if (entry.media?.isAdult) continue;
        items.push({ episode: entry.episode, airingAt: entry.airingAt, media: shape(entry.media) });
      }
      if (!data.Page.pageInfo.hasNextPage) break;
    }
    return items;
  });
}

const BY_IDS_QUERY = `
  query ($ids: [Int], $perPage: Int) {
    Page(page: 1, perPage: $perPage) {
      media(id_in: $ids, type: ANIME, isAdult: false) { ${MEDIA_FIELDS} }
    }
  }
`;

// AniList caps perPage at 50, so a longer list of ids has to be asked for in chunks. Sorted before
// keying so the same set of ids in a different order is one cache entry rather than two.
export async function byIds(ids, ttlMs = 60 * 60 * 1000) {
  const unique = [...new Set(ids.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  if (unique.length === 0) return [];

  const chunks = [];
  for (let i = 0; i < unique.length; i += 50) chunks.push(unique.slice(i, i + 50));

  const pages = await Promise.all(
    chunks.map(chunk =>
      cached(`anilist:ids:${chunk.join(",")}`, ttlMs, async () => {
        const data = await gql(BY_IDS_QUERY, { ids: chunk, perPage: chunk.length });
        return data.Page.media.map(shape);
      })
    )
  );
  return pages.flat();
}

const BY_ID_QUERY = `query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`;

export function byId(id) {
  return cached(`anilist:media:${id}`, 60 * 60 * 1000, async () => {
    const data = await gql(BY_ID_QUERY, { id: Number(id) });
    return shape(data.Media);
  });
}

function shape(media) {
  if (!media) return null;
  return {
    id: media.id,
    malId: media.idMal,
    title: {
      romaji: media.title?.romaji || null,
      english: media.title?.english || null,
      native: media.title?.native || null,
      display: media.title?.english || media.title?.romaji || media.title?.native || "Untitled"
    },
    synopsis: (media.description || "").replace(/<[^>]+>/g, "").trim() || null,
    cover: media.coverImage?.extraLarge || media.coverImage?.large || null,
    accent: media.coverImage?.color || null,
    banner: media.bannerImage || null,
    format: media.format,
    status: media.status,
    episodes: media.episodes,
    duration: media.duration,
    season: media.season,
    seasonYear: media.seasonYear,
    genres: media.genres || [],
    score: media.averageScore,
    popularity: media.popularity,
    startDate: media.startDate,
    nextEpisode: media.nextAiringEpisode
      ? {
          episode: media.nextAiringEpisode.episode,
          airingAt: media.nextAiringEpisode.airingAt,
          timeUntil: media.nextAiringEpisode.timeUntilAiring
        }
      : null,
    studio: media.studios?.nodes?.[0]?.name || null,
    directPrequels: countPrequels(media.relations),
    siteUrl: media.siteUrl
  };
}

// How many entries hang off this one directly. Note this is one hop, not the length of the chain:
// The Apothecary Diaries 3rd Season has exactly one PREQUEL edge even though two seasons precede
// it. Use prequelDepth when the answer has to be an ordinal.
function countPrequels(relations) {
  let count = 0;
  for (const edge of relations?.edges || []) {
    if (edge.relationType === "PREQUEL" && edge.node?.format !== "MOVIE") count += 1;
  }
  return count;
}

// Broadcast continuations only. A movie, an OVA or a side story is not a season, so following one
// would inflate the ordinal and point at the wrong Sonarr season.
const CHAIN_FORMATS = new Set(["TV", "TV_SHORT"]);

// Walking the chain costs one query per hop, so refuse to walk forever if AniList ever hands back
// a cycle. Nothing legitimate comes close: the longest broadcast chains are single digits.
const MAX_CHAIN_HOPS = 8;

const CHAIN_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      relations {
        edges {
          relationType
          node { id format startDate { year month day } }
        }
      }
    }
  }
`;

// How many broadcast seasons precede this one. This is the ordinal the Sonarr season number is
// derived from when air dates cannot decide, so "third season" has to come back as 2 and not as
// the 1 that counting direct edges gives.
//
// Cached for a day: relations only change when AniList adds a sequel announcement.
export function prequelDepth(anilistId) {
  const id = Number(anilistId);
  if (!Number.isInteger(id) || id <= 0) return Promise.resolve(0);
  return cached(`anilist:prequel-depth:${id}`, 24 * 60 * 60 * 1000, () => walkPrequels(id));
}

async function walkPrequels(startId) {
  const seen = new Set([startId]);
  let current = startId;
  let depth = 0;

  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
    let data;
    try {
      data = await gql(CHAIN_QUERY, { id: current });
    } catch {
      // A failed hop means the depth is unknown, not zero. Returning what has been counted so far
      // would be a confident wrong answer, and the caller treats null as "ask the user".
      return null;
    }

    const prequels = (data?.Media?.relations?.edges || [])
      .filter(edge => edge.relationType === "PREQUEL" && CHAIN_FORMATS.has(edge.node?.format))
      .map(edge => edge.node)
      .filter(node => node?.id && !seen.has(node.id));

    if (prequels.length === 0) return depth;

    // Several prequels means a split or a reboot. The earliest one is the start of the broadcast
    // order, which is what Sonarr's season numbering follows.
    prequels.sort((a, b) => (a.startDate?.year ?? 9999) - (b.startDate?.year ?? 9999));
    const next = prequels[0];

    seen.add(next.id);
    current = next.id;
    depth += 1;
  }

  return null;
}
