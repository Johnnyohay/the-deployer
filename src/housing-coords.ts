/**
 * One-time helper (`npm run housing:coords`): places every Zillow metro on the map using
 * the Census Bureau's metro-area gazetteer (center point of each metro). Writes
 * data/housing/metro-coords.json, which the daily housing collector reads. Metro
 * boundaries change rarely, so rerun only when the map shows metros without dots.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCsv, ZILLOW } from "./housing.ts";

const GAZETTEER = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_cbsa_national.zip";

const dir = await mkdtemp(path.join(os.tmpdir(), "anu-gaz-"));
const zip = path.join(dir, "gaz.zip");
await writeFile(zip, Buffer.from(await (await fetch(GAZETTEER)).arrayBuffer()));
execFileSync("unzip", ["-o", "-q", zip, "-d", dir]);
const txt = await readFile(path.join(dir, "2023_Gaz_cbsa_national.txt"), "utf8");

// "Austin-Round Rock-San Marcos, TX Metro Area" → cities [Austin, Round Rock, San Marcos], states [TX]
const census = txt.trim().split("\n").slice(1).map((line) => {
  const c = line.split("\t").map((s) => s.trim());
  const [cities, rest = ""] = c[2].split(/, (?=[A-Z]{2}\b)/);
  return {
    cities: cities.split("-").map((s) => s.toLowerCase()),
    states: rest.replace(/ (Metro|Micro) Area$/, "").split("-"),
    metro: c[3] === "1",
    lat: Number(c[8]),
    lon: Number(c[9]),
  };
});

const rows = parseCsv(await (await fetch(ZILLOW.zhviMetro)).text());
const coords: Record<string, [number, number]> = {};
const missing: string[] = [];
for (const r of rows) {
  if (r.RegionType !== "msa") continue;
  const [city, st] = String(r.RegionName).split(/, (?=[A-Z]{2}$)/);
  const c = city.toLowerCase();
  // Prefer the metro whose first city matches, then any metro listing the city, then micro areas.
  const hit =
    census.find((g) => g.metro && g.cities[0] === c && g.states.includes(st)) ??
    census.find((g) => g.cities.includes(c) && g.states.includes(st)) ??
    census.find((g) => g.cities.some((x) => x.startsWith(c) || c.startsWith(x)) && g.states.includes(st));
  if (hit) coords[r.RegionID] = [+hit.lat.toFixed(3), +hit.lon.toFixed(3)];
  else missing.push(String(r.RegionName));
}

await mkdir("data/housing", { recursive: true });
await writeFile("data/housing/metro-coords.json", JSON.stringify(coords) + "\n");
console.log(`Placed ${Object.keys(coords).length} metros. Not found (${missing.length}): ${missing.join("; ")}`);
