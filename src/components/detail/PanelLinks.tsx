import { Show } from "solid-js";
import type { AnimeDetail } from "../../api";
import { Icon } from "../Icon";
import type { DetailActions } from "./actions";

/** Where else this title exists, and the one place a hidden title can be brought back. */
export function PanelLinks(props: { anime: AnimeDetail; actions: DetailActions }) {
  const actions = () => props.actions;

  return (
    <div class="meta-row">
      <Show
        when={props.anime.links?.media}
        fallback={
          <Show when={props.anime.links?.search}>
            {url => (
              <a class="btn ghost tiny" href={url()} target="_blank" rel="noreferrer">
                <Icon name="external" size={14} />
                Find in Jellyseerr
              </a>
            )}
          </Show>
        }
      >
        {url => (
          <a class="btn ghost tiny" href={url()} target="_blank" rel="noreferrer">
            <Icon name="external" size={14} />
            Open in Jellyseerr
          </a>
        )}
      </Show>
      <a class="btn ghost tiny" href={props.anime.siteUrl} target="_blank" rel="noreferrer">
        AniList
      </a>
      <Show when={props.anime.malId}>
        {malId => (
          <a
            class="btn ghost tiny"
            href={`https://myanimelist.net/anime/${malId()}`}
            target="_blank"
            rel="noreferrer"
          >
            MyAnimeList
          </a>
        )}
      </Show>
      {/* "Not interested" from the panel too: the eye on the card is hover-only, and this is also the
          one place a hidden title can be found again (search still shows it). */}
      <button
        class={["btn ghost tiny", { active: props.anime.hidden }]}
        onClick={() => actions().toggleHidden(props.anime.id, props.anime.title.display, props.anime.hidden)}
        disabled={actions().busy()}
        aria-pressed={props.anime.hidden ? "true" : "false"}
        title={
          props.anime.hidden
            ? "Show in Discover and the schedule again"
            : "Hide from Discover, the schedule and the Homepage widget"
        }
      >
        <Icon name={props.anime.hidden ? "eye" : "eye-off"} size={14} />
        {props.anime.hidden ? "Hidden" : "Not interested"}
      </button>
    </div>
  );
}
