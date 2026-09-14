import { createMemo, createSignal, For, Loading, onSettled, Repeat, Show } from "solid-js";
import { getDiscover } from "../api";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { Rail, RailSkeleton } from "../components/Rail";
import { load, move, order, reconcile, save, toggle, type RowLayout } from "../rows";

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

  const [saved, setSaved] = createSignal<unknown>(load());
  const [editing, setEditing] = createSignal(false);

  // Reconciled against what the server sent on every read, so a row added or removed server-side is
  // handled without the stored value needing a migration.
  const layout = createMemo(() =>
    reconcile(
      saved(),
      data().rows.map(row => row.id)
    )
  );

  const apply = (next: RowLayout) => {
    save(next);
    setSaved(next);
  };

  const rows = createMemo(() => order(data().rows, layout()));
  const titleFor = (id: string) => data().rows.find(row => row.id === id)?.title ?? id;

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
        <Show when={Object.keys(data().errors ?? {}).length > 0}>
          <div class="section">
            <div class="notice bad">
              Some services could not be reached, so library and progress badges may be missing:{" "}
              {Object.entries(data().errors ?? {})
                .map(([service, message]) => `${service} (${message})`)
                .join("; ")}
            </div>
          </div>
        </Show>

        <div class="section rows-bar">
          <button
            class={["btn ghost tiny", { active: editing() }]}
            onClick={() => setEditing(value => !value)}
            aria-expanded={editing() ? "true" : "false"}
          >
            <Icon name="layout" size={14} />
            {editing() ? "Done" : "Rows"}
          </button>
        </div>

        <Show when={editing()}>
          <div class="section">
            <div class="rows-editor">
              <p class="rows-hint">Hide what you do not use, and put what you do at the top. Kept in this browser.</p>
              <For each={layout()} keyed={entry => entry.id}>
                {entry => (
                  <div class={["rows-row", { off: !entry().visible }]}>
                    <button
                      class="btn ghost tiny"
                      onClick={() => apply(toggle(layout(), entry().id))}
                      aria-label={`${entry().visible ? "Hide" : "Show"} ${titleFor(entry().id)}`}
                      title={entry().visible ? "Hide this row" : "Show this row"}
                    >
                      <Icon name={entry().visible ? "eye" : "eye-off"} size={14} />
                    </button>
                    <span class="rows-name">{titleFor(entry().id)}</span>
                    <button
                      class="btn ghost tiny"
                      onClick={() => apply(move(layout(), entry().id, -1))}
                      disabled={layout()[0]?.id === entry().id}
                      aria-label={`Move ${titleFor(entry().id)} up`}
                    >
                      <Icon name="up" size={14} />
                    </button>
                    <button
                      class="btn ghost tiny"
                      onClick={() => apply(move(layout(), entry().id, 1))}
                      disabled={layout()[layout().length - 1]?.id === entry().id}
                      aria-label={`Move ${titleFor(entry().id)} down`}
                    >
                      <Icon name="down" size={14} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Every row hidden is a legitimate choice, but a blank page looks like a failure. */}
        <Show when={rows().length === 0}>
          <div class="section">
            <div class="notice">Every row is hidden. Use Rows above to bring one back.</div>
          </div>
        </Show>

        <For each={rows()}>
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
