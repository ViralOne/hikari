import { createMemo, createSignal, For, Loading, onSettled, Show } from "solid-js";
import {
  ANILIST_STATUSES,
  getAnime,
  getList,
  postRequest,
  saveListEntry,
  setSonarrSeriesType,
  type SeasonInfo
} from "../api";
import { bytes, formatLabel, seasonLabel, statusLabel } from "../format";
import { Icon } from "./Icon";

type Selection = number[] | "all";
type Outcome = { ok: boolean; message: string };

const fetchDetail = (id: number, _token: number) => getAnime(id);

export function Detail(props: { id: number; token: number; onClose: () => void; onRequested: () => void }) {
  const detail = createMemo(() => fetchDetail(props.id, props.token));
  const [overrides, setOverrides] = createSignal<Record<number, Selection>>({});
  const [outcomes, setOutcomes] = createSignal<Record<number, Outcome>>({});
  const [requested, setRequested] = createSignal<Record<number, number[] | "all">>({});
  const [busy, setBusy] = createSignal(false);
  const [writable, setWritable] = createSignal(false);

  const defaultSelection = (seasons: SeasonInfo[] | null | undefined, suggested: number | null | undefined): Selection => {
    if (!seasons || seasons.length === 0) return "all";

    const suggestedSeason = suggested ? seasons.find(s => s.seasonNumber === suggested) : undefined;
    if (suggestedSeason && !suggestedSeason.taken) return [suggestedSeason.seasonNumber];

    const open = seasons.filter(s => !s.taken);
    if (open.length === 1) return [open[0].seasonNumber];

    return [];
  };

  const toggleSeason = (seasonNumber: number, current: Selection, allSeasons: number[]) => {
    // "all" has to expand to the real season list first, otherwise unchecking a box while
    // "all" is active reads as "not present -> add it" and selects only that season.
    const list = current === "all" ? allSeasons : current;
    const next = list.includes(seasonNumber)
      ? list.filter(n => n !== seasonNumber)
      : [...list, seasonNumber].sort((a, b) => a - b);
    setOverrides(prev => ({ ...prev, [props.id]: next }));

    // Deliberately picking seasons after a request means you want another one.
    setRequested(prev => {
      const { [props.id]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  const fixSeriesType = async (seriesId: number) => {
    setBusy(true);
    try {
      const result = await setSonarrSeriesType(seriesId, "anime");
      setOutcomes(prev => ({
        ...prev,
        [props.id]: {
          ok: true,
          message: result.changed
            ? `Sonarr series type changed from ${result.previous} to anime.`
            : "Sonarr already had this as anime."
        }
      }));
      props.onRequested();
    } catch (err) {
      setOutcomes(prev => ({
        ...prev,
        [props.id]: { ok: false, message: err instanceof Error ? err.message : String(err) }
      }));
    } finally {
      setBusy(false);
    }
  };

  const saveList = async (anilistId: number, payload: { status?: string; progress?: number }) => {
    setBusy(true);
    try {
      const result = await saveListEntry(anilistId, payload);
      setOutcomes(prev => ({
        ...prev,
        [props.id]: { ok: true, message: `AniList updated: ${result.entry.status}, episode ${result.entry.progress}.` }
      }));
      props.onRequested();
    } catch (err) {
      setOutcomes(prev => ({
        ...prev,
        [props.id]: { ok: false, message: err instanceof Error ? err.message : String(err) }
      }));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (tmdbId: number, mediaType: string, selection: Selection, forceAnime: boolean) => {
    setBusy(true);
    try {
      const payload =
        mediaType === "tv"
          ? { tmdbId, mediaType, seasons: selection === "all" ? ("all" as const) : selection, forceAnime }
          : { tmdbId, mediaType };
      const created = await postRequest(payload);

      setRequested(prev => ({ ...prev, [props.id]: selection }));
      // Drop the manual selection so the refreshed season statuses drive the default again.
      setOverrides(prev => {
        const { [props.id]: _dropped, ...rest } = prev;
        return rest;
      });

      setOutcomes(prev => ({
        ...prev,
        [props.id]: {
          ok: true,
          message: created.forcedAnime
            ? `Requested in Jellyseerr (#${created.requestId}), forced to ${created.forcedAnime.rootFolder} with the anime profile.`
            : `Requested in Jellyseerr (request #${created.requestId}).`
        }
      }));

      props.onRequested();
      // Jellyseerr updates mediaInfo a beat after the POST returns.
      setTimeout(() => props.onRequested(), 2500);
    } catch (err) {
      setOutcomes(prev => ({
        ...prev,
        [props.id]: { ok: false, message: err instanceof Error ? err.message : String(err) }
      }));
    } finally {
      setBusy(false);
    }
  };

  // Move focus into the panel on open, keep Tab inside it, and hand focus back to whatever
  // opened it on close. Without this a keyboard user tabs into the page behind the panel.
  let panelRef: HTMLElement | undefined;
  const opener = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);

  onSettled(() => {
    panelRef?.focus();
    // Whether AniList writes are permitted is server-side config, not something the UI knows.
    getList()
      .then(result => setWritable(Boolean(result.writable)))
      .catch(() => setWritable(false));

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !panelRef) return;

      const focusable = [
        ...panelRef.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ].filter(element => element.offsetParent !== null);

      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef)) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus?.();
    };
  });

  return (
    <>
      <div class="panel-scrim" onClick={() => props.onClose()} />
      <aside
        class="panel"
        ref={element => (panelRef = element)}
        role="dialog"
        aria-modal="true"
        aria-label="Anime details"
        tabindex="-1"
      >
        <button class="panel-close" onClick={() => props.onClose()} aria-label="Close details">
          ✕
        </button>

        <Loading fallback={<div class="skeleton" style={{ height: "210px" }} />} on={props.id}>
          <Show when={detail()}>
            {anime => (
              <>
                <div
                  class="panel-hero"
                  style={{ "background-image": `url(${anime().banner || anime().cover || ""})` }}
                />

                <div class="panel-body">
                  <div class="panel-top">
                    <div class="panel-cover">
                      <Show when={anime().cover}>
                        {cover => <img src={cover()} alt="" />}
                      </Show>
                    </div>
                    <div>
                      <h2 class="panel-title">{anime().title.display}</h2>
                      <Show when={anime().title.romaji && anime().title.romaji !== anime().title.display}>
                        <div class="panel-alt">{anime().title.romaji}</div>
                      </Show>
                    </div>
                  </div>

                  <div class="meta-row">
                    <span>{seasonLabel(anime().season, anime().seasonYear)}</span>
                    <i class="meta-sep" />
                    <span>{formatLabel(anime().format)}</span>
                    <i class="meta-sep" />
                    <span>{statusLabel(anime().status)}</span>
                    <Show when={anime().episodes}>
                      {count => (
                        <>
                          <i class="meta-sep" />
                          <span>{count()} ep</span>
                        </>
                      )}
                    </Show>
                    <Show when={anime().score}>
                      {score => (
                        <>
                          <i class="meta-sep" />
                          <span>{score()}%</span>
                        </>
                      )}
                    </Show>
                  </div>

                  <div class="chips">
                    <For each={anime().genres}>{genre => <span class="chip">{genre}</span>}</For>
                  </div>

                  <Show when={anime().synopsis}>
                    {synopsis => <p class="synopsis">{synopsis()}</p>}
                  </Show>

                  <Show when={outcomes()[props.id]}>
                    {outcome => (
                      <div class={["notice", outcome().ok ? "ok" : "bad"]} role="status" aria-live="polite">
                        {outcome().message}
                      </div>
                    )}
                  </Show>

                  <Show when={anime().watch}>
                    {watch => (
                      <div class="box">
                        <div class="box-head">
                          <span class="box-title">Your progress</span>
                          <span class={["badge", watch().finished ? "seen" : "watching"]}>
                            {watch().finished ? "Watched" : `${watch().episodes?.percent ?? watch().percent}%`}
                          </span>
                        </div>

                        <div class="bar" style={{ height: "6px" }}>
                          <span style={{ width: `${Math.min(watch().episodes?.percent ?? watch().percent, 100)}%` }} />
                        </div>

                        <Show when={watch().episodes}>
                          {episodes => (
                            <>
                              <dl class="kv">
                                <dt>Episodes watched</dt>
                                <dd>
                                  {episodes().played} of{" "}
                                  {watch().scoped ? (watch().total ?? episodes().total) : episodes().total}
                                  <Show when={!watch().scoped}>
                                    <span class="dim"> on disk</span>
                                  </Show>
                                  <Show
                                    when={
                                      watch().scoped && watch().total && watch().total !== episodes().total
                                    }
                                  >
                                    <span class="dim"> ({episodes().total} on disk)</span>
                                  </Show>
                                </dd>
                              </dl>

                              <Show when={watch().scoped && watch().total ? watch().total : null}>
                                {total => (
                                  <dl class="kv">
                                    <dt>Season length</dt>
                                    <dd>
                                      {total()} episodes
                                      <Show when={watch().aired !== null && watch().aired! < total()}>
                                        <span class="dim"> · {watch().aired} aired so far</span>
                                      </Show>
                                    </dd>
                                  </dl>
                                )}
                              </Show>

                              <Show when={watch().scoped && (watch().aired ?? 0) - episodes().total > 0}>
                                <div class="notice warn">
                                  {(watch().aired ?? 0) - episodes().total} aired episode
                                  {(watch().aired ?? 0) - episodes().total === 1 ? "" : "s"} not downloaded yet.
                                </div>
                              </Show>

                              <Show when={!watch().scoped}>
                                <div class="notice info">
                                  Matched by {watch().via}, which can cover the whole series rather than just this
                                  entry, so counts are what is on disk instead of this season's length.
                                </div>
                              </Show>
                              <Show when={episodes().furthest}>
                                {furthest => (
                                  <dl class="kv">
                                    <dt>Last watched</dt>
                                    <dd>
                                      S{furthest().season ?? "?"}E{furthest().episode ?? "?"} · {furthest().name}
                                    </dd>
                                  </dl>
                                )}
                              </Show>
                              <Show
                                when={episodes().next}
                                fallback={<div class="notice ok">You are fully caught up on what is on disk.</div>}
                              >
                                {next => (
                                  <div class="suggest">
                                    Up next: <strong>
                                      S{next().season ?? "?"}E{next().episode ?? "?"}
                                    </strong>{" "}
                                    — {next().name}
                                  </div>
                                )}
                              </Show>
                              <Show when={episodes().lastPlayed}>
                                {lastPlayed => (
                                  <dl class="kv">
                                    <dt>Last played</dt>
                                    <dd>{new Date(lastPlayed()).toLocaleDateString()}</dd>
                                  </dl>
                                )}
                              </Show>
                            </>
                          )}
                        </Show>

                        <div class="hint">
                          From Jellyfin ({watch().name}), matched by {watch().via}.
                        </div>
                      </div>
                    )}
                  </Show>

                  <Show when={anime().list}>
                    {entry => (
                      <div class="box">
                        <div class="box-head">
                          <span class="box-title">AniList</span>
                          <span class={["badge", entry().caughtUp ? "seen" : "watching"]}>
                            {entry().statusLabel}
                          </span>
                        </div>
                        <dl class="kv">
                          <dt>Progress</dt>
                          <dd>
                            episode {entry().progress}
                            {entry().total ? ` of ${entry().total}` : ""}
                          </dd>
                        </dl>
                        <Show when={entry().updatedAt}>
                          {updated => (
                            <dl class="kv">
                              <dt>Last updated</dt>
                              <dd>{new Date(updated() * 1000).toLocaleDateString()}</dd>
                            </dl>
                          )}
                        </Show>
                        <Show
                          when={anime().watch && anime().watch!.played > entry().progress}
                        >
                          <div class="notice warn">
                            Jellyfin has {anime().watch!.played} episodes watched but AniList only has{" "}
                            {entry().progress}. Ani-Sync may have missed some.
                            <Show when={writable()}>
                              {" "}
                              Use the buttons below to correct it.
                            </Show>
                          </div>
                        </Show>
                        <Show
                          when={writable()}
                          fallback={
                            <div class="hint">
                              Read-only. Set ANILIST_ALLOW_WRITES=true to change status from here.
                            </div>
                          }
                        >
                          <div class="chips">
                            <For each={ANILIST_STATUSES}>
                              {option => (
                                <button
                                  class={["btn", "tiny", entry().status === option.value ? "primary" : "ghost"]}
                                  disabled={busy() || entry().status === option.value}
                                  onClick={() => saveList(anime().id, { status: option.value })}
                                >
                                  {option.label}
                                </button>
                              )}
                            </For>
                          </div>
                          <Show when={anime().watch && anime().watch!.played > entry().progress}>
                            <button
                              class="btn"
                              disabled={busy()}
                              onClick={() =>
                                saveList(anime().id, { progress: anime().watch!.played })
                              }
                            >
                              Set progress to {anime().watch!.played} (from Jellyfin)
                            </button>
                          </Show>
                        </Show>
                      </div>
                    )}
                  </Show>

                  <Show when={anime().shoko}>
                    {info => (
                      <div class="box">
                        <div class="box-head">
                          <span class="box-title">Shoko / AniDB</span>
                          <span class="badge">matched by {info().via}</span>
                        </div>
                        <dl class="kv">
                          <dt>Episodes</dt>
                          <dd>
                            {info().onDisk} of {info().totalEpisodes} on disk
                            <Show when={info().missing > 0}>
                              <span class="dim"> · {info().missing} missing</span>
                            </Show>
                          </dd>
                        </dl>
                        <Show when={info().files?.missing?.length}>
                          <div class="notice warn">
                            Missing episodes: {info().files!.missing.join(", ")}
                          </div>
                        </Show>
                        <Show when={info().files?.groups?.length}>
                          <dl class="kv">
                            <dt>Release groups</dt>
                            <dd>
                              {info()
                                .files!.groups.map(group => `${group.name} (${group.count})`)
                                .join(", ")}
                            </dd>
                          </dl>
                        </Show>
                        <Show when={info().files?.mixedGroups}>
                          <div class="hint">
                            More than one release group in this season, so encoding and subtitle style
                            may change between episodes.
                          </div>
                        </Show>
                        <Show when={info().sources.length}>
                          <dl class="kv">
                            <dt>Sources</dt>
                            <dd>{info().sources.map(source => `${source.name} (${source.count})`).join(", ")}</dd>
                          </dl>
                        </Show>
                      </div>
                    )}
                  </Show>

                  <Show
                    when={anime().library}
                    fallback={
                      <div class="box">
                        <div class="box-title">Sonarr</div>
                        <div class="notice info">Not in your library yet.</div>
                      </div>
                    }
                  >
                    {library => (
                      <div class="box">
                        <div class="box-head">
                          <span class="box-title">Sonarr</span>
                          <span
                            class={[
                              "badge",
                              library().complete ? "owned" : library().episodeFileCount > 0 ? "partial" : "pending"
                            ]}
                          >
                            {library().episodeFileCount}/{library().episodeCount} episodes
                          </span>
                        </div>
                        <dl class="kv">
                          <dt>Series</dt>
                          <dd>{library().title}</dd>
                        </dl>
                        <dl class="kv">
                          <dt>Path</dt>
                          <dd>{library().path}</dd>
                        </dl>
                        <dl class="kv">
                          <dt>Type / monitored</dt>
                          <dd>
                            {library().seriesType} · {library().monitored ? "yes" : "no"}
                          </dd>
                        </dl>

                        <Show when={library().seriesType !== "anime" && anime().format !== "MOVIE"}>
                          <div class="notice bad">
                            Sonarr has this as <strong>{library().seriesType}</strong>. Anime releases use absolute
                            episode numbering, so imports will mismatch until this is <strong>anime</strong>.
                          </div>
                          <button
                            class="btn"
                            disabled={busy()}
                            onClick={() => fixSeriesType(library().id)}
                          >
                            <Show when={busy()}>
                              <i class="spinner" />
                            </Show>
                            Set series type to anime
                          </button>
                        </Show>
                        <dl class="kv">
                          <dt>On disk</dt>
                          <dd>{bytes(library().sizeOnDisk)}</dd>
                        </dl>
                      </div>
                    )}
                  </Show>

                  <Show
                    when={anime().request?.matched ? anime().request : null}
                    fallback={
                      <div class="box">
                        <div class="box-title">Request</div>
                        <div class="notice bad">
                          No confident TMDB match via Jellyseerr
                          <Show when={anime().request?.error}>{error => <> — {error()}</>}</Show>. Open Jellyseerr and
                          request it manually.
                        </div>
                        <Show when={anime().links?.search}>
                          {url => (
                            <a class="btn primary" href={url()} target="_blank" rel="noreferrer">
                              <Icon name="external" size={15} />
                              Search “{anime().title.display}” in Jellyseerr
                            </a>
                          )}
                        </Show>
                      </div>
                    }
                  >
                    {request => {
                      const seasonList = createMemo(() => request().seasons ?? []);
                      const openSeasons = createMemo(() =>
                        seasonList().filter(season => !season.taken).map(season => season.seasonNumber)
                      );
                      const doneSeasons = createMemo(() =>
                        seasonList().filter(season => season.taken).map(season => season.seasonNumber)
                      );
                      const allDone = createMemo(() => seasonList().length > 0 && openSeasons().length === 0);

                      const selection = createMemo<Selection>(
                        () =>
                          overrides()[props.id] ??
                          defaultSelection(request().seasons, request().suggestedSeason)
                      );

                      // What actually gets sent. Already-requested seasons are stripped here, so
                      // "all" can never re-request something Jellyseerr already has.
                      const submittable = createMemo<number[]>(() => {
                        if (seasonList().length === 0) return [];
                        const value = selection();
                        const open = openSeasons();
                        const chosen = value === "all" ? open : value;
                        return chosen.filter(number => open.includes(number));
                      });

                      const skipped = createMemo<number[]>(() => {
                        const value = selection();
                        const done = doneSeasons();
                        return value === "all" ? done : value.filter(number => done.includes(number));
                      });

                      const chosenCount = createMemo(() =>
                        seasonList().length === 0 ? 1 : submittable().length
                      );

                      return (
                        <div class="box">
                          <div class="box-head">
                            <span class="box-title">Request via Jellyseerr</span>
                            <span class="badge">
                              {request().status === "none" ? "not requested" : request().status}
                            </span>
                          </div>

                          <dl class="kv">
                            <dt>Matched</dt>
                            <dd>
                              {request().title}
                              <Show when={request().year}>{year => <> ({year()})</>}</Show> ·{" "}
                              {request().mediaType} · {Math.round((request().confidence ?? 0) * 100)}%
                            </dd>
                          </dl>

                          <Show when={request().mediaType === "tv" && request().seasons?.length}>
                            <>
                              <Show when={request().suggestedSeason}>
                                {suggested => (
                                  <div class="suggest">
                                    This AniList entry looks like TMDB season {suggested()} (matched on air date and
                                    title ordinal). Change the selection if that is wrong.
                                  </div>
                                )}
                              </Show>

                              <div class="season-list">
                                <For each={request().seasons ?? []}>
                                  {season => {
                                    const done = season.taken;
                                    const picked = createMemo(() => submittable().includes(season.seasonNumber));
                                    return (
                                      <label
                                        class={["season", { picked: picked() && !done, done }]}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={picked()}
                                          disabled={done}
                                          onChange={() =>
                                            toggleSeason(
                                              season.seasonNumber,
                                              selection(),
                                              (request().seasons ?? []).map(s => s.seasonNumber)
                                            )
                                          }
                                        />
                                        <span class="season-name">Season {season.seasonNumber}</span>
                                        <span class="season-meta">
                                          {season.episodeCount} ep
                                          <Show when={season.airDate}>{date => <> · {date()}</>}</Show>
                                          <Show when={done}>
                                            {" · "}
                                            {season.status}
                                          </Show>
                                        </span>
                                      </label>
                                    );
                                  }}
                                </For>
                              </div>
                            </>
                          </Show>

                          <Show when={anime().routing}>
                            {routing => (
                              <>
                                <dl class="kv">
                                  <dt>Will land as</dt>
                                  <dd>
                                    {routing().profileName ?? `profile ${routing().profileId}`} ·{" "}
                                    {routing().rootFolder} · {routing().seriesType}
                                  </dd>
                                </dl>
                                <Show when={routing().categories.length > 0}>
                                  <dl class="kv">
                                    <dt>qBittorrent category</dt>
                                    <dd>
                                      {routing()
                                        .categories.map(entry => entry.category || "none")
                                        .join(", ")}
                                    </dd>
                                  </dl>
                                </Show>
                                <Show when={!routing().treatedAsAnime}>
                                  <div class="notice warn">
                                    TMDB has not tagged this with the <code>anime</code> keyword, so Jellyseerr on its
                                    own would use your standard TV settings. Hikari will override the request to the
                                    anime profile and root folder. Sonarr's series type still has to be corrected after
                                    it is added — the button appears in the Sonarr box once it exists.
                                  </div>
                                </Show>
                              </>
                            )}
                          </Show>

                          <Show when={skipped().length > 0}>
                            <div class="notice info">
                              Season{skipped().length === 1 ? "" : "s"} {skipped().join(", ")}{" "}
                              {skipped().length === 1 ? "is" : "are"} already requested and will be skipped — only the
                              rest gets sent, so nothing is duplicated.
                            </div>
                          </Show>

                          <Show when={!allDone() && chosenCount() === 0 && skipped().length === 0}>
                            <div class="notice info">
                              Nothing preselected — Hikari could not tell which TMDB season this AniList entry maps
                              to, so pick the season you want.
                            </div>
                          </Show>

                          <Show when={anime().library && anime().library!.episodeFileCount > 0}>
                            <div class="notice info">
                              Sonarr already holds {anime().library!.episodeFileCount} episodes of this series
                              ({bytes(anime().library!.sizeOnDisk)}). Jellyseerr does not know about media added
                              outside it, so seasons can read as “not requested” even when you already have them.
                            </div>
                          </Show>

                          <Show
                            when={!allDone()}
                            fallback={
                              <>
                                <div class="notice ok">
                                  Every season is already requested in Jellyseerr — nothing left to send from here.
                                </div>
                                <Show when={anime().links?.media}>
                                  {url => (
                                    <a class="btn" href={url()} target="_blank" rel="noreferrer">
                                      <Icon name="external" size={15} />
                                      View the request in Jellyseerr
                                    </a>
                                  )}
                                </Show>
                              </>
                            }
                          >
                            <div class="meta-row" style={{ gap: "8px" }}>
                              <button
                                class="btn primary"
                                disabled={busy() || chosenCount() === 0 || Boolean(requested()[props.id])}
                                onClick={() =>
                                  submit(
                                    request().tmdbId!,
                                    request().mediaType!,
                                    seasonList().length === 0 ? "all" : submittable(),
                                    anime().routing?.treatedAsAnime === false
                                  )
                                }
                              >
                                <Show when={busy()}>
                                  <i class="spinner" />
                                </Show>
                                <Show
                                  when={!requested()[props.id]}
                                  fallback={<>Requested — waiting on Jellyseerr</>}
                                >
                                  Request {chosenCount()}{" "}
                                  {request().mediaType === "tv" ? "season" : "movie"}
                                  {chosenCount() === 1 ? "" : "s"}
                                  <Show when={submittable().length > 0 && seasonList().length > 0}>
                                    <span class="dim"> ({submittable().join(", ")})</span>
                                  </Show>
                                </Show>
                              </button>

                              <Show when={request().mediaType === "tv" && openSeasons().length > 1}>
                                <button
                                  class="btn ghost tiny"
                                  onClick={() => setOverrides(prev => ({ ...prev, [props.id]: openSeasons() }))}
                                >
                                  Select all {openSeasons().length} available
                                </button>
                              </Show>

                              <Show when={requested()[props.id] && anime().links?.media}>
                                {url => (
                                  <a class="btn ghost tiny" href={url()} target="_blank" rel="noreferrer">
                                    <Icon name="external" size={14} />
                                    Open request
                                  </a>
                                )}
                              </Show>
                            </div>
                          </Show>
                        </div>
                      );
                    }}
                  </Show>

                  <div class="meta-row">
                    <Show
                      when={anime().links?.media}
                      fallback={
                        <Show when={anime().links?.search}>
                          {url => (
                            <a class="btn ghost tiny" href={url()} target="_blank" rel="noreferrer">
                              <Icon name="external" size={14} />
                              Find in Jellyseerr
                            </a>
                          )}
                        </Show>
                      }
                    >
                      {url => (
                        <a class="btn ghost tiny" href={url()} target="_blank" rel="noreferrer">
                          <Icon name="external" size={14} />
                          Open in Jellyseerr
                        </a>
                      )}
                    </Show>
                    <a class="btn ghost tiny" href={anime().siteUrl} target="_blank" rel="noreferrer">
                      AniList
                    </a>
                    <Show when={anime().malId}>
                      {malId => (
                        <a
                          class="btn ghost tiny"
                          href={`https://myanimelist.net/anime/${malId()}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          MyAnimeList
                        </a>
                      )}
                    </Show>
                  </div>
                </div>
              </>
            )}
          </Show>
        </Loading>
      </aside>
    </>
  );
}
