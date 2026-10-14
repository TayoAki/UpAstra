import { createApp, serviceStatus } from "./app";
import { initAuth } from "./auth";
import { flushAll, getBackend } from "./db";

initAuth();
await getBackend().init();
const port = Number(process.env.PORT ?? 8788);
const server = createApp().listen(port, () => {
  const s = serviceStatus();
  console.log(`Clip Operator on http://localhost:${port}  (storage: ${s.storage}, AI: ${s.ai}${s.ai === "live" ? ` · ${s.aiModel}` : ""})`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, async () => {
    server.close();
    await flushAll().catch((e) => console.error("[shutdown] flush failed:", e));
    process.exit(0);
  });
