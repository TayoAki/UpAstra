#!/usr/bin/env bash
# Build the OpenReel editor (pinned commit + Clip Operator patches) into ../editor-dist.
# Used by the Dockerfile; also works locally: bash editor/build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/../editor-dist}"
commit="$(tr -d '[:space:]' < "$here/OPENREEL_COMMIT")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git -C "$work" init -q
git -C "$work" remote add origin https://github.com/Augani/openreel-video.git
git -C "$work" fetch -q --depth 1 origin "$commit"
git -C "$work" checkout -q FETCH_HEAD

node "$here/apply.mjs" "$work"

cd "$work"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1 NODE_OPTIONS="--max-old-space-size=4096"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile --filter "@openreel/web..." --filter "@openreel/core"
pnpm --filter @openreel/core build:wasm
OPENREEL_BASE=/editor/ pnpm --filter @openreel/web exec vite build
rm -rf "$out"
cp -r apps/web/dist "$out"
# Cloudflare-only files and the service worker aren't used here.
rm -f "$out/_headers" "$out/_redirects" "$out/sw.js"
echo "Editor built into $out"
