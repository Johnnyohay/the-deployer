/**
 * Golden test: the engine running the ANU pack must do exactly what ANU's own collector did.
 * The expected output in test/golden/expected/ came from ANU's code (github.com/Johnnyohay/anu)
 * run on the same recorded feeds and the same starting data; only timestamps may differ.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const golden = path.join(root, "test", "golden");
const DATE = "2026-11-04";

// Run timestamps and the new `pack` block are the only allowed differences.
const SKIP = new Set(["addedAt", "collectedAt", "generatedAt", "pack"]);
const norm = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !SKIP.has(k)).map(([k, x]) => [k, norm(x)])) : v;
const read = async (file: string) => norm(JSON.parse(await readFile(file, "utf8")));

test("ANU pack reproduces ANU's daily collect", async () => {
  const pack = await mkdtemp(path.join(os.tmpdir(), "deployer-golden-"));
  await cp(path.join(root, "packs", "anu-defense-housing", "topic"), path.join(pack, "topic"), { recursive: true });
  await cp(path.join(golden, "seed"), path.join(pack, "data"), { recursive: true });
  execFileSync(process.execPath, ["--import", path.join(root, "test", "mock-fetch.mjs"), "--import", "tsx", path.join(root, "src", "cli.ts"), "collect", "--pack", pack], {
    env: { ...process.env, FIXTURE_DIR: path.join(golden, "feeds"), DESK_DATE: DATE },
    stdio: "pipe",
  });

  const files = [
    ["data/updates.json", "data/updates.json"],
    ["data/catalysts.json", "data/catalysts.json"],
    ["data/meta.json", "data/meta.json"],
    [`data/briefs/${DATE}.json`, `data/briefs/${DATE}.json`],
    ...["all.json", "briefs.json", "sectors.json", "updates.json", "config.json", "meta.json", "brief/latest.json"].map((f) => [`api/${f}`, `public/api/v1/${f}`]),
  ];
  for (const [expected, actual] of files) {
    const want = await read(path.join(golden, "expected", expected));
    let got = await read(path.join(pack, actual));
    // config.json gained fields for the generic pages (topic, feeds, health); ANU's must be unchanged.
    if (actual.endsWith("config.json")) got = Object.fromEntries(Object.keys(want as object).map((k) => [k, (got as Record<string, unknown>)[k]]));
    assert.deepEqual(got, want, `${actual} differs from ANU's`);
  }
});
