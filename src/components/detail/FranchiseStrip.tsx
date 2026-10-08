import { For, Show } from "solid-js";
import type { FranchiseEntry } from "../../api";
import { seasonLabel, statusLabel } from "../../format";
import { LibraryBadge, WatchBadge } from "../Badges";

/**
 * Where this season falls in the story, with what of it is already in the library.
 *
 * Only drawn when there is a chain: a title on its own has nothing to place.
 */
export function FranchiseStrip(props: {
  chain: FranchiseEntry[];
  busy: boolean;
  onOpen?: (id: number) => void;
}) {
  return (
    <div class="franchise" role="group" aria-label="Seasons in this story">
      <div class="box-title">
        The story so far
        <span class="franchise-count">
          {props.chain.findIndex(entry => entry.current) + 1} of {props.chain.length}
        </span>
      </div>
      <div class="franchise-rail">
        <For each={props.chain}>
          {entry => (
            <button
              class={["franchise-entry", { current: entry.current }]}
              disabled={entry.current || !props.onOpen || props.busy}
              onClick={() => props.onOpen?.(entry.id)}
              aria-current={entry.current ? "true" : undefined}
              aria-label={`${entry.title.display}${entry.seasonYear ? `, ${seasonLabel(entry.season, entry.seasonYear)}` : ""}${entry.current ? ", this one" : ""}`}
            >
              <div class="franchise-art">
                <Show when={entry.cover} fallback={<div class="skeleton" style={{ height: "100%" }} />}>
                  {cover => <img src={cover()} alt="" loading="lazy" decoding="async" />}
                </Show>
                <div class="corner">
                  <WatchBadge watch={entry.watch} />
                  <LibraryBadge library={entry.library ?? entry.movie} />
                </div>
              </div>
              <div class="franchise-title">{entry.title.display}</div>
              {/* Season or status only: at this width an episode count just clips. */}
              <div class="franchise-sub">
                {entry.seasonYear ? seasonLabel(entry.season, entry.seasonYear) : statusLabel(entry.status)}
              </div>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
