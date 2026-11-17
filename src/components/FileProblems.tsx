import { createMemo, createSignal, For, Loading, Show } from "solid-js";
import { getFileProblems, remapFiles, removeExtraCopy, replaceEpisodes, replaceWrongEpisode, undoLink, type FileProblems } from "../api";
import { bytes } from "../format";

// Second copies in series folders and files nobody can follow. Loaded on its own, after the rest of
// the health report, because it reads every anime series' episode list from Sonarr.

const EMPTY: FileProblems & { error?: string } = { extraCopies: [], misplaced: [], wrongEpisode: [], suspiciousLinks: [], untracked: [], unwatchable: [], wanted: [] };

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
    if (!confirm(`Delete ${what} from disk?\n\n${copy.name}\n\n$Sonarr keeps: ${copy.kept?.name}`)) return;
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

      <Show when={!data().error && data().extraCopies.length === 0 && data().misplaced.length === 0 && data().wrongEpisode.length === 0 && data().suspiciousLinks.length === 0 && data().untracked.length === 0 && data().unwatchable.length === 0}>
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
                      <div class="link-meta truncate">Sonarr keeps: {copy.kept?.name} · {bytes(copy.kept?.size ?? 0)}</div>
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

      <Show when={data().misplaced.length > 0}>
        <div class="box">
          <div class="box-head">
            <span class="box-title">Episodes that moved · {data().misplaced.length}</span>
            <button class="btn tiny primary" disabled={busy()} onClick={() => run(async () => {
              const result = await remapFiles(data().misplaced.map(move => ({ path: move.path, toEpisodeId: move.toEpisodeId })));
              return `Moved ${result.moved} file(s) to the episodes their titles name. Sonarr renamed them; Jellyfin is rescanning.`;
            })}>
              Apply all moves
            </button>
          </div>
          <div class="dim" style={{ "font-size": "12px" }}>
            TVDB renumbered these: each file's title names another, still empty episode of the same series. Applying re-maps and
            renames them in Sonarr. Nothing is deleted.
          </div>
          <table class="table">
            <tbody>
              <For each={data().misplaced}>
                {move => (
                  <tr>
                    <td class="fill">
                      <div class="truncate">
                        {move.series.title} · "{move.title}": {move.from ?? "not tracked"} → {move.to}
                      </div>
                      <div class="link-meta truncate" title={move.path}>{move.path.split("/").pop()}</div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Show when={data().wrongEpisode.length > 0}>
        <div class="box">
          <div class="box-head">
            <span class="box-title">Wrong episode imported · {data().wrongEpisode.length}</span>
          </div>
          <div class="dim" style={{ "font-size": "12px" }}>
            The file's title matches no episode of the series, so it is something else under this episode's number, often a
            spin-off or recap. Replace blocklists that release, moves the file to Sonarr's recycle bin and searches again.
          </div>
          <table class="table">
            <tbody>
              <For each={data().wrongEpisode}>
                {item => (
                  <tr>
                    <td class="fill">
                      <div class="truncate">
                        {item.series.title} · {item.episode} should be "{item.sonarrTitle}", file is "{item.fileTitle}"
                      </div>
                      <div class="link-meta truncate" title={item.release}>{item.release}</div>
                    </td>
                    <td class="num">
                      <button class="btn tiny" disabled={busy()} onClick={() => {
                        if (!confirm(`Replace ${item.series.title} ${item.episode}?\n\nThe file "${item.fileTitle}" goes to Sonarr's recycle bin and the release is blocklisted.`)) return;
                        run(async () => { await replaceWrongEpisode(item.episodeId); return `Replacing ${item.series.title} ${item.episode}; Sonarr is searching.`; });
                      }}>
                        Replace
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Show when={data().suspiciousLinks.length > 0}>
        <div class="box">
          <div class="box-head">
            <span class="box-title">Links that look wrong · {data().suspiciousLinks.length}</span>
          </div>
          <div class="dim" style={{ "font-size": "12px" }}>
            Linked by hand to a different AniDB episode than Sonarr's number, while the AniDB episode with that number is
            still empty. Usually the air dates were shifted. Undo puts the file back under "Not in Jellyfin", where Link…
            suggests the matching number.
          </div>
          <table class="table">
            <tbody>
              <For each={data().suspiciousLinks}>
                {link => (
                  <tr>
                    <td class="fill">
                      <div class="truncate">
                        {link.series.title} · {link.episode}: linked to AniDB {link.linkedTo}, expected {link.expected}
                      </div>
                      <div class="link-meta truncate" title={link.name}>{link.name}</div>
                    </td>
                    <td class="num">
                      <button class="btn tiny" disabled={busy()} onClick={() => run(async () => { await undoLink(link.fileId); return `Link undone for ${link.series.title} ${link.episode}. Relink it from Not in Jellyfin.`; })}>
                        Undo link
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Show when={data().untracked.length > 0}>
        <div class="box">
          <div class="box-head">
            <span class="box-title">Sonarr lost track of these · {data().untracked.length}</span>
          </div>
          <div class="dim" style={{ "font-size": "12px" }}>
            Files in a series folder that Sonarr has no record of, and no other copy of the episode. Usually TVDB renumbered
            the season and Sonarr dropped the old episodes. They are the only copies, so nothing here deletes them: open the
            series in Sonarr, Manual Import, and match them to the new episodes.
          </div>
          <table class="table">
            <tbody>
              <For each={data().untracked}>
                {file => (
                  <tr>
                    <td class="fill">
                      <div class="truncate">
                        {file.series.title} {file.episode ? `· ${file.episode}` : ""}
                      </div>
                      <div class="link-meta truncate" title={file.name}>
                        {file.name} · {bytes(file.size)}
                      </div>
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
