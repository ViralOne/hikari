import { createMemo, createSignal, For, Loading, onSettled, Repeat, Show } from "solid-js";
import { getActivity, TORRENT_PAGE_SIZES } from "../api";
import { bytes, eta, queueState, speed, torrentState } from "../format";
import { StateLabel } from "../components/StateLabel";
import { AnimeHealthSection } from "./AnimeHealth";
import { SonarrLabel } from "../components/SonarrLabel";

const fetchActivity = (_token: number, _tick: number, scope: "anime" | "all", page: number, size: number) =>
  getActivity(scope, page, size);

type Scope = "all" | "anime";
const SCOPE_KEY = "hikari:activity:scope";
// Anime is the default; "all" is only kept once someone picks it.
const storedScope = (): Scope => (localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "anime");

export function Activity(props: { token: number }) {
  // A live download dashboard that only refreshed on mount showed frozen numbers while the
  // server-side data turned over every 15s.
  const [tick, setTick] = createSignal(0);
  onSettled(() => {
    const timer = setInterval(() => setTick(value => value + 1), 15000);
    return () => clearInterval(timer);
  });

  // Anime-only is the default on an anime box; the choice is remembered.
  const [scope, setScope] = createSignal<Scope>(storedScope());
  // The server sends one page of torrents; a thousand rows are never fetched or drawn at once.
  const [page, setPage] = createSignal(1);
  const [pageSize, setPageSize] = createSignal<number>(TORRENT_PAGE_SIZES[0]);
  const pickScope = (next: Scope) => {
    setScope(next);
    setPage(1);
    localStorage.setItem(SCOPE_KEY, next);
  };
  const pickSize = (next: number) => {
    setPageSize(next);
    setPage(1);
  };

  const data = createMemo(() => fetchActivity(props.token, tick(), scope(), page(), pageSize()));
  const queue = createMemo(() =>
    scope() === "anime" ? data().queue.filter(item => item.seriesType === "anime") : data().queue
  );
  // Already scoped and paged by the server.
  const torrents = () => data().torrents;
  const paging = () => data().torrentPage;

  // Over the whole scoped list, not the visible page, so the numbers hold still while paging.
  const totals = createMemo(() => ({
    queue: queue().length,
    active: data().torrentStats.active,
    down: data().torrentStats.down,
    up: data().torrentStats.up,
    anime: data().torrentStats.anime
  }));

  return (
    <Loading
      fallback={
        <div class="section">
          <Repeat count={4}>
            {() => <div class="skeleton" style={{ height: "60px", "margin-bottom": "10px" }} />}
          </Repeat>
        </div>
      }
    >
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">Right now</h2>
          <div class="chips" role="group" aria-label="Show">
            <button class={["btn ghost tiny", { active: scope() === "anime" }]} aria-pressed={scope() === "anime" ? "true" : "false"} onClick={() => pickScope("anime")}>
              Anime
            </button>
            <button class={["btn ghost tiny", { active: scope() === "all" }]} aria-pressed={scope() === "all" ? "true" : "false"} onClick={() => pickScope("all")}>
              All
            </button>
          </div>
          <span class="section-note">
            {totals().queue} in Sonarr queue · {totals().active} downloading · ↓ {speed(totals().down)} · ↑{" "}
            {speed(totals().up)} · {totals().anime} anime torrents
          </span>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <h2 class="section-title">Sonarr queue</h2>
        </div>
        <Show when={data().errors.queue}>
          {error => <div class="notice bad">Sonarr unreachable: {error()}</div>}
        </Show>
        <Show
          when={queue().length > 0}
          fallback={
            <Show when={!data().errors.queue}>
              <div class="notice info">{scope() === "anime" ? "No anime in the Sonarr queue." : "Queue is empty. Nothing downloading or importing."}</div>
            </Show>
          }
        >
          <div class="box" style={{ padding: "14px 6px" }}>
            <table class="table">
              <thead>
                <tr>
                  <th>Series</th>
                  <th>Episode</th>
                  <th>Quality</th>
                  <th>State</th>
                  <th class="num">Left</th>
                </tr>
              </thead>
              <tbody>
                <For each={queue()}>
                  {item => (
                    <tr>
                      <td>
                        <div class="truncate">{item.series}</div>
                        <Show when={item.messages.length > 0}>
                          <div style={{ color: "var(--warn)", "font-size": "11px" }}>{item.messages[0]}</div>
                        </Show>
                      </td>
                      <td>{item.episode ?? "—"}</td>
                      <td>{item.quality ?? "—"}</td>
                      <td>
                        <StateLabel state={queueState(item.trackedStatus ?? item.status)} raw={item.trackedStatus ?? item.status} />
                      </td>
                      <td class="num">{bytes(item.sizeleft)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>

      <section class="section">
        <div class="section-head">
          <h2 class="section-title">Torrents</h2>
          <span class="section-note">{scope() === "anime" ? "anime only" : "anime library and anything currently active"}</span>
        </div>
        <Show when={data().errors.torrents}>
          {error => <div class="notice bad">qBittorrent unreachable: {error()}</div>}
        </Show>
        <Show
          when={torrents().length > 0}
          fallback={
            <Show when={!data().errors.torrents}>
              <div class="notice info">No matching torrents in qBittorrent.</div>
            </Show>
          }
        >
          <div class="box" style={{ padding: "14px 6px" }}>
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>State</th>
                  <th style={{ width: "110px" }}>Progress</th>
                  <th class="num">Size</th>
                  <th class="num">Ratio</th>
                  <th class="num">ETA</th>
                </tr>
              </thead>
              <tbody>
                <For each={torrents()}>
                  {torrent => (
                    <tr>
                      <td class="fill">
                        <div class="truncate" title={torrent.name}>
                          {torrent.name}
                        </div>
                        <div style={{ color: "var(--text-faint)", "font-size": "11px" }}>
                          {/* Anime is matched to its Sonarr series; anything else keeps the client's own labels. */}
                          <Show when={torrent.isAnime} fallback={torrent.category || "no category"}>
                            <SonarrLabel series={torrent.sonarr} fallback={torrent.category} />
                          </Show>
                          <Show when={torrent.tags.length > 0}> · qBittorrent: {torrent.tags.join(", ")}</Show>
                        </div>
                      </td>
                      <td>
                        <StateLabel state={torrentState(torrent.state)} raw={torrent.state} />
                      </td>
                      <td>
                        <div class="bar">
                          <span style={{ width: `${Math.round(torrent.progress * 100)}%` }} />
                        </div>
                      </td>
                      <td class="num">{bytes(torrent.size)}</td>
                      <td class="num">{torrent.ratio.toFixed(2)}</td>
                      <td class="num">{torrent.active ? eta(torrent.eta) : "—"}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>

      <Show when={paging().total > TORRENT_PAGE_SIZES[0]}>
        <div class="section pager" role="navigation" aria-label="Torrent pages">
          <button class="btn ghost tiny" disabled={paging().page <= 1} onClick={() => setPage(p => p - 1)}>
            ‹ Previous
          </button>
          <span class="dim">
            Page {paging().page} of {paging().pages} · {paging().total} torrents
          </span>
          <button class="btn ghost tiny" disabled={paging().page >= paging().pages} onClick={() => setPage(p => p + 1)}>
            Next ›
          </button>
          <span class="pager-sizes">
            <span class="dim">Show</span>
            <For each={TORRENT_PAGE_SIZES}>
              {size => (
                <button
                  class={["btn ghost tiny", { active: pageSize() === size }]}
                  aria-pressed={pageSize() === size ? "true" : "false"}
                  onClick={() => pickSize(size)}
                >
                  {size}
                </button>
              )}
            </For>
          </span>
        </div>
      </Show>

      <AnimeHealthSection token={props.token} />

      <section class="section">
        <div class="section-head">
          <h2 class="section-title">Recent Jellyseerr requests</h2>
        </div>
        <Show when={data().errors.requests}>
          {error => <div class="notice bad">Jellyseerr unreachable: {error()}</div>}
        </Show>
        <Show
          when={data().requests.length > 0}
          fallback={
            <Show when={!data().errors.requests}>
              <div class="notice info">No requests recorded yet.</div>
            </Show>
          }
        >
          <div class="box" style={{ padding: "14px 6px" }}>
            <table class="table">
              <thead>
                <tr>
                  <th>TMDB</th>
                  <th>Type</th>
                  <th>Seasons</th>
                  <th>Media status</th>
                  <th>By</th>
                  <th class="num">Added</th>
                </tr>
              </thead>
              <tbody>
                <For each={data().requests}>
                  {request => (
                    <tr>
                      <td>{request.tmdbId ?? "—"}</td>
                      <td>{request.mediaType}</td>
                      <td>{request.seasons.length > 0 ? request.seasons.join(", ") : "—"}</td>
                      <td>{request.mediaStatus}</td>
                      <td>{request.requestedBy ?? "—"}</td>
                      <td class="num">{new Date(request.createdAt).toLocaleDateString()}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>
    </Loading>
  );
}
