import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The throttle is the whole brute-force defence, so it is tested rather than assumed. It is also
// the part most easily made worse: an earlier version escalated the lockout on the username as well
// as the address, which let six requests an hour keep a named person locked out of their own
// instance. That case is pinned below.
//
// Jellyfin is never contacted: the address points at a closed local port, so the credential check
// fails after the limiter has already had its say. Run: npm test

process.env.AUTH_FILE = join(mkdtempSync(join(tmpdir(), "hikari-rate-")), "auth.json");
process.env.JELLYFIN_URL = "http://127.0.0.1:1";
process.env.JELLYFIN_API_KEY = "not-a-real-key";

const { forgive, hit, lockedFor, penalise, sweep } = await import("../server/ratelimit.js");
const auth = await import("../server/auth.js");
auth.load();

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("fixed windows");

const WINDOW = { max: 5, windowMs: 60 * 1000 };
const counts = Array.from({ length: 6 }, () => hit("k1", WINDOW).allowed);
check("the first five are allowed and the sixth is not", counts.join() === "true,true,true,true,true,false");
check("the refusal says how long to wait", hit("k1", WINDOW).retryIn > 0 && hit("k1", WINDOW).retryIn <= 60);
check("a separate key has its own window", hit("k2", WINDOW).allowed === true);

// A window that has already elapsed must start clean rather than stay exhausted for ever.
const SHORT = { max: 1, windowMs: 1 };
hit("k3", SHORT);
await new Promise(resolve => setTimeout(resolve, 5));
check("an elapsed window resets", hit("k3", SHORT).allowed === true);

console.log("\nescalating lockout");

const LOCK = { baseMs: 1000, maxMs: 4000 };
check("the first penalty is the base wait", penalise("p1", LOCK) === 1);
check("the second doubles it", penalise("p1", LOCK) === 2);
check("the third doubles again", penalise("p1", LOCK) === 4);
check("it never exceeds the ceiling", penalise("p1", LOCK) === 4 && penalise("p1", LOCK) === 4);
check("a locked key reports the remaining wait", lockedFor("p1") > 0);
check("an untouched key is not locked", lockedFor("never-seen") === 0);
check("forgiving clears both the lockout and the window", (forgive("p1"), lockedFor("p1") === 0 && hit("p1", WINDOW).allowed === true));

// Without decay the count only ever climbed, so a typo months later inherited the full penalty.
const DECAY = { baseMs: 2, maxMs: 4 };
penalise("p2", DECAY);
penalise("p2", DECAY);
await new Promise(resolve => setTimeout(resolve, 20));
check("the escalation decays after a quiet spell", penalise("p2", DECAY) === 1);

check("sweeping drops expired records", typeof sweep().buckets === "number");

console.log("\nlogin: five a minute");

const attempt = async (username, address) => {
  try {
    await auth.login({ username, password: "wrong", address });
    return { status: 200 };
  } catch (err) {
    return { status: err.httpStatus, message: err.message };
  }
};

const first = [];
for (let i = 0; i < 5; i += 1) first.push(await attempt(`user${i}`, "10.0.0.1"));
check(
  "the first five reach Jellyfin rather than the limiter",
  first.every(result => result.status === 502),
  first.map(r => r.status).join()
);

const sixth = await attempt("user9", "10.0.0.1");
check("the sixth from that address is refused", sixth.status === 429, sixth.message);
check("the refusal says how long to wait", /try again in \d+s/.test(sixth.message ?? ""), sixth.message);

// The escalating lockout belongs to the address, never to the username. This is the case that used
// to lock out a real account: burn the window on throwaway names, then name the victim.
check("naming a different account from a locked address is still refused", (await attempt("milu", "10.0.0.1")).status === 429);
check("that account is NOT locked out from a different address", (await attempt("milu", "10.0.0.2")).status === 502);

console.log("\nlogin: per-username ceiling");

// Spraying one account from many addresses is still capped, so rotating addresses buys nothing.
const sprayed = [];
for (let i = 0; i < 6; i += 1) sprayed.push(await attempt("victim", `10.1.0.${i}`));
check("five attempts on one username get through", sprayed.filter(r => r.status === 502).length === 5);
check("the sixth on that username is refused", sprayed[5].status === 429, sprayed[5].message);
// A plain window, not an escalating lockout: the username must free itself when the window passes.
check("the username is not put in a lockout", lockedFor("login:u:victim") === 0);

console.log("\nlogin: input guards");

check("a missing username is a 400", (await attempt("", "10.2.0.1")).status === 400);
const long = await attempt("x".repeat(200), "10.2.0.2");
check("an over-long username is refused as a bad password", long.status === 401, long.message);
check("the over-long name is not told it was too long", !/long/i.test(long.message ?? ""), long.message);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
