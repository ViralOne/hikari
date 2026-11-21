import { createMemo, createSignal, For, isPending, Loading, Show } from "solid-js";
import { getGroqModels, refreshGroqModels, type GroqModels } from "../api";

const EMPTY: GroqModels = { enabled: false, preferred: null, refreshedAt: null, error: null, lastUsed: null, models: [] };

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

// The Groq model picker: "Automatic" or one of the models the key can use right now, from Groq's
// own list. Refresh fetches it again, with a key typed into the form if there is one, so a new key
// can be checked before it is saved. Models that are resting say why.
export function GroqModelPicker(props: {
  id: string;
  value: string;
  draftKey: string;
  keySaved: boolean;
  onChange: (value: string) => void;
}) {
  const [request, setRequest] = createSignal<{ refresh: boolean; key?: string; n: number }>({ refresh: false, n: 0 });
  const data = createMemo(() => {
    const { refresh, key } = request();
    return (refresh ? refreshGroqModels(key) : getGroqModels()).catch(
      err => ({ ...EMPTY, error: err instanceof Error ? err.message : String(err) }) as GroqModels
    ) as Promise<GroqModels>;
  });
  const refreshing = () => isPending(() => data());
  const canRefresh = () => props.keySaved || props.draftKey.trim().length > 0;
  const refresh = () =>
    setRequest(previous => ({ refresh: true, key: props.draftKey.trim() || undefined, n: previous.n + 1 }));

  return (
    <div class="groq-picker">
      <Loading fallback={<div class="skeleton" style={{ height: "36px" }} />}>
        <div class="label-row">
          <select
            id={props.id}
            class="field"
            value={props.value}
            disabled={data().models.length === 0}
            onChange={event => props.onChange(event.currentTarget.value)}
          >
            <option value="">Automatic</option>
            <Show when={props.value && !data().models.some(model => model.id === props.value)}>
              <option value={props.value}>{props.value} (not in the list)</option>
            </Show>
            <For each={data().models}>
              {model => (
                <option value={model.id}>
                  {model.id}
                  {model.state !== "ok" ? ` · ${model.state}` : ""}
                </option>
              )}
            </For>
          </select>
          <button class="btn ghost tiny" disabled={!canRefresh() || refreshing()} onClick={refresh}>
            {refreshing() ? "Refreshing…" : "Refresh models"}
          </button>
        </div>
        <p class="setup-hint">
          <Show when={!canRefresh()}>Enter a Groq API key above to load the models it can use. </Show>
          <Show when={data().error}>{error => <span style={{ color: "var(--bad)" }}>{error()}. </span>}</Show>
          <Show when={data().models.length > 0}>
            {data().models.filter(model => model.state === "ok").length} of {data().models.length} free models answering
            <Show when={data().refreshedAt}>{at => <>, list from {when(at())}</>}</Show>.
          </Show>
          <Show when={data().lastUsed}>{used => <> Last answer from {used().model}.</>}</Show>
        </p>
      </Loading>
    </div>
  );
}
