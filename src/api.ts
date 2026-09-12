export type LibraryMatch = {
  id: number;
  title: string;
  path: string;
  seriesType: string;
  monitored: boolean;
  episodeCount: number;
  episodeFileCount: number;
  sizeOnDisk: number;
  complete: boolean;
  confidence: number;
};

export type SeasonInfo = {
  seasonNumber: number;
  name: string;
  airDate: string | null;
  episodeCount: number;
  taken: boolean;
  status: string;
};

export type RequestMatch = {
  matched: boolean;
  error?: string;
  confidence?: number;
  tmdbId?: number;
  mediaType?: "tv" | "movie";
  title?: string;
  year?: number | null;
  status?: string;
  animeKeyword?: boolean | null;
  seasons?: SeasonInfo[] | null;
  suggestedSeason?: number | null;
  candidates?: Array<{ tmdbId: number; mediaType: string; title: string; year: string | null; status: string }>;
};

export type EpisodeProgress = {
  total: number;
  played: number;
  percent: number;
  lastPlayed: string | null;
  next: { season: number | null; episode: number | null; name: string } | null;
  furthest: { season: number | null; episode: number | null; name: string } | null;
};

export type Watch = {
  via: string;
  scoped: boolean;
  ids: string[];
  name: string;
  percent: number;
  unplayed: number;
  onDisk: number;
  played: number;
  total: number | null;
  aired: number | null;
  started: boolean;
  finished: boolean;
  episodes?: EpisodeProgress | null;
};

export type Anime = {
  id: number;
  malId: number | null;
  title: { romaji: string | null; english: string | null; native: string | null; display: string };
  synopsis: string | null;
  cover: string | null;
  accent: string | null;
  banner: string | null;
  format: string;
  status: string;
  episodes: number | null;
  duration: number | null;
  season: string | null;
  seasonYear: number | null;
  genres: string[];
  score: number | null;
  popularity: number | null;
  startDate: { year: number | null; month: number | null; day: number | null };
  nextEpisode: { episode: number; airingAt: number; timeUntil: number } | null;
  studio: string | null;
  prequelCount: number;
  siteUrl: string;
  library?: LibraryMatch | null;
  watch?: Watch | null;
};

export type SeerrLinks = { media: string | null; search: string | null };

export type Routing = {
  server: string;
  treatedAsAnime: boolean;
  overridden: boolean;
  animeKeyword: boolean | null;
  profileId: number;
  profileName: string | null;
  rootFolder: string;
  seriesType: string;
  categories: Array<{ client: string; category: string | null; tags: number[] }>;
  animeTagsConfigured: boolean;
};

export type AnimeDetail = Anime & {
  library: LibraryMatch | null;
  request: RequestMatch | null;
  routing: Routing | null;
  watch: Watch | null;
  links: SeerrLinks;
};

export type DiscoverRow = { id: string; title: string; media: Anime[] };
export type Discover = { season: { season: string; year: number }; rows: DiscoverRow[] };

export type ScheduleEntry = { episode: number; airingAt: number; media: Anime };
export type Schedule = { from: number; to: number; items: ScheduleEntry[] };

export type QueueItem = {
  id: number;
  series: string;
  seriesType: string | null;
  episode: string | null;
  title: string;
  quality: string | null;
  size: number;
  sizeleft: number;
  status: string;
  trackedStatus: string | null;
  messages: string[];
};

export type Torrent = {
  hash: string;
  name: string;
  category: string | null;
  tags: string[];
  state: string;
  active: boolean;
  progress: number;
  size: number;
  dlspeed: number;
  upspeed: number;
  ratio: number;
  eta: number;
  savePath: string;
  addedOn: number;
  isAnime: boolean;
};

export type SeerRequest = {
  id: number;
  status: number;
  mediaType: string;
  tmdbId: number | null;
  mediaStatus: string;
  seasons: number[];
  requestedBy: string | null;
  createdAt: string;
};

export type Activity = {
  errors: { queue: string | null; torrents: string | null; requests: string | null };
  queue: QueueItem[];
  torrents: Torrent[];
  requests: SeerRequest[];
};

export type Health = {
  ok: boolean;
  checks: Record<string, { configured: boolean; ok: boolean; detail: string }>;
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body && (body as { error?: string }).error) || `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

export const getHealth = () => json<Health>("/api/health");
export const getDiscover = () => json<Discover>("/api/discover");
export const getSchedule = (days = 7) => json<Schedule>(`/api/schedule?days=${days}`);
export const getAnime = (id: number) => json<AnimeDetail>(`/api/anime/${id}`);
export const getActivity = () => json<Activity>("/api/activity");

export function getSearch(params: Record<string, string>) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return json<{ total?: number; media: Anime[] }>(`/api/search?${query.toString()}`);
}

export function postRequest(payload: {
  tmdbId: number;
  mediaType: string;
  seasons?: number[] | "all";
  forceAnime?: boolean;
}) {
  return json<{
    ok: true;
    requestId: number;
    status: number;
    forcedAnime: { profileId: number; rootFolder: string } | null;
  }>("/api/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export function setSonarrSeriesType(seriesId: number, seriesType = "anime") {
  return json<{ ok: true; changed: boolean; previous: string; seriesType: string }>(
    `/api/sonarr/series/${seriesId}/series-type`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesType })
    }
  );
}
