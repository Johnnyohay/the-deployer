/** Records the pack's feeds into test/golden/feeds/ for the golden test: `tsx test/record-feeds.ts <pack>`. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { readFileSync } from "node:fs";

const pack = process.argv[2] ?? "packs/anu-defense-housing";
const out = "test/golden/feeds";
const { feeds } = parse(readFileSync(path.join(pack, "topic/sources.yaml"), "utf8")) as { feeds: { name: string; url: string }[] };
await mkdir(out, { recursive: true });
const index: Record<string, string> = {};
for (const [i, f] of feeds.entries()) {
  try {
    const res = await fetch(f.url, { headers: { "user-agent": "Mozilla/5.0 (anu news collector)" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const file = `${String(i).padStart(2, "0")}.xml`;
    await writeFile(path.join(out, file), await res.text());
    index[f.url] = file;
    console.log(`ok   ${f.name}`);
  } catch (err) {
    console.log(`skip ${f.name}: ${(err as Error).message}`);
  }
}
await writeFile(path.join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
