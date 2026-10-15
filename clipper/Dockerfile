# Clip Operator — single image: API + built web app + the OpenReel editor.

# The editor: OpenReel (MIT) at a pinned commit with Clip Operator's patches (editor/).
FROM node:22-slim AS editor
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /editor
COPY editor ./
RUN bash build.sh /editor-dist

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# ffmpeg cuts and encodes clips; DejaVu is the caption font.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=editor /editor-dist ./editor-dist
EXPOSE 8788
# node directly (not npm) so SIGTERM reaches the app and it can flush workspaces.
CMD ["node", "--import", "tsx", "server/index.ts"]
