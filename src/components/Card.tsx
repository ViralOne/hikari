import { Show } from "solid-js";
import type { Anime } from "../api";
import { countdown, formatLabel, seasonLabel, statusLabel } from "../format";
import { LibraryBadge, ScoreBadge, WatchBadge, WatchBar } from "./Badges";
import { Icon } from "./Icon";

export function Card(props: { anime: Anime; onOpen: (id: number) => void; onHide?: (anime: Anime) => void }) {
  // Without an explicit label the accessible name is the concatenation of every badge and
  // hover-only line, e.g. "In library84%Studio BindTV · 14 epEp 12 in 5h 1mMushoku Tensei…".
  const label = () => {
    const parts = [props.anime.title.display, when()];
    if (props.anime.watch?.started) {
      parts.push(
        props.anime.watch.finished
          ? "watched"
          : `${props.anime.watch.played} of ${props.anime.watch.total ?? props.anime.watch.onDisk} episodes watched`
      );
    } else if (props.anime.library) {
      parts.push("in library");
    }
    if (props.anime.because) parts.push(`sequel to ${props.anime.because.title}`);
    return parts.join(", ");
  };

  // A card is about 110px wide, so the score goes first: it is short, it is the reason this is being
  // suggested, and putting it after the title meant it was always the part that got clipped. A score
  // of 0 means the entry was never rated, and saying "rated 0" would be a lie.
  const reason = () => {
    const because = props.anime.because;
    if (!because) return null;
    return because.score > 0 ? `${because.score} · ${because.title}` : because.title;
  };

  // Announced sequels often have no season set yet, and the placeholder for that was a bare dash.
  // The status is both true and useful in the same space.
  const when = () =>
    props.anime.season || props.anime.seasonYear
      ? seasonLabel(props.anime.season, props.anime.seasonYear)
      : statusLabel(props.anime.status);

  // The card used to be one <button>. A hide control cannot live inside a button, so the outer
  // element is now a plain wrapper and the whole clickable face is `.card-main`; the hide button is
  // its sibling, placed over the art's corner. Hover and focus styling keys off `.card`, so nothing
  // visual changed for cards without a hide handler.
  return (
    <div class="card">
      <button class="card-main" onClick={() => props.onOpen(props.anime.id)} aria-label={label()}>
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
          <div class="card-sub">{when()}</div>
          <Show when={props.anime.because}>
            {because => (
              <div class="card-because" title={`Sequel to ${because().title}`}>
                {reason()}
              </div>
            )}
          </Show>
        </div>
      </button>

      <Show when={props.onHide}>
        {onHide => (
          <button
            class="card-hide"
            onClick={event => {
              event.stopPropagation();
              onHide()(props.anime);
            }}
            aria-label={`Not interested in ${props.anime.title.display}`}
            title="Not interested"
          >
            <Icon name="eye-off" size={14} />
          </button>
        )}
      </Show>
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div class="card">
      <div class="card-main">
        <div class="skeleton skel-card" />
        <div class="skeleton" style={{ height: "12px", width: "80%" }} />
      </div>
    </div>
  );
}
