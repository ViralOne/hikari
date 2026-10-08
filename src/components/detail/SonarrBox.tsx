import { Show } from "solid-js";
import type { AnimeDetail } from "../../api";
import { bytes } from "../../format";
import type { DetailActions } from "./actions";

export function SonarrBox(props: { anime: AnimeDetail; actions: DetailActions }) {
  return (
    <Show
      when={props.anime.library}
      fallback={
        <div class="box">
          <div class="box-title">Sonarr</div>
          <div class="notice info">Not in your library yet.</div>
        </div>
      }
    >
      {library => (
        <div class="box">
          <div class="box-head">
            <span class="box-title">Sonarr</span>
            <span
              class={[
                "badge",
                library().complete ? "owned" : library().episodeFileCount > 0 ? "partial" : "pending"
              ]}
            >
              {library().episodeFileCount}/{library().episodeCount} episodes
            </span>
          </div>
          <dl class="kv">
            <dt>Series</dt>
            <dd>{library().title}</dd>
          </dl>
          <dl class="kv">
            <dt>Path</dt>
            <dd>{library().path}</dd>
          </dl>
          <dl class="kv">
            <dt>Type / monitored</dt>
            <dd>
              {library().seriesType} · {library().monitored ? "yes" : "no"}
            </dd>
          </dl>
          <dl class="kv">
            <dt>Matched by</dt>
            <dd>
              {library().via === "shoko:tvdb"
                ? "TvDB id via Shoko (exact)"
                : `title, ${Math.round(library().confidence * 100)}% similar`}
            </dd>
          </dl>

          <Show when={library().seriesType !== "anime" && props.anime.format !== "MOVIE"}>
            <div class="notice bad">
              Sonarr has this as <strong>{library().seriesType}</strong>. Anime releases use absolute
              episode numbering, so imports will mismatch until this is <strong>anime</strong>.
            </div>
            <button
              class="btn"
              disabled={props.actions.busy()}
              onClick={() => props.actions.fixSeriesType(library().id)}
            >
              <Show when={props.actions.busy()}>
                <i class="spinner" />
              </Show>
              Set series type to anime
            </button>
          </Show>
          <dl class="kv">
            <dt>On disk</dt>
            <dd>{bytes(library().sizeOnDisk)}</dd>
          </dl>
        </div>
      )}
    </Show>
  );
}
