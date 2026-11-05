/**
 * `deployer change --request "…"` (or --from-file): changes a pack from a plain-English request,
 * e.g. "also follow Mexico nearshoring", "drop sports retail", "call it Tradewinds". The AI
 * turns the request into a list of specific edits; the engine applies them, checks any new
 * source, validates the pack and rebuilds. Nothing else in the pack is touched.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { z } from "zod/v4";
import { askJson } from "./ai.ts";
import { discoverFeed, siteUrl } from "./discover.ts";
import { slug } from "./store.ts";
import { compileRule, loadSources, loadTopic, scopeRule } from "./topic.ts";
import { runStep } from "./run-step.ts";
import { draftScope, GENERIC } from "./scope.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const request = opt("request") ?? (opt("from-file") ? await readFile(opt("from-file")!, "utf8") : args.filter((a) => !a.startsWith("--")).join(" "));
if (!request.trim()) {
  console.error('Say what to change: deployer change --request "also follow …, drop …"');
  process.exit(1);
}

type Doc = Record<string, any>;
const readYaml = async (file: string): Promise<Doc> => parse(await readFile(file, "utf8")) ?? {};
const topic = await readYaml("topic/topic.yaml");
const sources = await readYaml("topic/sources.yaml");
const site = await readYaml("topic/site.yaml");
const entities = JSON.parse(await readFile("data/companies.json", "utf8").catch(() => "[]")) as Doc[];

const Words = z.array(z.string().min(2));
const op = <T extends string, S extends z.ZodRawShape>(name: T, shape: S, about: string) => z.object({ op: z.literal(name), ...shape }).describe(about);
const Op = z.discriminatedUnion("op", [
  op("setSite", { newName: z.string().optional(), tagline: z.string().optional() }, "Rename the site or change its tagline"),
  op("setAudience", { audience: z.string() }, "Change who it is written for"),
  op("setWord", { word: z.enum(["theme", "entity", "state", "money", "watch", "ideas"]), text: z.string().min(2).max(40) }, "Change one of the site's own words (its tabs and headings), e.g. word theme, text 'Markets'"),
  op("editScope", { addKeywords: Words, removeKeywords: Words }, "Scope = the subject's core terms; a story must contain one to be kept. To keep out another field, ADD this subject's own defining terms (never the unwanted field's words)"),
  op("addTheme", { name: z.string(), keywords: Words.min(6), soWhat: z.string() }, "A new theme with specific keywords"),
  op("removeTheme", { name: z.string() }, "Remove a theme by its current name"),
  op("editTheme", { name: z.string(), newName: z.string().optional(), addKeywords: Words, removeKeywords: Words, soWhat: z.string().optional() }, "Change a theme's name, keywords or why-it-matters"),
  op("addSource", { name: z.string(), homepage: z.string().optional(), feed: z.string().optional(), googleNews: z.string().optional() }, "A site (homepage or feed URL) or a Google News search"),
  op("removeSource", { name: z.string() }, "Remove a source by its current name"),
  op("addEntity", { name: z.string(), kind: z.string(), about: z.string(), themes: z.array(z.string()) }, "Start tracking a name"),
  op("removeEntity", { name: z.string() }, "Stop tracking a name"),
  op("addNoise", { keywords: Words.min(1) }, "Drop headlines containing these phrases"),
  op("setIdeas", { wanted: z.boolean() }, "Turn suggested ideas on or off"),
]);
type Op = z.infer<typeof Op>;
const Plan = z.object({
  ops: z.array(Op).min(1).describe("The edits, in order: one for every part of the request, nothing more."),
  summary: z.array(z.string()).describe("One plain line per edit, for the person"),
});

const state = [
  `Site: ${site.site?.name} — ${site.site?.tagline}`,
  `Audience: ${topic.audience}`,
  `Site words: ${Object.entries(topic.vocab ?? {}).filter(([k]) => !/Intro|Example/.test(k)).map(([k, v]) => `${k}="${v}"`).join(", ")}`,
  `Scope terms: ${(topic.scope?.keywords ?? []).join(", ")}`,
  `Themes:\n${(topic.sectors as Doc[]).map((s) => `- ${s.name}: ${(s.keywords ?? []).join(", ")}${s.pattern ? ` (pattern)` : ""}`).join("\n")}`,
  `Sources: ${(sources.feeds as Doc[]).map((f) => f.name).join("; ")}`,
  `Tracked (${topic.entityKinds?.map((k: Doc) => k.id).join("/")}): ${entities.map((e) => e.name).join("; ")}`,
].join("\n");

const plan = await askJson(Plan, {
  tier: "smart",
  system:
    "You edit the setup of a personal news-briefing site. Turn the person's request into edits that do exactly what they ask, covering every part of it. Themes have keywords: whole-word phrases found in headlines; specific names and terms, never generic business words. When the person sees stories from an unrelated field, use editScope to ADD the subject's own defining terms (e.g. for women's football: women's, WSL, NWSL, Lionesses, Liga F) and addNoise for words that only the unwanted stories use. When they add a new area, also add its core terms to the scope. Refer to existing themes, sources and entities by their current names exactly.",
  user: `Current setup:\n${state}\n\nRequest:\n"""\n${request.trim()}\n"""`,
});

const find = (list: Doc[], name?: string) => list.find((x) => String(x.name).toLowerCase() === String(name ?? "").toLowerCase());
const ids = () => new Set((topic.sectors as Doc[]).map((s) => s.id));
const newId = (name: string) => {
  const base = slug(name).replace(/-/g, "").replace(/^(\d)/, "s$1").slice(0, 24) || "theme";
  let id = base;
  for (let i = 2; ids().has(id); i++) id = `${base}${i}`;
  return id;
};
const gnQuery = (k: string[]) => k.slice(0, 5).map((x) => (x.includes(" ") ? `"${x}"` : x)).join(" OR ");
const done: string[] = [];
const skipped: string[] = [];

for (const o of plan.ops as (Op & Record<string, any>)[]) {
  const themes = topic.sectors as Doc[];
  const feeds = sources.feeds as Doc[];
  switch (o.op) {
    case "setSite": {
      const was = `${site.site.name} — ${site.site.tagline}`;
      if (o.newName) site.site.name = o.newName;
      if (o.tagline) site.site.tagline = o.tagline;
      const now = `${site.site.name} — ${site.site.tagline}`;
      if (now !== was) done.push(`Site: ${now}`);
      break;
    }
    case "setAudience":
      if (o.audience) (topic.audience = o.audience), done.push(`Audience: ${o.audience}`);
      break;
    case "setWord": {
      // Theme and entity names come in pairs (a tab says "Markets", a card says "Market").
      const text = o.text.trim();
      if (o.word === "theme" || o.word === "entity") {
        const [one, many] = /ies$/i.test(text) ? [text.replace(/ies$/i, "y"), text] : /[^s]s$/i.test(text) ? [text.slice(0, -1), text] : [text, /y$/i.test(text) ? text.replace(/y$/i, "ies") : `${text}s`];
        topic.vocab = { ...topic.vocab, [o.word]: one, [o.word === "theme" ? "themes" : "entities"]: many };
        done.push(`The site now says "${one}" / "${many}"`);
      } else {
        topic.vocab = { ...topic.vocab, [o.word]: text };
        done.push(`The site now says "${text}" for ${o.word}`);
      }
      break;
    }
    case "editScope":
      topic.scope ??= { keywords: [] };
      // Drawing the scope from scratch is its own focused question; the plan only hints at it.
      if (!topic.scope.keywords?.length && !topic.scope.pattern) {
        const themeNames = (topic.sectors as Doc[]).map((x) => x.name);
        o.addKeywords = await draftScope(topic.domain, themeNames, `The person asked: ${request.trim()}`).catch(() => o.addKeywords);
        o.removeKeywords = [];
      }
      {
        // Report only what actually changed (a plan often "removes" terms that were never there).
        const had: string[] = topic.scope.keywords ?? [];
        const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
        const drop = lower(o.removeKeywords);
        const removed = had.filter((k) => drop.has(k.toLowerCase()));
        const kept = had.filter((k) => !drop.has(k.toLowerCase()));
        const added = [...new Set(o.addKeywords as string[])].filter((k) => !lower(kept).has(k.toLowerCase()));
        topic.scope.keywords = [...kept, ...added];
        if (added.length || removed.length) done.push(`Scope: ${[added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean).join("; ")}`);
      }
      break;
    case "addTheme": {
      if (!o.name || !o.keywords.length) { skipped.push(`addTheme without a name or keywords`); break; }
      if (find(themes, o.name)) { skipped.push(`${o.name} already exists`); break; }
      const id = newId(o.name);
      themes.push({ id, name: o.name, keywords: o.keywords, soWhat: o.soWhat ?? "" });
      feeds.push({ name: `Google News: ${o.name}`, googleNews: gnQuery(o.keywords), tier: "news", lang: "en-US" });
      done.push(`Added theme ${o.name} (${o.keywords.slice(0, 5).join(", ")}…)`);
      break;
    }
    case "removeTheme": {
      const t = find(themes, o.name);
      if (!t) { skipped.push(`no theme called ${o.name}`); break; }
      topic.sectors = themes.filter((x) => x !== t);
      sources.feeds = feeds.filter((f) => f.name !== `Google News: ${t.name}`);
      done.push(`Removed theme ${t.name}`);
      break;
    }
    case "editTheme": {
      const t = find(themes, o.name);
      if (!t) { skipped.push(`no theme called ${o.name}`); break; }
      const feed = feeds.find((f) => f.name === `Google News: ${t.name}`);
      if (o.newName) t.name = o.newName;
      t.keywords = [...new Set([...(t.keywords ?? []).filter((k: string) => !o.removeKeywords.includes(k)), ...o.addKeywords])];
      if (o.soWhat) t.soWhat = o.soWhat;
      if (feed) Object.assign(feed, { name: `Google News: ${t.name}`, googleNews: gnQuery(t.keywords) });
      done.push(`Edited theme ${t.name}${o.addKeywords.length ? ` +${o.addKeywords.join(", ")}` : ""}${o.removeKeywords.length ? ` −${o.removeKeywords.join(", ")}` : ""}`);
      break;
    }
    case "addSource": {
      if (!o.name) break;
      if (o.googleNews) {
        feeds.push({ name: o.name, googleNews: o.googleNews, tier: "news", lang: "en-US" });
        done.push(`Added Google News search ${o.name}`);
        break;
      }
      const found = await discoverFeed({ feed: o.feed, homepage: o.homepage });
      const host = siteUrl(o.homepage ?? o.feed)?.hostname.replace(/^www\./, "");
      if (found) feeds.push({ name: o.name, url: found.url, tier: "news" }), done.push(`Added source ${o.name} (${found.url})`);
      else if (host) feeds.push({ name: o.name, googleNews: `site:${host}`, tier: "news", lang: "en-US" }), done.push(`Added ${o.name} through Google News (it has no working feed)`);
      else skipped.push(`couldn't find ${o.name}`);
      break;
    }
    case "removeSource": {
      const f = find(feeds, o.name);
      if (!f) { skipped.push(`no source called ${o.name}`); break; }
      sources.feeds = feeds.filter((x) => x !== f);
      done.push(`Removed source ${f.name}`);
      break;
    }
    case "addEntity": {
      if (!o.name || find(entities, o.name)) break;
      const kinds = (topic.entityKinds ?? []) as Doc[];
      const kind = kinds.find((k) => k.id === o.kind || String(k.label).toLowerCase() === String(o.kind).toLowerCase()) ?? kinds[0];
      entities.push({ id: slug(o.name), name: o.name, kind: kind?.id, type: kind?.label, sectors: o.themes.map((n) => find(themes, n)?.id).filter(Boolean), about: o.about ?? "", aliases: [], latest: "" });
      done.push(`Now tracking ${o.name}`);
      break;
    }
    case "removeEntity": {
      const e = find(entities, o.name);
      if (e) entities.splice(entities.indexOf(e), 1), done.push(`Stopped tracking ${e.name}`);
      break;
    }
    case "addNoise":
      topic.noise ??= { keywords: [] };
      topic.noise.keywords = [...new Set([...(topic.noise.keywords ?? []), ...o.keywords])];
      done.push(`Now dropping headlines with: ${o.keywords.join(", ")}`);
      break;
    case "setIdeas":
      topic.curate = { ...(topic.curate ?? {}), ideas: !!o.wanted };
      done.push(o.wanted ? "Ideas turned on" : "Ideas turned off");
      break;
  }
}

// Generic words in the scope let any story in (an AI drew them, or an older setup has them),
// so every change also clears them out.
const vague = ((topic.scope?.keywords ?? []) as string[]).filter((k) => GENERIC.has(k.toLowerCase()));
if (vague.length && topic.scope.keywords.length - vague.length >= 5) {
  topic.scope.keywords = topic.scope.keywords.filter((k: string) => !GENERIC.has(k.toLowerCase()));
  done.push(`Scope: dropped words too general to mean this subject (${vague.join(", ")})`);
}

if (!done.length) {
  console.log(`Nothing to change.${skipped.length ? ` (${skipped.join("; ")})` : ""}`);
  await writeFile("change-report.md", `Nothing was changed: the request didn't map to anything I can edit.${skipped.length ? `\n\n${skipped.map((x) => `- ${x}`).join("\n")}` : ""}\n`);
  process.exit(0);
}

// Write, then validate; on a problem put the old files back so the site never breaks.
const files = { "topic/topic.yaml": topic, "topic/sources.yaml": sources, "topic/site.yaml": site } as const;
const before: Record<string, string> = Object.fromEntries(await Promise.all(Object.keys(files).map(async (f) => [f, await readFile(f, "utf8")] as const)));
const header = (f: string) => (before[f].match(/^(#.*\n)+\n?/)?.[0] ?? "");
for (const [f, doc] of Object.entries(files)) await writeFile(f, header(f) + stringify(doc, { lineWidth: 0 }));
try {
  await loadTopic();
  await loadSources();
} catch (err) {
  for (const [f, text] of Object.entries(before)) await writeFile(f, text);
  console.error(`The change didn't produce a valid setup, so nothing was changed:\n${(err as Error).message}`);
  process.exit(1);
}
await writeFile("data/companies.json", JSON.stringify(entities, null, 2) + "\n");

// A narrower scope or new noise words apply to what is already stored, so the site shows the
// change right away; stories written by hand (not auto-collected) are left alone.
if ((vague.length || plan.ops.some((o) => o.op === "editScope" || o.op === "addNoise")) && existsSync("data/updates.json")) {
  const t = await loadTopic();
  const scope = scopeRule(t.scope);
  const noise = compileRule(t.noise, "noise");
  const all = JSON.parse(await readFile("data/updates.json", "utf8")) as Doc[];
  const keep = all.filter((u) => !u.auto || ((!scope || scope.test(`${u.title} ${u.body}`)) && !noise.test(u.title)));
  if (keep.length < all.length) {
    await writeFile("data/updates.json", JSON.stringify(keep, null, 2) + "\n");
    done.push(`Removed ${all.length - keep.length} stored stories that no longer fit`);
  }
}

const report = `## Changed\n\n${done.map((x) => `- ${x}`).join("\n")}${skipped.length ? `\n\nNot done: ${skipped.join("; ")}.` : ""}\n\nNew themes and sources fill in from the next daily run.\n`;
await writeFile("change-report.md", report);
console.log(report);
if (!args.includes("--no-build") && existsSync("data")) runStep("build-api");
