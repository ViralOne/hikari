import { writeFileSync, mkdirSync } from "node:fs";

// Builds a labelled matching dataset from the live stack, read-only.
//
// Ground truth comes from id bridges, never from string similarity. Shoko is the bridge:
// it records MAL ids (which map to AniList via idMal), TvDB ids (which map to Sonarr) and
// AniDB ids (which map to Jellyfin items). Every pair below is therefore known-correct.
//
// Run: node --env-file-if-exists=.env scripts/build-match-fixtures.mjs

const need = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/+$/, "");
};

const SHOKO = need("SHOKO_URL");
const SHOKO_KEY = need("SHOKO_API_KEY");
const SONARR = need("SONARR_URL");
const SONARR_KEY = need("SONARR_API_KEY");
const JF = process.env.JELLYFIN_URL?.replace(/\/+$/, "");
const JF_KEY = process.env.JELLYFIN_API_KEY;
const JF_USER = process.env.JELLYFIN_USER_ID;

const get = async (url, headers) => {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
};

const anilist = async (query, variables) => {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "hikari-fixtures" },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`anilist ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(body.errors.map(e => e.message).join("; "));
  return body.data;
};

// --- Shoko: the bridge
const shokoSeries = [];
for (let page = 1; page <= 20; page += 1) {
  const body = await get(`${SHOKO}/api/v3/Series?pageSize=100&page=${page}`, { apikey: SHOKO_KEY });
  const batch = body.List || [];
  shokoSeries.push(...batch);
  if (batch.length < 100) break;
}
console.log(`Shoko series: ${shokoSeries.length}`);

// --- Sonarr, keyed by tvdb
const sonarrList = await get(`${SONARR}/api/v3/series`, { "X-Api-Key": SONARR_KEY });
const sonarrByTvdb = new Map(sonarrList.map(item => [item.tvdbId, item]));
console.log(`Sonarr series: ${sonarrList.length}`);

// --- Jellyfin, keyed by anidb
const jellyfinByAnidb = new Map();
if (JF && JF_KEY) {
  const body = await get(
    `${JF}/Items?userId=${JF_USER}&IncludeItemTypes=Series&Recursive=true&Fields=ProviderIds,OriginalTitle`,
    { Authorization: `MediaBrowser Token="${JF_KEY}"` }
  );
  for (const item of body.Items || []) {
    const anidb = item.ProviderIds?.AniDB;
    if (anidb) jellyfinByAnidb.set(Number(anidb), item);
  }
  console.log(`Jellyfin items with an AniDB id: ${jellyfinByAnidb.size}`);
}

// --- AniList entries by MAL id
const malIds = [...new Set(shokoSeries.flatMap(s => s.IDs?.MAL || []).map(Number))];
const byMal = new Map();

for (let i = 0; i < malIds.length; i += 40) {
  const slice = malIds.slice(i, i + 40);
  const data = await anilist(
    `query ($ids: [Int]) {
       Page(page: 1, perPage: 50) {
         media(idMal_in: $ids, type: ANIME) {
           id idMal format episodes
           title { romaji english native }
         }
       }
     }`,
    { ids: slice }
  );
  for (const entry of data.Page.media) byMal.set(entry.idMal, entry);
  await new Promise(resolve => setTimeout(resolve, 900));
}
console.log(`AniList entries resolved by MAL id: ${byMal.size}`);

// --- pairs
const sonarrCases = [];
const jellyfinCases = [];

for (const series of shokoSeries) {
  const ids = series.IDs || {};
  const entry = (ids.MAL || []).map(Number).map(mal => byMal.get(mal)).find(Boolean);
  if (!entry) continue;

  const titles = [entry.title.romaji, entry.title.english, entry.title.native].filter(Boolean);

  for (const tvdb of ids.TvDB || []) {
    const sonarrSeries = sonarrByTvdb.get(Number(tvdb));
    if (!sonarrSeries) continue;
    sonarrCases.push({
      anilistId: entry.id,
      titles,
      format: entry.format,
      target: sonarrSeries.title,
      targetAlternates: (sonarrSeries.alternateTitles || []).map(alt => alt.title).slice(0, 8),
      via: "shoko:tvdb"
    });
  }

  const jellyfinItem = ids.AniDB ? jellyfinByAnidb.get(Number(ids.AniDB)) : null;
  if (jellyfinItem) {
    jellyfinCases.push({
      anilistId: entry.id,
      titles,
      format: entry.format,
      target: jellyfinItem.Name,
      targetAlternates: [jellyfinItem.OriginalTitle].filter(Boolean),
      via: "shoko:anidb"
    });
  }
}

// Negatives: the same AniList titles against library entries that are definitely not them.
let seed = 20260913;
const nextRandom = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const buildNegatives = (cases, pool, perCase = 8) => {
  const out = [];
  for (const item of cases) {
    const picked = new Set();
    let guard = 0;
    while (picked.size < perCase && guard < perCase * 20) {
      guard += 1;
      const candidate = pool[Math.floor(nextRandom() * pool.length)];
      if (!candidate || candidate === item.target) continue;
      picked.add(candidate);
    }
    for (const candidate of picked) {
      out.push({ anilistId: item.anilistId, titles: item.titles, format: item.format, target: candidate });
    }
  }
  return out;
};

const fixtures = {
  builtAt: new Date().toISOString(),
  sonarr: {
    positives: sonarrCases,
    negatives: buildNegatives(sonarrCases, sonarrList.map(s => s.title))
  },
  jellyfin: {
    positives: jellyfinCases,
    negatives: buildNegatives(jellyfinCases, [...jellyfinByAnidb.values()].map(i => i.Name))
  }
};

mkdirSync("fixtures", { recursive: true });
writeFileSync("fixtures/match-cases.json", JSON.stringify(fixtures, null, 2));

console.log(`\nwrote fixtures/match-cases.json`);
console.log(`  sonarr:   ${sonarrCases.length} positives, ${fixtures.sonarr.negatives.length} negatives`);
console.log(`  jellyfin: ${jellyfinCases.length} positives, ${fixtures.jellyfin.negatives.length} negatives`);
