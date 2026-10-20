import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Frontend build config. The dev proxy targets the Fastify API so a single
 * origin is exercised during development. The production build only emits
 * static assets under dist/web which the Fastify process serves - the
 * embedded deployment never points the frontend at a separate API host.
 */
export default defineConfig(({ command }) => ({
  plugins: [react()],
  root: rootDir,
  publicDir: "public",
  // Load only explicitly public variables from a frontend-only directory. The
  // server `.env` must never be read by Vite: NODE_ENV=development there would
  // otherwise select React's development runtime in production builds.
  envDir: path.resolve(rootDir, ".vite-env"),
  envPrefix: ["VITE_"],
  // Force the production NODE_ENV branch for Vite builds even if a shell or
  // tool environment happens to define NODE_ENV.
  define:
    command === "build" ? { "process.env.NODE_ENV": JSON.stringify("production") } : undefined,
  resolve: {
    alias: {
      "@shared": path.resolve(rootDir, "src/shared"),
      "@web": path.resolve(rootDir, "src/web"),
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
        ws: false,
      },
    },
  },
}));
