/**
 * `deployer init`: plain-English interests in, a working pack out. No code, no YAML by hand.
 *
 *   deployer init --pack my-desk --describe "Trends in retail, supply chain and geopolitics, for a retail strategy lead"
 *   deployer init --pack my-desk            (asks the questions in the terminal)
 *   deployer init --pack . --from-file issue.md   (the GitHub "Set me up" issue)
 *
 * 1. Drafts the pack's ontology with an AI: what the subject is made of (themes with their
 *    keywords and why they matter, the kinds of things worth tracking, the kinds of events,
 *    the words the site should use), how Ask should talk, the sources and the key entities.
 * 2. Checks every source (see discover.ts) and adds a Google News search per theme, so each
 *    theme has coverage even where no site publishes a feed.
 * 3. Dry-runs the tagging on the live feeds and redrafts the keywords of themes that catch nothing.
 * 4. Writes topic/*.yaml and data/, then runs the first collect, curate and build.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stringify } from "yaml";
import { z } from "zod/v4";
import { askJson } from "./ai.ts";
import { discoverFeed, pool, resolveYouTube, siteUrl } from "./discover.ts";
import { fetchFeed } from "./rss.ts";
import { compileRule, feedUrl, loadTopic, loadSources, type Feed } from "./topic.ts";
import { slug } from "./store.ts";
import { runStep } from "./run-step.ts";
import { draftScope } from "./scope.ts";


// ---- what the AI drafts (lenient; normalized into the pack schema below) ----

const Phrases = z.array(z.string().min(2)).describe("Whole-word phrases matched case-insensitively in headlines and summaries");

const OntologyDraft = z.object({
  name: z.string().describe("A short, memorable name for the site, 1-3 words"),
  tagline: z.string().describe("One line under the name: what it follows, for whom"),
  domain: z.string().describe("A short noun phrase for the whole subject, e.g. 'retail, supply chains and geopolitics'"),
  audience: z.string().describe("Who reads it and what they want from it, one sentence starting lowercase, e.g. 'a retail strategy lead who wants to see supply shocks coming'"),
  vocab: z.object({
    theme: z.string().describe("What one theme is called on the site, e.g. Sector, Market, Region, Topic"),
    themes: z.string(),
    entity: z.string().describe("What the tracked things are called, e.g. Company, Brand, Player, Organization"),
    entities: z.string(),
    state: z.string().describe("Heading for a theme's current situation, e.g. 'Where it stands'"),
    money: z.string().describe("Heading for the second part of a theme brief that fits this subject, e.g. 'Where the money is', 'Who's winning', 'Key numbers'"),
    watch: z.string().describe("Heading for what to watch next"),
  }),
  entityKinds: z.array(z.object({ id: z.string(), label: z.string(), plural: z.string() })).min(1).max(6)
    .describe("The kinds of things worth tracking for this subject, e.g. company, country, port, person, product"),
  sectors: z.array(z.object({
    name: z.string().describe("Theme name, 1-5 words"),
    keywords: Phrases.min(6).max(20).describe("Specific phrases, names, acronyms and their plural forms that a headline about this theme would contain. Each keyword alone must mean this theme: use names, technical terms and exact phrases. Never use generic business phrases that fit any news (strategic partnership, joint venture, growth, approval, market, new deal)."),
    soWhat: z.string().describe("One sentence: why a story in this theme usually matters to the audience"),
  })).min(5).max(14),
  storyTypes: z.array(z.object({
    name: z.string().describe("Kind of event, e.g. 'Deal', 'Policy', 'Earnings', 'Launch'"),
    weight: z.number().min(1).max(3).describe("3 = usually important, 1 = background"),
    keywords: Phrases.min(3).max(14),
  })).min(3).max(8).describe("Kinds of events, most specific first; the first that matches a story wins"),
  defaultType: z.string().describe("Type for stories that match no other, e.g. 'News'"),
  noise: Phrases.max(25).describe("Phrases of headlines to drop: personnel moves, webinars, podcasts, sponsored posts, roundups"),
  briefTitle: z.string().describe("Title of the daily brief, e.g. 'Today in retail, supply chain and geopolitics'"),
  ideas: z.object({
    wanted: z.boolean().describe("Whether the audience would want concrete ideas or actions suggested from the news"),
    label: z.string().describe("What to call them, e.g. 'Ideas to act on', 'Plays', 'Opportunities'"),
    intro: z.string().describe("One sentence explaining them"),
  }),
  searchExample: z.string().describe("3-4 comma-separated example searches"),
  language: z.string().describe("Language-region of the news to follow, e.g. en-US, en-GB, fr-FR"),
});
type OntologyDraft = z.infer<typeof OntologyDraft>;

const AskDraft = z.object({
  intro: z.string().describe("Two or three sentences: who the assistant is (by the site's name), who it helps, and what they want"),
  rules: z.array(z.string()).min(2).max(5).describe("Answering rules specific to this subject and audience"),
  examples: z.object({
    cite: z.string().describe("Two example source tags in brackets, e.g. '[Reuters] or [Supply Chain Dive]'"),
    query: z.string().describe("Two example searches in quotes, e.g. \"'port congestion' or 'tariff'\""),
    company: z.string().describe("One example tracked name in quotes"),
    paper: z.string().describe("Two example research topics in quotes"),
  }),
  modes: z.array(z.object({
    id: z.string().describe("camelCase id; use learn, news, advise, company and compare for those common ones"),
    label: z.string().describe("Short dropdown label, e.g. 'Teach me'"),
    instruction: z.string().describe("What the assistant should do in this mode, written as the user's request"),
    suggest: z.array(z.string()).min(3).max(4).describe("Suggested questions; use {scope} for the chosen theme or subject, {when} for the time range, {entity} for a chosen tracked name"),
  })).min(4).max(7).describe("Ways of asking: always learn, news, advise, company (deep dive on one tracked name) and compare, plus up to two that fit this audience"),
});

const SourcesDraft = z.object({
  publications: z.array(z.object({
    name: z.string(),
    homepage: z.string().describe("https URL of the site"),
    feed: z.string().optional().describe("RSS/Atom URL if you are confident of it"),
    tier: z.enum(["primary", "news", "research", "aggregator"]).describe("primary = official releases/filings/data; news = journalism and trade press; research = think tanks, analysts"),
  })).min(10).max(28).describe("The best free, public sources for this subject: trade press, major outlets' section feeds, official bodies, research groups. Prefer ones known to publish RSS."),
  youtube: z.array(z.object({ handle: z.string().describe("@handle"), name: z.string(), theme: z.string().describe("theme name it mostly covers") })).max(8)
    .describe("YouTube channels that regularly post about this subject; empty if none are good"),
});

const EntitiesDraft = z.object({
  entities: z.array(z.object({
    name: z.string(),
    kind: z.string().describe("one of the entity kind ids"),
    themes: z.array(z.string()).describe("theme names it belongs to"),
    about: z.string().describe("One factual line on who or what it is and why it matters here"),
    aliases: z.array(z.string()).max(4).describe("Other names or tickers used in headlines"),
  })).min(10).max(30),
});

const KeywordFix = z.object({
  sectors: z.array(z.object({ name: z.string(), keywords: Phrases.min(6).max(20) })),
});

// ---- helpers ----

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const idOf = (name: string) => slug(name).replace(/-/g, "").replace(/^(\d)/, "s$1").slice(0, 24) || "theme";
const uniqueIds = (names: string[]) => {
  const seen = new Set<string>();
  return names.map((n) => {
    let id = idOf(n);
    for (let i = 2; seen.has(id); i++) id = `${idOf(n)}${i}`;
    seen.add(id);
    return id;
  });
};
const clean = (list: string[]) => [...new Set(list.map((k) => k.trim()).filter((k) => k.length > 1))];
const camel = (s: string) => slug(s).replace(/-(\w)/g, (_, c: string) => c.toUpperCase()).replace(/^(\d)/, "m$1") || "mode";

async function describeInteractively(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const q = async (text: string) => (await rl.question(`${text}\n> `)).trim();
  const what = await q("What do you want to follow? (any subjects, e.g. 'trends in retail, supply chain and geopolitics')");
  const who = await q("Who is it for, and what do you want from it? (optional)");
  const name = await q("A name for your site? (optional)");
  const reads = await q("Sources you already read or trust? (optional)");
  const tubes = await q("YouTube channels you like on this? (optional)");
  rl.close();
  return [`Follow: ${what}`, who && `For: ${who}`, name && `Name: ${name}`, reads && `Sources I read: ${reads}`, tubes && `YouTube channels: ${tubes}`].filter(Boolean).join("\n");
}

/** Counts stories per theme on the live feeds, and keeps headlines no theme caught. */
async function coverage(sectors: { id: string; name: string; keywords: string[] }[], feeds: Feed[], feedUrlOf: (f: Feed) => string, noise: RegExp, scope: RegExp) {
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const warn = console.warn;
  console.warn = () => {};
  const items = (await pool(feeds, 8, (f) => fetchFeed(f.name, feedUrlOf(f)))).flat().filter((i) => i.date >= since && !noise.test(i.title));
  console.warn = warn;
  const rules = sectors.map((s) => ({ id: s.id, re: compileRule({ keywords: s.keywords }, s.name) }));
  const counts = Object.fromEntries(sectors.map((s) => [s.id, 0]));
  const unmatched: string[] = [];
  for (const it of items) {
    const text = `${it.title} ${it.summary}`;
    const hits = scope.test(text) ? rules.filter((r) => r.re.test(text)) : [];
    hits.forEach((r) => counts[r.id]++);
    if (!hits.length) unmatched.push(it.title);
  }
  return { total: items.length, counts, unmatched: [...new Set(unmatched)] };
}

function run(command: string, env: Record<string, string> = {}) {
  if (!runStep(command, env)) console.warn(`(${command} did not finish cleanly; the site still builds from what is there)`);
}

// ---- main ----

const pack = process.cwd();
const fromFile = opt("from-file");
const description =
  opt("describe") ?? (fromFile ? await readFile(fromFile, "utf8") : process.env.DEPLOYER_DESCRIBE) ?? (process.stdin.isTTY ? await describeInteractively() : "");
if (!description.trim()) {
  console.error("Describe what to follow: deployer init --describe \"…\" (or run it in a terminal to be asked).");
  process.exit(1);
}
if (existsSync("topic/topic.yaml") && !args.includes("--force")) {
  console.error(`${pack} already has a pack (topic/topic.yaml). Use \`deployer change\` to adjust it, or --force to start over.`);
  process.exit(1);
}
const owner = opt("owner") ?? process.env.DEPLOYER_OWNER ?? "";

console.log("1/6 Drafting what your subject is made of…");
const o: OntologyDraft = await askJson(OntologyDraft, {
  tier: "smart",
  system:
    "You design the structure (ontology) of a personal daily news-briefing site for one person's interests. You choose the themes the subject breaks into, the keywords that find stories about each theme in news headlines, the kinds of events and of tracked things, and the words the site uses. Be concrete and specific to the subject; prefer 8-12 themes that together cover everything the person asked for, without overlap.",
  user: `The person's request, in their own words:\n"""\n${description.trim()}\n"""`,
});

const sectorIds = uniqueIds(o.sectors.map((s) => s.name));
let sectors = o.sectors.map((s, i) => ({ id: sectorIds[i], name: s.name, keywords: clean(s.keywords), soWhat: s.soWhat }));
const kinds = o.entityKinds.map((k, i) => ({ id: uniqueIds(o.entityKinds.map((x) => x.id))[i], label: k.label, plural: k.plural }));
const name = opt("name") ?? o.name;
console.log(`    ${name}: ${sectors.length} ${o.vocab.themes.toLowerCase()} (${sectors.map((s) => s.name).join(", ")})`);

console.log("2/6 Drafting how Ask should help you…");
const a = await askJson(AskDraft, {
  tier: "smart",
  system: `You write the instructions for "${name}", an AI assistant that answers questions from a personal news desk on ${o.domain}, written for ${o.audience}.`,
  user: `Themes: ${sectors.map((s) => s.name).join("; ")}. Tracked kinds: ${kinds.map((k) => k.plural).join(", ")}. The person's request:\n"""\n${description.trim()}\n"""`,
});
const modeIds = new Set<string>();
const modes = a.modes.map((m) => {
  let id = camel(m.id);
  while (modeIds.has(id)) id += "2";
  modeIds.add(id);
  return { id, label: m.label.replace(/[:\s]*\{\w+\}/g, "").trim(), instruction: m.instruction, suggest: m.suggest };
});

console.log("3/6 Finding sources…");
const s = await askJson(SourcesDraft, {
  tier: "smart",
  system: "You know the best free, public news and data sources for any subject, and their RSS feeds. Name real publications only.",
  user: `Subject: ${o.domain}. Audience: ${o.audience}. Language/region: ${o.language}. Themes: ${sectors.map((x) => x.name).join("; ")}.\nThe person's request (it may name sources and channels they like; include those):\n"""\n${description.trim()}\n"""`,
});
const checked = await pool(s.publications, 8, async (p) => ({ p, feed: await discoverFeed(p) }));
const feeds: Feed[] = [];
for (const { p, feed } of checked) {
  if (feed && !feeds.some((f) => "url" in f && f.url === feed.url)) feeds.push({ name: p.name, url: feed.url, tier: p.tier });
}
// Big outlets often publish no feed (or block readers); a Google News search limited to their
// site still brings in their headlines on this subject.
const noFeed = checked.filter((c) => !c.feed);
const siteFeeds: Feed[] = [];
const topicWords = (list: { keywords: string[] }[]) => list.slice(0, 6).map((x) => x.keywords[0]).map((k) => (k.includes(" ") ? `"${k}"` : k)).join(" OR ");
for (const { p } of noFeed.slice(0, 8)) {
  const host = siteUrl(p.homepage)?.hostname.replace(/^www\./, "");
  if (host && !siteFeeds.some((f) => f.name === p.name)) siteFeeds.push({ name: p.name, googleNews: `site:${host} (${topicWords(sectors)})`, tier: p.tier, lang: "en-US" });
}
const dead = noFeed.slice(8).map((c) => c.p.name);
console.log(`    ${feeds.length} of ${s.publications.length} suggested sources have a working feed; ${siteFeeds.length} more come in through Google News${dead.length ? ` (left out: ${dead.join(", ")})` : ""}`);

// A Google News search per theme: coverage for every theme, even with no dedicated feed.
const lang = /^[a-z]{2}-[A-Z]{2}$/.test(o.language) ? o.language : "en-US";
const gnQuery = (keywords: string[]) => keywords.slice(0, 5).map((k) => (k.includes(" ") ? `"${k}"` : k)).join(" OR ");
const themeFeeds = (list: typeof sectors): Feed[] => list.map((x) => ({ name: `Google News: ${x.name}`, googleNews: gnQuery(x.keywords), tier: "news" as const, lang }));
const noiseRe = compileRule({ keywords: clean(o.noise) }, "noise");
const scope = await draftScope(o.domain, sectors.map((x) => x.name)).catch(() => [] as string[]);
const scopeRe = scope.length ? compileRule({ keywords: scope }, "scope") : /(?:)/;

console.log("4/6 Testing the keywords on this week's news…");
let cov = await coverage(sectors, [...feeds, ...siteFeeds, ...themeFeeds(sectors)], feedUrl, noiseRe, scopeRe);
const weak = sectors.filter((x) => cov.counts[x.id] < 3);
if (weak.length && cov.unmatched.length) {
  const fix = await askJson(KeywordFix, {
    tier: "fast",
    system: "You improve keyword rules that sort news headlines into themes. Keywords are whole-word, case-insensitive phrases.",
    user: `These themes caught almost no stories this week: ${weak.map((x) => `${x.name} (keywords: ${x.keywords.join(", ")})`).join("; ")}.\nHere are recent headlines no theme caught; some may belong to those themes:\n${cov.unmatched.slice(0, 60).map((t) => `- ${t}`).join("\n")}\nGive better keywords for each of those themes (keep the names exactly), that would catch stories like these and future ones without catching unrelated news.`,
  }).catch(() => null);
  for (const f of fix?.sectors ?? []) {
    const t = sectors.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
    if (t) t.keywords = clean([...f.keywords, ...t.keywords]).slice(0, 24);
  }
  if (fix) cov = await coverage(sectors, [...feeds, ...siteFeeds, ...themeFeeds(sectors)], feedUrl, noiseRe, scopeRe);
}
console.log(`    ${cov.total} stories this week; per ${o.vocab.theme.toLowerCase()}: ${sectors.map((x) => `${x.name} ${cov.counts[x.id]}`).join(", ")}`);

console.log("5/6 Listing who and what to track…");
const e = await askJson(EntitiesDraft, {
  tier: "smart",
  system: "You list the key players and things a person following a subject should track. Only real, well-known ones; one factual line each.",
  user: `Subject: ${o.domain}, for ${o.audience}. Kinds (use these ids): ${kinds.map((k) => `${k.id} (${k.plural})`).join(", ")}. Themes: ${sectors.map((x) => x.name).join("; ")}.`,
}).catch((err) => (console.warn(`    skipped: ${(err as Error).message.split("\n")[0]}`), { entities: [] }));
const themeId = (n: string) => sectors.find((x) => x.name.toLowerCase() === n.toLowerCase())?.id;
const entities = e.entities.map((x) => {
  const kind = kinds.find((k) => k.id === x.kind || k.label.toLowerCase() === x.kind.toLowerCase()) ?? kinds[0];
  return { id: slug(x.name), name: x.name, kind: kind.id, type: kind.label, sectors: x.themes.map(themeId).filter(Boolean), about: x.about, aliases: clean(x.aliases), latest: "" };
});

const channels = (await pool(s.youtube, 4, async (y) => ({ y, ch: await resolveYouTube(y.handle) })))
  .filter((c) => c.ch)
  .map(({ y, ch }) => ({ name: y.name, id: ch!.id, topic: themeId(y.theme) ?? sectors[0].id }));
if (s.youtube.length) console.log(`    ${channels.length} of ${s.youtube.length} YouTube channels found`);

console.log("6/6 Writing your pack…");
const topic = {
  domain: o.domain,
  audience: o.audience,
  vocab: { ...o.vocab, ideas: o.ideas.label, ideasIntro: o.ideas.intro, updatesIntro: "Every sourced story, newest first.", searchExample: o.searchExample },
  entityKinds: kinds,
  scope: { keywords: scope },
  sectors,
  storyTypes: o.storyTypes.map((t) => ({ name: t.name, weight: t.weight, keywords: clean(t.keywords) })),
  defaultType: { name: o.defaultType, weight: 1 },
  noise: { keywords: clean(o.noise) },
  collect: { lookbackDays: 3 },
  curate: { ideas: o.ideas.wanted },
  brief: { title: o.briefTitle, stories: 5 },
  ask: { intro: a.intro, rules: a.rules, examples: a.examples, modes },
};
const header = (what: string) => `# ${what}\n# Written by \`deployer init\` from your description; edit freely or open a "Change my setup" issue.\n# A mistake here stops the build with a message naming the line, so the site never breaks.\n\n`;
await mkdir("topic", { recursive: true });
await mkdir("data", { recursive: true });
await writeFile("topic/topic.yaml", header(`What ${name} follows: ${o.domain}`) + stringify(topic, { lineWidth: 0 }));
await writeFile("topic/sources.yaml", header("Where the news comes from (RSS/Atom feeds and Google News searches)") + stringify({ feeds: [...feeds, ...siteFeeds, ...themeFeeds(sectors)] }, { lineWidth: 0 }));
const desks = [
  { id: "news", label: "Today", page: "./", enabled: true },
  ...(channels.length ? [{ id: "videos", label: "Watch", page: "videos.html", enabled: true }] : []),
  { id: "docs", label: "Docs", page: "docs.html", enabled: true },
];
await writeFile("topic/site.yaml", header("How the site looks: its name and tabs") + stringify({ site: { name, owner, tagline: o.tagline }, desks, flags: {} }, { lineWidth: 0 }));
if (channels.length) await writeFile("topic/videos.yaml", header("YouTube channels for the Watch tab (topic = a theme id)") + stringify({ keepDays: 60, maxVideos: 400, channels, match: {} }, { lineWidth: 0 }));
await writeFile("data/companies.json", JSON.stringify(entities, null, 2) + "\n");
// Check what was written against the pack schema before anything runs on it.
await loadTopic();
await loadSources();
for (const f of ["updates", "catalysts", "research", "ideas", "sectors"]) if (!existsSync(`data/${f}.json`)) await writeFile(`data/${f}.json`, "[]\n");
await writeFile("data/meta.json", JSON.stringify({ createdAt: new Date().toISOString(), request: description.trim() }, null, 2) + "\n");

// First run: a week of news (not just three days), then the curator writes the theme briefs.
// On GitHub (--no-run) the daily workflow does this right after setup instead.
if (!args.includes("--no-run")) {
  run("collect", { LOOKBACK_DAYS: "7" });
  if (channels.length) run("videos");
  run("curate");
  run("build-api");
}

const report = `## ${name} is set up

**Follows:** ${o.domain}, for ${o.audience}.

| ${o.vocab.theme} | Stories this week | Example keywords |
|---|---|---|
${sectors.map((x) => `| ${x.name} | ${cov.counts[x.id]} | ${x.keywords.slice(0, 5).join(", ")} |`).join("\n")}

- **Sources:** ${feeds.length} direct feeds (${feeds.map((f) => f.name).join(", ")})${siteFeeds.length ? `, ${siteFeeds.length} sites through Google News (${siteFeeds.map((f) => f.name).join(", ")})` : ""}, plus a Google News search for each ${o.vocab.theme.toLowerCase()}.${dead.length ? ` Left out: ${dead.join(", ")}.` : ""}
- **Tracking:** ${entities.length} ${kinds.map((k) => k.plural.toLowerCase()).join(", ")}.${channels.length ? ` ${channels.length} YouTube channels for the Watch tab.` : ""}
- **Ask modes:** ${modes.map((m) => m.label).join(", ")}.

It refreshes every morning on its own. To change anything, open a **Change my setup** issue and say what you want in plain words.
`;
await writeFile("setup-report.md", report);
console.log(`\n${report}`);
