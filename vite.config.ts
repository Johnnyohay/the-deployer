import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The Ask app lives in app/ and builds to app-dist/, which `deployer serve` serves; the
// GitHub Pages build (src/build-pages.ts) writes it into a pack's public/app instead.
// `npm run app:dev` runs Vite with hot reload and forwards /api to the local server.
// Paths are absolute so the build works from inside any pack.
export default defineConfig({
  root: fileURLToPath(new URL("./app", import.meta.url)),
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("./app-dist", import.meta.url)), emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
