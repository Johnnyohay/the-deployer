/**
 * The pack's site settings (topic/site.yaml, videos.yaml, requests.yaml): tabs, feature
 * flags, housing defaults, score weights, custom attributes, video channels and feature requests. Every file is
 * checked against the schemas below; a mistake stops the build with the path of the bad
 * value instead of shipping a broken page. build-api publishes the result as
 * public/api/v1/config.json, which every page reads.
 */
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod/v4";
import type { HousingMarket, Metro } from "./housing-kb.ts";

const FORMATS = ["money", "kmoney", "signedMoney", "percent", "percent2", "signedPercent", "number"] as const;
const AGGREGATES = ["median", "mean", "min", "max", "sum", "count"] as const;

/** Metro fields a custom attribute's formula may use. */
export const FORMULA_FIELDS = [
  "price", "rent", "priceMoM", "priceYoY", "price5y", "fromPeak", "rentYoY", "grossYield", "capRate",
  "cashFlow", "forecast12m", "inventory", "inventoryYoY", "score", "rank", "rate30",
] as const;

const Attribute = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, "use letters and digits only, starting with a letter"),
  label: z.string(),
  formula: z.string(),
  format: z.enum(FORMATS).default("number"),
  color: z.enum(["seq", "div"]).default("seq"),
  aggregate: z.enum(AGGREGATES).default("median"),
  column: z.boolean().default(false),
  higherIsBetter: z.boolean().default(true),
});

const SiteConfig = z.object({
  site: z.object({ name: z.string().default("My desk"), owner: z.string().default(""), tagline: z.string().default("") }).default({ name: "My desk", owner: "", tagline: "" }),
  desks: z.array(z.object({ id: z.string(), label: z.string(), page: z.string(), enabled: z.boolean().default(true) })).min(1),
  flags: z.record(z.string(), z.boolean()).default({}),
  // The subjects this site teaches ("You follow: …" on the brief). kind says where each one's
  // stories and numbers come from. Empty: worked out from the pack (its news, housing, series).
  topics: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), label: z.string(), kind: z.enum(["news", "housing", "series"]) })).default([]),
  housing: z.object({
    defaults: z.object({ metric: z.string().default("score"), size: z.number().int().default(200), budget: z.number().default(0) }).default({ metric: "score", size: 200, budget: 0 }),
    budgets: z.array(z.number().positive()).default([200000, 300000, 400000, 500000]),
    rental: z.object({ downPct: z.number().min(0).max(100), opexPct: z.number().min(0).max(90), years: z.number().int().min(1).max(40) }).default({ downPct: 25, opexPct: 45, years: 30 }),
    score: z.object({ grossYield: z.number().min(0), rentYoY: z.number().min(0), forecast12m: z.number().min(0), priceYoY: z.number().min(0), inventoryDrop: z.number().min(0) }).default({ grossYield: 40, rentYoY: 20, forecast12m: 20, priceYoY: 10, inventoryDrop: 10 }),
    attributes: z.array(Attribute).default([]),
  }).prefault({}),
});

const VideoConfig = z.object({
  keepDays: z.number().int().positive().default(90),
  maxVideos: z.number().int().positive().default(800),
  channels: z.array(z.object({ name: z.string(), id: z.string().regex(/^UC[\w-]{22}$/, "a YouTube channel id starts with UC and has 24 characters"), topic: z.string() })),
  match: z.record(z.string(), z.string()).default({}),
});

const Requests = z.object({
  requests: z.array(z.object({
    title: z.string(),
    area: z.string().default("other"),
    status: z.enum(["idea", "planned", "building", "done"]).default("idea"),
    notes: z.string().optional(),
    flag: z.string().optional(),
  })).default([]),
});

export type SiteConfig = z.infer<typeof SiteConfig>;
export type VideoConfig = z.infer<typeof VideoConfig>;
export type Attribute = z.infer<typeof Attribute>;

async function load<S extends z.ZodType>(file: string, schema: S): Promise<z.infer<S>> {
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

export async function loadSiteConfig(): Promise<SiteConfig> {
  const cfg = await load("topic/site.yaml", SiteConfig);
  for (const a of cfg.housing.attributes) compile(a.formula, `topic/site.yaml housing.attributes "${a.id}"`);
  const ids = cfg.housing.attributes.map((a) => a.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i || (FORMULA_FIELDS as readonly string[]).includes(id));
  if (dup) throw new Error(`topic/site.yaml: attribute id "${dup}" is used twice or clashes with a built-in field.`);
  return cfg;
}
export const loadVideoConfig = () => load("topic/videos.yaml", VideoConfig);
export const loadRequests = async () => (await load("topic/requests.yaml", Requests)).requests;

// ---- formulas: a tiny arithmetic language, parsed here so nothing in YAML is ever run as code ----

type Node = { n: number } | { f: string } | { op: string; a: Node; b: Node } | { neg: Node } | { call: string; args: Node[] };
const FUNCS: Record<string, (...x: number[]) => number> = { min: Math.min, max: Math.max, abs: Math.abs, round: (x, d = 0) => +x.toFixed(d) };

export function compile(src: string, where: string): Node {
  const tokens = src.match(/\d+(\.\d+)?|[A-Za-z_]\w*|[-+*/(),]|\S/g) ?? [];
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`${where}: formula "${src}": ${msg}`);
  };
  const peek = () => tokens[i];
  const take = (t?: string) => (t && tokens[i] !== t ? fail(`expected "${t}" near "${tokens[i] ?? "the end"}"`) : tokens[i++]);
  const expr = (): Node => {
    let a = term();
    while (peek() === "+" || peek() === "-") { const op = take()!; a = { op, a, b: term() }; }
    return a;
  };
  const term = (): Node => {
    let a = unary();
    while (peek() === "*" || peek() === "/") { const op = take()!; a = { op, a, b: unary() }; }
    return a;
  };
  const unary = (): Node => (peek() === "-" ? (take(), { neg: unary() }) : atom());
  const atom = (): Node => {
    const t = take() ?? fail("ends too early");
    if (/^\d/.test(t)) return { n: Number(t) };
    if (t === "(") { const e = expr(); take(")"); return e; }
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === "(") {
        if (!FUNCS[t]) fail(`unknown function "${t}" (use ${Object.keys(FUNCS).join(", ")})`);
        take("(");
        const args = [expr()];
        while (peek() === ",") { take(); args.push(expr()); }
        take(")");
        return { call: t, args };
      }
      if (!(FORMULA_FIELDS as readonly string[]).includes(t)) fail(`unknown field "${t}" (use ${FORMULA_FIELDS.join(", ")})`);
      return { f: t };
    }
    return fail(`unexpected "${t}"`);
  };
  const tree = expr();
  if (i < tokens.length) fail(`unexpected "${tokens[i]}"`);
  return tree;
}

function evaluate(node: Node, get: (f: string) => number | null | undefined): number | null {
  if ("n" in node) return node.n;
  if ("f" in node) { const v = get(node.f); return typeof v === "number" && Number.isFinite(v) ? v : null; }
  if ("neg" in node) { const v = evaluate(node.neg, get); return v === null ? null : -v; }
  if ("call" in node) {
    const args = node.args.map((a) => evaluate(a, get));
    return args.some((a) => a === null) ? null : FUNCS[node.call](...(args as number[]));
  }
  const a = evaluate(node.a, get), b = evaluate(node.b, get);
  if (a === null || b === null) return null;
  const v = node.op === "+" ? a + b : node.op === "-" ? a - b : node.op === "*" ? a * b : b === 0 ? null : a / b;
  return v === null || !Number.isFinite(v) ? null : v;
}

function aggregate(values: number[], how: Attribute["aggregate"]): number | null {
  if (how === "count") return values.length;
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  if (how === "median") return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  if (how === "mean") return s.reduce((x, y) => x + y, 0) / s.length;
  if (how === "sum") return s.reduce((x, y) => x + y, 0);
  return how === "min" ? s[0] : s[s.length - 1];
}

const round = (v: number | null) => (v === null ? null : +v.toFixed(4));

/**
 * Adds each custom attribute to every metro (metro.custom[id]) and rolls it up per state
 * (state.custom[id]) with the attribute's aggregate. Returns a new market; the stored data is unchanged.
 */
export function applyAttributes(market: HousingMarket, attributes: Attribute[]): HousingMarket {
  if (!attributes.length) return market;
  const compiled = attributes.map((a) => ({ a, tree: compile(a.formula, a.id) }));
  const metros = market.metros.map((m) => {
    const get = (f: string) => (f === "rate30" ? market.mortgage.rate30 : (m[f as keyof Metro] as number | undefined));
    return { ...m, custom: Object.fromEntries(compiled.map(({ a, tree }) => [a.id, round(evaluate(tree, get))])) };
  });
  const states = market.states.map((s) => ({
    ...s,
    custom: Object.fromEntries(compiled.map(({ a }) => [a.id, round(aggregate(metros.filter((m) => m.state === s.code && m.custom[a.id] !== null).map((m) => m.custom[a.id] as number), a.aggregate))])),
  }));
  return { ...market, metros, states };
}
