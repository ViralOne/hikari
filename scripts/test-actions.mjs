import { failureOutcome, resolveAction } from "../src/components/detail/outcome.ts";

// Every mutating action in the detail panel reports through these two, so a mistake here is a
// mistake in all fifteen at once. The branches matter: a dry run must stay quiet, a half-failed
// link must not read as success, and a thrown non-Error must still say something.
// Run with node's type stripping, which npm test does for us.

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("what an action reports when it finishes");

check(
  "a sentence counts as success and refetches",
  (() => {
    const resolved = resolveAction("Done.", true);
    return resolved?.outcome.ok === true && resolved.outcome.message === "Done." && resolved.refetch === true;
  })()
);
check(
  "an explicit outcome is passed through, so a half-failure is not dressed up as success",
  (() => {
    const resolved = resolveAction({ ok: false, message: "Linked 2, failed 1" }, true);
    return resolved?.outcome.ok === false && resolved.outcome.message === "Linked 2, failed 1";
  })()
);
// The first half of a two-step action only reads. Saying nothing is the point: the panel shows the
// plan it returned, and an outcome notice there would claim something had been changed.
check("a dry run reports nothing at all", resolveAction(null, true) === null);
check(
  "an action that changes nothing on the panel does not refetch",
  resolveAction("Jellyfin is scanning.", false)?.refetch === false
);
// Which is why an action that can fail without throwing has to return an explicit outcome: a
// failure phrased as a sentence would be stamped ok and rendered in the green box. narrowSeason
// and linkAll both refuse without throwing, and both return an outcome for exactly this reason.
check(
  "any sentence is success, with no inspection of what it says",
  resolveAction("Could not do the thing.", true)?.outcome.ok === true
);

console.log("\nwhat an action reports when it throws");

check("an Error gives up its message", failureOutcome(new Error("Sonarr said no")).message === "Sonarr said no");
check("a failure is never ok", failureOutcome(new Error("nope")).ok === false);
// A rejected fetch can throw a string, and (err as Error).message on one of those is undefined,
// which renders as an empty red box that says nothing at all.
check("a thrown string still says something", failureOutcome("socket hang up").message === "socket hang up");
check("a thrown object still says something", failureOutcome({ code: 500 }).message === "[object Object]");
check("a thrown undefined still says something", failureOutcome(undefined).message === "undefined");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
