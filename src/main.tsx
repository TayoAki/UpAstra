import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SessionGate } from "./store";
import "./styles.css";

// One bundle, two apps: the studio cockpit, and each studio's client portal
// (at /p/<slug>, or on a custom domain / portal subdomain).
const PortalApp = lazy(() => import("./portal/PortalApp").then((m) => ({ default: m.PortalApp })));

async function portalSlug(): Promise<string | null> {
  const m = window.location.pathname.match(/^\/p\/([a-z0-9-]+)/i);
  if (m) return m[1].toLowerCase();
  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return null;
  try {
    const res = await fetch("/papi/_host");
    return res.ok ? ((await res.json()).slug as string) : null;
  } catch {
    return null;
  }
}

const root = createRoot(document.getElementById("root")!);
portalSlug().then((slug) =>
  root.render(
    <StrictMode>
      {slug ? (
        <Suspense fallback={null}>
          <PortalApp slug={slug} />
        </Suspense>
      ) : (
        <SessionGate>
          <App />
        </SessionGate>
      )}
    </StrictMode>,
  ),
);
