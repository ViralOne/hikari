import { createMemo, createSignal, For, Loading, Show } from "solid-js";
import {
  avdumpUnlinked,
  clearMissingTorrents,
  getAnimeHealth,
  runShokoAction,
  type AnimeHealth,
  type HealthIssue,
  type HealthTorrent
} from "../api";
import { bytes, torrentState } from "../format";
import { SonarrLabel } from "../components/SonarrLabel";

// A failed request (Hikari restarting, a lost session) becomes an empty report with the reason,
// instead of escaping to the app's error boundary and taking the whole Activity view with it.
const EMPTY: AnimeHealth = {
  torrents: [],
  unmanagedFolders: [],
  unlinked: [],
  unlinkedByShow: [],
  sonarrTags: 0,
  totals: { anime: 0, missingFiles: 0, orphans: 0, orphanBytes: 0, unmanaged: 0, unlinked: 0, unmanagedFolders: 0 },
  configured: { qbit: false, sonarr: false, shoko: false },
  error: null
};
const fetchHealth = (_token: number, _tick: number) =>
  getAnimeHealth().catch(err => ({ ...EMPTY, error: err instanceof Error ? err.message : String(err) }));

const ISSUE_NOTE: Record<HealthIssue, string> = {
  "missing-files":
    "qBittorrent cannot find these torrents' data, usually because it was deleted. Nothing removes them on its own. Clearing removes only the entry, never files. If your storage was offline, fix that first: the entries recover by themselves.",
  orphan:
    "Sonarr grabbed these, but the series is gone or has no files left. The torrent copy is usually a hardlink, so the space only comes back once the torrent is removed with its files (in qBittorrent).",
  unmanaged:
    "Anime torrents Sonarr never grabbed. Their files sit in folders Sonarr does not manage, so Maintainerr reports them handled and deletes nothing. Import the folder in Sonarr (Library Import) or remove them by hand."
};

/** What the cleanup tools miss, for anime: files Jellyfin never shows and torrents nothing removes. */
export function AnimeHealthSection(props: { token: number }) {
  // Refreshed after every action. No timer: this reads Sonarr's whole grab history, and the
  // numbers only move when something is cleaned up.
  const [tick, setTick] = createSignal(0);
  const data = createMemo(() => fetchHealth(props.token, tick()));
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<{ tone: "good" | "bad"; text: string } | null>(null);

  const byIssue = (issue: HealthIssue) => data().torrents.filter(torrent => torrent.issue === issue);

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: "good", text: await action() });
      setTick(value => value + 1);
    } catch (err) {
      setMessage({ tone: "bad", text: `${label} failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const clearMissing = () => {
    const list = byIssue("missing-files");
    if (!confirm(`Remove ${list.length} torrent entr${list.length === 1 ? "y" : "ies"} from qBittorrent?\n\nFiles are not touched. Only do this if the data was deleted, not if a drive or share is temporarily offline.`)) return;
    run("Clear", async () => {
      const result = await clearMissingTorrents(list.map(torrent => torrent.hash));
      return `Cleared ${result.cleared} torrent entr${result.cleared === 1 ? "y" : "ies"}${
        result.skipped ? ` (${result.skipped} recovered meanwhile, left alone)` : ""
      }.`;
    });
  };

  const avdump = () =>
    run("AVDump", async () => {
      const result = await avdumpUnlinked();
      return `Sent ${result.queued} file(s) to AniDB${result.skipped ? `, skipped ${result.skipped} no longer on disk` : ""}. Shoko matches them once AniDB has processed them, usually within hours.`;
    });

  const shokoAction = (action: "refresh-anidb" | "forget-deleted", label: string) =>
    run(label, async () => `${(await runShokoAction(action)).label} queued in Shoko.`);

  return (
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">Anime health</h2>
        <span class="section-note">what the cleanup tools miss</span>
      </div>
      <Loading fallback={<div class="skeleton" style={{ height: "120px" }} />}>
        <Show when={data().error}>{error => <div class="notice bad">Could not build the report: {error()}</div>}</Show>
        <Show when={data().configured.sonarr && data().sonarrTags === 0}>
          <div class="dim" style={{ "font-size": "12px" }}>
            Sonarr has no tags set up, so items are grouped by series without tags. Add tags in Sonarr (Settings → Tags,
            then on each series) and they show up here.
          </div>
        </Show>
        <Show when={message()}>{m => <div class={`notice ${m().tone === "good" ? "info" : "bad"}`}>{m().text}</div>}</Show>

        <Show
          when={
            data().totals.unlinked + data().totals.missingFiles + data().totals.orphans + data().totals.unmanaged +
              data().totals.unmanagedFolders >
            0
          }
          fallback={<div class="notice info">Nothing to clean up. Every anime file is visible and every torrent is accounted for.</div>}
        >
          <div class="health-stack">
          <Show when={data().totals.unlinked > 0}>
            <div class="box">
              <div class="box-head">
                <span class="box-title">Not in Jellyfin · {data().totals.unlinked} file(s)</span>
                <div class="chips">
                  <button class="btn tiny primary" disabled={busy()} onClick={avdump}>
                    Send to AniDB
                  </button>
                  <button class="btn ghost tiny" disabled={busy()} onClick={() => shokoAction("refresh-anidb", "Retry AniDB")}>
                    Retry AniDB
                  </button>
                  <button class="btn ghost tiny" disabled={busy()} onClick={() => shokoAction("forget-deleted", "Forget deleted")}>
                    Forget deleted files
                  </button>
                </div>
              </div>
              <div class="dim" style={{ "font-size": "12px" }}>
                Shoko hashed these but AniDB has no record of the release, so they never reach Jellyfin's anime library.
                "Send to AniDB" submits them with AVDump (needs the AVDump key in Shoko).
              </div>
              <table class="table">
                <tbody>
                  <For each={data().unlinkedByShow}>
                    {group => (
                      <tr>
                        <td>
                          <SonarrLabel series={group.series} fallback={group.show} />
                        </td>
                        <td class="num">{group.files} file(s)</td>
                        <td class="num">{bytes(group.size)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>

          <TorrentGroup
            title="Broken torrents"
            list={byIssue("missing-files")}
            note={ISSUE_NOTE["missing-files"]}
            action={
              <button class="btn tiny primary" disabled={busy()} onClick={clearMissing}>
                Clear entries
              </button>
            }
          />
          <TorrentGroup
            title={`Orphaned torrents · ${bytes(data().totals.orphanBytes)}`}
            list={byIssue("orphan")}
            note={ISSUE_NOTE.orphan}
          />
          <TorrentGroup title="Not managed by Sonarr" list={byIssue("unmanaged")} note={ISSUE_NOTE.unmanaged} />

          <Show when={data().unmanagedFolders.length > 0}>
            <div class="box">
              <div class="box-head">
                <span class="box-title">Folders Sonarr does not manage · {data().unmanagedFolders.length}</span>
              </div>
              <div class="dim" style={{ "font-size": "12px" }}>
                Anything in these folders is invisible to Sonarr and Maintainerr cleanup. Empty ones are leftovers from
                deletions and are safe to remove.
              </div>
              <div class="chips">
                <For each={data().unmanagedFolders}>{name => <span class="chip">{name}</span>}</For>
              </div>
            </div>
          </Show>
          </div>
        </Show>
      </Loading>
    </section>
  );
}

// One block per Sonarr series. Torrents Sonarr never grabbed and no Sonarr title matches are grouped
// by the release title the server parsed, under a "not in Sonarr" header.
function groupBySeries(list: HealthTorrent[]) {
  const groups = new Map<
    string,
    { series: HealthTorrent["series"]; outside: boolean; label: string; items: HealthTorrent[]; size: number }
  >();
  for (const torrent of list) {
    // A download Sonarr did not grab still groups under the series Sonarr has it as, flagged.
    const owner = torrent.series ?? torrent.seriesGuess;
    const outside = !torrent.series && Boolean(torrent.seriesGuess);
    const label = owner ? owner.title : torrent.releaseTitle;
    const key = owner ? `s:${owner.id}:${outside}` : `n:${label.toLowerCase()}`;
    const group = groups.get(key) || { series: owner, outside, label, items: [], size: 0 };
    group.items.push(torrent);
    group.size += torrent.size;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.size - a.size);
}

function TorrentGroup(props: { title: string; list: HealthTorrent[]; note: string; action?: unknown }) {
  return (
    <Show when={props.list.length > 0}>
      <div class="box">
        <div class="box-head">
          <span class="box-title">
            {props.title} · {props.list.length}
          </span>
          {props.action as never}
        </div>
        <div class="dim" style={{ "font-size": "12px" }}>
          {props.note}
        </div>
        <table class="table">
          <For each={groupBySeries(props.list)}>
            {group => (
              <tbody>
                <tr>
                  <th colspan={2} class="group-head">
                    <SonarrLabel series={group.series} fallback={group.label} outside={group.outside} />
                    <span class="dim">
                      {group.items.length} · {bytes(group.size)}
                    </span>
                  </th>
                </tr>
                <For each={group.items}>
                  {torrent => (
                    <tr>
                      <td class="fill">
                        <div class="truncate" title={torrent.name}>
                          {torrent.name}
                        </div>
                        <div style={{ color: "var(--text-faint)", "font-size": "11px" }}>
                          {torrent.category ?? "no category"} · {torrentState(torrent.state).label}
                        </div>
                      </td>
                      <td class="num">{bytes(torrent.size)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            )}
          </For>
        </table>
      </div>
    </Show>
  );
}
