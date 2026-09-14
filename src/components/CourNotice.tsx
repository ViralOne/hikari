import { For, Show } from "solid-js";
import type { Cours, NarrowMode, NarrowResult } from "../api";

// AniList, TMDB and TVDB disagree about what a season is. TMDB folds several of Sonarr's seasons
// into one for a lot of anime, which means the season checkboxes in the request box cannot express
// which cour is wanted, and Hikari has to correct Sonarr after the request instead.
//
// These two notices are the whole user-facing story of that: what is about to happen, and what
// happened. They live here rather than inline in Detail.tsx because the states are a union and
// reading them inside nested Show fallbacks was unreadable.

export function LumpedNotice(props: { cours: Cours }) {
  const target = () => props.cours.target;

  return (
    <div class="notice warn">
      <Show
        when={props.cours.kind === "cour-within-season"}
        fallback={
          <>
            These seasons are lumped together. TMDB has{" "}
            {props.cours.tmdbSeasons === 1 ? "one season" : `${props.cours.tmdbSeasons} seasons`}
            <Show when={props.cours.sonarrSeasons}>{count => <> where Sonarr has {count()}</>}</Show>, so a Jellyseerr
            season number cannot say which cour you mean.
          </>
        }
      >
        This entry is only part of a Sonarr season. AniList splits the cours where Sonarr keeps them together, so
        requesting the season would fetch more episodes than this entry covers.
      </Show>{" "}
      <Show
        when={target()}
        fallback={
          <>
            Hikari will request through Jellyseerr and then narrow Sonarr to the right episodes once the series
            exists. If it cannot work out which, it will ask you rather than guess.
          </>
        }
      >
        {resolved => (
          <>
            Hikari will narrow Sonarr to season {resolved().seasonNumber}
            <Show when={!resolved().wholeSeason}>
              {" "}
              ({resolved().episodeCount} episode{resolved().episodeCount === 1 ? "" : "s"} of it)
            </Show>{" "}
            after requesting, matched on {resolved().via === "air-date" ? "air date" : "the prequel chain"}.
          </>
        )}
      </Show>
    </div>
  );
}

function Applied(props: { result: Extract<NarrowResult, { applied: true }> }) {
  const episodes = () => props.result.episodes;

  return (
    <div class="notice ok">
      Sonarr narrowed to {episodes().label} ({episodes().count} episode{episodes().count === 1 ? "" : "s"}) and
      searching.
      <Show when={props.result.unmonitoredSeasons.length > 0}>
        {" "}
        Season{props.result.unmonitoredSeasons.length === 1 ? "" : "s"} {props.result.unmonitoredSeasons.join(", ")}{" "}
        left unmonitored, so nothing else gets pulled in.
      </Show>
      <Show when={props.result.removedFromQueue.length > 0}>
        {" "}
        Removed {props.result.removedFromQueue.length} download
        {props.result.removedFromQueue.length === 1 ? "" : "s"} Jellyseerr had already started for another season
        <Show when={props.result.cancelledSearches?.length}> and stopped its search</Show>.
        <Show when={props.result.searchesStillRunning?.length}>
          {" "}
          Sonarr would not cancel the search it had already started, so it may run for a few more minutes. It has
          nothing left to grab now that only this cour is monitored.
        </Show>
      </Show>
      {/* A season TVDB has not fleshed out yet is monitored rather than complete. Saying "1 episode"
          and nothing else read as though only one episode would ever arrive. */}
      <Show when={props.result.episodes.count === 1 && props.result.wholeSeason}>
        {" "}
        TVDB only lists one placeholder episode for this season so far. The season itself is monitored, so the rest
        get picked up as TVDB publishes them.
      </Show>
      {/* AniList expecting more episodes than the season holds usually means TVDB split a cour
          across two seasons. Saying so beats silently downloading half of it. */}
      <Show when={props.result.clamped}>
        {" "}
        AniList expects more episodes than this Sonarr season holds, so the range stops at the season boundary. Check
        whether a later season covers the rest.
      </Show>
      <Show when={props.result.search.error}>
        {error => <> Sonarr refused the search: {error()}. The episodes are monitored, so a manual search will pick
        them up.</>}
      </Show>
    </div>
  );
}

// Refusing to guess is the point: a wrong season costs a whole download, a refusal costs a click.
function Unresolved(props: { result: Extract<NarrowResult, { applied: false }>; onPick: (season: number) => void; busy: boolean }) {
  return (
    <div class="notice warn">
      <Show
        when={props.result.reason === "cannot-map-cour" ? props.result.seasons : null}
        fallback={
          <>
            Sonarr was not narrowed: {props.result.reason}. Nothing is downloading for the wrong season, but it is
            worth a look in Sonarr.
          </>
        }
      >
        {seasons => (
          <>
            Hikari could not tell which of Sonarr's seasons this AniList entry is, so nothing is monitored yet. Pick
            one:
            <div class="season-list">
              <For each={seasons()}>
                {season => (
                  <button class="btn" disabled={props.busy} onClick={() => props.onPick(season.seasonNumber)}>
                    Season {season.seasonNumber} · {season.episodeCount} ep
                    {season.firstAirDate ? ` · ${season.firstAirDate}` : ""}
                    {season.onDisk > 0 ? ` · ${season.onDisk} on disk` : ""}
                  </button>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

// Narrowing runs on the server for up to about thirty-five seconds after the request, so every
// state here is reachable and has to read as something other than a stalled panel.
export function NarrowNotice(props: {
  narrowing: NonNullable<Cours["narrowing"]>;
  onPick: (season: number) => void;
  busy: boolean;
}) {
  const result = () => (props.narrowing.state === "done" ? props.narrowing.result : undefined);
  const guard = () => props.narrowing.guard;

  return (
    <>
    <Show
      when={result()}
      fallback={
        <div class={["notice", props.narrowing.state === "failed" ? "warn" : "info"]}>
          <Show when={props.narrowing.state === "failed"} fallback={<>Narrowing Sonarr to this cour…</>}>
            Narrowing Sonarr failed: {props.narrowing.error}. Sonarr may still be monitoring seasons you did not ask
            for.
          </Show>
        </div>
      }
    >
      {settled => (
        <Show
          when={settled().applied}
          fallback={
            <Unresolved
              result={settled() as Extract<NarrowResult, { applied: false }>}
              onPick={props.onPick}
              busy={props.busy}
            />
          }
        >
          <Applied result={settled() as Extract<NarrowResult, { applied: true }>} />
        </Show>
      )}
    </Show>

    {/* Sonarr's search does not grab as it goes: one observed run pushed eight releases in a burst
        eleven minutes after it started. So the sweep keeps running after the narrowing is reported
        done, and that has to be visible or a late removal looks like it came out of nowhere. */}
    <Show when={guard() === "watching"}>
      <div class="notice info">
        Still watching the download queue. Jellyseerr's search can keep grabbing for several minutes
        after this, and anything it pulls for another season is removed as it appears.
      </div>
    </Show>
    <Show when={guard() === "timed-out"}>
      <div class="notice warn">
        Gave up watching the download queue after twenty minutes. Jellyseerr's search was still going,
        so check Sonarr for anything grabbed for a season you did not ask for.
      </div>
    </Show>
    </>
  );
}

// Once Sonarr holds a lumped series, Jellyseerr has nothing left to say: it counts "season 1" as
// requested, which in TMDB's world is the whole show, so its request button is a dead end for every
// other cour. What decides what you get from here is which Sonarr episodes are monitored, so this
// shows that and acts on it directly.
export function CourActions(props: {
  cours: Cours;
  seasonNumber: number | null;
  busy: boolean;
  onApply: (mode: NarrowMode, seasonNumber?: number) => void;
}) {
  const seasons = () => props.cours.seasons ?? [];
  const target = () => props.seasonNumber;
  const monitoredNow = () => seasons().filter(season => season.monitored > 0).map(season => season.seasonNumber);
  const targetSeason = () => seasons().find(season => season.seasonNumber === target());
  const alreadyOn = () => (targetSeason()?.monitored ?? 0) > 0;

  // Deliberately not a nested <div class="box">: this renders inside the request box, and a box
  // within a box reads as a separate panel rather than part of the same decision.
  return (
    <>
      <div class="notice info">
        Jellyseerr already counts this whole show as requested, because TMDB has it as a single season, so it cannot
        add another cour. These act on Sonarr directly. Monitored now:{" "}
        {monitoredNow().length === 0 ? "nothing" : `season ${monitoredNow().join(", ")}`}.
      </div>

      <div class="season-list">
        <For each={seasons()}>
          {season => (
            <div class={["season", { picked: season.monitored > 0, done: season.onDisk >= season.episodeCount && season.episodeCount > 0 }]}>
              <span class="season-name">
                Season {season.seasonNumber}
                <Show when={season.seasonNumber === target()}> · this entry</Show>
              </span>
              <span class="season-meta">
                {season.episodeCount} ep · {season.monitored > 0 ? `${season.monitored} monitored` : "not monitored"}
                <Show when={season.onDisk > 0}> · {season.onDisk} on disk</Show>
                <Show when={season.firstAirDate}>{date => <> · {date()}</>}</Show>
              </span>
            </div>
          )}
        </For>
      </div>

      <Show when={target()}>
        {seasonNumber => (
          <>
            <Show when={!alreadyOn()}>
              <button class="btn" disabled={props.busy} onClick={() => props.onApply("add", seasonNumber())}>
                Also fetch season {seasonNumber()} (keep what is already monitored)
              </button>
            </Show>
            <button class="btn" disabled={props.busy} onClick={() => props.onApply("exclusive", seasonNumber())}>
              Only season {seasonNumber()} (stop monitoring the rest)
            </button>
          </>
        )}
      </Show>

      <button class="btn" disabled={props.busy} onClick={() => props.onApply("whole")}>
        Fetch the whole series (every season)
      </button>
    </>
  );
}
