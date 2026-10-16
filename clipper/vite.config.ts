import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { "/api": "http://localhost:8788" } },
  // Many tests run ffmpeg; in parallel they share the CPU, so the 5 s default is too tight.
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 },
} as any);
