import { Show } from "solid-js";
import type { LibraryMatch, Watch } from "../api";

export function WatchBadge(props: { watch: Watch | null | undefined }) {
  return (
    <Show when={props.watch?.started ? props.watch : null}>
      {watch => (
        <Show
          when={!watch().finished}
          fallback={<span class={["badge", "seen"]}>Watched</span>}
        >
          <span class={["badge", "watching"]}>
            {watch().played}/{(watch().scoped ? watch().total : null) ?? watch().onDisk}
          </span>
        </Show>
      )}
    </Show>
  );
}

export function WatchBar(props: { watch: Watch | null | undefined }) {
  return (
    <Show when={props.watch?.started && !props.watch?.finished ? props.watch : null}>
      {watch => (
        <div
          class="card-progress"
          title={`${watch().played} of ${(watch().scoped ? watch().total : null) ?? watch().onDisk} episodes watched`}
        >
          <span
            style={{
              width: `${Math.min(
                Math.round(
                  (watch().played /
                    Math.max((watch().scoped ? watch().total : null) ?? watch().onDisk, 1)) *
                    100
                ),
                100
              )}%`
            }}
          />
        </div>
      )}
    </Show>
  );
}

export function LibraryBadge(props: { library: LibraryMatch | null | undefined }) {
  return (
    <Show when={props.library}>
      {library => (
        <Show
          when={!library().complete}
          fallback={<span class={["badge", "owned"]}>In library</span>}
        >
          <Show
            when={library().episodeFileCount > 0}
            fallback={<span class={["badge", "pending"]}>Waiting</span>}
          >
            <span class={["badge", "partial"]}>
              {library().episodeFileCount}/{library().episodeCount} eps
            </span>
          </Show>
        </Show>
      )}
    </Show>
  );
}

export function ScoreBadge(props: { score: number | null }) {
  return (
    <Show when={props.score}>
      {score => <span class={["badge", "score"]}>{score()}%</span>}
    </Show>
  );
}
