// An optional second opinion from a free LLM, for the few decisions the rules cannot settle on their
// own (two AniDB entries scoring the same for one Sonarr season). Two providers, both with free
// tiers and both optional:
//
//   Groq        fast, generous free limits; every model a free key lists is usable.
//   OpenRouter  many more free models (ids ending in ":free"), but only 50 free requests a day
//               unless the account ever bought 10 credits.
//
// No model is hardcoded. Each provider's list comes from its own /models (OpenRouter's filtered to
// free ones), refreshed daily or from Settings. A model that is rate limited rests for as long as
// the provider asks; one that is gone is dropped until the next refresh; a provider that is out of
// its daily allowance rests as a whole. Whatever is next in line answers instead.
//
// AI_PROVIDERS sets the order: "auto" (every provider with a key, Groq first), "groq", "openrouter",
// "groq,openrouter" or "openrouter,groq". The model only ever picks among candidates the rules
// already kept, its answer is held to a JSON schema, and anything but a "high" pick counts as no.

import { config } from "./config.js";

const LIST_TTL_MS = 24 * 60 * 60 * 1000;
const TRIES_PER_PROVIDER = 3;

// Speech, moderation, agentic and embedding models cannot answer a chat question with JSON.
const NOT_CHAT = /whisper|tts|playai|orpheus|guard|safeguard|distil|compound|allam|embed|vision-preview/i;
const size = id => Number(/(\d+(?:\.\d+)?)b\b/i.exec(id)?.[1] || 0);
const byStrength = (a, b) =>
  Number(b.strict) - Number(a.strict) || size(b.id) - size(a.id) || (b.contextWindow || 0) - (a.contextWindow || 0) || a.id.localeCompare(b.id);

export const PROVIDERS = {
  groq: {
    label: "Groq",
    base: "https://api.groq.com/openai/v1",
    listPath: "/models",
    settings: () => config.groq,
    // Groq documents strict JSON-schema output for these families.
    rank: models =>
      models
        .filter(model => model.active !== false && !NOT_CHAT.test(model.id))
        .map(model => ({ id: model.id, owner: model.owned_by || null, contextWindow: model.context_window || null, strict: /gpt-oss|kimi-k2|llama-4/i.test(model.id) }))
        .sort(byStrength)
  },
  openrouter: {
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    // Free text models that take a response_format at all; the list says which do strict schemas.
    listPath: "/models?max_price=0&supported_parameters=response_format",
    settings: () => config.openrouter,
    rank: models =>
      models
        .filter(model => model.pricing && Number(model.pricing.prompt) === 0 && Number(model.pricing.completion) === 0)
        .filter(model => model.id !== "openrouter/free" && !NOT_CHAT.test(model.id))
        .map(model => ({
          id: model.id,
          owner: model.id.split("/")[0] || null,
          contextWindow: model.context_length || null,
          strict: (model.supported_parameters || []).includes("structured_outputs")
        }))
        .sort(byStrength)
  }
};

const state = {};
for (const name of Object.keys(PROVIDERS)) state[name] = fresh();
function fresh() {
  return { catalog: { at: 0, models: [], error: null }, health: new Map(), plainJson: new Set(), restUntil: 0, restReason: null };
}
let lastUsed = null;

const keyOf = name => PROVIDERS[name].settings().apiKey;
const preferredOf = name => {
  const model = PROVIDERS[name].settings().model;
  return model && model !== "auto" ? model : null;
};

export function enabled() {
  return order().length > 0;
}

// Providers to ask, in order, among those with a key.
export function order() {
  const raw = String(config.ai?.providers || "auto").toLowerCase().replace(/\s+/g, "");
  const wanted = raw === "auto" || !raw ? ["groq", "openrouter"] : raw.split(",").filter(name => PROVIDERS[name]);
  return [...new Set(wanted)].filter(name => keyOf(name));
}

async function call(name, path, options = {}, apiKey = keyOf(name), timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${PROVIDERS[name].base}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(name === "openrouter" ? { "X-Title": "Hikari" } : {}) }
    });
  } finally {
    clearTimeout(timer);
  }
}

// The models a key can use. `apiKey` lets Settings try a key before it is saved.
export async function refreshModels(name, { apiKey } = {}) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`unknown provider ${name}`);
  const key = apiKey || keyOf(name);
  const own = state[name];
  if (!key) return describe(name);
  try {
    const response = await call(name, provider.listPath, {}, key, 15000);
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? `${provider.label} rejected the API key` : `${provider.label} answered ${response.status}`);
    const body = await response.json();
    own.catalog = { at: Date.now(), models: provider.rank(body.data || []), error: null };
    // A fresh list is a fresh start: models that came back are worth trying again.
    for (const [id, entry] of own.health) if (entry.reason === "gone") own.health.delete(id);
  } catch (err) {
    own.catalog = { ...own.catalog, at: Date.now(), error: err.name === "AbortError" ? `${provider.label} did not answer` : err.message };
  }
  return describe(name);
}

async function modelsOf(name) {
  const own = state[name];
  if (own.catalog.models.length === 0 || Date.now() - own.catalog.at > LIST_TTL_MS) await refreshModels(name);
  return own.catalog.models;
}

// The models to try for one provider: the chosen one first (if any), then the rest, minus rested ones.
export async function modelOrder(name) {
  const own = state[name];
  if (own.restUntil > Date.now()) return [];
  const list = (await modelsOf(name)).map(model => model.id);
  const preferred = preferredOf(name);
  const ids = preferred ? [preferred, ...list.filter(id => id !== preferred)] : list;
  const now = Date.now();
  return ids.filter(id => !(own.health.get(id)?.until > now));
}

export function describe(name) {
  const own = state[name];
  const now = Date.now();
  return {
    provider: name,
    label: PROVIDERS[name].label,
    enabled: Boolean(keyOf(name)),
    inOrder: order().indexOf(name),
    preferred: preferredOf(name),
    refreshedAt: own.catalog.at ? new Date(own.catalog.at).toISOString() : null,
    error: own.catalog.error,
    resting: own.restUntil > now ? { reason: own.restReason, until: new Date(own.restUntil).toISOString() } : null,
    lastUsed: lastUsed?.provider === name ? lastUsed : null,
    models: own.catalog.models.map(model => {
      const entry = own.health.get(model.id);
      return {
        ...model,
        state: entry?.until > now ? entry.reason : "ok",
        until: entry?.until > now && Number.isFinite(entry.until) ? new Date(entry.until).toISOString() : null
      };
    })
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    anidbId: { type: "integer" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: { type: "string" }
  },
  required: ["anidbId", "confidence", "reason"],
  additionalProperties: false
};

function rest(name, id, response, text) {
  const own = state[name];
  if (response.status === 429) {
    const header = name => response.headers?.get?.(name);
    // OpenRouter's free allowance is per day for the whole account, not per model.
    if (/per[- ]day|daily|free-models-per-day/i.test(text)) {
      const reset = Number(header("x-ratelimit-reset"));
      own.restUntil = reset > Date.now() ? reset : Date.now() + 60 * 60 * 1000;
      own.restReason = "daily free allowance used";
      return;
    }
    const seconds = Number(header("retry-after")) || 60;
    own.health.set(id, { until: Date.now() + seconds * 1000, reason: "rate limited" });
  } else if (response.status === 404 || /decommission|deprecat|not found|does not exist|model_not_found|no endpoints/i.test(text)) {
    own.health.set(id, { until: Infinity, reason: "gone" });
  } else if (response.status === 401 || response.status === 403) {
    own.restUntil = Date.now() + 60 * 60 * 1000;
    own.restReason = "key rejected";
  } else if (response.status >= 500) {
    own.health.set(id, { until: Date.now() + 5 * 60 * 1000, reason: "unavailable" });
  } else {
    own.health.set(id, { until: Date.now() + 30 * 60 * 1000, reason: `error ${response.status}` });
  }
}

// undefined: this model failed, try the next. null: it answered with nothing usable.
async function ask(name, id, messages) {
  const own = state[name];
  const strict = !own.plainJson.has(id);
  const response = await call(name, "/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: id,
      temperature: 0,
      messages: strict
        ? messages
        : [...messages, { role: "system", content: `Reply with only a JSON object matching this schema: ${JSON.stringify(SCHEMA)}` }],
      response_format: strict
        ? { type: "json_schema", json_schema: { name: "anidb_pick", strict: true, schema: SCHEMA } }
        : { type: "json_object" }
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // A model without structured outputs still answers plain JSON; ask it that way from now on.
    if (strict && response.status === 400 && /json_schema|response_format|structured/i.test(text)) {
      own.plainJson.add(id);
      return ask(name, id, messages);
    }
    rest(name, id, response, text);
    return undefined;
  }
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content || "";
  try {
    return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "") || "null");
  } catch {
    return null;
  }
}

// `facts` describes the Sonarr season; `candidates` are { anidbId, title, type, airDate, episodes }.
// Returns { anidbId, reason, provider, model } or null.
export async function chooseSeries(facts, candidates) {
  if (candidates.length === 0) return null;
  const messages = [
    { role: "system", content: "You match anime TV seasons to AniDB entries. Be conservative: a wrong match is worse than none." },
    {
      role: "user",
      content: JSON.stringify({
        task: "Which AniDB anime is this Sonarr season? Answer with one candidate's anidbId, or 0 when none of them is clearly it.",
        notes: [
          "AniDB gives each season (often each cour) its own entry and marks same-named sequels with a year in brackets.",
          "Sonarr numbers seasons the way TVDB does, which often differs from AniDB's: a TVDB season 4 can be AniDB's 'III', and spin-offs can sit inside a TVDB season. A season number in a title is weak evidence.",
          "The strongest evidence is an AniDB start date in the same week as the season and a matching episode count. A candidate with no date or count is unknown, not wrong.",
          "A spin-off or side story with its own name is not the main season unless the release names say so."
        ],
        season: facts,
        candidates
      })
    }
  ];

  for (const name of order()) {
    let tries = 0;
    for (const id of await modelOrder(name)) {
      if (tries++ >= TRIES_PER_PROVIDER || state[name].restUntil > Date.now()) break;
      let answer;
      try {
        answer = await ask(name, id, messages);
      } catch {
        state[name].health.set(id, { until: Date.now() + 5 * 60 * 1000, reason: "unavailable" });
        continue;
      }
      if (answer === undefined) continue;
      lastUsed = { provider: name, model: id, at: new Date().toISOString() };
      // An answer is final: asking another model until one says yes would defeat the caution.
      if (!answer || answer.confidence !== "high") return null;
      if (!candidates.some(candidate => candidate.anidbId === answer.anidbId)) return null;
      return { anidbId: answer.anidbId, reason: String(answer.reason || "").slice(0, 300), provider: name, model: id };
    }
  }
  return null;
}

export function overview() {
  return { order: order(), setting: config.ai?.providers || "auto", providers: Object.keys(PROVIDERS).map(describe) };
}

// For tests.
export function _reset() {
  for (const name of Object.keys(PROVIDERS)) state[name] = fresh();
  lastUsed = null;
}
