/**
 * Builds the in-browser Ask app into the pack's public/app (for GitHub Pages). The app's
 * source lives with the engine; DEPLOYER_PACK (or the current folder) says which pack.
 */
import { build } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const core = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pack = path.resolve(process.env.DEPLOYER_PACK ?? ".");
process.env.VITE_STATIC = "1";
await build({
  configFile: path.join(core, "vite.config.ts"),
  base: "./",
  build: { outDir: path.join(pack, "public", "app"), emptyOutDir: true },
});
