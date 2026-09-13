import { Show } from "solid-js";
import type { Anime } from "../api";
import { countdown, formatLabel, seasonLabel } from "../format";
import { LibraryBadge, ScoreBadge, WatchBadge, WatchBar } from "./Badges";

export function Card(props: { anime: Anime; onOpen: (id: number) => void }) {
  // Without an explicit label the accessible name is the concatenation of every badge and
  // hover-only line, e.g. "In library84%Studio BindTV · 14 epEp 12 in 5h 1mMushoku Tensei…".
  const label = () => {
    const parts = [props.anime.title.display, seasonLabel(props.anime.season, props.anime.seasonYear)];
    if (props.anime.watch?.started) {
      parts.push(
        props.anime.watch.finished
          ? "watched"
          : `${props.anime.watch.played} of ${props.anime.watch.total ?? props.anime.watch.onDisk} episodes watched`
      );
    } else if (props.anime.library) {
      parts.push("in library");
    }
    return parts.join(", ");
  };

  return (
    <button class="card" onClick={() => props.onOpen(props.anime.id)} aria-label={label()}>
      <div class="card-art" aria-hidden="true">
        <Show when={props.anime.cover} fallback={<div class="skeleton" style={{ height: "100%" }} />}>
          {cover => <img src={cover()} alt="" loading="lazy" decoding="async" />}
        </Show>

        <div class="corner">
          <WatchBadge watch={props.anime.watch} />
          <LibraryBadge library={props.anime.library} />
          <ScoreBadge score={props.anime.score} />
        </div>

        <WatchBar watch={props.anime.watch} />

        <div class="scrim">
          <div class="card-hover-meta">
            <Show when={props.anime.studio}>{studio => <div>{studio()}</div>}</Show>
            <div>
              {formatLabel(props.anime.format)}
              <Show when={props.anime.episodes}>{count => <> · {count()} ep</>}</Show>
            </div>
            <Show when={props.anime.nextEpisode}>
              {next => (
                <div>
                  Ep {next().episode} in {countdown(next().timeUntil)}
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>

      <div aria-hidden="true">
        <div class="card-title">{props.anime.title.display}</div>
        <div class="card-sub">{seasonLabel(props.anime.season, props.anime.seasonYear)}</div>
      </div>
    </button>
  );
}

export function CardSkeleton() {
  return (
    <div class="card">
      <div class="skeleton skel-card" />
      <div class="skeleton" style={{ height: "12px", width: "80%" }} />
    </div>
  );
}
