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
const facts = { seasonNumber: 4 };
const candidates = [{ anidbId: 19882, title: "Shiguang Dailiren III" }, { anidbId: 19078, title: "Link Click - Bridon Arc" }];
const answer = content => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
let sent = null;
globalThis.fetch = async (url, options) => { sent = JSON.parse(options.body); return answer({ anidbId: 19882, confidence: "high", reason: "third Chinese season aired that week" })(); };
check("a confident pick among the candidates is taken", (await groq.chooseSeries(facts, candidates))?.anidbId === 19882);
check("its answer is held to a strict schema", sent?.response_format?.json_schema?.strict === true);
globalThis.fetch = answer({ anidbId: 19882, confidence: "medium", reason: "" });
check("anything less than high is no", (await groq.chooseSeries(facts, candidates)) === null);
globalThis.fetch = answer({ anidbId: 5, confidence: "high", reason: "" });
check("an id that was not offered is no", (await groq.chooseSeries(facts, candidates)) === null);
globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
check("a rate limit is no", (await groq.chooseSeries(facts, candidates)) === null);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
