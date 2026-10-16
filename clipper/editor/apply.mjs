// Apply UGCMediaClips's changes to a checkout of OpenReel (MIT, github.com/Augani/openreel-video).
// Usage: node apply.mjs <openreel-checkout>
// Every edit names the exact text it replaces and fails loudly if OpenReel has
// changed, so a version bump can't silently skip a patch.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2];
if (!root) throw new Error("usage: node apply.mjs <openreel-checkout>");
const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(root, "apps/web");

function edit(file, from, to) {
  const p = path.join(web, file);
  const src = fs.readFileSync(p, "utf8");
  if (!src.includes(from)) throw new Error(`apply.mjs: anchor not found in ${file}:\n${from}`);
  fs.writeFileSync(p, src.replace(from, to));
}

// 1. The bridge itself.
fs.copyFileSync(path.join(here, "bridge/clip-operator-bridge.tsx"), path.join(web, "src/clip-operator-bridge.tsx"));

// 2. Load it with the app.
edit("src/main.tsx", `import App from "./App";`, `import App from "./App";\nimport "./clip-operator-bridge";`);

// 3. Opening from UGCMediaClips starts a fresh project; don't offer to recover an old one.
edit(
  "src/App.tsx",
  `const { isChecking, showDialog, availableSaves, recover, dismiss, clearAll } = useProjectRecovery();`,
  `const { isChecking, showDialog: recoveryDialog, availableSaves, recover, dismiss, clearAll } = useProjectRecovery();\n  const showDialog = recoveryDialog && !OPENED_FROM_CLIP_OPERATOR;`,
);
edit("src/App.tsx", `import { useRouter } from "./hooks/use-router";`, `import { useRouter } from "./hooks/use-router";\nimport { OPENED_FROM_CLIP_OPERATOR } from "./clip-operator-bridge";`);

// 4. Served under /editor/ on UGCMediaClips's domain.
edit("vite.config.ts", `base: isDesktop ? "./" : "/",`, `base: isDesktop ? "./" : (process.env.OPENREEL_BASE ?? "/"),`);
edit(
  "src/components/editor/preview/threejs-layer-renderer.ts",
  `const DEFAULT_3D_FONT_URL = "/fonts/helvetiker_regular.typeface.json";\nconst DEFAULT_3D_BOLD_FONT_URL = "/fonts/helvetiker_bold.typeface.json";`,
  `const DEFAULT_3D_FONT_URL = \`\${import.meta.env.BASE_URL}fonts/helvetiker_regular.typeface.json\`;\nconst DEFAULT_3D_BOLD_FONT_URL = \`\${import.meta.env.BASE_URL}fonts/helvetiker_bold.typeface.json\`;`,
);

// 5. No service worker: OpenReel's registers at the site root, which on a shared
//    domain would sit in front of UGCMediaClips's own pages and API.
edit(
  "src/services/service-worker.ts",
  `  // Only register in production or if explicitly enabled\n  if (import.meta.env.DEV && !import.meta.env.VITE_ENABLE_SW) {`,
  `  // UGCMediaClips build: the editor shares a domain with the app, so never register.\n  if (import.meta.env.DEV || !import.meta.env.VITE_ENABLE_SW) {`,
);

console.log("OpenReel patched for UGCMediaClips.");
