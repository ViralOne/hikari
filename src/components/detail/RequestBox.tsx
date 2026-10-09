import { createMemo, For, Show } from "solid-js";
import type { AnimeDetail, RequestMatch } from "../../api";
import { bytes } from "../../format";
import { CourActions, LumpedNotice, NarrowNotice } from "../CourNotice";
import { Icon } from "../Icon";
import type { DetailActions } from "./actions";
import { defaultSelection, type Selection } from "./seasons";

export function RequestBox(props: { anime: AnimeDetail; actions: DetailActions }) {
  return (
    <Show
      when={props.anime.request?.matched ? props.anime.request : null}
      fallback={<NoMatch anime={props.anime} />}
    >
      {request => <Matched anime={props.anime} actions={props.actions} request={request()} />}
    </Show>
  );
}

/** No confident TMDB match, so the only way forward is Jellyseerr's own search. */
function NoMatch(props: { anime: AnimeDetail }) {
  return (
    <div class="box">
      <div class="box-title">Request</div>
      <div class="notice bad">
        No confident TMDB match via Jellyseerr
        <Show when={props.anime.request?.error}>{error => <>: {error()}</>}</Show>. Open Jellyseerr and request
        it manually.
      </div>
      <Show when={props.anime.links?.search}>
        {url => (
          <a class="btn primary" href={url()} target="_blank" rel="noreferrer">
            <Icon name="external" size={15} />
            Search “{props.anime.title.display}” in Jellyseerr
          </a>
        )}
      </Show>
    </div>
  );
}

function Matched(props: { anime: AnimeDetail; actions: DetailActions; request: RequestMatch }) {
  const actions = () => props.actions;
  const request = () => props.request;

  const seasonList = createMemo(() => request().seasons ?? []);
  const openSeasons = createMemo(() =>
    seasonList()
      .filter(season => !season.taken)
      .map(season => season.seasonNumber)
  );
  const doneSeasons = createMemo(() =>
    seasonList()
      .filter(season => season.taken)
      .map(season => season.seasonNumber)
  );
  const allDone = createMemo(() => seasonList().length > 0 && openSeasons().length === 0);

  const selection = createMemo<Selection>(
    () => actions().selectionOverride() ?? defaultSelection(request().seasons, request().suggestedSeason)
  );

  // What actually gets sent. Already-requested seasons are stripped here, so "all" can never
  // re-request something Jellyseerr already has.
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

  const chosenCount = createMemo(() => (seasonList().length === 0 ? 1 : submittable().length));

  return (
    <div class="box">
      <div class="box-head">
        <span class="box-title">Request via Jellyseerr</span>
        <span class="badge">{request().status === "none" ? "not requested" : request().status}</span>
      </div>

      <dl class="kv">
        <dt>Matched</dt>
        <dd>
          {request().title}
          <Show when={request().year}>{year => <> ({year()})</>}</Show> · {request().mediaType} ·{" "}
          {/* An id match has no similarity score, and printing 0% for the most reliable kind of
              match read as the least reliable one. */}
          {request().via === "id"
            ? "matched by id"
            : `${Math.round((request().confidence ?? 0) * 100)}% title match`}
        </dd>
      </dl>

      <Show when={request().mediaType === "tv" && request().seasons?.length}>
        <>
          <Show when={request().suggestedSeason}>
            {suggested => (
              <div class="suggest">
                {request().via === "id"
                  ? `This AniList entry maps to TMDB season ${suggested()}. Change the selection if that is wrong.`
                  : `This AniList entry looks like TMDB season ${suggested()} (matched on air date and title ordinal). Change the selection if that is wrong.`}
              </div>
            )}
          </Show>

          <div class="season-list">
            {/* Keyed by season number. Requesting refetches the detail twice within a few seconds,
                and identity keying rebuilt every checkbox, dropping focus mid-selection. With a
                custom key the item is an accessor, so it has to be read in JSX or a memo rather
                than hoisted to a local. */}
            <For each={request().seasons ?? []} keyed={season => season.seasonNumber}>
              {season => {
                const done = createMemo(() => season().taken);
                const picked = createMemo(() => submittable().includes(season().seasonNumber));
                return (
                  <label class={["season", { picked: picked() && !done(), done: done() }]}>
                    <input
                      type="checkbox"
                      checked={picked()}
                      disabled={done()}
                      onChange={() =>
                        actions().toggleSeason(
                          season().seasonNumber,
                          selection(),
                          (request().seasons ?? []).map(s => s.seasonNumber)
                        )
                      }
                    />
                    <span class="season-name">Season {season().seasonNumber}</span>
                    <span class="season-meta">
                      {season().episodeCount} ep
                      <Show when={season().airDate}>{date => <> · {date()}</>}</Show>
                      <Show when={done()}>
                        {" · "}
                        {season().status}
                      </Show>
                    </span>
                  </label>
                );
              }}
            </For>
          </div>
        </>
      </Show>

      {/* TMDB folds several of Sonarr's seasons into one for a lot of anime, so the checkboxes above
          cannot express which cour is wanted. Say so before the request rather than after the wrong
          season downloads. */}
      <Show when={props.anime.cours?.lumped}>
        <>
          <LumpedNotice cours={props.anime.cours!} />
          {/* Asked before the request rather than fixed afterwards: narrowing to one cour is right
              most of the time, but it actively undoes a request for a whole series, so it cannot be
              the only option. */}
          <div class="season-list">
            <label class={["season", { picked: !actions().wholeSeries() }]}>
              <input
                type="radio"
                checked={!actions().wholeSeries()}
                onChange={() => actions().setWholeSeries(false)}
              />
              <span class="season-name">Just this cour</span>
              <span class="season-meta">
                {props.anime.cours?.target
                  ? `season ${props.anime.cours!.target!.seasonNumber} in Sonarr`
                  : "worked out after the series is added"}
              </span>
            </label>
            <label class={["season", { picked: actions().wholeSeries() }]}>
              <input
                type="radio"
                checked={actions().wholeSeries()}
                onChange={() => actions().setWholeSeries(true)}
              />
              <span class="season-name">The whole series</span>
              <span class="season-meta">every season, no narrowing</span>
            </label>
          </div>
        </>
      </Show>

      {/* The narrowing runs after the request and takes about half a minute, so its state has to be
          visible or the panel looks like it did nothing. Jellyseerr is a dead end once it holds a
          request for a lumped show, so act on Sonarr instead of showing a locked checkbox. */}
      <Show when={props.anime.cours?.lumped && props.anime.cours?.inSonarr}>
        <CourActions
          cours={props.anime.cours!}
          seasonNumber={props.anime.cours?.target?.seasonNumber ?? null}
          busy={actions().busy()}
          onApply={(mode, seasonNumber) => actions().narrowSeason(props.anime.id, seasonNumber, mode)}
        />
      </Show>

      <Show when={props.anime.cours?.narrowing}>
        {narrowing => (
          <NarrowNotice
            narrowing={narrowing()}
            busy={actions().busy()}
            onPick={season => actions().narrowSeason(props.anime.id, season)}
          />
        )}
      </Show>

      <Show when={props.anime.routing}>
        {routing => (
          <>
            <dl class="kv">
              <dt>Will land as</dt>
              <dd>
                {routing().profileName ?? `profile ${routing().profileId}`} · {routing().rootFolder} ·{" "}
                {routing().seriesType}
              </dd>
            </dl>
            <Show when={routing().categories.length > 0}>
              <dl class="kv">
                <dt>qBittorrent category</dt>
                <dd>{routing().categories.map(entry => entry.category || "none").join(", ")}</dd>
              </dl>
            </Show>
            <Show when={!routing().treatedAsAnime}>
              <div class="notice warn">
                TMDB has not tagged this with the <code>anime</code> keyword, so Jellyseerr on its own would use
                your standard TV settings. Hikari will override the request to the anime profile and root folder.
                Sonarr's series type still has to be corrected after it is added. The button appears in the Sonarr
                box once it exists.
              </div>
            </Show>
          </>
        )}
      </Show>

      <Show when={skipped().length > 0}>
        <div class="notice info">
          Season{skipped().length === 1 ? "" : "s"} {skipped().join(", ")}{" "}
          {skipped().length === 1 ? "is" : "are"} already requested and will be skipped, so only the rest gets
          sent, so nothing is duplicated.
        </div>
      </Show>

      {/* Every season TMDB has is an older one, so ticking any of them requests episodes this entry
          is not. Said in red rather than as the usual "pick a season", which reads as permission. */}
      <Show
        when={!request().notOnTmdbYet}
        fallback={
          <div class="notice bad">
            This hasn't aired yet and TMDB has no season for it, so every season listed above is an earlier
            one. Requesting any of them downloads episodes you have already seen. Come back once TMDB lists
            the new season.
          </div>
        }
      >
        <Show when={!allDone() && chosenCount() === 0 && skipped().length === 0}>
          <div class="notice info">
            Nothing preselected: Hikari could not tell which TMDB season this AniList entry maps to, so pick the
            season you want.
          </div>
        </Show>
      </Show>

      <Show when={props.anime.library && props.anime.library.episodeFileCount > 0}>
        <div class="notice info">
          Sonarr already holds {props.anime.library!.episodeFileCount} episodes of this series (
          {bytes(props.anime.library!.sizeOnDisk)}). Jellyseerr does not know about media added outside it, so
          seasons can read as “not requested” even when you already have them.
        </div>
      </Show>

      <Show
        when={!allDone()}
        fallback={
          <>
            <div class="notice ok">
              Every season is already requested in Jellyseerr, so nothing is left to send from here.
            </div>
            <Show when={props.anime.links?.media}>
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
            disabled={actions().busy() || chosenCount() === 0 || Boolean(actions().requestedSelection())}
            onClick={() =>
              actions().submit(
                request().tmdbId!,
                request().mediaType!,
                seasonList().length === 0 ? "all" : submittable(),
                props.anime.routing?.treatedAsAnime === false
              )
            }
          >
            <Show when={actions().busy()}>
              <i class="spinner" />
            </Show>
            <Show when={!actions().requestedSelection()} fallback={<>Requested, waiting on Jellyseerr</>}>
              Request {chosenCount()} {request().mediaType === "tv" ? "season" : "movie"}
              {chosenCount() === 1 ? "" : "s"}
              <Show when={submittable().length > 0 && seasonList().length > 0}>
                <span class="dim"> ({submittable().join(", ")})</span>
              </Show>
            </Show>
          </button>

          <Show when={request().mediaType === "tv" && openSeasons().length > 1}>
            <button class="btn ghost tiny" onClick={() => actions().selectSeasons(openSeasons())}>
              Select all {openSeasons().length} available
            </button>
          </Show>

          <Show when={actions().requestedSelection() && props.anime.links?.media}>
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
}
