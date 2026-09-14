// Builds fixtures/cour-cases.json from the live Sonarr and AniList data, so the cour mapper is
// tested against real season shapes rather than shapes someone imagined. Run: npm run fixtures:cours
//
// Every pair below was verified by hand before being listed. The interesting ones are the two
// disagreement directions:
//   - TMDB lumps, TVDB splits: Hell's Paradise, 'Tis Time for "Torture," Princess
//   - AniList splits, TVDB lumps: Slime 2nd Season Part 1 / Part 2 both live in Sonarr's S2
// The rest are shows where everyone agrees, and they are here to prove the mapper leaves them be.

import { writeFileSync } from "node:fs";

const SONARR_URL = process.env.SONARR_URL;
const SONARR_API_KEY = process.env.SONARR_API_KEY;

if (!SONARR_URL || !SONARR_API_KEY) {
  console.error("SONARR_URL and SONARR_API_KEY are required. Run with --env-file-if-exists=.env");
  process.exit(1);
}

// seriesId is Sonarr's, and is only used to fetch episodes. The fixture stores the tvdbId so a
// rebuild against a different Sonarr install still describes the same show.
const CASES = [
  {
    series: 172,
    label: "Hell's Paradise",
    note: "TMDB has one 25-episode season; TVDB splits 13 + 12.",
    entries: [
      { anilistId: 128893, label: "Jigokuraku", expect: { seasonNumber: 1, first: 1, last: 13 } },
      { anilistId: 166613, label: "Jigokuraku 2nd Season", expect: { seasonNumber: 2, first: 14, last: 25 } }
    ]
  },
  {
    series: 170,
    label: "'Tis Time for \"Torture,\" Princess",
    note: "TMDB has one 24-episode season; TVDB splits 12 + 12.",
    entries: [
      { anilistId: 166522, label: "Hime-sama, \"Goumon\" no Jikan desu", expect: { seasonNumber: 1, first: 1, last: 12 } },
      {
        anilistId: 176370,
        label: "Hime-sama, \"Goumon\" no Jikan desu 2nd Season",
        expect: { seasonNumber: 2, first: 13, last: 24 }
      }
    ]
  },
  {
    series: 158,
    label: "That Time I Got Reincarnated as a Slime",
    note: "The reverse case: AniList splits 2nd Season into two cours, TVDB keeps them as one 24-episode S2.",
    entries: [
      { anilistId: 101280, label: "Slime S1", expect: { seasonNumber: 1, first: 1, last: 24 } },
      { anilistId: 108511, label: "Slime 2nd Season (part 1)", expect: { seasonNumber: 2, first: 25, last: 36 } },
      { anilistId: 116742, label: "Slime 2nd Season Part 2", expect: { seasonNumber: 2, first: 37, last: 48 } },
      { anilistId: 156822, label: "Slime 3rd Season", expect: { seasonNumber: 3, first: 49, last: 72 } },
      { anilistId: 182205, label: "Slime 4th Season", expect: { seasonNumber: 4, first: 73, last: 96 } }
    ]
  },
  {
    series: 159,
    label: "Wistoria: Wand and Sword",
    note: "Everyone agrees. Proves the mapper does not invent work on well-behaved shows.",
    entries: [
      { anilistId: 174576, label: "Wistoria S1", expect: { seasonNumber: 1, first: 1, last: 12 } },
      { anilistId: 182300, label: "Wistoria Season 2", expect: { seasonNumber: 2, first: 13, last: 24 } }
    ]
  },
  {
    series: 171,
    label: "Farming Life in Another World",
    note: "Everyone agrees.",
    entries: [
      { anilistId: 146850, label: "Isekai Nonbiri Nouka", expect: { seasonNumber: 1, first: 1, last: 12 } },
      { anilistId: 197824, label: "Isekai Nonbiri Nouka 2", expect: { seasonNumber: 2, first: 13, last: 24 } }
    ]
  }
];

async function sonarr(path) {
  const res = await fetch(`${SONARR_URL}/api/v3${path}`, { headers: { "X-Api-Key": SONARR_API_KEY } });
  if (!res.ok) throw new Error(`Sonarr responded ${res.status} for ${path}`);
  return res.json();
}

async function anilist(ids) {
  const query = `{
    Page(perPage: 50) {
      media(id_in: [${ids.join(",")}], type: ANIME) {
        id
        title { romaji english }
        format
        episodes
        startDate { year month day }
      }
    }
  }`;

  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query })
  });
  if (!res.ok) throw new Error(`AniList responded ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(`AniList: ${JSON.stringify(body.errors)}`);
  return body.data.Page.media;
}

const wanted = CASES.flatMap(entry => entry.entries.map(item => item.anilistId));
const media = await anilist(wanted);
const byId = new Map(media.map(item => [item.id, item]));

const out = { generated: new Date().toISOString().slice(0, 10), shows: [] };

for (const testCase of CASES) {
  const series = await sonarr(`/series/${testCase.series}`);
  const episodes = await sonarr(`/episode?seriesId=${testCase.series}`);

  const show = {
    label: testCase.label,
    note: testCase.note,
    tvdbId: series.tvdbId,
    tmdbId: series.tmdbId ?? null,
    // Only the fields the mapper reads. Specials (season 0) are excluded: AniList entries never
    // map onto them, and including 50 Apothecary specials would bloat the fixture for nothing.
    episodes: episodes
      .filter(episode => episode.seasonNumber > 0)
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
      .map(episode => ({
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        absoluteEpisodeNumber: episode.absoluteEpisodeNumber ?? null,
        airDate: episode.airDate || null
      })),
    entries: testCase.entries.map(entry => {
      const anime = byId.get(entry.anilistId);
      if (!anime) throw new Error(`AniList ${entry.anilistId} (${entry.label}) not found`);
      return {
        label: entry.label,
        anime: {
          id: anime.id,
          title: anime.title,
          format: anime.format,
          episodes: anime.episodes,
          startDate: anime.startDate
        },
        expect: entry.expect
      };
    })
  };

  out.shows.push(show);
  console.log(`${show.label}: ${show.episodes.length} episodes, ${show.entries.length} AniList entries`);
}

writeFileSync(new URL("../fixtures/cour-cases.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nWrote fixtures/cour-cases.json`);
