/**
 * `deployer series`: the data desk. Fetches every series in topic/series.yaml (FRED's public
 * CSV, World Bank, or any CSV/JSON URL; none need a key), works out the latest value, the
 * change since the last reading and against a year ago, and flags a change bigger than
 * `notableSigma` standard deviations of past changes as notable, so the brief can mention it.
 * A source that fails keeps its last good data; the run only fails if every series failed.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadSeriesConfig, loadTopic, seriesSourceUrl, type Series, type SeriesSource } from "./topic.ts";

export type Point = [date: string, value: number];

export interface SeriesData {
  id: string;
  name: string;
  unit: string;
  theme?: string;
  why: string;
  better: Series["better"];
  sourceUrl: string;
  frequency: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
  points: Point[];
  latest: { date: string; value: number } | null;
  change: { abs: number; pct: number | null } | null;
  yoy: { abs: number; pct: number | null } | null;
  notable: { direction: "up" | "down"; sigma: number } | null;
  fetchedAt: string;
  error?: string;
}

const UA = { "User-Agent": "the-deployer (data desk; github.com/Johnnyohay/the-deployer)" };
const MAX_POINTS = 600;

async function get(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Splits one CSV line, honoring quoted fields. */
function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** "2026-09-01", "2026-09", "2024", "Sep 2026", a timestamp… → YYYY-MM-DD, or null. */
export function normDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  const q = s.match(/^(\d{4})[- ]?Q([1-4])$/i);
  if (q) return `${q[1]}-${String((+q[2] - 1) * 3 + 1).padStart(2, "0")}-01`;
  const d = /^\d{10,13}$/.test(s) ? new Date(+s * (s.length === 10 ? 1000 : 1)) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[,%$\s]/g, ""));
  return v.trim() === "" || v.trim() === "." || !Number.isFinite(n) ? null : n;
};

function fromCsv(text: string, dateCol: string, valueCol: string, where: string): Point[] {
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error(`${where} returned a web page, not CSV (wrong code or URL?)`);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = csvLine(lines[0] ?? "").map((h) => h.toLowerCase());
  const di = head.indexOf(dateCol.toLowerCase());
  const vi = head.indexOf(valueCol.toLowerCase());
  if (di < 0 || vi < 0) throw new Error(`${where}: columns "${dateCol}" and "${valueCol}" not found (has: ${head.join(", ")})`);
  const pts: Point[] = [];
  for (const line of lines.slice(1)) {
    const cells = csvLine(line);
    const d = normDate(cells[di]), v = num(cells[vi]);
    if (d && v !== null) pts.push([d, v]);
  }
  return pts;
}

const dig = (obj: unknown, path: string): unknown =>
  path ? path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj) : obj;

/** Fetches one source and returns its points, oldest first. Throws a readable error. */
export async function fetchSeries(src: SeriesSource): Promise<Point[]> {
  let pts: Point[];
  switch (src.kind) {
    case "fred":
      pts = fromCsv(await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(src.code)}`), "observation_date", src.code, `FRED ${src.code}`);
      break;
    case "worldbank": {
      const url = `https://api.worldbank.org/v2/country/${encodeURIComponent(src.country)}/indicator/${encodeURIComponent(src.indicator)}?format=json&per_page=200`;
      const body = JSON.parse(await get(url)) as unknown[];
      if (!Array.isArray(body) || !Array.isArray(body[1])) throw new Error(`World Bank ${src.indicator}/${src.country}: no data (${JSON.stringify(body?.[0] ?? body).slice(0, 120)})`);
      pts = (body[1] as { date: string; value: number | null }[]).flatMap((r) => (r.value == null ? [] : [[normDate(r.date)!, r.value] as Point]));
      break;
    }
    case "csv":
      pts = fromCsv(await get(src.url), src.date, src.value, src.url);
      break;
    case "json": {
      const items = dig(JSON.parse(await get(src.url)), src.items);
      if (!Array.isArray(items)) throw new Error(`${src.url}: "${src.items || "(top level)"}" is not a list`);
      pts = items.flatMap((r) => {
        const d = normDate(dig(r, src.date)), v = num(dig(r, src.value));
        return d && v !== null ? [[d, v] as Point] : [];
      });
      break;
    }
  }
  pts.sort((a, b) => a[0].localeCompare(b[0]));
  const dedup = pts.filter((p, i) => i === pts.length - 1 || p[0] !== pts[i + 1][0]);
  if (!dedup.length) throw new Error("no data points");
  return dedup.slice(-MAX_POINTS);
}

const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

function frequency(pts: Point[]): SeriesData["frequency"] {
  const tail = pts.slice(-25);
  const gaps = tail.slice(1).map((p, i) => days(tail[i][0], p[0])).sort((a, b) => a - b);
  const g = gaps[gaps.length >> 1] ?? 30;
  return g <= 2 ? "daily" : g <= 10 ? "weekly" : g <= 45 ? "monthly" : g <= 120 ? "quarterly" : "yearly";
}

const pct = (from: number, to: number) => (from === 0 ? null : ((to - from) / Math.abs(from)) * 100);
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** Latest value, change, year-on-year and the notable-move test, from the points alone. */
export function analyze(pts: Point[], sigma: number) {
  const last = pts.at(-1)!, prev = pts.at(-2);
  const change = prev ? { abs: round(last[1] - prev[1]), pct: pct(prev[1], last[1]) } : null;
  // Year ago: the reading closest to 365 days earlier, if one is within 45 days of it.
  const target = Date.parse(last[0]) - 365 * 86_400_000;
  const yearAgo = pts.reduce<Point | null>((best, p) => (Math.abs(Date.parse(p[0]) - target) < Math.abs(Date.parse(best?.[0] ?? "1900-01-01") - target) ? p : best), null);
  const yoy = yearAgo && Math.abs(Date.parse(yearAgo[0]) - target) <= 45 * 86_400_000 ? { abs: round(last[1] - yearAgo[1]), pct: pct(yearAgo[1], last[1]) } : null;
  // Notable: the last change against the spread of up to 60 earlier changes (needs at least 12).
  const tail = pts.slice(-62);
  const diffs = tail.slice(1).map((p, i) => p[1] - tail[i][1]);
  const past = diffs.slice(0, -1);
  let notable: SeriesData["notable"] = null;
  if (change && past.length >= 12) {
    const mean = past.reduce((s, x) => s + x, 0) / past.length;
    const sd = Math.sqrt(past.reduce((s, x) => s + (x - mean) ** 2, 0) / past.length);
    const z = sd > 0 ? (change.abs - mean) / sd : 0;
    if (Math.abs(z) >= sigma) notable = { direction: z > 0 ? "up" : "down", sigma: round(Math.abs(z), 1) };
  }
  return {
    latest: { date: last[0], value: last[1] },
    change: change && { abs: change.abs, pct: change.pct === null ? null : round(change.pct, 2) },
    yoy: yoy && { abs: yoy.abs, pct: yoy.pct === null ? null : round(yoy.pct, 2) },
    notable,
  };
}

export async function collectSeries(): Promise<{ data: SeriesData[]; failed: string[] }> {
  const cfg = await loadSeriesConfig();
  const themes = new Set((await loadTopic()).sectors.map((t) => t.id));
  const old: SeriesData[] = existsSync("data/series.json") ? JSON.parse(await readFile("data/series.json", "utf8")).series ?? [] : [];
  const byId = new Map(old.map((s) => [s.id, s]));
  const fetchedAt = new Date().toISOString();
  const failed: string[] = [];
  const data: SeriesData[] = [];
  for (const s of cfg.series) {
    if (s.theme && !themes.has(s.theme)) console.warn(`  ${s.id}: theme "${s.theme}" is not one of this desk's themes (${[...themes].join(", ")}); showing it without one.`);
    const theme = s.theme && themes.has(s.theme) ? s.theme : undefined;
    const base = { id: s.id, name: s.name, unit: s.unit, theme, why: s.why, better: s.better, sourceUrl: seriesSourceUrl(s.source) };
    try {
      const points = await fetchSeries(s.source);
      data.push({ ...base, frequency: frequency(points), points, ...analyze(points, cfg.notableSigma), fetchedAt });
      console.log(`  ${s.id}: ${points.length} points, latest ${points.at(-1)![0]}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push(`${s.id}: ${msg}`);
      console.warn(`  ${s.id} failed: ${msg}`);
      const prior = byId.get(s.id);
      // Keep yesterday's numbers, but with today's name/why so a config edit still shows.
      if (prior) data.push({ ...prior, ...base, error: msg });
    }
  }
  return { data, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!existsSync("topic/series.yaml")) {
    console.log("No topic/series.yaml; this pack has no data desk.");
    process.exit(0);
  }
  try {
    const { data, failed } = await collectSeries();
    await writeFile("data/series.json", JSON.stringify({ updatedAt: new Date().toISOString(), series: data, failed }, null, 1) + "\n");
    const notable = data.filter((s) => s.notable && !s.error).map((s) => `${s.name} (${s.notable!.direction}, ${s.notable!.sigma}σ)`);
    console.log(`Series: ${data.filter((s) => !s.error).length} updated, ${failed.length} failed.${notable.length ? ` Notable: ${notable.join("; ")}` : ""}`);
    if (data.length && failed.length === data.length) process.exit(1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
