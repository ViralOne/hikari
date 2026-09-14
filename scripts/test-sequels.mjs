import { candidates, rank } from "../server/sequels.js";

// The sequel row decides what to put in front of you, so the rules for what counts and what order it
// comes in are pinned here. Both functions are pure, so this needs no AniList and no token.
// Run: npm test

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const anime = (id, extra = {}) => ({ id, type: "ANIME", format: "TV", status: "FINISHED", isAdult: false, ...extra });

const entry = ({ id, status = "COMPLETED", score = 0, progress = 0, episodes = 12, title = `Show ${id}`, sequels = [], relations = [] }) => ({
  status,
  score,
  progress,
  media: {
    id,
    episodes,
    title: { english: title, romaji: title },
    relations: { edges: [...sequels.map(node => ({ relationType: "SEQUEL", node })), ...relations] }
  }
});

const collection = entries => ({ lists: [{ entries }] });
const ids = found => [...found.keys()].sort((a, b) => a - b);

console.log("what counts as a sequel worth showing");

check(
  "a sequel to a completed show is suggested",
  ids(candidates(collection([entry({ id: 1, sequels: [anime(2)] })]))).join() === "2"
);

check(
  "a sequel already on the list is not a discovery",
  candidates(collection([entry({ id: 1, sequels: [anime(2)] }), entry({ id: 2, status: "PLANNING" })])).size === 0
);

check(
  "a sequel to something you dropped is not suggested",
  candidates(collection([entry({ id: 1, status: "DROPPED", sequels: [anime(2)] })])).size === 0
);

check(
  "a sequel to something you paused is not suggested",
  candidates(collection([entry({ id: 1, status: "PAUSED", sequels: [anime(2)] })])).size === 0
);

// Halfway is the line, so sampling two episodes of a long show does not fill the row.
check(
  "a show you are under halfway through does not suggest its sequel",
  candidates(collection([entry({ id: 1, status: "CURRENT", progress: 5, episodes: 12, sequels: [anime(2)] })])).size === 0
);
check(
  "at halfway it does",
  candidates(collection([entry({ id: 1, status: "CURRENT", progress: 6, episodes: 12, sequels: [anime(2)] })])).size === 1
);
check(
  "with no episode count, one episode watched is enough",
  candidates(collection([entry({ id: 1, status: "CURRENT", progress: 1, episodes: null, sequels: [anime(2)] })])).size === 1 &&
    candidates(collection([entry({ id: 1, status: "CURRENT", progress: 0, episodes: null, sequels: [anime(2)] })])).size === 0
);
check(
  "rewatching counts as a source",
  candidates(collection([entry({ id: 1, status: "REPEATING", progress: 12, sequels: [anime(2)] })])).size === 1
);

console.log("\nwhat gets filtered out");

// Relations cross media types, so without this a manga continuation lands in an anime row.
check(
  "a manga continuation is not an anime suggestion",
  candidates(collection([entry({ id: 1, sequels: [anime(2, { type: "MANGA" })] })])).size === 0
);
check("adult titles are excluded", candidates(collection([entry({ id: 1, sequels: [anime(2, { isAdult: true })] })])).size === 0);
check(
  "only SEQUEL edges count",
  candidates(
    collection([
      entry({
        id: 1,
        relations: [
          { relationType: "PREQUEL", node: anime(2) },
          { relationType: "SIDE_STORY", node: anime(3) },
          { relationType: "ADAPTATION", node: anime(4) }
        ]
      })
    ])
  ).size === 0
);
check("a self-referencing edge is ignored", candidates(collection([entry({ id: 1, sequels: [anime(1)] })])).size === 0);
check(
  "a null node does not throw",
  candidates(collection([{ status: "COMPLETED", score: 0, progress: 1, media: { id: 1, episodes: 1, relations: { edges: [{ relationType: "SEQUEL", node: null }] } } }])).size === 0
);
check("an empty collection is empty, not an error", candidates({}).size === 0 && candidates(null).size === 0);

// Only the next unwatched step should surface: S3 follows S2, which you have not seen either.
check(
  "a chain only surfaces the next step",
  ids(candidates(collection([entry({ id: 1, sequels: [anime(2)] })]))).join() === "2"
);

console.log("\nwhy it is being suggested");

const shared = candidates(
  collection([
    entry({ id: 1, title: "Liked it", score: 70, sequels: [anime(9)] }),
    entry({ id: 2, title: "Loved it", score: 95, sequels: [anime(9)] })
  ])
);
check(
  "when two shows point at the same sequel, the one you rated highest is the reason",
  shared.get(9)?.because.title === "Loved it" && shared.get(9)?.because.score === 95
);

const unrated = candidates(collection([entry({ id: 1, title: "Never rated", score: 0, sequels: [anime(9)] })]));
check("an unrated parent still produces a reason", unrated.get(9)?.because.title === "Never rated");

console.log("\norder");

const reasons = new Map([
  [1, { because: { title: "A", score: 60 } }],
  [2, { because: { title: "B", score: 90 } }],
  [3, { because: { title: "C", score: 50 } }],
  [4, { because: { title: "D", score: 99 } }]
]);
const ordered = rank(
  [
    { id: 1, status: "FINISHED", popularity: 10 },
    { id: 2, status: "NOT_YET_RELEASED", popularity: 10, startDate: { year: 2027, month: 1, day: 1 } },
    { id: 3, status: "RELEASING", popularity: 10 },
    { id: 4, status: "NOT_YET_RELEASED", popularity: 10, startDate: { year: 2026, month: 4, day: 1 } }
  ],
  reasons
).map(item => item.id);
check("airing now, then watchable, then still coming", ordered.join() === "3,1,4,2", ordered.join());

const soonest = rank(
  [
    { id: 2, status: "NOT_YET_RELEASED", startDate: { year: 2027, month: 1, day: 1 } },
    { id: 4, status: "NOT_YET_RELEASED", startDate: { year: 2026, month: 4, day: 1 } }
  ],
  reasons
).map(item => item.id);
check("within what is still coming, the soonest first", soonest.join() === "4,2", soonest.join());

// A sequel with no announced date must not jump the queue ahead of one with a date.
const undated = rank(
  [
    { id: 4, status: "NOT_YET_RELEASED", startDate: null },
    { id: 2, status: "NOT_YET_RELEASED", startDate: { year: 2027, month: 1, day: 1 } }
  ],
  reasons
).map(item => item.id);
check("an unannounced date sorts last", undated.join() === "2,4", undated.join());

const byScore = rank(
  [
    { id: 1, status: "FINISHED", popularity: 10 },
    { id: 2, status: "FINISHED", popularity: 10 }
  ],
  reasons
).map(item => item.id);
check("in the same bucket, the better-rated parent wins", byScore.join() === "2,1", byScore.join());

const byPopularity = rank(
  [
    { id: 1, status: "FINISHED", popularity: 10 },
    { id: 3, status: "FINISHED", popularity: 5000 }
  ],
  new Map([
    [1, { because: { title: "A", score: 80 } }],
    [3, { because: { title: "C", score: 80 } }]
  ])
).map(item => item.id);
check("an equal rating falls back to popularity", byPopularity.join() === "3,1", byPopularity.join());

check("media with no reason is dropped", rank([{ id: 77, status: "FINISHED" }], reasons).length === 0);
check("the reason is attached to the media", rank([{ id: 2, status: "FINISHED" }], reasons)[0].because.title === "B");
check("a null entry does not throw", rank([null, { id: 2, status: "FINISHED" }], reasons).length === 1);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
