/**
 * `deployer <command> [--pack <dir>] [args…]`: runs one step of the engine against a pack.
 * The pack is a folder with topic/*.yaml and data/ (a user's repo is exactly that); it is
 * taken from --pack, then DEPLOYER_PACK, then the current folder. Every step reads and
 * writes relative to the pack, so the engine itself holds no deployment's data.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CORE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const COMMANDS: Record<string, { file: string; about: string }> = {
  init: { file: "wizard.ts", about: "set up a new pack from a plain-English description" },
  change: { file: "change.ts", about: "change a pack from a plain-English request" },
  daily: { file: "daily-run.ts", about: "the whole daily refresh: collect, videos, curate, build" },
  curate: { file: "curate.ts", about: "refresh theme briefs, momentum, events, directory and ideas" },
  collect: { file: "collect.ts", about: "fetch the news, sort it, write today's brief and the API" },
  housing: { file: "housing.ts", about: "collect the housing desk (Zillow, Freddie Mac, housing news)" },
  "housing-coords": { file: "housing-coords.ts", about: "one time: map positions for metros" },
  videos: { file: "videos.ts", about: "collect videos from topic/videos.yaml" },
  series: { file: "series.ts", about: "collect the data desk from topic/series.yaml (FRED, World Bank, CSV, JSON)" },
  "build-api": { file: "build-api.ts", about: "check the pack and rebuild public/ from data/" },
  "build-app": { file: "build-pages.ts", about: "build the in-browser Ask app into public/app" },
  enrich: { file: "enrich.ts", about: "tag companies on stored updates" },
  kb: { file: "kb-cli.ts", about: "free lookups over the data" },
  ask: { file: "agent.ts", about: "ask questions on the command line" },
  serve: { file: "server.ts", about: "run the Ask app at http://localhost:8787" },
  "answer-issue": { file: "answer-issue.ts", about: "answer an \"Ask …\" GitHub issue (used by ask.yml)" },
  "daily-claude": { file: "daily.ts", about: "optional, paid: a Claude-researched brief" },
};

const args = process.argv.slice(2);
const command = args.shift();
const flag = args.indexOf("--pack");
const pack = path.resolve(flag >= 0 ? args.splice(flag, 2)[1] : (process.env.DEPLOYER_PACK ?? "."));

if (!command || !COMMANDS[command]) {
  console.log(`Usage: deployer <command> [--pack <dir>] [args…]\n\n${Object.entries(COMMANDS).map(([c, { about }]) => `  ${c.padEnd(16)}${about}`).join("\n")}`);
  process.exit(command ? 1 : 0);
}
if (command === "init") mkdirSync(pack, { recursive: true });
else if (!existsSync(path.join(pack, "topic", "topic.yaml"))) {
  console.error(`${pack} is not a pack: it has no topic/topic.yaml. Pass --pack <dir> or run this inside one.`);
  process.exit(1);
}

process.chdir(pack);
const file = path.join(CORE_DIR, "src", COMMANDS[command].file);
// Steps read their own arguments and check whether they were run directly, as if started on their own.
process.argv = [process.argv[0], file, ...args];
await import(pathToFileURL(file).href);
