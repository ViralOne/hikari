import { Show } from "solid-js";
import type { Anime } from "../api";
import { countdown, formatLabel, seasonLabel } from "../format";
import { LibraryBadge, ScoreBadge, WatchBadge, WatchBar } from "./Badges";

export function Card(props: { anime: Anime; onOpen: (id: number) => void }) {
  return (
    <button class="card" onClick={() => props.onOpen(props.anime.id)}>
      <div class="card-art">
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

      <div>
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
