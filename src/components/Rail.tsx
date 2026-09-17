import { For, Repeat, Show } from "solid-js";
import type { Anime } from "../api";
import { Card, CardSkeleton } from "./Card";

export function Rail(props: {
  title: string;
  note?: string;
  media: Anime[];
  onOpen: (id: number) => void;
  onHide?: (anime: Anime) => void;
}) {
  return (
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">{props.title}</h2>
        <Show when={props.note}>{note => <span class="section-note">{note()}</span>}</Show>
      </div>
      <div class="rail">
        <For each={props.media}>{item => <Card anime={item} onOpen={props.onOpen} onHide={props.onHide} />}</For>
      </div>
    </section>
  );
}

export function RailSkeleton(props: { count?: number }) {
  return (
    <section class="section">
      <div class="section-head">
        <div class="skeleton" style={{ height: "17px", width: "180px" }} />
      </div>
      <div class="rail">
        <Repeat count={props.count ?? 8}>{() => <CardSkeleton />}</Repeat>
      </div>
    </section>
  );
}
