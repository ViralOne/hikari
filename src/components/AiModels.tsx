import { createMemo, createSignal, For, isPending, Loading, Show } from "solid-js";
import { getAiOverview, refreshAiModels, type AiOverview, type AiProviderName } from "../api";

const EMPTY: AiOverview = { order: [], setting: "auto", providers: [] };
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

export const PROVIDER_CHOICES: { value: string; label: string }[] = [
  { value: "auto", label: "Automatic: Groq first, OpenRouter if Groq can't answer" },
  { value: "groq", label: "Groq only" },
  { value: "openrouter", label: "OpenRouter only" },
  { value: "openrouter,groq", label: "OpenRouter first, then Groq" }
];

// Which providers to ask and in what order. Only those with a key count, so "Automatic" with one key
// is simply that one.
export function AiProviderChoice(props: { id: string; value: string; onChange: (value: string) => void }) {
  const known = () => PROVIDER_CHOICES.some(choice => choice.value === props.value) || props.value === "groq,openrouter";
  return (
    <select id={props.id} class="field" value={props.value === "groq,openrouter" || !props.value ? "auto" : props.value} onChange={event => props.onChange(event.currentTarget.value)}>
      <For each={PROVIDER_CHOICES}>{choice => <option value={choice.value}>{choice.label}</option>}</For>
      <Show when={!known()}>
        <option value={props.value}>{props.value}</option>
      </Show>
    </select>
  );
}

// One provider's model picker: "Automatic" or one of the free models its key can use right now,
// from the provider's own list. Refresh fetches it again, with a key typed into the form if there
// is one, so a new key can be checked before it is saved. Models that are resting say why.
export function AiModelPicker(props: {
  id: string;
  provider: AiProviderName;
  value: string;
  draftKey: string;
  keySaved: boolean;
  onChange: (value: string) => void;
}) {
  const [request, setRequest] = createSignal<{ refresh: boolean; key?: string; n: number }>({ refresh: false, n: 0 });
  const data = createMemo(() => {
    const { refresh, key } = request();
    return (refresh ? refreshAiModels(props.provider, key) : getAiOverview()).catch(
      err => ({ ...EMPTY, error: err instanceof Error ? err.message : String(err) }) as AiOverview & { error?: string }
    ) as Promise<AiOverview & { error?: string }>;
  });
  const mine = () => data().providers.find(item => item.provider === props.provider) ?? null;
  const models = () => mine()?.models ?? [];
  const refreshing = () => isPending(() => data());
  const canRefresh = () => props.keySaved || props.draftKey.trim().length > 0;
  const refresh = () => setRequest(previous => ({ refresh: true, key: props.draftKey.trim() || undefined, n: previous.n + 1 }));

  return (
    <div class="ai-picker">
      <Loading fallback={<div class="skeleton" style={{ height: "36px" }} />}>
        <div class="label-row">
          <select id={props.id} class="field" value={props.value} disabled={models().length === 0} onChange={event => props.onChange(event.currentTarget.value)}>
            <option value="">Automatic</option>
            <Show when={props.value && !models().some(model => model.id === props.value)}>
              <option value={props.value}>{props.value} (not in the list)</option>
            </Show>
            <For each={models()}>
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
          <Show when={!canRefresh()}>Enter the API key above to load the free models it can use. </Show>
          <Show when={data().error ?? mine()?.error}>{error => <span style={{ color: "var(--bad)" }}>{error()}. </span>}</Show>
          <Show when={mine()?.resting}>{resting => <span style={{ color: "var(--bad)" }}>Resting until {when(resting().until)}: {resting().reason}. </span>}</Show>
          <Show when={models().length > 0}>
            {models().filter(model => model.state === "ok").length} of {models().length} free models answering
            <Show when={mine()?.refreshedAt}>{at => <>, list from {when(at())}</>}</Show>.
          </Show>
          <Show when={mine()?.lastUsed}>{used => <> Last answer from {used().model}.</>}</Show>
          <Show when={mine()?.enabled && mine()!.inOrder < 0}> Not asked with the current “Use” choice.</Show>
        </p>
      </Loading>
    </div>
  );
}
