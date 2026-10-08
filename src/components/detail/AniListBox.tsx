import { For, Show } from "solid-js";
import { ANILIST_STATUSES, type AnimeDetail } from "../../api";
import { watchedPayload } from "../../list";
import type { DetailActions } from "./actions";

export function AniListBox(props: { anime: AnimeDetail; actions: DetailActions }) {
  const actions = () => props.actions;
  /** The furthest episode Jellyfin has watched, which is what AniList progress is compared against. */
  const watched = () => props.anime.watch?.episodes?.progress ?? 0;

  return (
    <Show when={props.anime.list} fallback={<NotOnList anime={props.anime} actions={props.actions} />}>
      {entry => (
        <div class="box">
          <div class="box-head">
            <span class="box-title">AniList</span>
            <span class={["badge", entry().caughtUp ? "seen" : "watching"]}>{entry().statusLabel}</span>
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
          {/* The furthest watched episode, not the number of watched files: those are the same only
              for a season that is complete from episode one, and it is AniList's progress number
              this is being compared with. */}
          <Show when={watched() > entry().progress}>
            <div class="notice warn">
              Jellyfin has episode {watched()} watched but AniList only has {entry().progress}. Ani-Sync may
              have missed some.
              <Show when={actions().writable()}> Use the buttons below to correct it.</Show>
            </div>
          </Show>
          <Show
            when={actions().writable()}
            fallback={
              <div class="hint">Read-only. Set ANILIST_ALLOW_WRITES=true to change status from here.</div>
            }
          >
            <div class="chips">
              <For each={ANILIST_STATUSES}>
                {option => (
                  <button
                    class={["btn", "tiny", entry().status === option.value ? "primary" : "ghost"]}
                    disabled={actions().busy() || entry().status === option.value}
                    onClick={() => actions().saveList(props.anime.id, { status: option.value })}
                  >
                    {option.label}
                  </button>
                )}
              </For>
            </div>
            <div class="stepper">
              <button
                class="btn tiny ghost"
                aria-label="One episode back"
                disabled={actions().busy() || actions().draftProgress(entry().progress) <= 0}
                onClick={() => actions().setDraft(actions().draftProgress(entry().progress) - 1, entry().total)}
              >
                −
              </button>
              <input
                class="field stepper-input"
                type="number"
                inputmode="numeric"
                min="0"
                max={entry().total ?? undefined}
                aria-label="Episodes watched"
                value={actions().draftProgress(entry().progress)}
                onInput={event => {
                  // An empty field parses as 0, which would silently offer to wipe real progress on
                  // the account. Pasted text parses as NaN, which survives the clamp and makes Save
                  // look enabled while sending a progress value JSON turns into null.
                  const parsed = Number(event.currentTarget.value);
                  if (event.currentTarget.value === "" || !Number.isFinite(parsed)) return;
                  actions().setDraft(parsed, entry().total);
                }}
              />
              <button
                class="btn tiny ghost"
                aria-label="One episode forward"
                disabled={
                  actions().busy() ||
                  (entry().total != null && actions().draftProgress(entry().progress) >= entry().total!)
                }
                onClick={() => actions().setDraft(actions().draftProgress(entry().progress) + 1, entry().total)}
              >
                +
              </button>
              <span class="hint">of {entry().total ?? "?"}</span>
              <button
                class="btn tiny primary"
                disabled={actions().busy() || actions().draftProgress(entry().progress) === entry().progress}
                onClick={() =>
                  actions().saveList(props.anime.id, { progress: actions().draftProgress(entry().progress) })
                }
              >
                Save to AniList
              </button>
            </div>

            {/* Only ever offered as a way forward. Jellyfin reporting 0 because a Shokofin rebuild
                orphaned its watch flags must not turn into a one-tap button that wipes real
                progress on the account. */}
            <Show when={watched() > entry().progress}>
              <button
                class="btn"
                disabled={actions().busy()}
                onClick={() => actions().saveList(props.anime.id, { progress: watched() })}
              >
                Set progress to {watched()} (from Jellyfin)
              </button>
            </Show>
          </Show>
        </div>
      )}
    </Show>
  );
}

/**
 * Offered for a title that is not on your list at all.
 *
 * The rows that suggest a sequel are built from exactly that absence: a title stops being suggested
 * once it is on the list, which is what these buttons are for.
 */
function NotOnList(props: { anime: AnimeDetail; actions: DetailActions }) {
  const actions = () => props.actions;

  return (
    <Show when={actions().listConfigured()}>
      <div class="box">
        <div class="box-head">
          <span class="box-title">AniList</span>
          <span class="badge">Not on your list</span>
        </div>
        <Show
          when={actions().writable()}
          fallback={
            <div class="hint">Read-only. Set ANILIST_ALLOW_WRITES=true to add titles from here.</div>
          }
        >
          <div class="hint">Already seen this? Adding it stops it being suggested again.</div>
          <button
            class="btn primary"
            disabled={actions().busy()}
            onClick={() => actions().saveList(props.anime.id, watchedPayload(props.anime))}
          >
            Mark as watched
            {(props.anime.episodes ?? 0) > 1 ? ` (all ${props.anime.episodes} episodes)` : ""}
          </button>
          <div class="chips">
            {/* Completed is the button above, which also sets the episode count. Offering it here as
                well would add it on episode zero. */}
            <For each={ANILIST_STATUSES.filter(option => option.value !== "COMPLETED")}>
              {option => (
                <button
                  class="btn tiny ghost"
                  disabled={actions().busy()}
                  onClick={() => actions().saveList(props.anime.id, { status: option.value })}
                >
                  {option.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
