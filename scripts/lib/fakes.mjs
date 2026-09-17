import { createServer } from "node:http";

// In-process stand-ins for every service Hikari talks to: Jellyseerr, Sonarr, Radarr, Jellyfin,
// Shoko, AniList and qBittorrent. Each is a plain node:http server on 127.0.0.1 with an ephemeral
// port, answering only the paths the server modules actually read and only with the fields they
// actually use. Everything else gets an empty body rather than a 404, because a fake that 404s
// on a path it does not know turns an unrelated code change into a confusing red test.
//
// The point is to run the real server end to end -- routes, cache, matching, request flow -- with
// nothing on the network. The unit tests pin the pure functions; this pins the wiring between them.
//
// Every request is appended to `calls`, so a test can assert on what Hikari sent (the request
// body that reached Jellyseerr, the mutation that reached AniList) rather than only on what came
// back. `state` is the live scenario: tests can edit it before or between calls, and the handlers
// read it on every request rather than snapshotting it at start.

const DAY = 24 * 60 * 60 * 1000;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const midnight = ms => Math.floor(ms / DAY) * DAY;

// The default scenario in one plain object. Two AniList entries, one of which is everywhere:
//
//   101 "Frontier Saga"  airing, 12 episodes, 4 aired and on disk, 2 watched. Present in Sonarr
//                        (series 7, tvdb 90001), Jellyfin (series jf-series-1), Shoko (series 55,
//                        anidb 777, MAL 5001) and Jellyseerr (tmdb 60001, not yet requested).
//                        On the AniList list as CURRENT with progress 2.
//   202 "Orbit Drift"    finished, 24 episodes, in no library at all. Jellyseerr knows it as tmdb
//                        60002. On the list as PLANNING, and the SEQUEL of...
//   303 "Old Classic"    a COMPLETED film whose relations point at 202, which is what puts 202 in
//                        the "Continue the story" row. A film rather than a series on purpose:
//                        prequelDepth only walks TV prequels, so 202 has no chain and Jellyseerr's
//                        single TMDB season is not read as lumped, which would start a background
//                        Sonarr narrowing the request test does not want.
//
// Air dates are relative to today, so "4 aired, 8 to come" stays true whenever the test runs.
export function defaultScenario() {
  const start = midnight(Date.now() - 25 * DAY);
  const airDate = n => isoDay(start + (n - 1) * 7 * DAY);
  const now = new Date();
  const month = now.getUTCMonth();
  const season = month < 3 ? "WINTER" : month < 6 ? "SPRING" : month < 9 ? "SUMMER" : "FALL";

  const startDate = ms => {
    const date = new Date(ms);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  };

  const relationNode = (media, extra = {}) => ({
    id: media.id,
    type: "ANIME",
    format: media.format,
    status: media.status,
    isAdult: false,
    title: { romaji: media.title.romaji },
    startDate: media.startDate,
    ...extra
  });

  const frontier = {
    id: 101,
    idMal: 5001,
    title: { romaji: "Frontier Saga", english: "Frontier Saga", native: "フロンティア・サーガ" },
    description: "A survey ship crosses the last uncharted stretch of sky.",
    coverImage: { extraLarge: "https://s4.anilist.co/fake/101-xl.jpg", large: "https://s4.anilist.co/fake/101.jpg", color: "#3366aa" },
    bannerImage: "https://s4.anilist.co/fake/101-banner.jpg",
    format: "TV",
    status: "RELEASING",
    episodes: 12,
    duration: 24,
    season,
    seasonYear: now.getUTCFullYear(),
    genres: ["Adventure", "Sci-Fi"],
    averageScore: 78,
    popularity: 12000,
    startDate: startDate(start),
    isAdult: false,
    nextAiringEpisode: {
      episode: 5,
      airingAt: Math.floor((start + 28 * DAY) / 1000),
      timeUntilAiring: Math.floor((start + 28 * DAY - Date.now()) / 1000)
    },
    studios: { nodes: [{ name: "Fake Studio" }] },
    relations: { edges: [] },
    siteUrl: "https://anilist.co/anime/101"
  };

  const orbit = {
    id: 202,
    idMal: 5002,
    title: { romaji: "Orbit Drift", english: "Orbit Drift", native: "オービット・ドリフト" },
    description: "Twenty-four episodes of slow decay in a forgotten station.",
    coverImage: { extraLarge: "https://s4.anilist.co/fake/202-xl.jpg", large: "https://s4.anilist.co/fake/202.jpg", color: "#aa6633" },
    bannerImage: null,
    format: "TV",
    status: "FINISHED",
    episodes: 24,
    duration: 24,
    season: "SPRING",
    seasonYear: 2024,
    genres: ["Drama", "Sci-Fi"],
    averageScore: 81,
    popularity: 8000,
    startDate: { year: 2024, month: 4, day: 5 },
    isAdult: false,
    nextAiringEpisode: null,
    studios: { nodes: [{ name: "Fake Studio" }] },
    relations: { edges: [] },
    siteUrl: "https://anilist.co/anime/202"
  };

  const classic = {
    id: 303,
    idMal: 5003,
    title: { romaji: "Old Classic", english: "Old Classic", native: "オールド・クラシック" },
    description: "The film that started it.",
    coverImage: { extraLarge: null, large: null, color: null },
    bannerImage: null,
    format: "MOVIE",
    status: "FINISHED",
    episodes: 1,
    duration: 110,
    season: "WINTER",
    seasonYear: 2019,
    genres: ["Drama"],
    averageScore: 85,
    popularity: 5000,
    startDate: { year: 2019, month: 1, day: 12 },
    isAdult: false,
    nextAiringEpisode: null,
    studios: { nodes: [{ name: "Fake Studio" }] },
    relations: { edges: [{ relationType: "SEQUEL", node: relationNode(orbit) }] },
    siteUrl: "https://anilist.co/anime/303"
  };

  const seriesFolder = "Frontier Saga";
  const episodeFile = n => `Season 1/Frontier Saga - S01E${String(n).padStart(2, "0")}.mkv`;

  return {
    anilist: {
      viewer: { id: 1, name: "tester", siteUrl: "https://anilist.co/user/tester" },
      // Keyed by id so a test can add or edit an entry without touching the arrays below.
      media: { 101: frontier, 202: orbit, 303: classic },
      // What every Page query returns, whatever it was sorted or filtered by. The discover rows only
      // need something to annotate; the test does not check ordering.
      page: [101, 202],
      list: [
        { id: 9101, mediaId: 101, status: "CURRENT", progress: 2, score: 0, repeat: 0, updatedAt: 1_700_000_300 },
        { id: 9202, mediaId: 202, status: "PLANNING", progress: 0, score: 0, repeat: 0, updatedAt: 1_700_000_200 },
        { id: 9303, mediaId: 303, status: "COMPLETED", progress: 1, score: 85, repeat: 0, updatedAt: 1_700_000_100 }
      ],
      nextListId: 9900
    },

    jellyseerr: {
      version: "2.7.0",
      media: {
        60001: {
          mediaType: "tv",
          name: "Frontier Saga",
          firstAirDate: isoDay(start),
          seasons: [{ seasonNumber: 1, name: "Season 1", airDate: isoDay(start), episodeCount: 12 }],
          // TMDB's anime keyword, which is what makes Jellyseerr route it to the anime profile.
          keywords: [{ id: 210024 }],
          mediaInfo: null
        },
        60002: {
          mediaType: "tv",
          name: "Orbit Drift",
          firstAirDate: "2024-04-05",
          seasons: [{ seasonNumber: 1, name: "Season 1", airDate: "2024-04-05", episodeCount: 24 }],
          // No anime keyword: this is the case where the frontend sends forceAnime and Hikari has
          // to supply the profile and root folder overrides itself.
          keywords: [],
          mediaInfo: null
        }
      },
      requests: [],
      nextRequestId: 900,
      sonarrServers: [
        {
          id: 0,
          name: "Sonarr",
          isDefault: true,
          is4k: false,
          activeProfileId: 1,
          activeDirectory: "/data/tv",
          activeAnimeProfileId: 2,
          activeAnimeDirectory: "/data/anime",
          animeTags: [],
          animeSeriesType: "anime"
        }
      ],
      radarrServers: []
    },

    sonarr: {
      version: "4.0.10.2544",
      series: [
        {
          id: 7,
          title: "Frontier Saga",
          tvdbId: 90001,
          tmdbId: 60001,
          path: `/data/anime/${seriesFolder}`,
          seriesType: "anime",
          monitored: true,
          alternateTitles: [],
          seasons: [{ seasonNumber: 1, monitored: true }],
          statistics: { episodeCount: 12, episodeFileCount: 4, sizeOnDisk: 4 * 700_000_000 }
        }
      ],
      episodes: Array.from({ length: 12 }, (_, i) => {
        const n = i + 1;
        const hasFile = n <= 4;
        return {
          id: 700 + n,
          seriesId: 7,
          seasonNumber: 1,
          episodeNumber: n,
          absoluteEpisodeNumber: n,
          title: `Episode ${n}`,
          airDate: airDate(n),
          airDateUtc: `${airDate(n)}T15:00:00Z`,
          hasFile,
          monitored: true,
          episodeFile: hasFile ? { relativePath: episodeFile(n), size: 700_000_000 } : undefined
        };
      }),
      queue: [],
      commands: [],
      nextCommandId: 1,
      qualityProfiles: [
        { id: 1, name: "HD-1080p" },
        { id: 2, name: "Anime" }
      ],
      downloadClients: [
        {
          id: 1,
          name: "qBittorrent",
          implementation: "QBittorrent",
          enable: true,
          fields: [{ name: "tvCategory", value: "anime" }],
          tags: []
        }
      ]
    },

    radarr: { version: "5.14.0.9383", movies: [] },

    jellyfin: {
      version: "10.10.3",
      users: [{ Id: "user-1", Name: "tester", Policy: { IsAdministrative: true } }],
      libraries: [{ ItemId: "lib-1", Name: "Anime", CollectionType: "tvshows", Locations: ["/mnt/shokofin"] }],
      series: [
        {
          Id: "jf-series-1",
          Name: "Frontier Saga",
          OriginalTitle: "Frontier Saga",
          Path: `/data/anime/${seriesFolder}`,
          ProviderIds: { AniList: "101", AniDB: "777", Tvdb: "90001" },
          RecursiveItemCount: 4,
          UserData: { PlayedPercentage: 50, UnplayedItemCount: 2, Played: false }
        }
      ],
      // The two played episodes are the first two, so "next up" is episode 3.
      episodes: Array.from({ length: 4 }, (_, i) => ({
        Id: `jf-ep-${i + 1}`,
        Name: `Episode ${i + 1}`,
        ParentId: "jf-series-1",
        ParentIndexNumber: 1,
        IndexNumber: i + 1,
        UserData: { Played: i < 2, LastPlayedDate: i < 2 ? `${airDate(i + 1)}T20:00:00Z` : null }
      }))
    },

    shoko: {
      state: "Started",
      series: [
        {
          IDs: { ID: 55, AniDB: 777, MAL: [5001], TvDB: [90001], TMDB: { Show: [60001] } },
          Name: "Frontier Saga",
          Sizes: {
            Local: { Episodes: 4, Specials: 0 },
            Missing: { Episodes: 8, Specials: 0 },
            Total: { Episodes: 12, Specials: 0 },
            Watched: { Episodes: 2, Specials: 0 },
            FileSources: { Web: 4 }
          }
        }
      ],
      // Keyed by Shoko series id.
      episodes: {
        55: Array.from({ length: 12 }, (_, i) => {
          const n = i + 1;
          return {
            IDs: { ID: 5500 + n, AniDB: 77000 + n },
            AniDB: { EpisodeNumber: n, Type: "Normal", AirDate: airDate(n) },
            Files: n <= 4 ? [{ ID: 8800 + n, AniDB: { ReleaseGroup: { Name: "FakeSubs" }, Source: "Web" } }] : []
          };
        })
      },
      files: Array.from({ length: 4 }, (_, i) => {
        const n = i + 1;
        return {
          ID: 8800 + n,
          Size: 700_000_000,
          Created: `${airDate(n)}T16:00:00Z`,
          SeriesIDs: [{ SeriesID: { ID: 55 }, EpisodeIDs: [{ ID: 5500 + n }] }],
          Locations: [{ RelativePath: `${seriesFolder}/${episodeFile(n)}` }]
        };
      })
    },

    qbit: { version: "v5.0.3", torrents: [] }
  };
}

// A response that is not JSON, or not a 200. Everything else a handler returns is JSON-encoded.
class Raw {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}
const text = (body, status = 200, headers = {}) => new Raw(status, body, { "Content-Type": "text/plain", ...headers });
const empty = () => new Raw(204, "");

export async function startFakes({ scenario } = {}) {
  const state = scenario || defaultScenario();
  const calls = [];
  const servers = [];

  // One server per service. The handler gets the parsed request and returns a value; undefined
  // means "nothing specific", which is answered with an empty array. An array rather than an
  // object because most of the list endpoints call .map on the body directly, while every object
  // reader in server/ already guards with `body.x || []`.
  const serve = async (service, handle) => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = raw || null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }

      const url = new URL(req.url, "http://fake");
      const query = Object.fromEntries(url.searchParams);
      const call = { service, method: req.method, path: url.pathname, query, body };
      calls.push(call);

      let out;
      try {
        out = handle({ method: req.method, path: url.pathname, query, body, raw, headers: req.headers });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      if (out === undefined) {
        call.unhandled = true;
        out = [];
      }

      if (out instanceof Raw) {
        res.writeHead(out.status, out.headers);
        res.end(out.body);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });

    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };

  // ---------------------------------------------------------------------------------------------
  // AniList. One GraphQL endpoint, so the query text is pattern-matched rather than parsed: each
  // of Hikari's queries has a distinctive token, and a superset of the requested fields is returned
  // because GraphQL clients ignore extras.
  // ---------------------------------------------------------------------------------------------

  const mediaById = id => state.anilist.media[Number(id)] || null;

  const listEntry = entry => {
    const media = mediaById(entry.mediaId);
    return {
      id: entry.id,
      status: entry.status,
      progress: entry.progress,
      score: entry.score,
      repeat: entry.repeat ?? 0,
      updatedAt: entry.updatedAt ?? null,
      media: media
        ? { id: media.id, episodes: media.episodes, title: media.title, relations: media.relations }
        : { id: entry.mediaId, episodes: null, title: {}, relations: { edges: [] } }
    };
  };

  const collection = statuses => {
    const wanted = Array.isArray(statuses) && statuses.length ? new Set(statuses) : null;
    const lists = new Map();
    for (const entry of state.anilist.list) {
      if (wanted && !wanted.has(entry.status)) continue;
      if (!lists.has(entry.status)) lists.set(entry.status, { status: entry.status, entries: [] });
      lists.get(entry.status).entries.push(listEntry(entry));
    }
    return { MediaListCollection: { lists: [...lists.values()] } };
  };

  const save = variables => {
    const mediaId = Number(variables.mediaId);
    let entry = state.anilist.list.find(item => item.mediaId === mediaId);
    if (!entry) {
      entry = { id: state.anilist.nextListId++, mediaId, status: "PLANNING", progress: 0, score: 0, repeat: 0 };
      state.anilist.list.push(entry);
    }
    if (variables.status != null) entry.status = variables.status;
    if (variables.progress != null) entry.progress = variables.progress;
    if (variables.score != null) entry.score = variables.score;
    entry.updatedAt = Math.floor(Date.now() / 1000);
    return { SaveMediaListEntry: { id: entry.id, status: entry.status, progress: entry.progress, score: entry.score } };
  };

  const anilist = await serve("anilist", ({ method, body }) => {
    if (method !== "POST" || !body || typeof body.query !== "string") return { data: {} };
    const { query, variables = {} } = body;

    if (query.includes("Viewer")) return { data: { Viewer: state.anilist.viewer } };
    if (query.includes("SaveMediaListEntry")) return { data: save(variables) };
    if (query.includes("MediaListCollection")) return { data: collection(variables.statuses) };

    if (query.includes("airingSchedules")) {
      const airing = Object.values(state.anilist.media)
        .filter(media => media.nextAiringEpisode)
        .map(media => ({
          episode: media.nextAiringEpisode.episode,
          airingAt: media.nextAiringEpisode.airingAt,
          media
        }));
      return { data: { Page: { pageInfo: { hasNextPage: false }, airingSchedules: airing } } };
    }

    // Both the detail query and the prequel-chain query ask for Media(id:), and the full record
    // satisfies either. An unknown id is null, which the detail route turns into a 404.
    if (query.includes("Media(id:")) return { data: { Media: mediaById(variables.id) } };

    if (query.includes("Page(")) {
      const ids = Array.isArray(variables.ids) ? variables.ids.map(Number) : state.anilist.page;
      const perPage = Number(variables.perPage) || ids.length;
      const media = ids.map(mediaById).filter(Boolean).slice(0, perPage);
      return { data: { Page: { pageInfo: { hasNextPage: false, total: media.length }, media } } };
    }

    return { data: {} };
  });

  // ---------------------------------------------------------------------------------------------
  // Jellyseerr, under /api/v1.
  // ---------------------------------------------------------------------------------------------

  const seerrMedia = id => state.jellyseerr.media[Number(id)] || null;

  const searchResult = (id, media) => ({
    id: Number(id),
    mediaType: media.mediaType,
    name: media.name,
    firstAirDate: media.firstAirDate,
    ...(media.mediaInfo ? { mediaInfo: media.mediaInfo } : {})
  });

  const jellyseerr = await serve("jellyseerr", ({ method, path, query, body }) => {
    const route = path.replace(/^\/api\/v1/, "");

    if (route === "/status") return { version: state.jellyseerr.version };

    if (route === "/search") {
      const needle = (query.query || "").toLowerCase();
      const results = Object.entries(state.jellyseerr.media)
        .filter(([, media]) => media.name.toLowerCase().includes(needle))
        .map(([id, media]) => searchResult(id, media));
      return { page: 1, totalPages: 1, totalResults: results.length, results };
    }

    const detail = route.match(/^\/(tv|movie)\/(\d+)$/);
    if (detail) {
      const media = seerrMedia(detail[2]);
      if (!media) return new Raw(404, JSON.stringify({ message: "Not found" }), { "Content-Type": "application/json" });
      return { id: Number(detail[2]), name: media.name, seasons: media.seasons, keywords: media.keywords, mediaInfo: media.mediaInfo };
    }

    if (route === "/request" && method === "POST") {
      const media = seerrMedia(body.mediaId);
      const seasons = Array.isArray(body.seasons)
        ? body.seasons.map(Number)
        : (media?.seasons || []).map(season => season.seasonNumber).filter(n => n > 0);
      const request = {
        id: state.jellyseerr.nextRequestId++,
        // 2 is approved. Auto-approval is the common setup, and it is what makes the follow-up
        // detail read report the season as taken.
        status: 2,
        type: body.mediaType,
        media: { tmdbId: Number(body.mediaId), status: 2 },
        seasons: seasons.map(seasonNumber => ({ seasonNumber, status: 2 })),
        requestedBy: { displayName: "tester" },
        createdAt: new Date().toISOString()
      };
      state.jellyseerr.requests.unshift(request);
      if (media) {
        // What a real Jellyseerr reports once a request exists: media status pending, the season
        // marked pending, and the request itself listed. Hikari's duplicate check reads the last
        // two, so a bare status on its own would let a second request through.
        media.mediaInfo = {
          status: 2,
          seasons: seasons.map(seasonNumber => ({ seasonNumber, status: 2 })),
          requests: [{ id: request.id, status: 2, seasons: seasons.map(seasonNumber => ({ seasonNumber })) }]
        };
      }
      return new Raw(201, JSON.stringify(request), { "Content-Type": "application/json" });
    }

    if (route === "/request") {
      const take = Number(query.take) || 20;
      return { pageInfo: { results: state.jellyseerr.requests.length }, results: state.jellyseerr.requests.slice(0, take) };
    }

    if (route === "/settings/sonarr") return state.jellyseerr.sonarrServers;
    if (route === "/settings/radarr") return state.jellyseerr.radarrServers;
    return undefined;
  });

  // ---------------------------------------------------------------------------------------------
  // Sonarr, under /api/v3.
  // ---------------------------------------------------------------------------------------------

  const sonarr = await serve("sonarr", ({ method, path, query, body }) => {
    const route = path.replace(/^\/api\/v3/, "");

    if (route === "/system/status") return { version: state.sonarr.version };
    if (route === "/series") return state.sonarr.series;

    const one = route.match(/^\/series\/(\d+)$/);
    if (one) {
      const index = state.sonarr.series.findIndex(item => item.id === Number(one[1]));
      if (index === -1) return new Raw(404, JSON.stringify({ message: "NotFound" }), { "Content-Type": "application/json" });
      if (method === "PUT") {
        state.sonarr.series[index] = { ...state.sonarr.series[index], ...body };
        return state.sonarr.series[index];
      }
      return state.sonarr.series[index];
    }

    if (route === "/episode" && method === "GET") {
      return state.sonarr.episodes.filter(episode => episode.seriesId === Number(query.seriesId));
    }

    if (route === "/episode/monitor" && method === "PUT") {
      const ids = new Set((body?.episodeIds || []).map(Number));
      for (const episode of state.sonarr.episodes) {
        if (ids.has(episode.id)) episode.monitored = Boolean(body.monitored);
      }
      return state.sonarr.episodes.filter(episode => ids.has(episode.id));
    }

    if (route === "/queue" && method === "GET") {
      return { page: 1, pageSize: Number(query.pageSize) || 20, totalRecords: state.sonarr.queue.length, records: state.sonarr.queue };
    }
    const queueItem = route.match(/^\/queue\/(\d+)$/);
    if (queueItem && method === "DELETE") {
      state.sonarr.queue = state.sonarr.queue.filter(item => item.id !== Number(queueItem[1]));
      return empty();
    }

    if (route === "/command" && method === "GET") return state.sonarr.commands;
    if (route === "/command" && method === "POST") {
      const command = { id: state.sonarr.nextCommandId++, name: body?.name, body, status: "queued" };
      state.sonarr.commands.push(command);
      return new Raw(201, JSON.stringify(command), { "Content-Type": "application/json" });
    }
    const command = route.match(/^\/command\/(\d+)$/);
    if (command && method === "DELETE") {
      state.sonarr.commands = state.sonarr.commands.filter(item => item.id !== Number(command[1]));
      return empty();
    }

    if (route === "/qualityprofile") return state.sonarr.qualityProfiles;
    if (route === "/downloadclient") return state.sonarr.downloadClients;
    return undefined;
  });

  // ---------------------------------------------------------------------------------------------
  // Radarr, under /api/v3. Nothing in the scenario is a film, so this mostly exists to be healthy.
  // ---------------------------------------------------------------------------------------------

  const radarr = await serve("radarr", ({ path }) => {
    const route = path.replace(/^\/api\/v3/, "");
    if (route === "/system/status") return { version: state.radarr.version };
    if (route === "/movie") return state.radarr.movies;
    return undefined;
  });

  // ---------------------------------------------------------------------------------------------
  // Jellyfin. Item queries are told apart by IncludeItemTypes, which is how server/jellyfin.js
  // asks for series and for the episodes under one of them.
  // ---------------------------------------------------------------------------------------------

  const jellyfin = await serve("jellyfin", ({ method, path, query }) => {
    if (path === "/System/Info") return { Version: state.jellyfin.version, ServerName: "fake" };
    if (path === "/Users") return state.jellyfin.users;
    if (path === "/Library/VirtualFolders") return state.jellyfin.libraries;

    if (path === "/Items") {
      const types = (query.IncludeItemTypes || "").split(",");
      if (types.includes("Series")) {
        return { Items: state.jellyfin.series, TotalRecordCount: state.jellyfin.series.length };
      }
      if (types.includes("Episode")) {
        const items = state.jellyfin.episodes.filter(item => !query.ParentId || item.ParentId === query.ParentId);
        return { Items: items, TotalRecordCount: items.length };
      }
      return { Items: [], TotalRecordCount: 0 };
    }

    const played = path.match(/^\/UserPlayedItems\/([^/]+)$/);
    if (played && method === "POST") {
      const item = state.jellyfin.episodes.find(episode => episode.Id === played[1]);
      if (item) item.UserData = { ...item.UserData, Played: true, LastPlayedDate: new Date().toISOString() };
      return { Played: true };
    }

    if (/^\/Items\/[^/]+\/Refresh$/.test(path) && method === "POST") return empty();
    if (path === "/Library/Refresh" && method === "POST") return empty();
    return undefined;
  });

  // ---------------------------------------------------------------------------------------------
  // Shoko, under /api/v3. Lists are paged with Total, the way server/shoko.js walks them.
  // ---------------------------------------------------------------------------------------------

  const paged = (list, query) => {
    const size = Number(query.pageSize) || 100;
    const page = Number(query.page) || 1;
    return { Total: list.length, List: list.slice((page - 1) * size, page * size) };
  };

  const shoko = await serve("shoko", ({ method, path, query }) => {
    const route = path.replace(/^\/api\/v3/, "");

    if (route === "/Init/Status") return { State: state.shoko.state };
    if (route === "/Series") return paged(state.shoko.series, query);

    const episodes = route.match(/^\/Series\/(\d+)\/Episode$/);
    if (episodes) return paged(state.shoko.episodes[Number(episodes[1])] || [], query);

    if (route === "/File") return paged(state.shoko.files, query);
    if (/^\/File\/\d+\/(Rescan|Link)$/.test(route) && method === "POST") return empty();
    if (route.startsWith("/Action/")) return empty();
    return undefined;
  });

  // ---------------------------------------------------------------------------------------------
  // qBittorrent, under /api/v2. Cookie login, then plain text for the version.
  // ---------------------------------------------------------------------------------------------

  const qbit = await serve("qbit", ({ path }) => {
    if (path === "/api/v2/auth/login") return text("Ok.", 200, { "Set-Cookie": "SID=fake-session; path=/" });
    if (path === "/api/v2/app/version") return text(state.qbit.version);
    if (path === "/api/v2/torrents/info") return state.qbit.torrents;
    return undefined;
  });

  return {
    urls: { jellyseerr, sonarr, radarr, jellyfin, shoko, anilist, qbit },
    calls,
    state,
    async stop() {
      // Hikari's fetch keeps connections alive, so a plain close() would wait for them to time out.
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
      }
    }
  };
}
