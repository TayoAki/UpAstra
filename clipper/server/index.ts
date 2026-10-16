import { alert } from "./alerts";
import { createApp, serviceStatus } from "./app";
import { initAuth } from "./auth";
import { flushAll, getBackend, loadTenant } from "./db";
import { startMetricsPoller } from "./publishing";

initAuth();
await getBackend().init();
const port = Number(process.env.PORT ?? 8788);
startMetricsPoller();
const server = createApp().listen(port, () => {
  const s = serviceStatus();
  console.log(`UGCMediaClips on http://localhost:${port}  (storage: ${s.storage}, AI: ${s.ai}${s.ai === "live" ? ` · ${s.aiModel}` : ""})`);
});

// Resume renders and caption jobs a restart cut off. Wait a little first: during
// a deploy the previous server is still running until this one is healthy.
setTimeout(
  () =>
    void getBackend()
      .workspacesWithPendingWork()
      .then(async (ids) => {
        for (const id of ids) await loadTenant(id).catch((e) => console.error(`[resume] ${id}:`, (e as Error).message));
        if (ids.length) console.log(`[resume] picked up interrupted work in ${ids.length} workspace(s)`);
      })
      .catch((e) => console.error("[resume] scan failed:", (e as Error).message)),
  Number(process.env.RESUME_DELAY_SEC ?? 45) * 1000,
).unref();

// Anything that escapes a request or job: log it, tell the operator, keep serving
// (an uncaught exception leaves the process in an unknown state, so restart).
process.on("unhandledRejection", (e) => {
  console.error("[unhandled]", e);
  alert("unhandled error", (e as Error)?.message ?? String(e), (e as Error)?.stack?.split("\n").slice(1, 4).join("\n"));
});
process.on("uncaughtException", (e) => {
  console.error("[crash]", e);
  alert("server crashed", e.message, e.stack?.split("\n").slice(1, 4).join("\n"));
  void flushAll()
    .catch(() => undefined)
    .finally(() => setTimeout(() => process.exit(1), 1500));
});

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, async () => {
    server.close();
    await flushAll().catch((e) => console.error("[shutdown] flush failed:", e));
    process.exit(0);
  });
