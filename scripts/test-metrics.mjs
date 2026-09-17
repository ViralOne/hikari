import { createServer } from "node:http";

// The latency table is read off the sidebar, so a wrong percentile or a service that never shows up
// is a display bug that looks like a healthy service. Pinned here: request() records every call
// including failures and timeouts, percentiles come from the recent window only, and the counts
// are since boot. Run: npm test

const { observe, resetMetrics, timed, upstreamStats } = await import("../server/metrics.js");
const { request } = await import("../server/http.js");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("percentiles");

resetMetrics();
for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000]) observe("svc", ms);
let stats = upstreamStats().svc;
check("median is the middle of the window", stats.p50 === 50, `p50 ${stats.p50}`);
check("p95 reaches the slow outlier", stats.p95 === 1000, `p95 ${stats.p95}`);
check("calls are counted", stats.calls === 10);
check("no errors were recorded", stats.errors === 0 && stats.lastError === null);

observe("svc", 5, "boom");
stats = upstreamStats().svc;
check("a failure counts as a call and an error", stats.calls === 11 && stats.errors === 1);
check("and keeps its message", stats.lastError === "boom");
check("the last sample is the most recent one", stats.lastMs === 5);

// Past the window the oldest samples fall out, so an outage that ended an hour ago stops
// dragging the median up.
resetMetrics();
for (let i = 0; i < 100; i += 1) observe("svc", 5000);
for (let i = 0; i < 100; i += 1) observe("svc", 10);
stats = upstreamStats().svc;
check("old samples leave the window", stats.p95 === 10 && stats.calls === 200, `p95 ${stats.p95}, calls ${stats.calls}`);

console.log("\ntimed()");

resetMetrics();
const value = await timed("wrapped", async () => "ok");
check("returns the wrapped result", value === "ok");
let thrown = null;
await timed("wrapped", async () => {
  throw new Error("nope");
}).catch(err => (thrown = err));
check("rethrows the wrapped error unchanged", thrown?.message === "nope");
stats = upstreamStats().wrapped;
check("both outcomes are recorded", stats.calls === 2 && stats.errors === 1 && stats.lastError === "nope");

console.log("\nrequest()");

const server = createServer((req, res) => {
  if (req.url === "/slow") {
    setTimeout(() => {
      res.end("{}");
    }, 60);
    return;
  }
  if (req.url === "/fail") {
    res.statusCode = 503;
    res.end("down");
    return;
  }
  if (req.url === "/hang") return; // never answers
  res.end(JSON.stringify({ hello: "world" }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

resetMetrics();
await request("fake", `${base}/ok`);
await request("fake", `${base}/slow`);
stats = upstreamStats().fake;
check("successful calls are timed", stats.calls === 2 && stats.errors === 0);
check("to the end of the body, so a slow body shows", stats.p95 >= 55, `p95 ${stats.p95}`);

await request("fake", `${base}/fail`).catch(() => null);
stats = upstreamStats().fake;
check("a non-2xx answer is an error with its status", stats.errors === 1 && /503/.test(stats.lastError), stats.lastError);

await request("fake", `${base}/hang`, { timeout: 50 }).catch(() => null);
stats = upstreamStats().fake;
check("a timeout is recorded as an error too", stats.errors === 2 && stats.calls === 4, stats.lastError);

await request("fake", "http://127.0.0.1:1/", { timeout: 500 }).catch(() => null);
stats = upstreamStats().fake;
check("a refused connection is recorded", stats.errors === 3 && stats.calls === 5, stats.lastError);

server.closeAllConnections?.();
server.close();

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
