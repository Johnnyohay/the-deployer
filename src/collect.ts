/**
 * Free daily collector: no AI, no API key. Pulls the pack's news feeds (topic/sources.yaml),
 * sorts articles into its sectors with the keyword rules in topic/topic.yaml, writes new updates and (if no brief
 * exists yet for today) an automatic headline brief, then rebuilds the JSON API.
 */
import { fetchFeed } from "./rss.ts";
import { loadDesk, saveDaily, slug } from "./store.ts";
import { buildApi } from "./build-api.ts";
import { tagCompanies } from "./companies.ts";
import type { Brief, Update } from "./schema.ts";
import { compileRule, loadSources, loadTopic, typeWeights } from "./topic.ts";

const topic = await loadTopic();
const FEEDS = (await loadSources()).feeds;
const SECTOR_RULES = Object.fromEntries(topic.sectors.map((s) => [s.id, compileRule(s, s.id)]));
const TYPE_RULES = topic.storyTypes.map((t) => [t.name, compileRule(t, t.name)] as const);
const SECTOR_SO_WHAT = Object.fromEntries(topic.sectors.map((s) => [s.id, s.soWhat]));
const NOISE = compileRule(topic.noise, "noise");
const TYPE_WEIGHT = typeWeights(topic);

interface Article { title: string; link: string; date: string; summary: string; source: (typeof FEEDS)[number] }

const fetchArticles = async (feed: (typeof FEEDS)[number]): Promise<Article[]> =>
  (await fetchFeed(feed.name, feed.url)).map(({ title, link, date, summary }) => ({ title, link, date, summary, source: feed }));

const today = process.env.DESK_DATE ?? new Date().toISOString().slice(0, 10);
const lookbackDays = Number(process.env.LOOKBACK_DAYS ?? topic.collect.lookbackDays);
const since = new Date(Date.parse(today) - lookbackDays * 864e5).toISOString().slice(0, 10);

const desk = await loadDesk();
const articles = (await Promise.all(FEEDS.map(fetchArticles))).flat().filter((a) => a.date >= since && a.date <= today);
console.log(`Fetched ${articles.length} recent articles from ${FEEDS.length} feeds.`);

const knownUrls = new Set(desk.updates.map((u) => u.src?.u));
const knownIds = new Set(desk.updates.map((u) => u.id));
const addedAt = new Date().toISOString();
const added: (Update & { score: number })[] = [];

for (const a of articles) {
  const text = `${a.title} ${a.summary}`;
  const sectors = Object.entries(SECTOR_RULES).filter(([, re]) => re.test(text)).map(([id]) => id);
  if (!sectors.length) continue; // not about anything this desk tracks
  if (NOISE.test(a.title)) continue; // personnel moves, events listings, opinion roundups
  const id = `u-${a.date.replace(/-/g, "")}-${slug(a.title)}`;
  if (knownUrls.has(a.link) || knownIds.has(id)) continue;
  knownUrls.add(a.link);
  knownIds.add(id);
  const type = TYPE_RULES.find(([, re]) => re.test(text))?.[0] ?? topic.defaultType.name;
  const companies = desk.companies
    .map((c) => String(c.name))
    .filter((name) => name.split(/ · | \/ /).some((n) => n.length > 2 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)));
  const titleSectors = sectors.filter((s) => SECTOR_RULES[s].test(a.title));
  const titleSector = titleSectors[0] ?? sectors[0];
  // Lead with the sectors the headline itself is about.
  sectors.sort((x, y) => Number(titleSectors.includes(y)) - Number(titleSectors.includes(x)));
  added.push({
    id, d: a.date, title: a.title, body: a.summary || a.title, why: SECTOR_SO_WHAT[titleSector] ?? "",
    sectors: sectors.slice(0, 4) as Update["sectors"], type, companies,
    src: { t: a.source.name, u: a.link, q: a.source.tier }, addedAt, auto: true,
    score: (TYPE_WEIGHT[type] ?? 1) + companies.length * 2 + titleSectors.length * 2 + (/\$\d/.test(a.title) ? 2 : 0) + (a.source.tier === "primary" ? 1 : 0),
  } as Update & { score: number; auto: boolean });
}

const fresh = added.map(({ score, ...u }) => u);
// Tag companies with the local Hugging Face NER model; keyword matches above still stand if it can't load.
try {
  if (fresh.length) console.log(`Tagged companies on ${await tagCompanies(desk, fresh)} updates that had none.`);
} catch (err) {
  console.warn(`Company tagging skipped: ${err instanceof Error ? err.message : err}`);
}
desk.updates.push(...fresh);
console.log(`Added ${added.length} new updates.`);

// Free brief: only when nothing (e.g. a Claude-written brief) exists for today yet.
let brief: Brief | null = null;
if (!desk.briefs.some((b) => b.date === today) && added.length) {
  const picked: typeof added = [];
  const usedSectors = new Set<string>();
  for (const u of [...added].sort((a, b) => b.score - a.score || b.d.localeCompare(a.d))) {
    const lead = u.sectors[0];
    if (usedSectors.has(lead) && picked.length < added.length - 1) continue; // spread across sectors
    picked.push(u);
    usedSectors.add(lead);
    if (picked.length === topic.brief.stories) break;
  }
  const sectorName = (id: string) => desk.sectors.find((s) => s.id === id)?.name ?? id;
  const counts = new Map<string, number>();
  added.forEach((u) => u.sectors.forEach((s) => counts.set(s, (counts.get(s) ?? 0) + 1)));
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s]) => sectorName(s).toLowerCase());
  const next = desk.catalysts.filter((c) => c.d >= today).sort((a, b) => a.d.localeCompare(b.d))[0];
  const idea = desk.ideas.length ? desk.ideas[Math.floor(Date.parse(today) / 864e5) % desk.ideas.length] : null;
  brief = {
    date: today,
    title: topic.brief.title,
    big: `${added.length} new stories since the last brief. The busiest areas: ${busiest.join(" and ")}.`,
    stories: picked.map((u) => ({ tag: sectorName(u.sectors[0]), h: u.title, what: u.body, you: u.why, ref: u.id })),
    watch: next ? { h: next.title, why: `${next.approx ? "Around " : ""}${new Date(next.d + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}. ${next.why}` } : { h: "Nothing scheduled", why: "" },
    idea: idea ? { h: String(idea.t), why: `${idea.what} ${idea.why}` } : { h: "", why: "" },
    auto: true,
  } as Brief & { auto: boolean };
  desk.briefs.push(brief);
}

desk.meta = { ...desk.meta, collectedAt: addedAt };
await saveDaily(desk, brief);
await buildApi(desk);
console.log(brief ? `Wrote the ${today} brief with ${brief.stories.length} stories.` : "Brief for today already exists or nothing new; kept it.");
