// An optional second opinion from an LLM on Groq's free tier, for the few decisions the rules
// cannot settle on their own (two AniDB entries scoring the same for one Sonarr season). Off unless
// GROQ_API_KEY is set. The model only ever picks among candidates the rules already kept, its
// answer is held to a JSON schema, and anything but a "high" confidence pick counts as no.
//
// No model is hardcoded. The list comes from Groq's /models for your key (on a free key, that is
// what the free tier offers), refreshed daily or from Settings. A model that is rate limited is
// rested for as long as Groq asks, one that is gone is dropped until the next refresh, and the next
// one in line answers instead. GROQ_MODEL, or the Settings picker, only puts one model first.

import { config } from "./config.js";

const BASE = "https://api.groq.com/openai/v1";
const LIST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRIES = 4;

// Speech, moderation, agentic and embedding models cannot answer a chat question with JSON.
const NOT_CHAT = /whisper|tts|playai|orpheus|guard|safeguard|distil|compound|allam|embed|vision-preview/i;
// Families Groq documents strict JSON-schema output for; they go first when nothing else decides.
const STRICT = /gpt-oss|kimi-k2|llama-4/i;

let catalog = { at: 0, models: [], error: null };
const health = new Map(); // id -> { until, reason }
const plainJson = new Set(); // ids that refused strict json_schema
let lastUsed = null;

export function enabled() {
  return Boolean(config.groq.apiKey);
}

function headers(apiKey = config.groq.apiKey) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function call(path, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const size = id => Number(/(\d+(?:\.\d+)?)b\b/i.exec(id)?.[1] || 0);

// Strongest first: strict-schema families, then parameter count, then context window.
export function rankModels(models) {
  return models
    .filter(model => model.active !== false && !NOT_CHAT.test(model.id))
    .map(model => ({
      id: model.id,
      owner: model.owned_by || null,
      contextWindow: model.context_window || null,
      strict: STRICT.test(model.id)
    }))
    .sort((a, b) => Number(b.strict) - Number(a.strict) || size(b.id) - size(a.id) || (b.contextWindow || 0) - (a.contextWindow || 0) || a.id.localeCompare(b.id));
}

// The models this key can use. `apiKey` lets Settings try a key before it is saved.
export async function refreshModels({ apiKey } = {}) {
  const key = apiKey || config.groq.apiKey;
  if (!key) return describe();
  try {
    const response = await call("/models", { headers: headers(key) }, 15000);
    if (!response.ok) throw new Error(response.status === 401 ? "Groq rejected the API key" : `Groq answered ${response.status}`);
    const body = await response.json();
    catalog = { at: Date.now(), models: rankModels(body.data || []), error: null };
    // A fresh list is a fresh start: models that came back are worth trying again.
    for (const id of [...health.keys()]) if (health.get(id).reason === "gone") health.delete(id);
  } catch (err) {
    catalog = { ...catalog, at: Date.now(), error: err.name === "AbortError" ? "Groq did not answer" : err.message };
  }
  return describe();
}

async function models() {
  if (catalog.models.length === 0 || Date.now() - catalog.at > LIST_TTL_MS) await refreshModels();
  return catalog.models;
}

// The order to try models in: the chosen one first (if any), then the rest, skipping rested ones.
export async function order() {
  const list = (await models()).map(model => model.id);
  const preferred = config.groq.model && config.groq.model !== "auto" ? config.groq.model : null;
  const ids = preferred ? [preferred, ...list.filter(id => id !== preferred)] : list;
  const now = Date.now();
  return ids.filter(id => !(health.get(id)?.until > now));
}

export function describe() {
  const now = Date.now();
  return {
    enabled: enabled(),
    preferred: config.groq.model && config.groq.model !== "auto" ? config.groq.model : null,
    refreshedAt: catalog.at ? new Date(catalog.at).toISOString() : null,
    error: catalog.error,
    lastUsed,
    models: catalog.models.map(model => {
      const state = health.get(model.id);
      return {
        ...model,
        state: state?.until > now ? state.reason : "ok",
        until: state?.until > now && Number.isFinite(state.until) ? new Date(state.until).toISOString() : null
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

function rest(id, response, text) {
  if (response.status === 429) {
    const seconds = Number(response.headers?.get?.("retry-after")) || 60;
    health.set(id, { until: Date.now() + seconds * 1000, reason: "rate limited" });
  } else if (response.status === 404 || /decommission|deprecat|not found|does not exist|model_not_found/i.test(text)) {
    health.set(id, { until: Infinity, reason: "gone" });
  } else if (response.status >= 500) {
    health.set(id, { until: Date.now() + 5 * 60 * 1000, reason: "unavailable" });
  } else {
    health.set(id, { until: Date.now() + 30 * 60 * 1000, reason: `error ${response.status}` });
  }
}

async function ask(id, messages) {
  const strict = !plainJson.has(id);
  const response = await call("/chat/completions", {
    method: "POST",
    headers: headers(),
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
    // A model without structured outputs still answers plain JSON; ask it that way next time.
    if (strict && response.status === 400 && /json_schema|response_format|structured/i.test(text)) {
      plainJson.add(id);
      return ask(id, messages);
    }
    rest(id, response, text);
    return undefined;
  }
  const body = await response.json();
  try {
    return JSON.parse(body.choices?.[0]?.message?.content || "null");
  } catch {
    return null;
  }
}

// `facts` describes the Sonarr season; `candidates` are { anidbId, title, type, airDate, episodes }.
// Returns { anidbId, reason, model } or null.
export async function chooseSeries(facts, candidates) {
  if (!enabled() || candidates.length === 0) return null;
  const messages = [
    { role: "system", content: "You match anime TV seasons to AniDB entries. Be conservative: a wrong match is worse than none." },
    {
      role: "user",
      content: JSON.stringify({
        task: "Which AniDB anime is this Sonarr season? Answer with one candidate's anidbId, or 0 when none of them is clearly it. AniDB gives each season its own entry and marks same-named sequels with a year in brackets.",
        season: facts,
        candidates
      })
    }
  ];

  let tries = 0;
  for (const id of await order()) {
    if (tries++ >= MAX_TRIES) break;
    let answer;
    try {
      answer = await ask(id, messages);
    } catch {
      health.set(id, { until: Date.now() + 5 * 60 * 1000, reason: "unavailable" });
      continue;
    }
    if (answer === undefined) continue; // that model failed; the next one answers
    lastUsed = { model: id, at: new Date().toISOString() };
    if (!answer || answer.confidence !== "high") return null;
    if (!candidates.some(candidate => candidate.anidbId === answer.anidbId)) return null;
    return { anidbId: answer.anidbId, reason: String(answer.reason || "").slice(0, 300), model: id };
  }
  return null;
}

// For tests.
export function _reset() {
  catalog = { at: 0, models: [], error: null };
  health.clear();
  plainJson.clear();
  lastUsed = null;
}
