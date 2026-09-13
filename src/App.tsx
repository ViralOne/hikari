import { createMemo, createSignal, Errored, For, Loading, Match, onSettled, Show, Switch } from "solid-js";
import { getHealth, getSettings } from "./api";
import { Detail } from "./components/Detail";
import { Icon } from "./components/Icon";
import { Activity } from "./pages/Activity";
import { Discover } from "./pages/Discover";
import { Schedule } from "./pages/Schedule";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";

// "settings" is reachable from the gear rather than the tab bar: four tabs is the most a phone
// can show without crowding, and settings is not somewhere you go every day.
type View = "discover" | "schedule" | "search" | "activity" | "settings";

const VIEWS: Array<{ id: View; label: string; icon: string }> = [
  { id: "discover", label: "Discover", icon: "compass" },
  { id: "schedule", label: "Schedule", icon: "calendar" },
  { id: "search", label: "Search", icon: "search" },
  { id: "activity", label: "Activity", icon: "pulse" }
];

// The sidebar and the mobile tab bar are separate elements because on a phone the brand belongs
// at the top and the tabs belong at the bottom, which no amount of CSS reordering achieves from
// one DOM position. Only one is ever displayed, so `display: none` keeps the other out of the
// accessibility tree entirely and there is no duplicate navigation to tab through.
function NavButtons(props: { view: View; onSelect: (view: View) => void; itemClass: string }) {
  return (
    <For each={VIEWS}>
      {item => (
        <button
          class={[props.itemClass, { active: props.view === item.id }]}
          onClick={() => props.onSelect(item.id)}
          aria-current={props.view === item.id ? "page" : undefined}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </button>
      )}
    </For>
  );
}

export function App() {
  const [view, setView] = createSignal<View>("discover");
  const [selected, setSelected] = createSignal<number | null>(null);
  const [token, setToken] = createSignal(0);
  const [statusOpen, setStatusOpen] = createSignal(false);
  const [health, setHealth] = createSignal<Awaited<ReturnType<typeof getHealth>> | null>(null);
  // null until asked, so a fresh install is not shown Discover for a moment before setup.
  const [configured, setConfigured] = createSignal<boolean | null>(null);

  const refresh = () => setToken(value => value + 1);

  const loadHealth = () => {
    getHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  };

  const loadConfigured = () => {
    getSettings()
      .then(result => setConfigured(result.configured))
      // A failure here must not trap you on the setup screen, so assume configured and let the
      // service dots report the real problem.
      .catch(() => setConfigured(true));
  };

  onSettled(() => {
    loadHealth();
    loadConfigured();
    const timer = setInterval(loadHealth, 60000);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelected(null);
        setStatusOpen(false);
      }
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

  // The sidebar's status list is hidden on a phone, so the tally has to be reachable from the
  // top bar or a red service is invisible on the device most likely to be used casually.
  const tally = createMemo(() => {
    const configured = services().filter(service => service.configured);
    return { ok: configured.filter(service => service.ok).length, total: configured.length };
  });

  const pick = (next: View) => {
    setView(next);
    setStatusOpen(false);
  };

  return (
    <div class="app">
      <a class="skip-link" href="#content">
        Skip to content
      </a>

      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" />
          <div>
            <div class="brand-name">Hikari</div>
            <div class="brand-sub">anime deck</div>
          </div>
        </div>

        <button
          class={["status-pill", { bad: tally().total > 0 && tally().ok < tally().total }]}
          onClick={() => setStatusOpen(open => !open)}
          aria-expanded={statusOpen() ? "true" : "false"}
          aria-label={`Service status, ${tally().ok} of ${tally().total} connected`}
        >
          <i
            class={["dot", { ok: tally().total > 0 && tally().ok === tally().total, bad: tally().ok < tally().total }]}
            aria-hidden="true"
          />
          {tally().ok}/{tally().total}
        </button>

        <button class="icon-btn" onClick={refresh} aria-label="Refresh data">
          <Icon name="refresh" size={18} />
        </button>

        <button
          class={["icon-btn", { active: view() === "settings" }]}
          onClick={() => pick("settings")}
          aria-label="Settings"
        >
          <Icon name="settings" size={18} />
        </button>
      </header>

      <Show when={statusOpen()}>
        <div class="sheet-scrim" onClick={() => setStatusOpen(false)} />
        <div class="status-sheet" role="dialog" aria-label="Service status">
          <div class="box-title">Services</div>
          <For each={services()}>
            {service => (
              <div class="svc">
                <i class={["dot", { ok: service.ok, bad: service.configured && !service.ok }]} aria-hidden="true" />
                <span class="svc-name">{service.name}</span>
                <span class="svc-detail">{service.configured ? service.detail : "not configured"}</span>
              </div>
            )}
          </For>
          <button class="btn ghost tiny" onClick={() => setStatusOpen(false)}>
            Close
          </button>
        </div>
      </Show>

      <nav class="sidebar" aria-label="Sections">
        <div class="brand">
          <div class="brand-mark" />
          <div>
            <div class="brand-name">Hikari</div>
            <div class="brand-sub">anime deck</div>
          </div>
        </div>

        {/* Hidden until something is configured: every one of these views would only be able to
            show an error, and offering them as the first thing you see is a bad welcome. */}
        <Show when={configured() === true}>
          <div class="nav">
            <NavButtons view={view()} onSelect={pick} itemClass="nav-item" />
          </div>
        </Show>

        <div class="sidebar-foot">
          <For each={services()}>
            {service => (
              <div class="svc" title={service.detail}>
                <i class={["dot", { ok: service.ok, bad: service.configured && !service.ok }]} aria-hidden="true" />
                {service.name}
                <span class="visually-hidden">
                  {service.configured ? (service.ok ? "connected" : "error") : "not configured"}: {service.detail}
                </span>
              </div>
            )}
          </For>
          <button class="btn ghost tiny" style={{ "margin-top": "6px" }} onClick={refresh}>
            Refresh data
          </button>
          <button
            class={["nav-item", "compact", { active: view() === "settings" }]}
            onClick={() => pick("settings")}
            aria-current={view() === "settings" ? "page" : undefined}
          >
            <Icon name="settings" />
            Settings
          </button>
        </div>
      </nav>

      <main class="main" id="content" tabindex="-1">
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
            {/* Held until the answer is known. Falling through to Discover in the meantime meant a
                fresh install fired a screenful of failing requests before the setup screen won. */}
            <Match when={configured() === null}>
              <div class="section">
                <div class="skeleton" style={{ height: "320px" }} />
              </div>
            </Match>
            {/* A fresh install lands here, and cannot leave until at least one service answers. */}
            <Match when={configured() === false || view() === "settings"}>
              <Settings
                welcome={configured() === false}
                token={token()}
                // Saving the first service must not throw you straight into Discover: the point
                // of the welcome screen is to fill in the optional ones too.
                onSaved={() => {
                  loadConfigured();
                  loadHealth();
                  refresh();
                  setView("settings");
                }}
                onExit={() => setView("discover")}
              />
            </Match>
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

      <Show when={configured() === true}>
        <nav class="tabbar" aria-label="Sections">
          <NavButtons view={view()} onSelect={pick} itemClass="tab" />
        </nav>
      </Show>

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
