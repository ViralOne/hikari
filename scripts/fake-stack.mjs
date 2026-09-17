import { existsSync } from "node:fs";
import { startFakes } from "./lib/fakes.mjs";
import { startHikari } from "./lib/harness.mjs";

// Hikari with every integration on and nothing real behind it. Starts the fakes from
// scripts/lib/fakes.mjs and a production-mode server against them, then stays up until you stop
// it. For clicking through the UI, or pointing Playwright at, without a Jellyseerr or a Sonarr in
// reach.
//
// Serves dist/, so build first:  npm run build && npm run dev:fakes
// PORT picks the port (default 7998, one above the real default so both can run side by side).

const port = Number(process.env.PORT || 7998);

if (!existsSync(new URL("../dist/index.html", import.meta.url))) {
  console.warn("[fake-stack] dist/ is missing, so only the API will answer. Run `npm run build` first for the UI.");
}

const fakes = await startFakes();

const hikari = await startHikari({
  fakes,
  echo: true,
  env: {
    PORT: String(port),
    // Reachable from outside the container or the machine, which is the point of a manual stack.
    HOST: "0.0.0.0",
    NODE_ENV: "production"
  }
});

console.log(`\n[fake-stack] hikari is up on http://localhost:${port} against fake services:`);
for (const [name, url] of Object.entries(fakes.urls)) console.log(`[fake-stack]   ${name.padEnd(10)} ${url}`);
console.log("[fake-stack] Ctrl-C to stop\n");

let stopping = false;
const shutdown = async () => {
  stopping = true;
  hikari.stop();
  await fakes.stop();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);

// If Hikari dies on its own there is nothing left to serve, so do not sit there looking alive.
hikari.child.on("exit", code => {
  if (stopping) return;
  console.error(`[fake-stack] hikari exited with ${code}`);
  fakes.stop().then(() => process.exit(code ?? 1));
});
