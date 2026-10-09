import { For, Show } from "solid-js";
import type { SonarrRef } from "../api";

/**
 * Who owns a torrent or file in Sonarr. One layout everywhere: the title first, then the badges
 * (ownership problem, then the series' Sonarr tags), with a fixed gap between them.
 *
 * "Not in Sonarr" is shown on purpose instead of nothing: those are exactly the items Sonarr and
 * Maintainerr never clean up. "Grabbed outside Sonarr" means Sonarr has the show, but not this
 * particular download.
 */
export function SonarrLabel(props: { series: SonarrRef | null; fallback?: string | null; outside?: boolean }) {
  const title = () => props.series?.title ?? props.fallback ?? "";
  return (
    <span class="label-row">
      <Show when={title()}>
        <span class="label-title">{title()}</span>
      </Show>
      <Show when={!props.series}>
        <span class="badge pending" title="Sonarr has no series for this, so neither Sonarr nor Maintainerr will clean it up">
          not in Sonarr
        </span>
      </Show>
      <Show when={props.series && props.outside}>
        <span class="badge pending" title="Sonarr has this show, but this download was added outside Sonarr, so Sonarr will not clean it up">
          grabbed outside Sonarr
        </span>
      </Show>
      <For each={props.series?.tags ?? []}>{tag => <span class="badge">{tag}</span>}</For>
    </span>
  );
}
