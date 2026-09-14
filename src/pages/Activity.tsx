import { createMemo, createSignal, For, Loading, onSettled, Repeat, Show } from "solid-js";
import { getActivity } from "../api";
import { bytes, eta, speed } from "../format";

const fetchActivity = (_token: number, _tick: number) => getActivity();

export function Activity(props: { token: number }) {
  // A live download dashboard that only refreshed on mount showed frozen numbers while the
  // server-side data turned over every 15s.
  const [tick, setTick] = createSignal(0);
  onSettled(() => {
    const timer = setInterval(() => setTick(value => value + 1), 15000);
    return () => clearInterval(timer);
  });

  const data = createMemo(() => fetchActivity(props.token, tick()));

  const totals = createMemo(() => {
    const current = data();
    const active = current.torrents.filter(torrent => torrent.active);
    return {
      queue: current.queue.length,
      active: active.length,
      down: active.reduce((sum, torrent) => sum + torrent.dlspeed, 0),
      up: current.torrents.reduce((sum, torrent) => sum + torrent.upspeed, 0),
      anime: current.torrents.filter(torrent => torrent.isAnime).length
    };
  });

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
          when={data().queue.length > 0}
          fallback={
            <Show when={!data().errors.queue}>
              <div class="notice info">Queue is empty. Nothing downloading or importing.</div>
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
                <For each={data().queue}>
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
                      <td>{item.trackedStatus ?? item.status}</td>
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
          <span class="section-note">anime library and anything currently active</span>
        </div>
        <Show when={data().errors.torrents}>
          {error => <div class="notice bad">qBittorrent unreachable: {error()}</div>}
        </Show>
        <Show
          when={data().torrents.length > 0}
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
                <For each={data().torrents}>
                  {torrent => (
                    <tr>
                      <td>
                        <div class="truncate">{torrent.name}</div>
                        <div style={{ color: "var(--text-faint)", "font-size": "11px" }}>
                          {torrent.category || "no category"}
                          <Show when={torrent.tags.length > 0}> · {torrent.tags.join(", ")}</Show>
                        </div>
                      </td>
                      <td>{torrent.state}</td>
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
