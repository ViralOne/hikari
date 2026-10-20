import { createMemo, createSignal, For, isPending, Loading, onSettled, Show } from "solid-js";
import {
  addShokoSeries,
  applyLinks,
  getLinkPlan,
  searchAnidb,
  undoLink,
  type AnidbResult,
  type LinkPlan,
  type LinkPlanSeason,
  type LinkVia
} from "../api";
import { bytes } from "../format";
import { Icon } from "./Icon";

// Links the files auto-link would not decide on alone. Every row arrives with the guess the same
// rules make and the reason for it; nothing is written until Link is pressed, and a hand link made
// here can be undone from here.

type Override = { season: number | null; shokoId: number };
type Plan = LinkPlan & { error?: string };

const VIA_LABEL: Record<LinkVia, string> = {
  numbering: "numbering AniDB confirmed",
  "air date": "same air date",
  title: "same title"
};

const seasonLabel = (season: number | null) => (season == null ? "Unsorted files" : `Season ${season}`);
const episodeLabel = (episode: LinkPlanSeason["episodes"][number]) =>
  `AniDB ${episode.episode} · ${episode.title || "untitled"}${episode.airDate ? ` · ${episode.airDate}` : ""}`;

export function LinkDialog(props: { folder: string; title: string; onClose: () => void; onChanged: () => void }) {
  const [override, setOverride] = createSignal<Override | null>(null);
  const [tick, setTick] = createSignal(0);
  const plan = createMemo(() => {
    tick();
    return getLinkPlan(props.folder, override() ?? undefined).catch(
      err => ({ folder: props.folder, series: null, seasons: [], error: err instanceof Error ? err.message : String(err) }) as Plan
    ) as Promise<Plan>;
  });

  // What the person picked per file. A file missing from the map shows the server's guess; 0 means
  // they cleared it on purpose.
  const [choices, setChoices] = createSignal<Record<number, number>>({});
  const choiceFor = (file: LinkPlanSeason["files"][number]) => choices()[file.fileId] ?? file.guess?.shokoEpisodeId ?? 0;
  const choose = (fileId: number, episodeId: number) => setChoices(current => ({ ...current, [fileId]: episodeId }));

  const [busy, setBusy] = createSignal(false);
  // What is happening right now, in words, while busy. Adding a series asks AniDB and can take
  // most of a minute, which looked like nothing happening at all.
  const [working, setWorking] = createSignal<string | null>(null);
  const [message, setMessage] = createSignal<{ tone: "good" | "bad"; text: string } | null>(null);
  const [undoable, setUndoable] = createSignal<{ fileId: number; name: string }[]>([]);

  const [picking, setPicking] = createSignal<number | null | undefined>(undefined);
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<AnidbResult[] | null>(null);

  const pending = () =>
    plan().seasons.flatMap(season =>
      season.files.map(file => ({ fileId: file.fileId, shokoEpisodeId: choiceFor(file) })).filter(link => link.shokoEpisodeId > 0)
    );

  const run = async (action: () => Promise<void>, label: string | null = null) => {
    setBusy(true);
    setWorking(label);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setMessage({ tone: "bad", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setWorking(null);
    }
  };
  // The plan reloads after every change (a series picked, files linked). Until it lands the old
  // rows would sit there looking current, so they are swapped for a skeleton.
  const reloading = () => isPending(() => plan());

  const link = () =>
    run(async () => {
      const names = new Map(plan().seasons.flatMap(season => season.files.map(file => [file.fileId, file.name] as const)));
      const result = await applyLinks(pending());
      setUndoable(current => [...current, ...result.linked.map(item => ({ fileId: item.fileId, name: names.get(item.fileId) || `file ${item.fileId}` }))]);
      setChoices({});
      setMessage({
        tone: result.errors.length ? "bad" : "good",
        text:
          `Linked ${result.linked.length} file(s)${result.scanned ? ", Jellyfin is rescanning" : ""}.` +
          (result.errors.length ? ` ${result.errors.length} failed: ${result.errors.map(e => e.error).join("; ")}` : "")
      });
      setTick(value => value + 1);
      props.onChanged();
    }, `Linking ${pending().length} file(s) and asking Jellyfin to rescan…`);

  const undo = (fileId: number) =>
    run(async () => {
      await undoLink(fileId);
      setUndoable(current => current.filter(item => item.fileId !== fileId));
      setMessage({ tone: "good", text: "Link undone. The file is back in the list." });
      setTick(value => value + 1);
      props.onChanged();
    }, "Undoing the link…");

  const openPicker = (season: number | null) => {
    // Signal writes land on the next flush in Solid 2, so the first search gets the text directly
    // rather than reading it back from the signal it was just written to.
    // Sonarr's main title first, then its alternates: AniDB's list is mostly romaji, so the English
    // title alone often finds nothing.
    const titles = plan().series?.titles?.length ? plan().series!.titles : [props.title];
    setPicking(season);
    setQuery(titles[0]);
    setResults(null);
    void run(async () => {
      for (const title of titles) {
        const found = (await searchAnidb(title)).results;
        if (found.length > 0 || title === titles[titles.length - 1]) {
          setQuery(title);
          setResults(found);
          return;
        }
      }
    }, "Searching AniDB titles…");
  };

  // null until a search has run, so "no matches" is only said after one has.
  const search = (text = query()) =>
    run(async () => {
      if (text.trim().length < 2) return;
      setResults((await searchAnidb(text.trim())).results);
    }, "Searching AniDB titles…");

  const pick = (season: number | null, result: AnidbResult) =>
    run(async () => {
      let shokoId = result.shokoId;
      if (!shokoId) {
        shokoId = (await addShokoSeries(result.anidbId)).shokoId;
        if (!shokoId) {
          setMessage({ tone: "bad", text: `Shoko is still fetching ${result.title} from AniDB. Try picking it again in a minute.` });
          return;
        }
      }
      setPicking(undefined);
      setChoices({});
      setOverride({ season, shokoId });
    }, result.shokoId
      ? `Loading the episodes of ${result.title}…`
      : `Adding ${result.title} to Shoko and fetching its episodes from AniDB. This can take up to a minute…`);

  // Focus moves in on open and back out on close; Escape closes, like the details panel.
  let ref: HTMLElement | undefined;
  const opener = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  onSettled(() => {
    ref?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus?.();
    };
  });

  return (
    <>
      <div class="panel-scrim" onClick={() => props.onClose()} />
      <aside class="panel link-dialog" ref={element => (ref = element)} role="dialog" aria-modal="true" aria-label={`Link files for ${props.title}`} tabindex="-1">
        <button class="panel-close" onClick={() => props.onClose()} aria-label="Close">
          <Icon name="close" size={17} />
        </button>
        <div class="panel-body">
          <h2 class="section-title link-title">Link files · {props.title}</h2>
          <div class="dim link-intro">
            Shoko could not match these on AniDB, so Jellyfin cannot show them. Check each guess, change any that are wrong,
            then Link. Only Shoko's records change, never the files.
          </div>

          <Show when={working() || (reloading() && "Loading the episodes and guesses…")}>
            {text => (
              <div class="notice info link-working" role="status" aria-live="polite">
                <i class="spinner" />
                <span>{text()}</span>
              </div>
            )}
          </Show>
          <Show when={message()}>{m => <div class={`notice ${m().tone === "good" ? "info" : "bad"}`}>{m().text}</div>}</Show>

          <Loading fallback={<div class="skeleton" style={{ height: "160px" }} />}>
            <Show when={plan().error}>{error => <div class="notice bad">{error()}</div>}</Show>
            <Show when={!plan().error && plan().seasons.length === 0}>
              <div class="notice info">Nothing left to link here. Every file in this folder is visible in Jellyfin.</div>
            </Show>

            <Show when={reloading()}>
              <div class="box link-season" aria-hidden="true">
                <div class="skeleton" style={{ height: "22px", width: "40%" }} />
                <For each={[0, 1, 2]}>{() => <div class="skeleton" style={{ height: "44px" }} />}</For>
              </div>
            </Show>
            <For each={reloading() ? [] : plan().seasons}>
              {season => {
                const taken = (fileId: number) =>
                  new Set(season.files.filter(file => file.fileId !== fileId).map(choiceFor).filter(id => id > 0));
                return (
                  <div class="box link-season">
                    <div class="box-head">
                      <span class="box-title">{seasonLabel(season.seasonNumber)}</span>
                      <div class="label-row">
                        <Show
                          when={season.shoko}
                          fallback={<span class="badge pending">no Shoko series yet</span>}
                        >
                          {shoko => (
                            <span class="dim" title={shoko().anidbId ? `AniDB ${shoko().anidbId}` : undefined}>
                              {shoko().name}
                              {season.chosenBy === "you" ? " · picked by you" : ""}
                            </span>
                          )}
                        </Show>
                        <button class="btn ghost tiny" disabled={busy()} onClick={() => openPicker(season.seasonNumber)}>
                          {season.shoko ? "Change" : "Pick series"}
                        </button>
                      </div>
                    </div>

                    <Show when={picking() === season.seasonNumber}>
                      <div class="link-picker">
                        <form
                          class="label-row"
                          onSubmit={event => {
                            event.preventDefault();
                            void search();
                          }}
                        >
                          <input
                            class="field"
                            value={query()}
                            onInput={event => setQuery(event.currentTarget.value)}
                            placeholder="Search AniDB titles"
                            aria-label="Search AniDB titles"
                          />
                          <button class="btn tiny" type="submit" disabled={busy()}>
                            Search
                          </button>
                          <button class="btn ghost tiny" type="button" onClick={() => setPicking(undefined)}>
                            Cancel
                          </button>
                        </form>
                        <Show when={results()?.length === 0}>
                          <div class="dim link-meta">
                            No AniDB title matches. Try the Japanese title, or paste the AniDB id from the anime's AniDB page.
                          </div>
                        </Show>
                        <For each={results() ?? []}>
                          {result => (
                            <button class="link-result" disabled={busy()} onClick={() => pick(season.seasonNumber, result)}>
                              <span>{result.title}</span>
                              <span class="dim">
                                {[result.type !== "Unknown" ? result.type : null, result.airDate?.slice(0, 4), result.episodes ? `${result.episodes} eps` : null, `AniDB ${result.anidbId}`, result.shokoId ? "in Shoko" : "adds to Shoko"]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>

                    <table class="table">
                      <tbody>
                        <For each={season.files}>
                          {file => (
                            <tr>
                              <td class="fill">
                                <div class="truncate" title={file.name}>
                                  {file.sonarr ? `E${String(file.sonarr.episodeNumber).padStart(2, "0")} · ${file.sonarr.title || "untitled"}` : file.name}
                                </div>
                                <div class="link-meta">
                                  {file.sonarr?.airDate ? `Sonarr ${file.sonarr.airDate} · ` : ""}
                                  {bytes(file.size)}
                                </div>
                              </td>
                              <td class="link-choice">
                                <select
                                  class="field"
                                  disabled={busy() || !season.shoko}
                                  value={String(choiceFor(file))}
                                  onChange={event => choose(file.fileId, Number(event.currentTarget.value))}
                                  aria-label={`AniDB episode for ${file.name}`}
                                >
                                  <option value="0">Choose an episode…</option>
                                  <For each={season.episodes}>
                                    {episode => (
                                      <option
                                        value={String(episode.shokoEpisodeId)}
                                        disabled={episode.hasFile || taken(file.fileId).has(episode.shokoEpisodeId)}
                                      >
                                        {episodeLabel(episode)}
                                        {episode.hasFile ? " (has a file)" : ""}
                                      </option>
                                    )}
                                  </For>
                                </select>
                                <div class="link-meta">
                                  {file.guess && choiceFor(file) === file.guess.shokoEpisodeId
                                    ? `Guess: ${VIA_LABEL[file.guess.via]}`
                                    : choiceFor(file) > 0
                                      ? "Picked by you"
                                      : file.reason || "No guess"}
                                </div>
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                );
              }}
            </For>

            <div class="link-actions">
              <button class="btn ghost" onClick={() => props.onClose()}>
                Close
              </button>
              <button class="btn primary" disabled={busy() || pending().length === 0} onClick={link}>
                Link {pending().length} file{pending().length === 1 ? "" : "s"}
              </button>
            </div>
          </Loading>

          <Show when={undoable().length > 0}>
            <div class="box">
              <div class="box-head">
                <span class="box-title">Linked just now</span>
              </div>
              <For each={undoable()}>
                {item => (
                  <div class="label-row link-undo">
                    <span class="truncate" title={item.name}>
                      {item.name}
                    </span>
                    <button class="btn ghost tiny" disabled={busy()} onClick={() => undo(item.fileId)}>
                      Undo
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </aside>
    </>
  );
}
