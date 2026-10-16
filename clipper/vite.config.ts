import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { "/api": "http://localhost:8788" } },
  // Many tests run ffmpeg; in parallel they share the CPU, so the 5 s default is too tight.
  // At most 3 test files at once: render tests run ffmpeg and starve each other on small machines.
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000, maxWorkers: 3 },
} as any);
