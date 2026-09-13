import { Show } from "solid-js";
import type { Anime } from "../api";
import { countdown, formatLabel, seasonLabel, statusLabel } from "../format";

export function Hero(props: { anime: Anime; eyebrow: string; onOpen: (id: number) => void }) {
  return (
    <header class="hero">
      <div
        class="hero-bg"
        style={{ "background-image": `url(${props.anime.banner || props.anime.cover || ""})` }}
      />
      <div class="hero-veil" />

      <div class="hero-body">
        <span class="hero-eyebrow">{props.eyebrow}</span>
        <h1 class="hero-title">{props.anime.title.display}</h1>

        {/* meta-dotted draws the separators with ::before so they stay attached to their own
            item. Standalone separator elements were left dangling at the end of a wrapped line,
            which happens on every narrow viewport. */}
        <div class="meta-row meta-dotted">
          <span>{seasonLabel(props.anime.season, props.anime.seasonYear)}</span>
          <span>{formatLabel(props.anime.format)}</span>
          <span>{statusLabel(props.anime.status)}</span>
          <Show when={props.anime.episodes}>{count => <span>{count()} episodes</span>}</Show>
          <Show when={props.anime.studio}>{studio => <span>{studio()}</span>}</Show>
        </div>

        <Show when={props.anime.synopsis}>
          {synopsis => <p class="hero-synopsis">{synopsis()}</p>}
        </Show>

        <div class="meta-row" style={{ gap: "10px", "margin-top": "4px" }}>
          <button class="btn primary" onClick={() => props.onOpen(props.anime.id)}>
            View &amp; request
          </button>
          <Show when={props.anime.nextEpisode}>
            {next => (
              <span class={["badge", "airing"]}>
                Ep {next().episode} in {countdown(next().timeUntil)}
              </span>
            )}
          </Show>
        </div>
      </div>
    </header>
  );
}
