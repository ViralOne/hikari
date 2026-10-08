import { For, Show } from "solid-js";
import type { AnimeDetail } from "../../api";
import { formatLabel, seasonLabel, statusLabel } from "../../format";

/** Cover, titles, and the facts that need no integration to be true. */
export function PanelHeader(props: { anime: AnimeDetail }) {
  return (
    <>
      <div class="panel-top">
        <div class="panel-cover">
          <Show when={props.anime.cover}>{cover => <img src={cover()} alt="" />}</Show>
        </div>
        <div>
          <h2 class="panel-title">{props.anime.title.display}</h2>
          <Show when={props.anime.title.romaji && props.anime.title.romaji !== props.anime.title.display}>
            <div class="panel-alt">{props.anime.title.romaji}</div>
          </Show>
        </div>
      </div>

      <div class="meta-row meta-dotted">
        <span>{seasonLabel(props.anime.season, props.anime.seasonYear)}</span>
        <span>{formatLabel(props.anime.format)}</span>
        <span>{statusLabel(props.anime.status)}</span>
        <Show when={props.anime.episodes}>{count => <span>{count()} ep</span>}</Show>
        <Show when={props.anime.score}>{score => <span>{score()}%</span>}</Show>
      </div>

      <div class="chips">
        <For each={props.anime.genres}>{genre => <span class="chip">{genre}</span>}</For>
      </div>

      <Show when={props.anime.synopsis}>{synopsis => <p class="synopsis">{synopsis()}</p>}</Show>
    </>
  );
}
