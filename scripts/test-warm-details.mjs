import { createDetailWarmer, detailTargets } from "../server/warm-details.js";

// Opening a Discover card the first time used to pay for the slow, long-lived parts of the panel on
// the spot: the Jellyseerr/TMDB title search (cached 30 minutes) and AniList's franchise and prequel
// walks (cached a day). The warmer pays for them in the background for the first cards of every
// row, which are the ones anybody actually opens. What matters: the cards on screen first are warmed
// first, a title in several rows is warmed once, one broken title does not stop the rest, and it
// never runs twice at once or more often than it is useful.

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const row = (id, ids) => ({ id, media: ids.map(n => ({ id: n })) });

console.log("which titles, in which order");

{
  const rows = [row("airing", [1, 2, 3]), row("trending", [4, 5, 6])];
  // Left to right across every row before going deeper into any, because the leftmost cards are
  // the ones on screen without scrolling.
  check("the first card of every row comes before the second of any", detailTargets(rows, 10).join() === "1,4,2,5,3,6", detailTargets(rows, 10).join());
}
check("each row contributes at most the first n", detailTargets([row("airing", [1, 2, 3, 4])], 2).join() === "1,2");
check(
  "a title in several rows is warmed once, where it first appears",
  detailTargets([row("airing", [1, 2]), row("trending", [2, 3])], 10).join() === "1,2,3",
  detailTargets([row("airing", [1, 2]), row("trending", [2, 3])], 10).join()
);
check("an empty or missing row is skipped", detailTargets([row("continuing", []), { id: "x" }, row("top", [9])], 10).join() === "9");
check("nonsense ids are skipped", detailTargets([{ id: "a", media: [{ id: null }, {}, { id: 7 }] }], 10).join() === "7");
check("nothing in gives nothing out", detailTargets(null, 10).length === 0);

console.log("\nrunning it");

{
  const warmed = [];
  let time = 0;
  const warmer = createDetailWarmer({ warm: async id => warmed.push(id), now: () => time, minIntervalMs: 25 * 60 * 1000 });
  const first = await warmer.run([row("airing", [1, 2])], 10);
  check("warms every target", warmed.join() === "1,2" && first.warmed === 2, warmed.join());

  time += 60 * 1000;
  const again = await warmer.run([row("airing", [1, 2])], 10);
  // The slow parts stay cached far longer than a minute, so a second pass this soon would only
  // repeat the fast local calls for nothing.
  check("a second run soon after is skipped", again.skipped === "recent" && warmed.length === 2);

  time += 25 * 60 * 1000;
  await warmer.run([row("airing", [1, 2])], 10);
  check("and goes again once the interval has passed, before the 30-minute search entries lapse", warmed.length === 4);
}

{
  let release;
  const gate = new Promise(resolve => (release = resolve));
  let calls = 0;
  const warmer = createDetailWarmer({
    warm: async () => {
      calls += 1;
      await gate;
    }
  });
  const running = warmer.run([row("airing", [1, 2])], 10);
  const overlap = await warmer.run([row("airing", [1, 2])], 10);
  check("never runs twice at once", overlap.skipped === "running" && calls === 1);
  release();
  await running;
}

{
  const warmed = [];
  const warmer = createDetailWarmer({
    warm: async id => {
      if (id === 2) throw new Error("Jellyseerr fell over");
      warmed.push(id);
    }
  });
  const result = await warmer.run([row("airing", [1, 2, 3])], 10);
  check("one title failing does not stop the rest", warmed.join() === "1,3" && result.failed === 1, warmed.join());
  check("and does not count as warmed", result.warmed === 2);
}

{
  let active = 0;
  let peak = 0;
  const warmer = createDetailWarmer({
    warm: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
    }
  });
  await warmer.run([row("airing", [1, 2, 3, 4])], 10);
  // One at a time: this is background work against services a person may be using right now.
  check("titles are warmed one at a time", peak === 1, `peak ${peak}`);
}

{
  const warmer = createDetailWarmer({ warm: async () => {} });
  const result = await warmer.run([], 10);
  check("an empty Discover page is a quiet no-op", result.warmed === 0 && result.failed === 0);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
