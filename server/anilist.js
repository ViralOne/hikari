import { config } from "./config.js";
import { cached } from "./cache.js";
import { request } from "./http.js";

const ENDPOINT = "https://graphql.anilist.co";

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

export function page(variables, ttlMs = 10 * 60 * 1000) {
  const key = `anilist:page:${JSON.stringify(variables)}`;
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
    prequelCount: countPrequels(media.relations),
    siteUrl: media.siteUrl
  };
}

function countPrequels(relations) {
  let count = 0;
  for (const edge of relations?.edges || []) {
    if (edge.relationType === "PREQUEL" && edge.node?.format !== "MOVIE") count += 1;
  }
  return count;
}
