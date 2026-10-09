import { retryWhenRateLimited } from "../src/retry.ts";

// What the detail panel does when the server answers "AniList is rate limiting, come back in N
// seconds": come back in N seconds, with the skeleton still up, instead of showing an error with a
// Retry button the person has to press at the right moment. Run with node's type stripping.

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const limited = retryIn => Object.assign(new Error("AniList is rate limiting requests."), { status: 503, retryIn });
const waits = [];
const wait = ms => (waits.push(ms), Promise.resolve());

{
  waits.length = 0;
  let calls = 0;
  const value = await retryWhenRateLimited(
    async () => {
      calls += 1;
      if (calls === 1) throw limited(4);
      return "detail";
    },
    { wait }
  );
  check("a rate limited load waits as long as it was told and tries again", value === "detail" && calls === 2, `calls ${calls}`);
  check("for exactly the time the server quoted", waits.join() === "4000", waits.join());
}

{
  waits.length = 0;
  let calls = 0;
  let error = null;
  await retryWhenRateLimited(
    async () => {
      calls += 1;
      throw limited(3);
    },
    { wait }
  ).catch(err => (error = err));
  check("it gives up after a couple of tries rather than spinning forever", calls === 3 && error?.retryIn === 3, `calls ${calls}`);
}

{
  waits.length = 0;
  let calls = 0;
  let error = null;
  await retryWhenRateLimited(
    async () => {
      calls += 1;
      throw limited(300);
    },
    { wait }
  ).catch(err => (error = err));
  // Five minutes behind a skeleton reads as broken. Better to show the message straight away.
  check("a wait too long to sit through is shown at once instead", calls === 1 && waits.length === 0 && error?.retryIn === 300);
}

{
  waits.length = 0;
  let calls = 0;
  let error = null;
  await retryWhenRateLimited(
    async () => {
      calls += 1;
      throw Object.assign(new Error("Sonarr responded 500"), { status: 502 });
    },
    { wait }
  ).catch(err => (error = err));
  check("any other failure is not retried, because waiting will not fix it", calls === 1 && error?.status === 502);
}

{
  let error = null;
  await retryWhenRateLimited(async () => {
    throw new Error("plain");
  }, { wait }).catch(err => (error = err));
  check("an error with no status at all passes straight through", error?.message === "plain");
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
