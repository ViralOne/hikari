import { createMemo, createSignal, Errored, For, Loading, Match, onSettled, Show, Switch } from "solid-js";
import { getHealth } from "./api";
import { Detail } from "./components/Detail";
import { Icon } from "./components/Icon";
import { Activity } from "./pages/Activity";
import { Discover } from "./pages/Discover";
import { Schedule } from "./pages/Schedule";
import { Search } from "./pages/Search";

type View = "discover" | "schedule" | "search" | "activity";

const VIEWS: Array<{ id: View; label: string; icon: string }> = [
  { id: "discover", label: "Discover", icon: "compass" },
  { id: "schedule", label: "Schedule", icon: "calendar" },
  { id: "search", label: "Search", icon: "search" },
  { id: "activity", label: "Activity", icon: "pulse" }
];

export function App() {
  const [view, setView] = createSignal<View>("discover");
  const [selected, setSelected] = createSignal<number | null>(null);
  const [token, setToken] = createSignal(0);
  const [health, setHealth] = createSignal<Awaited<ReturnType<typeof getHealth>> | null>(null);

  const refresh = () => setToken(value => value + 1);

  const loadHealth = () => {
    getHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  };

  onSettled(() => {
    loadHealth();
    const timer = setInterval(loadHealth, 60000);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);

    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  });

  const services = createMemo(() => {
    const current = health();
    if (!current) return [];
    return Object.entries(current.checks).map(([name, check]) => ({ name, ...check }));
  });

  return (
    <div class="app">
      <nav class="sidebar">
        <div class="brand">
          <div class="brand-mark" />
          <div>
            <div class="brand-name">Hikari</div>
            <div class="brand-sub">anime deck</div>
          </div>
        </div>

        <div class="nav">
          <For each={VIEWS}>
            {item => (
              <button
                class={["nav-item", { active: view() === item.id }]}
                onClick={() => setView(item.id)}
              >
                <Icon name={item.icon} />
                {item.label}
              </button>
            )}
          </For>
        </div>

        <div class="sidebar-foot">
          <For each={services()}>
            {service => (
              <div class="svc" title={service.detail}>
                <i class={["dot", { ok: service.ok, bad: service.configured && !service.ok }]} />
                {service.name}
              </div>
            )}
          </For>
          <button class="btn ghost tiny" style={{ "margin-top": "6px" }} onClick={refresh}>
            Refresh data
          </button>
        </div>
      </nav>

      <main class="main">
        <Errored
          fallback={(error, reset) => (
            <div class="empty">
              <strong>Something broke</strong>
              <div style={{ "margin-bottom": "14px" }}>{String(error())}</div>
              <button class="btn" onClick={reset}>
                Try again
              </button>
            </div>
          )}
        >
          <Switch>
            <Match when={view() === "discover"}>
              <Discover token={token()} onOpen={setSelected} />
            </Match>
            <Match when={view() === "schedule"}>
              <Schedule token={token()} onOpen={setSelected} />
            </Match>
            <Match when={view() === "search"}>
              <Search token={token()} onOpen={setSelected} />
            </Match>
            <Match when={view() === "activity"}>
              <Activity token={token()} />
            </Match>
          </Switch>
        </Errored>
      </main>

      <Show when={selected()}>
        {id => (
          <Errored
            fallback={(error, reset) => (
              <>
                <div class="panel-scrim" onClick={() => setSelected(null)} />
                <aside class="panel">
                  <div class="panel-body" style={{ "padding-top": "60px" }}>
                    <div class="notice bad">{String(error())}</div>
                    <button class="btn" onClick={reset}>
                      Retry
                    </button>
                    <button class="btn ghost" onClick={() => setSelected(null)}>
                      Close
                    </button>
                  </div>
                </aside>
              </>
            )}
          >
            <Loading fallback={<div class="panel-scrim" />}>
              <Detail
                id={id()}
                token={token()}
                onClose={() => setSelected(null)}
                onRequested={refresh}
              />
            </Loading>
          </Errored>
        )}
      </Show>
    </div>
  );
}
