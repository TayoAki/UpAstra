# Studio Operator — single image: API + built web app.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
EXPOSE 8787
# Run node directly (not npm) so SIGTERM reaches the app and it can flush workspaces.
CMD ["node", "--import", "tsx", "server/index.ts"]
