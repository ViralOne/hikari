import { createMemo, createSignal, For, Loading, onSettled, Repeat, Show } from "solid-js";
import { getDiscover } from "../api";
import { Hero } from "../components/Hero";
import { Rail, RailSkeleton } from "../components/Rail";

const fetchDiscover = (_token: number) => getDiscover();

export function Discover(props: { token: number; onOpen: (id: number) => void }) {
  const data = createMemo(() => fetchDiscover(props.token));

  // Ticks every 30s so the hero actually rotates. Reading Date.now() inside the memo instead
  // made it non-reactive (it never rotated) and non-deterministic (any revalidation jumped it).
  const [slot, setSlot] = createSignal(0);
  onSettled(() => {
    const timer = setInterval(() => setSlot(value => value + 1), 30000);
    return () => clearInterval(timer);
  });

  const pool = createMemo(() => {
    const airing = data().rows.find(row => row.id === "airing")?.media ?? [];
    return airing.filter(item => item.banner).slice(0, 8);
  });

  const spotlight = createMemo(() => {
    const options = pool();
    return options.length === 0 ? null : options[slot() % options.length];
  });

  return (
    <>
      {/* Hero and rails get their own boundaries so one slow row cannot hold the page hostage. */}
      <Loading fallback={<div class="skeleton" style={{ height: "380px", "border-radius": "0" }} />}>
        <Show when={spotlight()}>
          {anime => <Hero anime={anime()} eyebrow="Airing now" onOpen={props.onOpen} />}
        </Show>
      </Loading>

      <Loading
        fallback={
          <Repeat count={3}>{() => <RailSkeleton />}</Repeat>
        }
      >
        <For each={data().rows}>
          {row => (
            <Show when={row.media.length > 0}>
              <Rail
                title={row.title}
                note={`${row.media.filter(item => item.library).length} in library`}
                media={row.media}
                onOpen={props.onOpen}
              />
            </Show>
          )}
        </For>
      </Loading>
    </>
  );
}
