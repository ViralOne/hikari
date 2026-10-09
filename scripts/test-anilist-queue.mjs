import { createQueue, inBackground, currentLane, RateLimitedError } from "../server/anilist-queue.js";

// The one gate every AniList call goes through. AniList limits by IP across everything Hikari does
// (the Discover warm-up, card annotation, the franchise walks and the panel you are waiting on) and
// is currently degraded to 30 a minute, so a burst from any one of them used to 429 the rest. What
// matters here: the panel you clicked never queues behind background work, background work leaves
// headroom for it, a 429 stops everything for as long as AniList asked, and a click that would wait
// too long is told so at once instead of hanging for the length of the retry.

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

// Time only moves when a test says so. wait() resolves once the clock passes its deadline.
function fakeClock() {
  let time = 0;
  let timers = [];
  return {
    now: () => time,
    wait: ms =>
      new Promise(resolve => {
        timers.push({ at: time + ms, resolve });
      }),
    async advance(ms) {
      const until = time + ms;
      // Step through every deadline in order so a timer set by a woken pump fires in the same advance.
      for (;;) {
        await flush();
        const due = timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        time = due.at;
        timers = timers.filter(timer => timer !== due);
        due.resolve();
      }
      time = until;
      await flush();
    }
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

// Records when each task started, by name, against the fake clock.
function recorder(clock) {
  const started = [];
  const task = name => () => {
    started.push({ name, at: clock.now() });
    return name;
  };
  return { started, task, names: () => started.map(entry => entry.name).join(",") };
}

console.log("bursts and pacing");

{
  const clock = fakeClock();
  const queue = createQueue({ limit: 30, now: clock.now, wait: clock.wait });
  const log = recorder(clock);
  // Opening one cold title costs several calls at once. Making those wait two seconds each would turn
  // a quarter-second panel into a ten-second one, so a burst inside the budget goes straight out.
  for (let i = 0; i < 5; i += 1) queue.run(log.task(`u${i}`), { lane: "user" });
  await clock.advance(0);
  check("a burst within the budget starts at once", log.started.length === 5 && log.started.every(entry => entry.at === 0), log.names());
}

{
  const clock = fakeClock();
  const queue = createQueue({ limit: 30, now: clock.now, wait: clock.wait });
  const log = recorder(clock);
  queue.observe({ remaining: 0 });
  queue.run(log.task("late"), { lane: "user" });
  await clock.advance(1000);
  check("with the budget spent, the next call waits for it to refill", log.started.length === 0);
  // 30 a minute is one every two seconds.
  await clock.advance(1100);
  check("and goes once it has", log.started.length === 1 && log.started[0].at <= 2100, `at ${log.started[0]?.at}`);
}

console.log("\nyour click before background work");

{
  const clock = fakeClock();
  const queue = createQueue({ limit: 30, now: clock.now, wait: clock.wait });
  const log = recorder(clock);
  queue.observe({ remaining: 0 });
  queue.run(log.task("bg1"), { lane: "background" });
  queue.run(log.task("bg2"), { lane: "background" });
  queue.run(log.task("user"), { lane: "user" });
  await clock.advance(2100);
  check("a click queued after background work still goes first", log.started[0]?.name === "user", log.names());
}

{
  const clock = fakeClock();
  const queue = createQueue({ limit: 30, now: clock.now, wait: clock.wait });
  const log = recorder(clock);
  // A third of the budget is held back for clicks: with five left, background work does not start.
  queue.observe({ remaining: 5 });
  queue.run(log.task("bg"), { lane: "background" });
  await clock.advance(0);
  check("background work leaves headroom for a click", log.started.length === 0);
  queue.run(log.task("user"), { lane: "user" });
  await clock.advance(0);
  check("which a click can still use straight away", log.names() === "user", log.names());
}

{
  const clock = fakeClock();
  const queue = createQueue({ limit: 30, now: clock.now, wait: clock.wait });
  const log = recorder(clock);
  queue.observe({ remaining: 0 });
  queue.run(log.task("bg"), { lane: "background" });
  // The pump is asleep waiting for the background reserve, which takes a while to refill. A click
  // arriving then must wake it rather than sleep through the same wait.
  await clock.advance(100);
  queue.run(log.task("user"), { lane: "user" });
  await clock.advance(2000);
  check("a click wakes a queue that was waiting on background headroom", log.started[0]?.name === "user" && log.started[0].at <= 2100, `${log.names()} at ${log.started[0]?.at}`);
}

console.log("\nwhat AniList says wins");

{
  const clock = fakeClock();
  const queue = createQueue({ limit: 30, now: clock.now, wait: clock.wait });
  queue.observe({ limit: 90, remaining: 90 });
  check("a higher limit in the headers is adopted, so a recovered AniList is not throttled at 30", queue.snapshot().limit === 90);
  queue.observe({ remaining: 3 });
  check("the remaining count only ever lowers what Hikari thinks it has", Math.floor(queue.snapshot().tokens) === 3, `${queue.snapshot().tokens}`);
  queue.observe({ limit: Number.NaN, remaining: -1 });
  check("nonsense headers are ignored", queue.snapshot().limit === 90 && Math.floor(queue.snapshot().tokens) === 3);
}

console.log("\nwhen AniList says stop");

{
  const clock = fakeClock();
  const queue = createQueue({ limit: 30, now: clock.now, wait: clock.wait, userWaitMs: 8000 });
  const log = recorder(clock);
  queue.throttled(30);
  // Nobody should sit in front of a skeleton for thirty seconds: say so now, with when to come back.
  let error = null;
  await queue.run(log.task("user"), { lane: "user" }).catch(err => (error = err));
  check("a click that would wait past the limit is refused at once", error instanceof RateLimitedError && log.started.length === 0);
  check("and says how long to wait, as AniList did", error?.retryIn === 30, `retryIn ${error?.retryIn}`);
  check("as a 503, which is what it is", error?.httpStatus === 503);

  queue.run(log.task("bg"), { lane: "background" });
  await clock.advance(29000);
  check("background work waits out the pause instead of failing", log.started.length === 0);
  await clock.advance(25000);
  check("and runs after it", log.names() === "bg", log.names());
}

{
  const clock = fakeClock();
  const queue = createQueue({ limit: 30, now: clock.now, wait: clock.wait, userWaitMs: 8000 });
  const log = recorder(clock);
  queue.throttled(3);
  queue.run(log.task("user"), { lane: "user" });
  await clock.advance(2000);
  check("a short pause is waited out for a click too", log.started.length === 0);
  await clock.advance(1100);
  check("and the click goes once it ends", log.names() === "user", log.names());
}

{
  const clock = fakeClock();
  const queue = createQueue({ limit: 30, now: clock.now, wait: clock.wait });
  queue.throttled(Number.NaN);
  check("a 429 without a usable Retry-After still pauses, for a minute", queue.snapshot().pausedFor === 60000, `${queue.snapshot().pausedFor}`);
  queue.throttled(5);
  check("and a shorter one later does not cut that pause short", queue.snapshot().pausedFor === 60000);
}

{
  const clock = fakeClock();
  const queue = createQueue({ limit: 30, now: clock.now, wait: clock.wait, userWaitMs: 8000 });
  queue.observe({ remaining: 0 });
  // Two seconds a token: three clicks ahead plus this one is eight seconds, the fifth is past it.
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(queue.run(() => i, { lane: "user" }).then(() => "ran", err => err.name));
  await clock.advance(20000);
  const settled = await Promise.all(results);
  check("the wait a click is quoted counts the clicks queued ahead of it", settled.join(",") === "ran,ran,ran,ran,RateLimitedError", settled.join(","));
}

{
  const clock = fakeClock();
  const queue = createQueue({ limit: 30, now: clock.now, wait: clock.wait });
  let error = null;
  await queue
    .run(() => {
      throw new Error("boom");
    }, { lane: "user" })
    .catch(err => (error = err));
  await clock.advance(0);
  check("a task that throws rejects its own caller", error?.message === "boom");
  let second = null;
  queue.run(() => "fine", { lane: "user" }).then(value => (second = value));
  await clock.advance(0);
  check("and does not wedge the queue for the next one", second === "fine");
}

console.log("\nlanes follow the work, not the call site");

check("calls are a click unless they say otherwise", currentLane() === "user");
check("inside inBackground they are background", inBackground(() => currentLane()) === "background");
check(
  "and stay background across an await, which is where the AniList call actually happens",
  (await inBackground(async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    return currentLane();
  })) === "background"
);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
