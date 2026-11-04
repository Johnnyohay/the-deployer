#!/usr/bin/env node
// `npx github:Johnnyohay/the-deployer <command>`: runs src/cli.ts with tsx, so the engine ships as TypeScript.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const { status } = spawnSync(process.execPath, [tsx, cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(status ?? 1);
