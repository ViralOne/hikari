import { For, Show } from "solid-js";
import type { AnimeDetail } from "../../api";
import type { DetailActions } from "./actions";

/** How far through this season you are, as Jellyfin sees it. */
export function ProgressBox(props: { anime: AnimeDetail; actions: DetailActions }) {
  const actions = () => props.actions;

  return (
    <Show when={props.anime.watch}>
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
                    <Show when={watch().scoped && watch().total && watch().total !== episodes().total}>
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

                {/* Deliberately phrased from the reconciliation rather than the raw gap: saying "not
                    downloaded" about files that are sitting on the disk sent me looking for a
                    download that had already happened. */}
                <Show when={watch().scoped && (watch().aired ?? 0) - episodes().total > 0}>
                  <Show
                    when={props.anime.shoko?.report}
                    fallback={
                      <div class="notice warn">
                        {(watch().aired ?? 0) - episodes().total} aired episode
                        {(watch().aired ?? 0) - episodes().total === 1 ? "" : "s"} not downloaded yet.
                      </div>
                    }
                  >
                    {report => (
                      <>
                        <Show when={report().counts.notDownloaded > 0}>
                          <div class="notice warn">
                            {report().counts.notDownloaded} aired episode
                            {report().counts.notDownloaded === 1 ? "" : "s"} not downloaded yet. The Shoko box
                            below can send them to Sonarr.
                          </div>
                        </Show>
                        <Show when={report().counts.onDiskUnlinked + report().counts.onDiskNotHashed > 0}>
                          <div class="notice info">
                            {report().counts.onDiskUnlinked + report().counts.onDiskNotHashed} aired episode
                            {report().counts.onDiskUnlinked + report().counts.onDiskNotHashed === 1
                              ? " is"
                              : "s are"}{" "}
                            already on disk but not matched by Shoko, so they do not count here. The Shoko box
                            below can repair that.
                          </div>
                        </Show>
                      </>
                    )}
                  </Show>
                </Show>

                <Show when={!watch().scoped}>
                  <div class="notice info">
                    Matched by {watch().via}, which can cover the whole series rather than just this entry, so
                    counts are what is on disk instead of this season's length.
                  </div>
                </Show>

                {/* Jellyfin keys played flags to item ids, so a Shokofin VFS rebuild orphans the
                    whole history and a watched season reads as 0. AniList usually survives that, so
                    it can be copied back. */}
                {/* Against the furthest watched episode, not how many are watched: with the first
                    nine of a season undownloaded those are nine apart, and comparing the count
                    offers to "catch Jellyfin up" to progress it is already ahead of. */}
                <Show
                  when={watch().scoped && props.anime.list && props.anime.list.progress > episodes().progress}
                >
                  <Show
                    when={actions().playedPlan()}
                    fallback={
                      <button
                        class="btn"
                        disabled={actions().busy()}
                        onClick={() => actions().syncJellyfin(props.anime.id, undefined, false)}
                      >
                        Mark {props.anime.list!.progress} episode
                        {props.anime.list!.progress === 1 ? "" : "s"} played in Jellyfin (from AniList)
                      </button>
                    }
                  >
                    {plan => (
                      <div class="plan">
                        <Show
                          when={plan().episodes.length > 0}
                          fallback={
                            <div class="notice info">
                              Jellyfin already has {plan().covers} episode
                              {plan().covers === 1 ? "" : "s"} marked played
                              {plan().byEpisode ? ` up to episode ${plan().upTo}` : ""}.
                            </div>
                          }
                        >
                          <div class="box-title">
                            {plan().executed ? "Marked" : "Would mark"} {plan().episodes.length} of {plan().total}{" "}
                            played in {plan().item}
                          </div>
                          <For each={plan().episodes}>
                            {item => (
                              <div class="plan-row">
                                <span class="plan-ep">
                                  S{String(item.season ?? 0).padStart(2, "0")}E
                                  {String(item.episode ?? 0).padStart(2, "0")}
                                </span>
                                <span class="dim">{item.name}</span>
                              </div>
                            )}
                          </For>
                          <Show when={!plan().executed}>
                            <button
                              class="btn primary"
                              disabled={actions().busy()}
                              onClick={() => actions().syncJellyfin(props.anime.id, plan().upTo, true)}
                            >
                              Mark them played
                            </button>
                            <div class="hint">
                              Only marks played, never unmarks, and only{" "}
                              {plan().byEpisode
                                ? `up to episode ${plan().upTo}`
                                : `the first ${plan().upTo} of this item`}
                              .
                            </div>
                          </Show>
                        </Show>
                      </div>
                    )}
                  </Show>
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
                      Up next:{" "}
                      <strong>
                        S{next().season ?? "?"}E{next().episode ?? "?"}
                      </strong>{" "}
                      · {next().name}
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
  );
}
