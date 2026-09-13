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
  /** "shoko:tvdb" and "tmdb" are exact id matches; "title" is fuzzy and can be wrong. */
  via?: string | null;
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
  movie?: LibraryMatch | null;
  watch?: Watch | null;
  list?: ListEntry | null;
  shoko?: ShokoInfo | null;
};

export type SeerrLinks = { media: string | null; search: string | null };

export type ListEntry = {
  entryId: number;
  status: string;
  statusLabel: string;
  progress: number;
  total: number | null;
  score: number;
  repeat: number;
  updatedAt: number | null;
  caughtUp: boolean;
};

export type ShokoInfo = {
  shokoId: number;
  name: string;
  anidbId: number | null;
  malIds: number[];
  onDisk: number;
  missing: number;
  totalEpisodes: number;
  watched: number;
  sources: Array<{ name: string; count: number }>;
  via: string;
  files?: {
    missing: number[];
    groups: Array<{ name: string; count: number }>;
    mixedGroups: boolean;
  } | null;
  report?: MissingReport | null;
};

export type MissingRowState =
  | "not-aired"
  | "not-downloaded"
  | "on-disk-unlinked"
  | "on-disk-not-hashed"
  | "unresolved";

export type MissingRow = {
  episode: number | null;
  shokoEpisodeId: number | null;
  airDate: string | null;
  state: MissingRowState;
  detail: string | null;
  sonarr: {
    id: number;
    seasonNumber: number;
    episodeNumber: number;
    title: string | null;
    hasFile: boolean;
    monitored: boolean;
    size: number | null;
    relativePath: string | null;
  } | null;
  shokoFile: { fileId: number; size: number; path: string } | null;
};

export type MissingReport = {
  series: { id: number; title: string; via?: string | null } | null;
  /** Whole-collection totals, so "unlinked" can be put in context. */
  collection: { files: number; unlinked: number };
  rows: MissingRow[];
  counts: {
    notAired: number;
    notDownloaded: number;
    onDiskUnlinked: number;
    onDiskNotHashed: number;
    unresolved: number;
  };
};

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
  list: ListEntry | null;
  shoko: ShokoInfo | null;
  movie: LibraryMatch | null;
  links: SeerrLinks;
};

export type DiscoverRow = { id: string; title: string; media: Anime[] };
export type ServiceErrors = Record<string, string>;
export type Discover = { season: { season: string; year: number }; rows: DiscoverRow[]; errors?: ServiceErrors };

export type ScheduleEntry = { episode: number; airingAt: number; media: Anime };
export type Schedule = { from: number; to: number; items: ScheduleEntry[]; errors?: ServiceErrors };

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

export type SettingField = {
  key: string;
  env: string;
  type: "url" | "secret" | "text" | "boolean" | "number";
  group: string;
  label: string;
  hint: string | null;
  placeholder: string | null;
  min: number | null;
  max: number | null;
  /** Where the effective value came from: the settings file, the environment, or a built-in. */
  source: "settings" | "env" | "default";
  /** Always null for secrets — the server never sends one back. */
  value: string | number | boolean | null;
  /** Last four characters of a secret, so you can tell which key is stored. */
  preview: string | null;
  set: boolean;
};

export type Settings = {
  path: string | null;
  writable: boolean;
  configured: boolean;
  fields: SettingField[];
  enabled: Record<string, boolean>;
};

export const getSettings = () => json<Settings>("/api/settings");

export const saveSettings = (patch: Record<string, string | number | boolean>) =>
  json<Settings & { changed: string[] }>("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });

export const testService = (service: string, url?: string, key?: string) =>
  json<{ ok: boolean; detail?: string; error?: string }>("/api/settings/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service, url, key })
  });

export const getHealth = () => json<Health>("/api/health");
export const getDiscover = () => json<Discover>("/api/discover");
export const getSchedule = (days = 7) => json<Schedule>(`/api/schedule?days=${days}`);
export const getAnime = (id: number) => json<AnimeDetail>(`/api/anime/${id}`);
export const getActivity = () => json<Activity>("/api/activity");

export function getSearch(params: Record<string, string>) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return json<{ total?: number; media: Anime[]; errors?: ServiceErrors }>(`/api/search?${query.toString()}`);
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

export const ANILIST_STATUSES = [
  { value: "CURRENT", label: "Watching" },
  { value: "PLANNING", label: "Planning" },
  { value: "COMPLETED", label: "Completed" },
  { value: "PAUSED", label: "Paused" },
  { value: "DROPPED", label: "Dropped" },
  { value: "REPEATING", label: "Rewatching" }
];

export function getList(status?: string) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return json<{
    configured: boolean;
    writable?: boolean;
    user?: { id: number; name: string; siteUrl: string };
    entries: Array<ListEntry & { anilistId: number }>;
  }>(`/api/list${query}`);
}

export function saveListEntry(
  anilistId: number,
  payload: { status?: string; progress?: number; score?: number }
) {
  return json<{ ok: true; entry: { status: string; progress: number } }>(`/api/list/${anilistId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

/** Shokofin only exposes newly linked files after Jellyfin scans, so this closes the loop. */
export function refreshJellyfinLibrary() {
  return json<{ ok: true; queued: boolean; scope: "library" | "all"; library: string | null }>("/api/jellyfin/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
}

export type ShokoAction = "refresh-anidb" | "forget-deleted" | "import-new";

export function runShokoAction(action: ShokoAction) {
  return json<{ ok: true; queued: boolean; action: string; label: string }>(`/api/shoko/action/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
}

export function rescanShokoFile(anilistId: number, fileId: number) {
  return json<{ ok: true; episode: number | null; rescanned: boolean }>(
    `/api/shoko/rescan/${anilistId}/${fileId}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
}

export function linkAllShokoFiles(anilistId: number) {
  return json<{ ok: boolean; linked: Array<number | null>; failed: Array<{ episode: number | null; error: string }> }>(
    `/api/shoko/link-all/${anilistId}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
}

export function linkShokoFile(anilistId: number, fileId: number) {
  return json<{ ok: true; episode: number | null; linked: number }>(
    `/api/shoko/link/${anilistId}/${fileId}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
}

export type PlayedPlan = {
  item: string;
  via: string;
  upTo: number;
  total: number;
  alreadyPlayed: number;
  episodes: Array<{ id: string; season: number | null; episode: number | null; name: string }>;
  planned?: boolean;
  executed: boolean;
  marked?: number;
};

/** Without `confirm` this only reads: it returns the episodes it would mark played. */
export function markJellyfinPlayed(anilistId: number, upTo?: number, confirm = false) {
  return json<PlayedPlan>(`/api/jellyfin/played/${anilistId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upTo, confirm })
  });
}

export type MissingSearchPlan = {
  series: { id: number; title: string; via?: string | null };
  matched: Array<{
    anidbEpisode: number | null;
    airDate: string;
    id: number;
    seasonNumber: number;
    episodeNumber: number;
    title: string | null;
    monitored: boolean;
  }>;
  truncated: boolean;
  skipped: Array<{
    episode: number | null;
    airDate?: string;
    code: "no-air-date" | "no-sonarr-episode" | "ambiguous" | "already-on-disk";
    reason: string;
  }>;
  planned?: boolean;
  executed: boolean;
  monitored?: number;
};

/** Without `confirm` this only reads: it returns the episodes it would search for. */
export function searchMissingEpisodes(anilistId: number, confirm = false) {
  return json<MissingSearchPlan>(`/api/sonarr/missing/${anilistId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm })
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
