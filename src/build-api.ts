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
  // The data desk: one file with every series, so the Data page and Ask read the same numbers.
  const series = existsSync("data/series.json") ? JSON.parse(await readFile("data/series.json", "utf8")) : null;
  if (series) await put("series.json", series);

  // Settings from topic/*.yaml that the pages read (tabs, flags, defaults, custom attributes, requests).
  const site = await loadSiteConfig();
  const video = existsSync("topic/videos.yaml") ? await loadVideoConfig() : { channels: [], match: {}, keepDays: 0 };
  const topic = await loadTopic();
  const feeds = (await loadSources()).feeds;
  await buildPages({ name: site.site.name, tagline: site.site.tagline, domain: topic.domain });
  // A pack with series gets a Data tab even if its site.yaml predates the data desk.
  const desks = series?.series?.length && !site.desks.some((d) => d.id === "data")
    ? [...site.desks.slice(0, -1), { id: "data", label: "Data", page: "data.html", enabled: true }, ...site.desks.slice(-1)]
    : site.desks;
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
