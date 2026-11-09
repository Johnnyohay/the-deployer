/**
 * The topic pack: everything that makes a deployment about one subject and not another.
 * topic/topic.yaml holds what it follows (sectors, story types, the brief, how Ask talks)
 * and topic/sources.yaml where the news comes from. The engine reads only these, so a new
 * subject needs a new pack, not new code. Both files are checked against the schemas below;
 * a mistake stops the run with the path of the bad value.
 */
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod/v4";

const TIERS = ["primary", "news", "research", "aggregator"] as const;
export type Tier = (typeof TIERS)[number];

// A rule matches text by plain keywords (whole words, any case) and/or a raw regex `pattern`.
const rule = {
  keywords: z.array(z.string().min(1)).default([]),
  pattern: z.string().optional().describe("A regular expression, matched case-insensitively"),
};
const hasRule = (r: { keywords: string[]; pattern?: string }) => r.keywords.length > 0 || !!r.pattern;

const Sector = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*$/, "use lowercase letters and digits only, starting with a letter"),
  name: z.string(),
  ...rule,
  soWhat: z.string().default("").describe("Why a story in this sector usually matters to the audience"),
}).refine(hasRule, "give the sector some keywords or a pattern");

const StoryType = z.object({ name: z.string(), weight: z.number().min(0).default(1), ...rule }).refine(hasRule, "give the story type some keywords or a pattern");

const Mode = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  label: z.string(),
  instruction: z.string(),
  suggest: z.array(z.string()).default([]).describe("Suggested questions; {scope}, {when} and {entity} are filled in"),
});

// The words the site uses for this subject's building blocks: what a theme is called
// ("Sector", "Market", "Region"…), what the tracked things are ("Company", "Brand", "Club"…).
const VOCAB_DEFAULTS = {
  theme: "Sector",
  themes: "Sectors",
  entity: "Company",
  entities: "Companies",
  state: "Where it stands",
  money: "Where the money is",
  watch: "What to watch",
  ideas: "Ideas",
  ideasIntro: "Openings that come out of the evidence collected here.",
  updatesIntro: "Every sourced story, newest first.",
  searchExample: "",
};
const Vocab = z.object(Object.fromEntries(Object.entries(VOCAB_DEFAULTS).map(([k, v]) => [k, z.string().default(v)])) as {
  [K in keyof typeof VOCAB_DEFAULTS]: z.ZodDefault<z.ZodString>;
}).prefault({});

// The kinds of things the desk tracks (companies, countries, ports, people…). Entities in
// data/companies.json carry one of these in `kind`; stories are tagged with the ones they mention.
const EntityKind = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*$/, "use lowercase letters and digits only"),
  label: z.string(),
  plural: z.string(),
});

const Topic = z.object({
  domain: z.string().describe("A short phrase for what this desk covers, e.g. 'defense tech and US housing'"),
  audience: z.string().describe("Who reads it and why; every 'why it matters' is written for them"),
  vocab: Vocab,
  entityKinds: z.array(EntityKind).default([{ id: "company", label: "Company", plural: "Companies" }]),
  scope: z.object(rule).default({ keywords: [] })
    .describe("The subject's core terms: when set, a story must contain at least one to be kept, so a theme keyword can't pull in news from another field"),
  sectors: z.array(Sector).min(1),
  storyTypes: z.array(StoryType).default([]),
  defaultType: z.object({ name: z.string(), weight: z.number().min(0).default(1) }).default({ name: "News", weight: 1 }),
  noise: z.object(rule).default({ keywords: [] }).describe("Headlines matching this are dropped (personnel moves, webinars…)"),
  collect: z.object({ lookbackDays: z.number().int().positive().default(3) }).default({ lookbackDays: 3 }),
  curate: z.object({ ideas: z.boolean().default(false).describe("Let the curator suggest ideas from the news each week") }).prefault({}),
  brief: z.object({
    title: z.string(),
    stories: z.number().int().min(1).max(10).default(5),
  }),
  ask: z.object({
    intro: z.string().describe("Who the assistant is and who it helps; the first lines of every answer's instructions"),
    rules: z.array(z.string()).default([]).describe("Extra answering rules for this subject"),
    examples: z.object({
      cite: z.string().default("[Reuters]"),
      query: z.string().default("'price increase'"),
      company: z.string().default("'Acme'"),
      paper: z.string().default("'battery degradation modeling'"),
    }).default({ cite: "[Reuters]", query: "'price increase'", company: "'Acme'", paper: "'battery degradation modeling'" })
      .describe("Examples shown to the model in tool descriptions and answering rules"),
    modes: z.array(Mode).min(1),
  }),
  // Only the optional Claude-written brief (npm run daily:claude) uses this.
  research: z.object({
    scope: z.string().describe("What to research each day; {{since}} becomes the date of the last brief"),
    preferredSources: z.string().describe("Which sources to trust first"),
  }).optional(),
});

// A feed is an RSS/Atom URL, or a Google News search (`googleNews: "query"`), which works
// for any subject and covers sites that publish no feed of their own.
const Feed = z.union([
  z.object({ name: z.string(), url: z.url(), tier: z.enum(TIERS).default("news") }),
  z.object({ name: z.string(), googleNews: z.string().min(2), tier: z.enum(TIERS).default("news"), lang: z.string().default("en-US") }),
]);

const Sources = z.object({ feeds: z.array(Feed).min(1) });
export type Feed = z.infer<typeof Feed>;

/** The URL a feed is read from. */
export function feedUrl(f: Feed): string {
  if ("url" in f) return f.url;
  const [hl, gl = "US"] = f.lang.split("-");
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`${f.googleNews} when:7d`)}&hl=${f.lang}&gl=${gl}&ceid=${gl}:${hl}`;
}

export type Topic = z.infer<typeof Topic>;
export type Sources = z.infer<typeof Sources>;

export async function loadYaml<S extends z.ZodType>(file: string, schema: S): Promise<z.infer<S>> {
  const text = await readFile(file, "utf8");
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`${file}: not valid YAML. ${err instanceof Error ? err.message : err}`);
  }
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".") || "(top level)"}: ${i.message}`).join("\n");
    throw new Error(`${file} has problems:\n${problems}`);
  }
  return result.data;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Turns a rule into one case-insensitive regex: keywords as whole words, plus the raw pattern. */
export function compileRule(r: { keywords: string[]; pattern?: string }, where: string): RegExp {
  const parts = [];
  if (r.pattern) parts.push(r.pattern);
  if (r.keywords.length) parts.push(`\\b(?:${r.keywords.map(escape).join("|")})\\b`);
  const src = parts.length === 1 ? parts[0] : parts.map((p) => `(?:${p})`).join("|");
  try {
    return new RegExp(src || "(?!)", "i");
  } catch (err) {
    throw new Error(`${where}: pattern is not a valid regular expression. ${(err as Error).message}`);
  }
}

/** Either number of a term: "tariffs" also finds "tariff", "port" also finds "ports". */
const eitherNumber = (term: string) => {
  const t = escape(term);
  if (/ies$/i.test(term)) return `${t.slice(0, -3)}(?:y|ies)`;
  if (/[^s]s$/i.test(term)) return `${t.slice(0, -1)}s?`;
  if (/y$/i.test(term)) return `${t.slice(0, -1)}(?:y|ies)`;
  return `${t}(?:s|es)?`;
};

/** The scope rule. Unlike theme keywords, scope terms match in either number, since a story
 * dropped for "tariff" vs "tariffs" is lost for good. */
export function scopeRule(scope: { keywords: string[]; pattern?: string }): RegExp | null {
  if (!scope.keywords.length && !scope.pattern) return null;
  return compileRule({ keywords: [], pattern: [scope.pattern, scope.keywords.length ? `\\b(?:${scope.keywords.map(eitherNumber).join("|")})\\b` : ""].filter(Boolean).map((p) => `(?:${p})`).join("|") }, "topic/topic.yaml scope");
}

export async function loadTopic(): Promise<Topic> {
  const topic = await loadYaml("topic/topic.yaml", Topic);
  const ids = topic.sectors.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`topic/topic.yaml: sector id "${dup}" is used twice.`);
  topic.sectors.forEach((s) => compileRule(s, `topic/topic.yaml sector "${s.id}"`));
  topic.storyTypes.forEach((t) => compileRule(t, `topic/topic.yaml story type "${t.name}"`));
  compileRule(topic.noise, "topic/topic.yaml noise");
  scopeRule(topic.scope);
  return topic;
}

export const loadSources = () => loadYaml("topic/sources.yaml", Sources);

// topic/series.yaml (optional): the data desk. Each series is a number tracked over time from
// a source that needs no key: FRED's public CSV, World Bank, or any CSV/JSON URL.
const SeriesSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fred"), code: z.string().regex(/^[A-Za-z0-9_.]+$/, "a FRED series code, e.g. RSXFS") }),
  z.object({
    kind: z.literal("worldbank"),
    indicator: z.string().describe("A World Bank indicator code, e.g. NE.IMP.GNFS.ZS"),
    country: z.string().default("WLD").describe("ISO code, e.g. US, CN, or WLD for the world"),
  }),
  z.object({
    kind: z.literal("csv"),
    url: z.url(),
    date: z.string().default("date").describe("The date column's header"),
    value: z.string().describe("The value column's header"),
  }),
  z.object({
    kind: z.literal("json"),
    url: z.url(),
    items: z.string().default("").describe("Dot path to the array of points, e.g. 'data.rows'; empty when the response is the array"),
    date: z.string().default("date"),
    value: z.string().default("value"),
  }),
]);
const Series = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "use lowercase letters, digits and dashes"),
  name: z.string(),
  unit: z.string().default(""),
  theme: z.string().optional().describe("The sector id this series belongs to, so the theme page can show it"),
  why: z.string().default("").describe("One line on why this number matters to the audience"),
  better: z.enum(["up", "down", "neither"]).default("neither").describe("Which direction is good news, for coloring"),
  source: SeriesSource,
});
const SeriesFile = z.object({
  series: z.array(Series).default([]),
  notableSigma: z.number().positive().default(2).describe("A change bigger than this many standard deviations of past changes is notable"),
});
export type Series = z.infer<typeof Series>;
export type SeriesSource = z.infer<typeof SeriesSource>;
export const loadSeriesConfig = () => loadYaml("topic/series.yaml", SeriesFile);

/** The page a person can open to see where a series comes from. */
export function seriesSourceUrl(s: SeriesSource): string {
  switch (s.kind) {
    case "fred": return `https://fred.stlouisfed.org/series/${s.code}`;
    case "worldbank": return `https://data.worldbank.org/indicator/${s.indicator}?locations=${s.country}`;
    default: return s.url;
  }
}

/** Every story type name: the ruled ones in order, then the default. */
export const typeNames = (t: Topic) => [...new Set([...t.storyTypes.map((s) => s.name), t.defaultType.name])];
export const typeWeights = (t: Topic): Record<string, number> =>
  Object.fromEntries([...t.storyTypes, t.defaultType].map((s) => [s.name, s.weight]));

/** The parts of the pack that answering needs, published in all.json so every way of asking sees the same. */
export interface PackInfo {
  name: string;
  owner: string;
  tagline: string;
  domain: string;
  vocab: Topic["vocab"];
  entityKinds: Topic["entityKinds"];
  audience: string;
  types: string[];
  ask: Topic["ask"];
}

export const packInfo = (topic: Topic, site: { name: string; owner: string; tagline: string }): PackInfo => ({
  name: site.name,
  owner: site.owner,
  tagline: site.tagline,
  domain: topic.domain,
  vocab: topic.vocab,
  entityKinds: topic.entityKinds,
  audience: topic.audience,
  types: typeNames(topic),
  ask: topic.ask,
});
