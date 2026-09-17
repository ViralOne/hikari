import { createMemo, createSignal, For, Loading, onSettled, Repeat, Show } from "solid-js";
import { getDiscover, getHidden, hideAnime, showAnime, type Anime, type HiddenTitle } from "../api";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { Rail, RailSkeleton } from "../components/Rail";
import { load, move, order, reconcile, save, toggle, type RowLayout } from "../rows";

const fetchDiscover = (_token: number) => getDiscover();

export function Discover(props: { token: number; onOpen: (id: number) => void; onChanged?: () => void }) {
  const data = createMemo(() => fetchDiscover(props.token));

  // "Not interested". The server drops hidden titles from the rows on the next load; this holds the
  // ones hidden since, so a card disappears on the click rather than after a refetch.
  const [justHidden, setJustHidden] = createSignal<Set<number>>(new Set());
  const [hiddenList, setHiddenList] = createSignal<HiddenTitle[] | null>(null);
  const [hideNote, setHideNote] = createSignal<string | null>(null);
  // null = not loaded yet or failed, so opening the editor tries again after a failure.
  const loadHidden = () =>
    getHidden()
      .then(result => setHiddenList(result.hidden))
      .catch(err => {
        setHiddenList(null);
        setHideNote(`Could not load the hidden titles: ${(err as Error).message}`);
      });

  const hide = async (anime: Anime) => {
    setJustHidden(prev => new Set(prev).add(anime.id));
    setHideNote(null);
    try {
      await hideAnime(anime.id, anime.title.display);
      // Cheap, and keeps the list in the open editor current instead of leaving it stale or blank.
      if (hiddenList() !== null) loadHidden();
    } catch (err) {
      setJustHidden(prev => {
        const next = new Set(prev);
        next.delete(anime.id);
        return next;
      });
      setHideNote(`Could not hide ${anime.title.display}: ${(err as Error).message}`);
    }
  };

  const unhide = async (entry: HiddenTitle) => {
    try {
      await showAnime(entry.id);
      setHiddenList(list => list?.filter(item => item.id !== entry.id) ?? null);
      setJustHidden(prev => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
      // The rows come from the server, so bringing a title back needs a refetch.
      props.onChanged?.();
    } catch (err) {
      setHideNote(`Could not bring back ${entry.title}: ${(err as Error).message}`);
    }
  };


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

  const rows = createMemo(() =>
    order(data().rows, layout()).map(row => ({ ...row, media: row.media.filter(item => !justHidden().has(item.id)) }))
  );
  const titleFor = (id: string) => data().rows.find(row => row.id === id)?.title ?? id;

  const pool = createMemo(() => {
    const airing = data().rows.find(row => row.id === "airing")?.media ?? [];
    return airing.filter(item => item.banner && !justHidden().has(item.id)).slice(0, 8);
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
            onClick={() => {
              const opening = !editing();
              setEditing(opening);
              if (opening && hiddenList() === null) loadHidden();
            }}
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

              {/* Titles hidden with the eye on a card. Kept on the server, so they stay hidden on every
                  device, and this is where they come back. */}
              <div class="rows-hidden">
                <p class="rows-hint">
                  Not interested: titles you have hidden from every row, the schedule and the Homepage widget.
                </p>
                <Show when={hiddenList()} fallback={<div class="hint">Loading…</div>}>
                  {list => (
                    <Show when={list().length > 0} fallback={<div class="hint dim">Nothing hidden. Hover a card and use the eye to hide a title.</div>}>
                      <For each={list()} keyed={entry => entry.id}>
                        {entry => (
                          <div class="rows-row">
                            <button
                              class="btn ghost tiny"
                              onClick={() => unhide(entry())}
                              aria-label={`Show ${entry().title || `#${entry().id}`} again`}
                              title="Show again"
                            >
                              <Icon name="eye" size={14} />
                            </button>
                            <span class="rows-name">{entry().title || `AniList #${entry().id}`}</span>
                          </div>
                        )}
                      </For>
                    </Show>
                  )}
                </Show>
              </div>
            </div>
          </div>
        </Show>

        <Show when={hideNote()}>{note => <div class="section"><div class="notice bad">{note()}</div></div>}</Show>

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
                onHide={hide}
              />
            </Show>
          )}
        </For>
      </Loading>
    </>
  );
}
