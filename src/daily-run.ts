/**
 * `deployer daily`: the whole morning refresh for a pack, in order. Each step runs on its
 * own, so a source that is down (videos, housing, a data series) never stops the brief or the site.
 */
import { existsSync } from "node:fs";
import { runStep } from "./run-step.ts";

const steps = [
  ["collect", true],
  ["videos", existsSync("topic/videos.yaml")],
  ["series", existsSync("topic/series.yaml")],
  ["housing", existsSync("data/housing/metro-coords.json")],
  ["curate", true],
  ["build-api", true],
] as const;

let failed = false;
for (const [step, wanted] of steps) {
  if (!wanted) continue;
  console.log(`\n== ${step}`);
  if (!runStep(step)) {
    console.warn(`${step} failed; keeping yesterday's data for it.`);
    failed ||= step === "collect" || step === "build-api";
  }
}
process.exit(failed ? 1 : 0);
