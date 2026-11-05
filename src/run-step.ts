import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Runs another `deployer` step in the same pack as a child process. tsx is resolved from the
// engine, not the pack, so this works from any folder (a user's repo has no node_modules).
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

export function runStep(step: string, env: Record<string, string> = {}): boolean {
  const { status } = spawnSync(process.execPath, ["--import", TSX, CLI, step], { stdio: "inherit", env: { ...process.env, ...env } });
  return status === 0;
}
