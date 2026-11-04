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

const Mode = z.object({ id: z.string().regex(/^[a-z][a-zA-Z0-9]*$/), label: z.string(), instruction: z.string() });

const Topic = z.object({
  domain: z.string().describe("A short phrase for what this desk covers, e.g. 'defense tech and US housing'"),
  audience: z.string().describe("Who reads it and why; every 'why it matters' is written for them"),
  sectors: z.array(Sector).min(1),
  storyTypes: z.array(StoryType).default([]),
  defaultType: z.object({ name: z.string(), weight: z.number().min(0).default(1) }).default({ name: "News", weight: 1 }),
  noise: z.object(rule).default({ keywords: [] }).describe("Headlines matching this are dropped (personnel moves, webinars…)"),
  collect: z.object({ lookbackDays: z.number().int().positive().default(3) }).default({ lookbackDays: 3 }),
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

const Sources = z.object({
  feeds: z.array(z.object({ name: z.string(), url: z.url(), tier: z.enum(TIERS).default("news") })).min(1),
});

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

export async function loadTopic(): Promise<Topic> {
  const topic = await loadYaml("topic/topic.yaml", Topic);
  const ids = topic.sectors.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`topic/topic.yaml: sector id "${dup}" is used twice.`);
  topic.sectors.forEach((s) => compileRule(s, `topic/topic.yaml sector "${s.id}"`));
  topic.storyTypes.forEach((t) => compileRule(t, `topic/topic.yaml story type "${t.name}"`));
  compileRule(topic.noise, "topic/topic.yaml noise");
  return topic;
}

export const loadSources = () => loadYaml("topic/sources.yaml", Sources);

/** Every story type name: the ruled ones in order, then the default. */
export const typeNames = (t: Topic) => [...new Set([...t.storyTypes.map((s) => s.name), t.defaultType.name])];
export const typeWeights = (t: Topic): Record<string, number> =>
  Object.fromEntries([...t.storyTypes, t.defaultType].map((s) => [s.name, s.weight]));

/** The parts of the pack that answering needs, published in all.json so every way of asking sees the same. */
export interface PackInfo {
  name: string;
  owner: string;
  domain: string;
  audience: string;
  types: string[];
  ask: Topic["ask"];
}

export const packInfo = (topic: Topic, site: { name: string; owner: string }): PackInfo => ({
  name: site.name,
  owner: site.owner,
  domain: topic.domain,
  audience: topic.audience,
  types: typeNames(topic),
  ask: topic.ask,
});
