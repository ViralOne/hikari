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
  directPrequels: number;
  siteUrl: string;
  library?: LibraryMatch | null;
  movie?: LibraryMatch | null;
  watch?: Watch | null;
  list?: ListEntry | null;
  shoko?: ShokoInfo | null;
  /** Only on the "Continue the story" row: which of your finished shows this follows. */
  because?: { id: number; title: string; score: number; status: string } | null;
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

// What Sonarr was narrowed to, and why it had to be. TMDB folds several of Sonarr's seasons into
// one for a lot of anime, so a Jellyseerr season number cannot say which cour was meant.
export type CourSeason = {
  seasonNumber: number;
  episodeCount: number;
  firstAirDate: string | null;
  onDisk: number;
  monitored: number;
};

export type NarrowMode = "exclusive" | "add" | "whole";

export type NarrowResult =
  | {
      applied: true;
      seriesId: number;
      seriesTitle: string;
      seasonNumber: number;
      via: "air-date" | "chain-ordinal" | "chosen";
      confidence: number;
      episodes: { count: number; first: number; last: number; label: string };
      clamped: boolean;
      wholeSeason: boolean;
      unmonitoredSeasons: number[];
      keptSeasons: number[];
      unmonitoredEpisodes: number;
      seriesType: { changed: boolean; previous?: string; error?: string };
      /** Jellyseerr searches that were actually stopped. Sonarr refuses to cancel a started one. */
      cancelledSearches: string[];
      /** Searches Sonarr would not cancel. Harmless once the episodes are unmonitored. */
      searchesStillRunning: string[];
      removedFromQueue: Array<{ season: number; episode: number | null; title: string }>;
      search: { commandId: number | null; error?: string };
    }
  | {
      applied: false;
      reason: string;
      seriesId?: number;
      seriesTitle?: string;
      seasons?: CourSeason[];
      /** Present when reason is "not-confirmed": what the write would do, having written nothing. */
      plan?: NarrowPlan;
    };

export type NarrowPlan = {
  seriesId: number;
  seriesTitle: string;
  seasonNumber: number;
  via: string;
  confidence: number;
  episodes: { count: number; first: number; last: number; label: string };
  clamped: boolean;
  wholeSeason: boolean;
  keptSeasons: number[];
  unmonitoredSeasons: number[];
  unmonitoredEpisodes: number;
  searchable: number;
  removedFromQueue: Array<{ season: number; episode: number | null; title: string }>;
};

export type Cours = {
  lumped?: boolean;
  // seasons-folded: TMDB reports fewer seasons than Sonarr has.
  // cour-within-season: the counts agree, but this AniList entry is only part of a Sonarr season.
  kind?: "seasons-folded" | "cour-within-season";
  tmdbSeasons?: number;
  sonarrSeasons?: number | null;
  prequelDepth?: number | null;
  inSonarr?: boolean;
  target?: { seasonNumber: number; via: string; episodeCount: number; wholeSeason: boolean } | null;
  seasons?: CourSeason[] | null;
  narrowing?: {
    state: "running" | "done" | "failed";
    at: number;
    result?: NarrowResult;
    error?: string;
    /** Background queue sweep: Jellyseerr's search can grab minutes after the narrowing finished. */
    guard?: "watching" | "settled" | "timed-out" | "failed" | null;
  } | null;
};

export type AnimeDetail = Anime & {
  library: LibraryMatch | null;
  request: RequestMatch | null;
  routing: Routing | null;
  cours: Cours | null;
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

export type UpstreamStat = {
  calls: number;
  errors: number;
  p50: number | null;
  p95: number | null;
  lastMs: number | null;
  lastAt: number | null;
  lastError: string | null;
};

export type Health = {
  ok: boolean;
  checks: Record<string, { configured: boolean; ok: boolean; detail: string }>;
  uptimeSeconds?: number;
  cache?: {
    entries: number;
    limit: number;
    hits: number;
    misses: number;
    stale: number;
    revalidated: number;
    hitRate: number | null;
    persisted: boolean;
  };
  upstream?: Record<string, UpstreamStat>;
};

// A session can end while the app is open: it expires, someone signs out everywhere, or the login
// gets switched on from the Settings screen. Without this the app kept rendering over an API that
// answered 401 to everything, so every request reports the loss once and the shell can show the
// login form instead.
let onLost: (() => void) | null = null;
export const onSessionLost = (handler: () => void) => {
  onLost = handler;
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body && (body as { error?: string }).error) || `${res.status} ${res.statusText}`;
    // 403 is a real account that is not allowed to do this, which is not a lost session.
    if (res.status === 401 && !path.startsWith("/api/auth")) onLost?.();
    throw new Error(message);
  }
  // A 200 whose body is not JSON used to be cast to T and returned as null, which then blew up
  // deep inside a render as "cannot read properties of null" rather than as a failed request.
  // A reverse proxy answering with an HTML error page is the usual way this happens.
  if (body === null) throw new Error(`${path} returned a response that was not JSON`);
  return body as T;
}

export type SettingField = {
  key: string;
  env: string;
  type: "url" | "secret" | "text" | "boolean" | "number" | "list";
  group: string;
  label: string;
  /** Has its own control instead of an input: saving it through the patch is refused. */
  managed: boolean;
  hint: string | null;
  placeholder: string | null;
  min: number | null;
  max: number | null;
  /** Where the effective value came from: the settings file, the environment, or a built-in. */
  source: "settings" | "env" | "default";
  /** Always null for secrets: the server never sends one back. */
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

export type AuthState = {
  enabled: boolean;
  configured: boolean;
  signedIn: boolean;
  user: { name: string; admin: boolean } | null;
};

export const getAuth = () => json<AuthState>("/api/auth");

export const login = (username: string, password: string) =>
  json<{ ok: true; user: { name: string; admin: boolean } }>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

export const logout = (everywhere = false) =>
  json<{ ok: true }>(`/api/auth/logout${everywhere ? "?everywhere=1" : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });

export const getSettings = () => json<Settings>("/api/settings");

export const saveSettings = (patch: Record<string, string | number | boolean>) =>
  json<Settings & { changed: string[] }>("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });

// Neither route reads a body, but the header still has to be sent. Hono's csrf() treats a missing
// Content-Type as text/plain, which is form-like, so it falls back to comparing the Origin against
// the request URL: that breaks a plain curl (no Origin at all, so 403 with a non-JSON body) and any
// browser behind a TLS-terminating proxy that does not send Sec-Fetch-Site, since the comparison
// never consults x-forwarded-proto. Declaring JSON skips that path, exactly as every other mutating
// call here already does.
const TOKEN_HEADERS = { "Content-Type": "application/json" };

/**
 * Mints a new shared secret and returns it in the clear. This is the only response that ever
 * carries it, so whatever calls this has to show it to the user straight away.
 */
export const generateToken = () =>
  json<Settings & { token: string }>("/api/settings/token", { method: "POST", headers: TOKEN_HEADERS });

/** Hands the field back to HIKARI_TOKEN, which may still supply one. */
export const removeToken = () =>
  json<Settings & { cleared: boolean; fromEnv: boolean }>("/api/settings/token", {
    method: "DELETE",
    headers: TOKEN_HEADERS
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
  anilistId?: number;
  whole?: boolean;
}) {
  return json<{
    ok: true;
    requestId: number;
    status: number;
    forcedAnime: { profileId: number; rootFolder: string } | null;
    narrowing: { started: boolean; whole?: boolean } | null;
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

// Narrow Sonarr to the episodes one AniList entry covers. Without a season the server resolves the
// cour from air dates; with one, the choice is taken as given.
//
// Two steps, like searchMissingEpisodes: nothing is written unless confirm is true, and the first
// call returns the plan. This unmonitors episodes and removes downloads, so it is worth a look.
export function narrowToCour(
  anilistId: number,
  { seasonNumber, mode = "exclusive", confirm = false }: { seasonNumber?: number; mode?: NarrowMode; confirm?: boolean } = {}
) {
  return json<{ ok: true } & NarrowResult>(`/api/sonarr/narrow/${anilistId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(seasonNumber === undefined ? {} : { seasonNumber }), mode, confirm })
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
