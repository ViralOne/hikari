import { watchedPayload } from "../src/list.ts";

// What "Mark as watched" sends to a real AniList account. The rule that matters is that an unknown
// episode count never becomes an invented progress number, because this writes to the account and
// cannot be undone. Run with node's type stripping, which npm test does for us.

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("marking a title watched");

check(
  "a finished series is completed at its last episode",
  JSON.stringify(watchedPayload({ episodes: 12 })) === JSON.stringify({ status: "COMPLETED", progress: 12 })
);
check(
  "a movie is completed at episode one",
  JSON.stringify(watchedPayload({ episodes: 1 })) === JSON.stringify({ status: "COMPLETED", progress: 1 })
);
check(
  "an unknown episode count sends no progress rather than a guess",
  (() => {
    const payload = watchedPayload({ episodes: null });
    return payload.status === "COMPLETED" && !("progress" in payload);
  })(),
  JSON.stringify(watchedPayload({ episodes: null }))
);
check(
  "an episode count of zero counts as unknown",
  !("progress" in watchedPayload({ episodes: 0 })),
  JSON.stringify(watchedPayload({ episodes: 0 }))
);
check(
  "a nonsense episode count sends no progress",
  !("progress" in watchedPayload({ episodes: Number.NaN })) &&
    !("progress" in watchedPayload({ episodes: -3 })) &&
    !("progress" in watchedPayload({ episodes: 12.5 }))
);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
