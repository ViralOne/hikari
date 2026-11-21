// Which AniDB anime a Sonarr season is, from titles, years and air dates. Every case is a real one
// from a library where the id bridges had nothing. Run: npm test
process.env.GROQ_API_KEY = "test-key";
const { airTiming, airingRun, decide, releaseShowNames, scoreCandidates, titleOrdinal, titleYear } = await import("../server/seasonmatch.js");
const groq = await import("../server/groq.js");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const at = date => Date.parse(date);
const sonarr = titles => titles.map(title => ({ title, weight: 1, from: "sonarr" }));

console.log("reading names");
check("year", titleYear("Kikansha no Mahou wa Tokubetsu Desu (2026)") === 2026 && titleYear("Kikansha no Mahou wa Tokubetsu Desu") === null);
check("ordinals", titleOrdinal("Youjo Senki II") === 2 && titleOrdinal("Tensei Kizoku, Kantei Skill de Nariagaru Dai 3 Ki") === 3 &&
  titleOrdinal("Sasaki to P-chan Season 2") === 2 && titleOrdinal("Link Click 2nd Season") === 2 && titleOrdinal("Tougen Anki") === null);
check("Erai-raws release", releaseShowNames("[Erai-raws] Tougen Anki: Nikko Kegon no Taki-hen - 06 [1080p CR WEB-DL AVC AAC][MultiSub][5C6C4B4F]")[0] === "Tougen Anki: Nikko Kegon no Taki-hen");
check("scene release", releaseShowNames("A Returners Magic Should Be Special S02E07 1080p WEB H264-SUGOI")[0] === "A Returners Magic Should Be Special");
check("ToonsHub alternates", releaseShowNames("[ToonsHub] Bleach Thousand-Year Blood War S01E49 1080p BILI WEB-DL AAC2.0 H.265 (BLEACH: Sennen Kessen-hen, Multi-Subs)").includes("BLEACH: Sennen Kessen-hen"));

console.log("air dates");
check("same week", airTiming(at("2026-10-08"), 12, at("2026-10-08")) === "week");
check("mid-cour after a broadcast break", airTiming(at("2026-07-25"), 10, at("2026-10-19")) === "airing");
check("a previous season is not", airTiming(at("2025-07-10"), 12, at("2026-10-08")) === null);
const bleach = [41, 42, 43, 44, 45, 46, 47, 48, 49, 50].map((n, i) => ({ seasonNumber: 17, episodeNumber: n, airDate: i < 8 ? new Date(at("2026-07-25") + i * 7 * 864e5).toISOString().slice(0, 10) : ["2026-10-19", "2026-10-26"][i - 8] }));
check("runs split at a gap", airingRun(bleach, [50]).map(e => e.episodeNumber).join() === "49,50");

console.log("choosing");
const returner = scoreCandidates(
  { seasonNumber: 2, seasonStart: at("2026-10-08"), episodeCount: 12, titles: sonarr(["A Returner's Magic Should Be Special", "Kikansha no Mahou wa Tokubetsu desu"]) },
  [
    { anidbId: 17944, shokoId: null, title: "Kikansha no Mahou wa Tokubetsu Desu", type: "Unknown", airDate: null, episodes: null },
    { anidbId: 18345, shokoId: null, title: "Kikansha no Mahou wa Tokubetsu Desu (2026)", type: "Unknown", airDate: null, episodes: null },
    { anidbId: 1623, shokoId: null, title: "Seikai no Monshou Tokubetsu Hen", type: "Unknown", airDate: null, episodes: null }
  ]
);
check("the year tells a new season from the first, before Shoko has it", decide(returner)?.anidbId === 18345, returner.map(c => `${c.anidbId}:${c.score}`).join(" "));
const firstSeason = scoreCandidates(
  { seasonNumber: 1, seasonStart: at("2025-07-10"), episodeCount: 12, titles: sonarr(["A Returner's Magic Should Be Special", "Kikansha no Mahou wa Tokubetsu desu"]) },
  returner.map(({ score, reasons, ...c }) => c)
);
check("and the plain title is the first season", decide(firstSeason)?.anidbId === 17944);
check("a year from another season rules it out", !firstSeason.some(c => c.anidbId === 18345));

const tanya = scoreCandidates(
  { seasonNumber: 2, seasonStart: at("2026-07-08"), episodeCount: 12, titles: sonarr(["Saga of Tanya the Evil", "Youjo Senki"]) },
  [
    { anidbId: 11905, title: "Youjo Senki", airDate: "2017-01-06", episodes: 12 },
    { anidbId: 16392, title: "Youjo Senki II", airDate: "2026-07-08", episodes: 12 }
  ]
);
check("a known air date from another year rules it out", tanya.length === 1 && decide(tanya)?.anidbId === 16392);

const linkClick = scoreCandidates(
  { seasonNumber: 4, seasonStart: at("2026-08-14"), episodeCount: 12, titles: sonarr(["Link Click", "Shiguang Dailiren", "Link Click - Bridon Arc", "Link Click S3"]) },
  [
    { anidbId: 19882, title: "Shiguang Dailiren III", airDate: "2026-08-14", episodes: 12 },
    { anidbId: 19078, title: "Link Click - Bridon Arc", airDate: null, episodes: null }
  ]
);
check("too close to call is left alone", decide(linkClick) === null, linkClick.map(c => `${c.anidbId}:${c.score}`).join(" "));
check("movies are never candidates", scoreCandidates({ seasonNumber: 1, seasonStart: null, episodeCount: 12, titles: sonarr(["Bleach"]) }, [{ anidbId: 1, title: "Bleach", type: "Movie" }]).length === 0);

console.log("the AI second opinion");
const { config } = await import("../server/config.js");
const facts = { seasonNumber: 4 };
const candidates = [{ anidbId: 19882, title: "Shiguang Dailiren III" }, { anidbId: 19078, title: "Link Click - Bridon Arc" }];
const MODELS = [
  { id: "whisper-large-v3", active: true, context_window: 448 },
  { id: "llama-3.1-8b-instant", active: true, context_window: 131072 },
  { id: "llama-3.3-70b-versatile", active: true, context_window: 131072 },
  { id: "openai/gpt-oss-120b", active: true, context_window: 131072 },
  { id: "meta-llama/llama-guard-4-12b", active: true, context_window: 131072 },
  { id: "old-model", active: false, context_window: 8192 }
];
const reply = (status, body, extra = {}) => ({
  ok: status < 300, status,
  headers: { get: name => extra[name.toLowerCase()] ?? null },
  json: async () => body, text: async () => JSON.stringify(body)
});
const pick = content => reply(200, { choices: [{ message: { content: JSON.stringify(content) } }] });
// Answers per model, in call order; `calls` records which model each chat request went to.
const stack = (perModel) => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith("/models")) return reply(200, { data: MODELS });
    const body = JSON.parse(options.body);
    calls.push({ model: body.model, format: body.response_format.type });
    const next = perModel[body.model];
    return typeof next === "function" ? next(body) : next ?? reply(500, {});
  };
  return calls;
};
const good = pick({ anidbId: 19882, confidence: "high", reason: "third Chinese season aired that week" });

groq._reset();
stack({});
await groq.refreshModels();
const ranked = groq.describe().models.map(model => model.id);
check("only chat models, strongest and strict-capable first", ranked.join() === "openai/gpt-oss-120b,llama-3.3-70b-versatile,llama-3.1-8b-instant", ranked.join());

groq._reset();
let calls = stack({ "openai/gpt-oss-120b": good });
check("a confident pick among the candidates is taken", (await groq.chooseSeries(facts, candidates))?.anidbId === 19882);
check("no model is hardcoded: the first from the list answers", calls[0]?.model === "openai/gpt-oss-120b" && calls[0]?.format === "json_schema");

groq._reset();
calls = stack({ "openai/gpt-oss-120b": reply(429, {}, { "retry-after": "30" }), "llama-3.3-70b-versatile": good });
check("a rate-limited model hands over to the next", (await groq.chooseSeries(facts, candidates))?.model === "llama-3.3-70b-versatile");
check("and rests for as long as Groq asked", groq.describe().models.find(m => m.id === "openai/gpt-oss-120b")?.state === "rate limited");
calls = stack({ "openai/gpt-oss-120b": good, "llama-3.3-70b-versatile": good });
await groq.chooseSeries(facts, candidates);
check("so the next question skips it", calls[0]?.model === "llama-3.3-70b-versatile");

groq._reset();
stack({ "openai/gpt-oss-120b": reply(400, { error: { message: "The model `openai/gpt-oss-120b` has been decommissioned", code: "model_decommissioned" } }), "llama-3.3-70b-versatile": good });
await groq.chooseSeries(facts, candidates);
check("a retired model is dropped until the list is refreshed", groq.describe().models.find(m => m.id === "openai/gpt-oss-120b")?.state === "gone");

groq._reset();
calls = stack({ "llama-3.3-70b-versatile": body => body.response_format.type === "json_schema"
  ? reply(400, { error: { message: "response_format json_schema is not supported with this model" } })
  : good });
config.groq.model = "llama-3.3-70b-versatile";
check("a chosen model goes first, and without strict schemas it is asked for plain JSON",
  (await groq.chooseSeries(facts, candidates))?.model === "llama-3.3-70b-versatile" && calls.map(c => c.format).join() === "json_schema,json_object");
config.groq.model = "";

groq._reset();
stack({ "openai/gpt-oss-120b": pick({ anidbId: 19882, confidence: "medium", reason: "" }) });
check("anything less than high is no", (await groq.chooseSeries(facts, candidates)) === null);
groq._reset();
stack({ "openai/gpt-oss-120b": pick({ anidbId: 5, confidence: "high", reason: "" }) });
check("an id that was not offered is no", (await groq.chooseSeries(facts, candidates)) === null);
groq._reset();
calls = stack({});
check("when every model fails it is no, after a few tries", (await groq.chooseSeries(facts, candidates)) === null && calls.length === 3);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
