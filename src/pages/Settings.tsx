import { createMemo, createSignal, For, Loading, Show } from "solid-js";
import {
  generateToken,
  getSettings,
  removeToken,
  saveSettings,
  testService,
  type SettingField
} from "../api";
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
  {
    id: "token",
    title: "API token",
    blurb:
      "One secret for the callers that cannot hold a session cookie: the Homepage widget, the Sonarr webhook, and your own scripts."
  },
  { id: "autolink", title: "Automatic linking", blurb: "Keeps Shoko's episode links in step with Sonarr." },
  { id: "general", title: "General", blurb: "" }
];

type Draft = Record<string, string | number | boolean>;

// What to paste into the Jellyfin Webhook plugin's template box. Mirrors server/scrobble.js TEMPLATE;
// the server reads the plugin's own PascalCase names too, so "Send All Properties" also works.
const WEBHOOK_TEMPLATE = `{
  "event": "{{NotificationType}}",
  "itemType": "{{ItemType}}",
  "itemId": "{{ItemId}}",
  "seriesId": "{{SeriesId}}",
  "seriesName": "{{SeriesName}}",
  "playedToCompletion": "{{PlayedToCompletion}}",
  "played": "{{Played}}",
  "saveReason": "{{SaveReason}}",
  "userId": "{{UserId}}"
}`;
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
        // explaining rather than repeating. It now only happens with a token set and the login off,
        // since a signed-in session satisfies the token check.
        message:
          message === "unauthorized"
            ? "A token is set and the login is off, so this screen cannot save. Turn the login on to edit settings in the browser, or configure with environment variables."
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

  // A managed field has its own control, so it must not also appear as an input the save button
  // would try to send. The server refuses it, which would only ever read as a bug here.
  const editableFieldsFor = (group: string) => fieldsFor(group).filter(field => !field.managed);

  const tokenField = createMemo(() => data().fields.find(field => field.key === "token") ?? null);

  // The saved value, not the draft: generating is refused until the login is actually on, and it is
  // only on once it has been saved. A pending tick in the form is worth mentioning, not obeying.
  const loginOn = createMemo(() => Boolean(data().fields.find(field => field.key === "auth.enabled")?.value));
  const loginPending = createMemo(() => !loginOn() && draft()["auth.enabled"] === true);

  const [revealed, setRevealed] = createSignal<string | null>(null);
  const [tokenBusy, setTokenBusy] = createSignal(false);
  const [tokenNote, setTokenNote] = createSignal<{ ok: boolean; message: string } | null>(null);
  const [copied, setCopied] = createSignal(false);

  const generate = async () => {
    setTokenBusy(true);
    setTokenNote(null);
    setCopied(false);
    try {
      const result = await generateToken();
      // Held in a signal rather than refetched, because this is the only response that carries it.
      setRevealed(result.token);
      setTick(value => value + 1);
      props.onSaved();
    } catch (err) {
      // Whatever is on screen is deliberately left alone. A failed regenerate means the old token is
      // still the live one, and this is the only place it is ever shown, so clearing it here would
      // destroy a working secret the moment the network hiccuped.
      setTokenNote({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTokenBusy(false);
    }
  };

  const remove = async () => {
    setTokenBusy(true);
    setTokenNote(null);
    try {
      const result = await removeToken();
      setRevealed(null);
      setTokenNote({
        ok: true,
        message: result.fromEnv
          ? `Removed. ${tokenField()?.env ?? "HIKARI_TOKEN"} still sets one, so that is what applies now.`
          : "Removed. Nothing needs a token now."
      });
      setTick(value => value + 1);
      props.onSaved();
    } catch (err) {
      setTokenNote({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTokenBusy(false);
    }
  };

  // navigator.clipboard does not exist on a plain-http origin that is not localhost, which is
  // exactly how a LAN install is reached, so selecting the text is the fallback rather than an
  // afterthought.
  const copy = async (value: string, input?: HTMLInputElement) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      input?.select();
      setCopied(false);
    }
  };

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

                <Show when={group.id === "token" && tokenField()}>
                  {field => (
                    <div class="token-panel">
                      <div class="token-state">
                        <Show
                          when={field().set}
                          fallback={<span class="token-status">No token yet</span>}
                        >
                          <span class="token-status">
                            <span class="badge owned">active</span>
                            <code>{field().preview}</code>
                          </span>
                          <span class="setup-source">
                            {field().source === "env"
                              ? `from ${field().env}`
                              : "generated here"}
                          </span>
                        </Show>
                      </div>

                      <Show when={!loginOn()}>
                        <div class="notice" role="status">
                          {loginPending()
                            ? "Save the login setting first. A token can only be generated once Hikari knows who you are."
                            : "Turn the login on above and save, then a token can be generated here. Without a login, anyone who can reach this port could generate one, so Hikari will not offer it."}
                        </div>
                      </Show>

                      <Show when={field().source === "env" && loginOn()}>
                        <p class="setup-hint">
                          {field().env} is set, so generating one here will override it until you remove it
                          again.
                        </p>
                      </Show>

                      <Show when={tokenNote()}>
                        {note => (
                          <div class={["notice", note().ok ? "ok" : "bad"]} role="status" aria-live="polite">
                            {note().message}
                          </div>
                        )}
                      </Show>

                      <Show when={revealed()}>
                        {value => {
                          let input: HTMLInputElement | undefined;
                          return (
                            <div class="token-reveal">
                              <p class="token-warn">
                                Copy this now. Hikari never shows it again — later visits see only the
                                last four characters, so if you lose it you will have to generate a new
                                one.
                              </p>
                              <div class="token-value">
                                <input
                                  ref={input}
                                  class="field"
                                  readonly
                                  value={value()}
                                  spellcheck={false}
                                  onFocus={event => event.currentTarget.select()}
                                />
                                <button class="btn tiny" onClick={() => copy(value(), input)}>
                                  {copied() ? "Copied" : "Copy"}
                                </button>
                              </div>
                              <p class="setup-hint">
                                Send it as <code>X-Hikari-Token</code> or{" "}
                                <code>Authorization: Bearer …</code>. For Homepage, put it under{" "}
                                <code>headers</code> on the widget.
                              </p>
                            </div>
                          );
                        }}
                      </Show>

                      <div class="token-actions">
                        <button
                          class="btn primary tiny"
                          disabled={tokenBusy() || !loginOn()}
                          onClick={generate}
                        >
                          <Show when={field().set} fallback={<>Generate token</>}>
                            <Icon name="refresh" size={14} />
                            Regenerate
                          </Show>
                        </button>
                        <Show when={field().source === "settings"}>
                          <button class="btn ghost tiny" disabled={tokenBusy() || !loginOn()} onClick={remove}>
                            Remove
                          </button>
                        </Show>
                      </div>

                      <Show when={field().set}>
                        <p class="setup-hint">
                          Regenerating takes effect at once, so anything still sending the old token stops
                          working until you update it.
                        </p>
                      </Show>
                    </div>
                  )}
                </Show>

                {/* Keyed by field name, not identity. Every save refetches and JSON gives back
                    brand new objects, so the default identity keying tore down and rebuilt the
                    whole form, losing focus and anything half-typed in a field you had not
                    touched. A custom key hands the callback an accessor. */}
                <For each={editableFieldsFor(group.id)} keyed={field => field.key}>
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

                {/* The webhook Jellyfin needs for scrobbling. Shown whenever the AniList group is, so the
                    address and template are one copy away even before the toggle is on. */}
                <Show when={group.id === "anilist"}>
                  <div class="token-panel">
                    <div class="box-title">Jellyfin webhook</div>
                    <p class="setup-hint">
                      With "Update my list as I watch" on, install Jellyfin's <strong>Webhook</strong> plugin, add a{" "}
                      <strong>Generic Destination</strong> pointed here, tick <em>Playback Stop</em> and{" "}
                      <em>User Data Saved</em>, enable <em>Send All Properties</em> or paste the template below, and
                      set the request content type to <code>application/json</code>.
                    </p>
                    {(() => {
                      let urlInput: HTMLInputElement | undefined;
                      let templateInput: HTMLTextAreaElement | undefined;
                      const webhookUrl = () => `${location.origin}/api/hooks/jellyfin`;
                      return (
                        <>
                          <div class="token-value">
                            <input
                              ref={urlInput}
                              class="field"
                              readonly
                              value={webhookUrl()}
                              spellcheck={false}
                              onFocus={event => event.currentTarget.select()}
                              aria-label="Webhook address"
                            />
                            <button class="btn tiny" onClick={() => copy(webhookUrl(), urlInput)}>
                              Copy
                            </button>
                          </div>
                          <Show when={tokenField()?.set}>
                            <p class="setup-hint">
                              An API token is set, so add a request header on the destination:{" "}
                              <code>X-Hikari-Token</code> with the token from below.
                            </p>
                          </Show>
                          <div class="token-value">
                            <textarea
                              ref={templateInput}
                              class="field template"
                              readonly
                              rows={6}
                              spellcheck={false}
                              value={WEBHOOK_TEMPLATE}
                              onFocus={event => event.currentTarget.select()}
                              aria-label="Webhook template"
                            />
                            <button class="btn tiny" onClick={() => copy(WEBHOOK_TEMPLATE, templateInput as unknown as HTMLInputElement)}>
                              Copy
                            </button>
                          </div>
                          <p class="setup-hint">
                            Only episodes of a series Shokofin has tagged with an AniList or AniDB id are written, only
                            for the Jellyfin user Hikari reads progress for, and progress only ever moves forward.
                          </p>
                        </>
                      );
                    })()}
                  </div>
                </Show>
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
