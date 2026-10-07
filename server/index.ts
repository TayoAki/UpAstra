import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app";
import { initAuth } from "./auth";
import { getBackend } from "./persist";
import { startRadarScheduler } from "./radar";
import { flushAll } from "./store";

loadEnv();
initAuth();
const port = Number(process.env.PORT ?? 8787);

await getBackend().init();
const app = createApp({ port });
const server = app.listen(port, () => {
  console.log(`Studio Operator on http://localhost:${port}  (storage: ${getBackend().kind}, AI: ${process.env.OPENROUTER_API_KEY ? "openrouter" : process.env.OPENAI_API_KEY ? "openai" : "simulated"}, Apify: ${process.env.APIFY_TOKEN ? "live" : "simulated"})`);
});
startRadarScheduler();

// Railway sends SIGTERM on redeploy: stop taking requests, then flush workspaces.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    server.close();
    try {
      await flushAll();
    } finally {
      process.exit(0);
    }
  });
}

function loadEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== "" && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
