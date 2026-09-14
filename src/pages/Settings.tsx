import { createMemo, createSignal, For, Loading, Show } from "solid-js";
import { getSettings, saveSettings, testService, type SettingField } from "../api";
import { Icon } from "../components/Icon";

// Groups in the order a first run wants them: the one required service, then the ones that add
// the most, then the switches.
const GROUPS: Array<{
  id: string;
  title: string;
  blurb: string;
  testable?: boolean;
  required?: boolean;
  /** Which key in the health/enabled map says this one is live. */
  enabledKey?: string;
}> = [
  {
    id: "jellyseerr",
    title: "Jellyseerr",
    blurb: "The only service Hikari needs. It resolves titles and creates requests.",
    testable: true,
    required: true,
    enabledKey: "jellyseerr"
  },
  {
    id: "sonarr",
    title: "Sonarr",
    blurb: "Library badges, episode counts and the download queue.",
    testable: true,
    enabledKey: "sonarr"
  },
  {
    id: "jellyfin",
    title: "Jellyfin",
    blurb: "Watch progress and what to play next.",
    testable: true,
    enabledKey: "jellyfin"
  },
  {
    id: "shoko",
    title: "Shoko",
    blurb: "True episode counts from AniDB, and which episodes are missing.",
    testable: true,
    enabledKey: "shoko"
  },
  { id: "radarr", title: "Radarr", blurb: "Library badges for films.", testable: true, enabledKey: "radarr" },
  { id: "qbit", title: "qBittorrent", blurb: "The torrent activity view.", enabledKey: "qbit" },
  {
    id: "anilist",
    title: "AniList",
    blurb: "Optional. Adds your own list status and progress.",
    enabledKey: "anilistList"
  },
  {
    id: "auth",
    title: "Login",
    blurb: "Require a Jellyfin username and password before Hikari will show anything."
  },
  { id: "autolink", title: "Automatic linking", blurb: "Keeps Shoko's episode links in step with Sonarr." },
  { id: "general", title: "General", blurb: "" }
];

type Draft = Record<string, string | number | boolean>;
type TestResult = { ok: boolean; detail?: string; error?: string };

const fetchSettings = (_token: number) => getSettings();

/** Narrows the "running" placeholder out, so Show's callback gets a real result. */
const settled = (state: TestResult | "running" | undefined): TestResult | null =>
  state && state !== "running" ? state : null;

export function Settings(props: { welcome: boolean; token: number; onSaved: () => void; onExit: () => void }) {
  const [tick, setTick] = createSignal(0);
  const data = createMemo(() => fetchSettings(props.token + tick()));

  const [draft, setDraft] = createSignal<Draft>({});
  const [tests, setTests] = createSignal<Record<string, TestResult | "running">>({});
  const [busy, setBusy] = createSignal(false);
  const [outcome, setOutcome] = createSignal<{ ok: boolean; message: string } | null>(null);

  const dirty = createMemo(() => Object.keys(draft()).length > 0);

  const edit = (key: string, value: string | number | boolean) => {
    setDraft(prev => ({ ...prev, [key]: value }));
    setOutcome(null);
  };

  const current = (field: SettingField): string | number | boolean => {
    const pending = draft()[field.key];
    if (pending !== undefined) return pending;
    if (field.type === "secret") return "";
    return field.value ?? (field.type === "boolean" ? false : "");
  };

  const save = async () => {
    setBusy(true);
    try {
      const result = await saveSettings(draft());
      setDraft({});
      setOutcome({
        ok: true,
        message:
          result.changed.length === 0
            ? "Nothing had changed."
            : `Saved ${result.changed.length} setting${result.changed.length === 1 ? "" : "s"}.`
      });
      setTick(value => value + 1);
      props.onSaved();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOutcome({
        ok: false,
        // The built-in UI cannot send the shared secret, so this is the one failure that needs
        // explaining rather than repeating.
        message:
          message === "unauthorized"
            ? "HIKARI_TOKEN is set, so this screen cannot save. Configure with environment variables, or unset the token and put authentication in your reverse proxy instead."
            : message
      });
    } finally {
      setBusy(false);
    }
  };

  // Tests the values in the form, falling back to what is already stored, so it works both
  // during setup and later when you only want to check a service is still reachable.
  const test = async (group: string) => {
    setTests(prev => ({ ...prev, [group]: "running" }));
    const url = draft()[`${group}.url`];
    const key = draft()[`${group}.key`];
    try {
      const result = await testService(group, url ? String(url) : undefined, key ? String(key) : undefined);
      setTests(prev => ({ ...prev, [group]: result }));
    } catch (err) {
      setTests(prev => ({
        ...prev,
        [group]: { ok: false, error: err instanceof Error ? err.message : String(err) }
      }));
    }
  };

  const fieldsFor = (group: string) => data().fields.filter(field => field.group === group);

  return (
    <Loading fallback={<div class="section"><div class="skeleton" style={{ height: "420px" }} /></div>}>
      <div class={["setup", { welcome: props.welcome }]}>
        <Show when={props.welcome}>
          <div class="setup-hero">
            <div class="brand-mark large" />
            <h1 class="setup-title">Welcome to Hikari</h1>
            <p class="setup-lede">
              Point it at the services you already run. Only Jellyseerr is required. Everything else adds
              features and can be filled in later. Keys are stored on the server, never in your browser.
            </p>
          </div>
        </Show>

        <Show when={!props.welcome}>
          <div class="section-head setup-head">
            <h2 class="section-title">Settings</h2>
            <span class="section-note">
              Saved to {data().path ?? "the settings file"} · values from the environment are used when a
              field is blank
            </span>
            <button class="btn ghost tiny" onClick={() => props.onExit()}>
              Back
            </button>
          </div>
        </Show>

        <Show when={outcome()}>
          {result => (
            <div class={["notice", result().ok ? "ok" : "bad"]} role="status" aria-live="polite">
              {result().message}
            </div>
          )}
        </Show>

        <For each={GROUPS}>
          {group => (
            <Show when={fieldsFor(group.id).length > 0}>
              <section class="setup-group">
                <div class="setup-group-head">
                  <h3 class="setup-group-title">
                    {group.title}
                    <Show when={group.required}>
                      <span class="badge pending">required</span>
                    </Show>
                    <Show when={group.enabledKey && data().enabled[group.enabledKey]}>
                      <span class="badge owned">connected</span>
                    </Show>
                  </h3>
                  <Show when={group.testable}>
                    <button class="btn tiny ghost" disabled={tests()[group.id] === "running"} onClick={() => test(group.id)}>
                      {tests()[group.id] === "running" ? "Testing…" : "Test connection"}
                    </button>
                  </Show>
                </div>

                <Show when={group.blurb}>
                  <p class="setup-blurb">{group.blurb}</p>
                </Show>

                <Show when={settled(tests()[group.id])}>
                  {result => (
                    <div class={["notice", result().ok ? "ok" : "bad"]} role="status" aria-live="polite">
                      {result().ok
                        ? `Reachable: ${result().detail}`
                        : `Could not connect: ${result().error}`}
                    </div>
                  )}
                </Show>

                {/* Keyed by field name, not identity. Every save refetches and JSON gives back
                    brand new objects, so the default identity keying tore down and rebuilt the
                    whole form, losing focus and anything half-typed in a field you had not
                    touched. A custom key hands the callback an accessor. */}
                <For each={fieldsFor(group.id)} keyed={field => field.key}>
                  {field => (
                    <div class={["setup-field", { switch: field().type === "boolean" }]}>
                      <label class="setup-label" for={`set-${field().key}`}>
                        <span>{field().label}</span>
                        <Show when={field().source === "env"}>
                          <span class="setup-source" title={`Currently coming from ${field().env}`}>
                            from {field().env}
                          </span>
                        </Show>
                        <Show when={field().hint}>
                          <span class="setup-hint">{field().hint}</span>
                        </Show>
                      </label>

                      <Show
                        when={field().type !== "boolean"}
                        fallback={
                          <input
                            id={`set-${field().key}`}
                            type="checkbox"
                            checked={Boolean(current(field()))}
                            onChange={event => edit(field().key, event.currentTarget.checked)}
                          />
                        }
                      >
                        <input
                          id={`set-${field().key}`}
                          class="field"
                          type={
                            field().type === "secret" ? "password" : field().type === "number" ? "number" : "text"
                          }
                          min={field().min ?? undefined}
                          max={field().max ?? undefined}
                          autocomplete="off"
                          spellcheck={false}
                          placeholder={
                            field().type === "secret"
                              ? (field().preview ?? "not set")
                              : (field().placeholder ?? "")
                          }
                          value={String(current(field()))}
                          onInput={event => edit(field().key, event.currentTarget.value)}
                        />
                      </Show>
                    </div>
                  )}
                </For>
              </section>
            </Show>
          )}
        </For>

        <div class="setup-actions">
          <button class="btn primary" disabled={busy() || !dirty()} onClick={save}>
            {busy() ? "Saving…" : dirty() ? "Save settings" : "Nothing to save"}
          </button>
          <Show when={dirty()}>
            <button class="btn ghost" disabled={busy()} onClick={() => setDraft({})}>
              Discard changes
            </button>
          </Show>
          <Show when={data().configured}>
            <button class="btn ghost" onClick={() => props.onExit()}>
              <Icon name="compass" size={15} />
              Start browsing
            </button>
          </Show>
        </div>

        <p class="setup-foot">
          A secret is never sent back to the browser, so a field shows the last four characters of what
          is stored. Leave one blank to keep it. Clearing a field hands it back to the environment
          variable, if you have one set.
        </p>
      </div>
    </Loading>
  );
}
