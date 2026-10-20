import { createMemo, createSignal, For, Loading, Show } from "solid-js";
import { getFileProblems, removeExtraCopy, replaceEpisodes, type FileProblems } from "../api";
import { bytes } from "../format";

// Second copies in series folders and files nobody can follow. Loaded on its own, after the rest of
// the health report, because it reads every anime series' episode list from Sonarr.

const EMPTY: FileProblems & { error?: string } = { extraCopies: [], unwatchable: [], wanted: [] };

export function FileProblemsBoxes(props: { token: number }) {
  const [tick, setTick] = createSignal(0);
  const data = createMemo(() => {
    tick();
    props.token;
    return getFileProblems().catch(
      err => ({ ...EMPTY, error: err instanceof Error ? err.message : String(err) })
    ) as Promise<FileProblems & { error?: string }>;
  });
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<{ tone: "good" | "bad"; text: string } | null>(null);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: "good", text: await action() });
      setTick(value => value + 1);
    } catch (err) {
      setMessage({ tone: "bad", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = (copy: FileProblems["extraCopies"][number]) => {
    const what = copy.torrent ? "the file and its torrent" : "the file";
    if (!confirm(`Delete ${what} from disk?\n\n${copy.name}\n\n${copy.kept ? `Sonarr keeps: ${copy.kept.name}` : "Sonarr has no other file for this episode."}`)) return;
    run(async () => {
      const result = await removeExtraCopy(copy.fileId);
      return `Removed ${result.removed}${result.torrent ? " and its torrent" : ""}.`;
    });
  };

  const replace = (episodeIds: number[]) =>
    run(async () => {
      const result = await replaceEpisodes(episodeIds);
      return `Asked Sonarr to look for ${result.searched} better release(s). It grabs one only if it scores higher than the file it has; check the queue in a few minutes.`;
    });

  return (
    <Loading fallback={<div class="skeleton" style={{ height: "60px" }} />}>
      <Show when={message()}>{m => <div class={`notice ${m().tone === "good" ? "info" : "bad"}`}>{m().text}</div>}</Show>
      <Show when={data().error}>{error => <div class="notice bad">Could not check the files: {error()}</div>}</Show>

      <Show when={!data().error && data().extraCopies.length === 0 && data().unwatchable.length === 0}>
        <div class="dim" style={{ "font-size": "12px" }}>
          Files: every episode has one copy, with {data().wanted.join("/") || "wanted"} subtitles or audio.
        </div>
      </Show>
      <Show when={data().extraCopies.length > 0}>
        <div class="box">
          <div class="box-head">
            <span class="box-title">Extra copies · {data().extraCopies.length}</span>
          </div>
          <div class="dim" style={{ "font-size": "12px" }}>
            A second file for an episode, in a series folder, that Sonarr does not track. Nothing ever removes these, and
            Jellyfin may play the wrong one. Usually a torrent was added by hand with the library as its save path.
          </div>
          <table class="table">
            <tbody>
              <For each={data().extraCopies}>
                {copy => (
                  <tr>
                    <td class="fill">
                      <div class="truncate" title={copy.name}>
                        {copy.series.title} {copy.episode ? `· ${copy.episode}` : ""}
                      </div>
                      <div class="link-meta truncate" title={copy.name}>
                        Extra: {copy.name} · {bytes(copy.size)}
                        {copy.torrent ? ` · torrent in ${copy.torrent.category ?? "no category"}` : ""}
                      </div>
                      <div class="link-meta truncate">
                        {copy.kept ? `Sonarr keeps: ${copy.kept.name} · ${bytes(copy.kept.size)}` : "Sonarr has no file for this episode"}
                      </div>
                    </td>
                    <td class="num">
                      <button class="btn tiny" disabled={busy()} onClick={() => remove(copy)}>
                        Remove copy
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Show when={data().unwatchable.length > 0}>
        <div class="box">
          <div class="box-head">
            <span class="box-title">
              No {data().wanted.join("/")} subtitles or audio · {data().unwatchable.length}
            </span>
            <button class="btn tiny primary" disabled={busy()} onClick={() => replace(data().unwatchable.map(item => item.episodeId))}>
              Find better releases
            </button>
          </div>
          <div class="dim" style={{ "font-size": "12px" }}>
            Sonarr's media scan found no subtitle or audio track in a language you watch in. Release names often promise
            "Multi-Subs" that are not there. Sonarr replaces these only if its profile scores such releases down (see
            docs/anime-sonarr.md).
          </div>
          <table class="table">
            <tbody>
              <For each={data().unwatchable}>
                {item => (
                  <tr>
                    <td class="fill">
                      <div class="truncate">
                        {item.series.title} · {item.episode}
                      </div>
                      <div class="link-meta truncate" title={item.release ?? item.name}>
                        subtitles: {item.subtitles || "none"} · audio: {item.audio || "unknown"} · {item.release ?? item.name}
                      </div>
                    </td>
                    <td class="num">
                      <button class="btn ghost tiny" disabled={busy()} onClick={() => replace([item.episodeId])}>
                        Find better
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Loading>
  );
}
