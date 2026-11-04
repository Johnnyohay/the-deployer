import { z } from "zod/v4";
import { typeNames, type Topic } from "./topic.ts";

// Sector ids and story types come from the pack (topic/topic.yaml), so the schemas that the
// optional Claude pipeline and the agent's tools validate against are built per pack.

const Source = z.object({
  t: z.string().describe("Publication or organization name, e.g. 'Reuters'"),
  u: z.string().describe("Full https URL of the article or document"),
  q: z.enum(["primary", "news", "research", "aggregator"]).describe(
    "primary = filings, company or government releases; news = reported journalism; research = think tanks, CRS, data providers; aggregator = secondary compilations",
  ),
});

const updateDraft = (SectorId: z.ZodType<string>, Type: z.ZodType<string>, audience: string) => z.object({
  d: z.string().describe("Date the event happened, YYYY-MM-DD"),
  title: z.string().describe("Plain-language headline, under 110 characters"),
  body: z.string().describe("One or two sentences on what happened"),
  why: z.string().describe(`One sentence on why it matters to ${audience}`),
  sectors: z.array(SectorId),
  type: Type,
  companies: z.array(z.string()),
  src: Source,
});

const story = (audience: string) => z.object({
  tag: z.string().describe("Short topic label, e.g. the sector's name"),
  h: z.string().describe("Headline a non-expert understands"),
  what: z.string().describe("One or two plain sentences. Few numbers, no acronyms without explanation."),
  you: z.string().describe(`Why it matters to ${audience}`),
  updateIndex: z.number().int().describe("Index into the updates array of the update this story is based on"),
});

const catalyst = (SectorId: z.ZodType<string>) => z.object({
  d: z.string().describe("YYYY-MM-DD; use the 15th or last day of the month when only the month is known"),
  approx: z.boolean(),
  title: z.string(),
  sectors: z.array(SectorId),
  why: z.string(),
});

/** What the optional Claude pipeline must return, with this pack's sectors and story types. */
export function dailyOutput(topic: Topic) {
  const SectorId = z.enum(topic.sectors.map((s) => s.id) as [string, ...string[]]);
  const Type = z.enum(typeNames(topic) as [string, ...string[]]);
  return z.object({
    updates: z.array(updateDraft(SectorId, Type, topic.audience)).describe("New, significant developments not already on the desk, newest first"),
    brief: z.object({
      title: z.string().describe("A short headline for the day"),
      big: z.string().describe("One or two sentences: the big picture today"),
      stories: z.array(story(topic.audience)).describe("Three to five stories, most important first"),
      watch: z.object({ h: z.string(), why: z.string() }).describe("The one thing to keep an eye on"),
      idea: z.object({ h: z.string(), why: z.string() }).describe(`One concrete idea for ${topic.audience}, grounded in today's news`),
    }),
    newCatalysts: z.array(catalyst(SectorId)).describe("New dated upcoming events (deadlines, decisions, launches) not already listed"),
  });
}

export type DailyOutput = z.infer<ReturnType<typeof dailyOutput>>;
export type UpdateDraft = DailyOutput["updates"][number];
export type Update = UpdateDraft & { id: string; dApprox?: boolean; addedAt?: string; orgs?: string[] };
export type Catalyst = DailyOutput["newCatalysts"][number] & { id: string };
export interface Sector { id: string; order: number; name: string; heat: number; state: string; money: string; watch: string }
export interface Brief {
  date: string;
  title: string;
  big: string;
  stories: { tag: string; h: string; what: string; you: string; ref: string }[];
  watch: { h: string; why: string };
  idea: { h: string; why: string };
}
