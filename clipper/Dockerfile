# UGCMediaClips — single image: API + built web app + the OpenReel editor.

# The editor: OpenReel (MIT) at a pinned commit with UGCMediaClips's patches (editor/).
FROM node:22-slim AS editor
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /editor
COPY editor ./
RUN bash build.sh /editor-dist

# Speech to text for captions: whisper.cpp (MIT) at a pinned commit, built for
# generic x86-64 with AVX2 (not the build host's CPU), plus Whisper's
# multilingual base model (~99 languages).
FROM node:22-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl cmake g++ make && rm -rf /var/lib/apt/lists/*
ARG WHISPER_COMMIT=0c7be696371069e0baa2515ed7aa08d5a5473aa6
WORKDIR /src
RUN git init -q && git remote add origin https://github.com/ggml-org/whisper.cpp.git \
  && git fetch -q --depth 1 origin "$WHISPER_COMMIT" && git checkout -q FETCH_HEAD \
  && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
       -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
  && cmake --build build -j "$(nproc)" --target whisper-cli \
  && cp build/bin/whisper-cli /whisper-cli
RUN mkdir /models && curl -fsSL -o /models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# ffmpeg cuts and encodes clips. Fonts: DejaVu, plus Noto for captions in any
# script (CJK, Arabic, Devanagari, Thai…) — libass falls back to them through
# fontconfig. libgomp runs whisper.cpp.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-core fonts-noto-cjk fontconfig libgomp1 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /whisper-cli /usr/local/bin/whisper-cli
WORKDIR /app
COPY --from=whisper /models ./models
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/fonts ./fonts
COPY --from=build /app/licenses ./licenses
COPY --from=editor /editor-dist ./editor-dist
EXPOSE 8788
# node directly (not npm) so SIGTERM reaches the app and it can flush workspaces.
CMD ["node", "--import", "tsx", "server/index.ts"]
