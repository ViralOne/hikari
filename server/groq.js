// An optional second opinion from an LLM on Groq's free tier, for the few decisions the rules
// cannot settle on their own (two AniDB entries scoring the same for one Sonarr season). Off unless
// GROQ_API_KEY is set. The model only ever picks among candidates the rules already kept, its
// answer is constrained to a JSON schema, and anything but a "high" confidence pick counts as no.

import { config } from "./config.js";

const URL = "https://api.groq.com/openai/v1/chat/completions";

export function enabled() {
  return Boolean(config.groq.apiKey);
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

// `facts` describes the Sonarr season; `candidates` are { anidbId, title, type, airDate, episodes }.
// Returns { anidbId, reason } or null.
export async function chooseSeries(facts, candidates) {
  if (!enabled() || candidates.length === 0) return null;
  const prompt = {
    task: "Which AniDB anime is this Sonarr season? Answer with one candidate's anidbId, or 0 when none of them is clearly it. AniDB gives each season its own entry and marks same-named sequels with a year in brackets.",
    season: facts,
    candidates
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(URL, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${config.groq.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.groq.model,
        temperature: 0,
        messages: [
          { role: "system", content: "You match anime TV seasons to AniDB entries. Be conservative: a wrong match is worse than none." },
          { role: "user", content: JSON.stringify(prompt) }
        ],
        response_format: { type: "json_schema", json_schema: { name: "anidb_pick", strict: true, schema: SCHEMA } }
      })
    });
    if (!response.ok) return null;
    const body = await response.json();
    const answer = JSON.parse(body.choices?.[0]?.message?.content || "{}");
    if (answer.confidence !== "high") return null;
    if (!candidates.some(candidate => candidate.anidbId === answer.anidbId)) return null;
    return { anidbId: answer.anidbId, reason: String(answer.reason || "").slice(0, 300) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
