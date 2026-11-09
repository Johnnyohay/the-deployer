import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDesk, type Desk } from "./store.ts";
import { FORMULA_FIELDS, loadRequests, loadSiteConfig, loadVideoConfig } from "./config.ts";
import { feedUrl, loadSources, loadTopic, typeNames } from "./topic.ts";

const API_DIR = path.join("public", "api", "v1");
// The site's pages are part of the engine; each build copies them into the pack's public/.
// A pack can replace any page with its own in site/ (ANU keeps its hand-made ones that way).
const SITE_DIR = fileURLToPath(new URL("../site", import.meta.url));

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Copies the pages and fills in {{name}}, {{tagline}} and {{domain}} from the pack. */
async function buildPages(words: Record<string, string>) {
  await cp(SITE_DIR, "public", { recursive: true });
  if (existsSync("site")) await cp("site", "public", { recursive: true });
  for (const file of (await readdir("public")).filter((f) => f.endsWith(".html"))) {
    const html = await readFile(path.join("public", file), "utf8");
    const filled = html.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in words ? escHtml(words[key]) : m));
    if (filled !== html) await writeFile(path.join("public", file), filled);
  }
}

// The best rental markets among the 200 largest metros (easy to buy and sell in), for the brief.
type Metro = { name: string; state: string; rank?: number; price?: number; rent?: number; grossYield?: number; capRate?: number; cashFlow?: number; rentYoY?: number; priceYoY?: number; forecast12m?: number; score?: number };
function topMetros(metros: Metro[]) {
  const pick = ({ name, state, price, rent, grossYield, capRate, cashFlow, rentYoY, priceYoY, forecast12m, score }: Metro) => ({ name, state, price, rent, grossYield, capRate, cashFlow, rentYoY, priceYoY, forecast12m, score });
  const big = metros.filter((x) => (x.rank ?? 9999) <= 200 && x.price && x.rent);
  return {
    topScore: [...big].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 8).map(pick),
    topYield: [...big].sort((a, b) => (b.grossYield ?? 0) - (a.grossYield ?? 0)).slice(0, 5).map(pick),
  };
}

async function put(file: string, value: unknown) {
  const full = path.join(API_DIR, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(value) + "\n");
}

/** Writes the site's pages and the static JSON API that GitHub Pages serves under /api/v1/. */
export async function buildApi(desk: Desk): Promise<void> {
  const briefs = [...desk.briefs].sort((a, b) => b.date.localeCompare(a.date));
  const updates = [...desk.updates].sort((a, b) => b.d.localeCompare(a.d));
  const generatedAt = new Date().toISOString();

  await put("all.json", { generatedAt, pack: desk.pack, meta: desk.meta, briefs: briefs.slice(0, 30), sectors: desk.sectors, updates, companies: desk.companies, catalysts: desk.catalysts, research: desk.research, ideas: desk.ideas });
  await put("brief/latest.json", briefs[0] ?? null);
  await put("briefs.json", briefs.map((b) => ({ date: b.date, title: b.title })));
  for (const b of briefs) await put(`brief/${b.date}.json`, b);
  await put("updates.json", updates);
  await put("sectors.json", desk.sectors);
  await put("companies.json", desk.companies);
  await put("catalysts.json", desk.catalysts);
  await put("research.json", desk.research);
  await put("ideas.json", desk.ideas);
  await put("meta.json", { ...desk.meta, generatedAt });
  // The housing desk and videos are separate files so the defense page stays light.
  if (desk.housing) {
    await put("housing.json", desk.housing.market);
    await put("housing-news.json", desk.housing.news);
  }
  if (desk.videos) await put("videos.json", desk.videos);
  // A small housing summary for the brief page (the full market file is about 1 MB).
  if (desk.housing) {
    const m = desk.housing.market as unknown as { asOf?: Record<string, string>; mortgage?: { history?: [string, number][] } & Record<string, unknown>; national?: Record<string, number> };
    await put("housing-summary.json", { asOf: m.asOf ?? {}, mortgage: m.mortgage ? { ...m.mortgage, history: (m.mortgage.history ?? []).slice(-53) } : null, national: m.national ?? null, ...topMetros((desk.housing.market as unknown as { metros?: Metro[] }).metros ?? []) });
  }
  // Key terms and lessons (data/glossary.json, kept by the curator).
  if (existsSync("data/glossary.json")) await put("glossary.json", JSON.parse(await readFile("data/glossary.json", "utf8")));
  // The data desk: one file with every series, so the Data page and Ask read the same numbers.
  const series = existsSync("data/series.json") ? JSON.parse(await readFile("data/series.json", "utf8")) : null;
  if (series) await put("series.json", series);

  // Settings from topic/*.yaml that the pages read (tabs, flags, defaults, custom attributes, requests).
  const site = await loadSiteConfig();
  const video = existsSync("topic/videos.yaml") ? await loadVideoConfig() : { channels: [], match: {}, keepDays: 0 };
  const feeds = (await loadSources()).feeds;
  const topic = await loadTopic();
  await buildPages({ name: site.site.name, tagline: site.site.tagline, domain: topic.domain });
  // The brief links to the full story list and the themes (desk.html), and a pack with series gets
  // a Data tab, even when its site.yaml predates them.
  const desks = [...site.desks];
  // Only for the standard brief: a pack with its own home page (site/index.html) keeps its own tabs.
  if (!existsSync("site/index.html") && !desks.some((d) => d.page.startsWith("desk.html"))) {
    const at = Math.max(1, desks.findIndex((d) => d.page === "./") + 1);
    desks.splice(at, 0, { id: "stories", label: "All stories", page: "desk.html#updates", enabled: true }, { id: "themes", label: `By ${topic.vocab.theme.toLowerCase()}`, page: "desk.html#sectors", enabled: true });
  }
  if (series?.series?.length && !desks.some((d) => d.id === "data")) desks.splice(Math.max(0, desks.length - 1), 0, { id: "data", label: "Data", page: "data.html", enabled: true });
  await put("config.json", {
    generatedAt,
    ...site,
    desks,
    videos: { topics: [...new Set(video.channels.map((c) => c.topic).filter((t) => t !== "mixed").concat(Object.keys(video.match)))], channels: video.channels, keepDays: video.keepDays },
    requests: existsSync("topic/requests.yaml") ? await loadRequests() : [],
    formulaFields: FORMULA_FIELDS,
    // What the docs page shows: what the desk follows and where it comes from.
    topic: {
      domain: topic.domain,
      audience: topic.audience,
      vocab: topic.vocab,
      entityKinds: topic.entityKinds,
      types: typeNames(topic),
      sectors: topic.sectors.map(({ id, name, keywords, pattern, soWhat }) => ({ id, name, keywords, pattern, soWhat })),
    },
    feeds: feeds.map((f) => ({ ...f, url: "url" in f ? f.url : undefined, feedUrl: feedUrl(f) })),
    health: existsSync("data/health.json") ? JSON.parse(await readFile("data/health.json", "utf8")) : null,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await buildApi(await loadDesk());
  } catch (err) {
    // Pack mistakes (topic/*.yaml) come with a readable message; show just that.
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  console.log(`API written to ${API_DIR}/`);
}
