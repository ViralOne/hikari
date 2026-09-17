import { createMemo, createSignal, Errored, For, Loading, Match, onSettled, Show, Switch } from "solid-js";
import { getAuth, getHealth, getSettings, logout, onSessionLost } from "./api";
import { Detail } from "./components/Detail";
import { Icon } from "./components/Icon";
import { latency, percent } from "./format";
import { Activity } from "./pages/Activity";
import { Discover } from "./pages/Discover";
import { Schedule } from "./pages/Schedule";
import { Search } from "./pages/Search";
import { Login } from "./pages/Login";
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
  // Same reasoning for the session: rendering the app before the answer arrives would fire a
  // screenful of requests that all come back 401.
  const [session, setSession] = createSignal<Awaited<ReturnType<typeof getAuth>> | null>(null);

  const refresh = () => setToken(value => value + 1);

  const loadHealth = () => {
    getHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  };

  // Health and settings are only fetched once the session is known, otherwise a signed-out
  // load fires two requests that can only come back 401 and litter the console. Returns the state
  // so a caller can tell whether signing in actually took.
  const loadSession = () =>
    getAuth()
      .then(state => {
        setSession(state);
        if (state.signedIn) {
          loadHealth();
          loadConfigured();
        }
        return state;
      })
      // Unreachable API must not strand you on a login form you cannot use.
      .catch(() => {
        const assumed = { enabled: false, configured: false, signedIn: true, user: null };
        setSession(assumed);
        loadHealth();
        loadConfigured();
        return assumed;
      });

  const loadConfigured = () => {
    getSettings()
      .then(result => setConfigured(result.configured))
      // A failure here must not trap you on the setup screen, so assume configured and let the
      // service dots report the real problem.
      .catch(() => setConfigured(true));
  };

  onSettled(() => {
    loadSession();
    // Any 401 from anywhere means the session ended under us. Re-asking rather than trusting the
    // 401 keeps one flaky request from throwing you out.
    onSessionLost(() => {
      if (session()?.signedIn !== false) loadSession();
    });

    const timer = setInterval(() => {
      if (session()?.signedIn !== false) loadHealth();
    }, 60000);

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

  // The list integration shares AniList's endpoint, so its latency is AniList's.
  const upstreamKey = (name: string) => (name === "anilistList" ? "anilist" : name);

  const services = createMemo(() => {
    const current = health();
    if (!current) return [];
    return Object.entries(current.checks).map(([name, check]) => {
      const stat = current.upstream?.[upstreamKey(name)];
      const ms = latency(stat?.p50);
      const timing = stat
        ? `median ${latency(stat.p50)}, p95 ${latency(stat.p95)}, ${stat.calls} calls${stat.errors ? `, ${stat.errors} failed` : ""}`
        : null;
      return { name, ...check, ms, timing, slow: (stat?.p50 ?? 0) >= 2000 };
    });
  });

  // One line for the cache: the hit rate is the number that explains a slow first open after a
  // restart, and a rate that stays low points at an integration whose entries keep being swept.
  const cacheLine = createMemo(() => {
    const cache = health()?.cache;
    if (!cache || cache.hits + cache.misses === 0) return null;
    const rate = percent(cache.hitRate);
    const notes = [`${rate} hits`, `${cache.entries} entries`];
    if (cache.revalidated) notes.push(`${cache.revalidated} refreshed in the background`);
    if (cache.stale) notes.push(`${cache.stale} served stale`);
    return { short: `${rate} cached`, long: notes.join(", ") };
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

  const signOut = async (everywhere: boolean) => {
    await logout(everywhere).catch(() => null);
    setSession(null);
    loadSession();
  };

  return (
    <Show
      when={session()?.signedIn === true}
      fallback={
        // Three states, not two: while the answer is still in flight the shell used to render for
        // a signed-out visitor, so the top bar and status pill flashed up before the login form.
        <Show when={session()} fallback={<div class="login" aria-busy="true" />}>
          <Login
            // Defaults to true so that signing out, which clears the session for a moment, does not
            // flash the "Jellyfin is not configured" warning on the way to the form.
            configured={session()?.configured ?? true}
            onSignedIn={async () => {
              const state = await loadSession();
              if (!state.signedIn) return false;
              refresh();
              return true;
            }}
          />
        </Show>
      }
    >
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
              <div class="svc" title={service.timing ?? undefined}>
                <i class={["dot", { ok: service.ok, bad: service.configured && !service.ok }]} aria-hidden="true" />
                <span class="svc-name">{service.name}</span>
                <span class="svc-detail">
                  {service.configured ? service.detail : "not configured"}
                  <Show when={service.ms}>{ms => <span class={["svc-ms", { slow: service.slow }]}> · {ms()}</span>}</Show>
                </span>
              </div>
            )}
          </For>
          <Show when={cacheLine()}>
            {line => (
              <div class="svc">
                <span class="svc-name">Cache</span>
                <span class="svc-detail">{line().long}</span>
              </div>
            )}
          </Show>
          <Show when={session()?.enabled && session()?.user}>
            {user => (
              <div class="svc">
                <span class="svc-name">Signed in as {user().name}</span>
                <button class="btn ghost tiny" onClick={() => signOut(false)}>
                  Sign out
                </button>
                {/* The only place this is offered. A session cannot be revoked one at a time, so
                    this is what you reach for when a device is lost. */}
                <button class="btn ghost tiny" onClick={() => signOut(true)} title="Ends every session on every device">
                  Everywhere
                </button>
              </div>
            )}
          </Show>
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
              <div class="svc" title={service.timing ? `${service.detail} · ${service.timing}` : service.detail}>
                <i class={["dot", { ok: service.ok, bad: service.configured && !service.ok }]} aria-hidden="true" />
                {service.name}
                <Show when={service.ms}>
                  {ms => (
                    <span class={["svc-ms", { slow: service.slow }]} aria-hidden="true">
                      {ms()}
                    </span>
                  )}
                </Show>
                <span class="visually-hidden">
                  {service.configured ? (service.ok ? "connected" : "error") : "not configured"}: {service.detail}
                  {service.timing ? `, ${service.timing}` : ""}
                </span>
              </div>
            )}
          </For>
          <Show when={cacheLine()}>
            {line => (
              <div class="svc" title={line().long}>
                <i class="dot" aria-hidden="true" />
                {line().short}
              </div>
            )}
          </Show>
          <button class="btn ghost tiny" style={{ "margin-top": "6px" }} onClick={refresh}>
            Refresh data
          </button>
          <Show when={session()?.enabled && session()?.user}>
            {user => (
              <div class="signed-in">
                <span class="svc-name">{user().name}</span>
                <button class="btn ghost tiny" onClick={() => signOut(false)}>
                  Sign out
                </button>
              </div>
            )}
          </Show>
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
                  // Saving can switch the login on, which invalidates this very page: without
                  // re-reading the session the app kept rendering while every request 401'd and the
                  // login form was only reachable by reloading by hand.
                  loadSession();
                  loadConfigured();
                  loadHealth();
                  refresh();
                  setView("settings");
                }}
                onExit={() => setView("discover")}
              />
            </Match>
            <Match when={view() === "discover"}>
              <Discover token={token()} onOpen={setSelected} onChanged={refresh} />
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
    </Show>
  );
}
