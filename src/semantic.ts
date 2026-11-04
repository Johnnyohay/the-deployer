import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Desk } from "./store.ts";
import { cosine, embed, EMBED_MODEL } from "./hf.ts";
import { slimUpdate } from "./kb.ts";

// Semantic index over everything in data/: each item's text is embedded with a local
// Hugging Face model, so searches match meaning ("kamikaze drones" finds "loitering
// munitions"). Vectors are cached by text hash in .hf-cache/, so only new or changed
// items are embedded on later runs; nothing here is committed to git.

export const KINDS = ["update", "company", "research", "idea", "sector"] as const;
export type Kind = (typeof KINDS)[number];

interface Doc {
  kind: Kind;
  id: string;
  text: string;
  date?: string;
  sectors: string[];
}

export interface SemanticIndex {
  docs: (Doc & { v: number[] })[];
}

const CACHE_FILE = `.hf-cache/vectors-${EMBED_MODEL.replace(/\W+/g, "_")}.json`;
const s = (v: unknown) => (v == null ? "" : String(v));

function documents(desk: Desk): Doc[] {
  return [
    ...desk.updates.map((u) => ({ kind: "update" as const, id: u.id, date: u.d, sectors: u.sectors as string[], text: `${u.title}. ${u.body}` })),
    ...desk.companies.map((c) => ({ kind: "company" as const, id: s(c.id), sectors: (c.sectors as string[]) ?? [], text: `${s(c.name)} (${s(c.type)}, ${s(c.hq)}). ${s(c.edge)}. ${s(c.latest)}` })),
    ...desk.research.map((r) => ({ kind: "research" as const, id: s(r.id), sectors: (r.sectors as string[]) ?? [], text: `${s(r.t)} (${s(r.who)}). ${s(r.why)}` })),
    ...desk.ideas.map((i) => ({ kind: "idea" as const, id: s(i.id), sectors: (i.sectors as string[]) ?? [], text: `${s(i.t)}. ${s(i.what)} ${s(i.why)}` })),
    ...desk.sectors.map((x) => ({ kind: "sector" as const, id: x.id, sectors: [x.id], text: `${x.name}. ${x.state} ${x.money}` })),
  ];
}

const hash = (t: string) => createHash("sha1").update(t).digest("hex");

export async function buildIndex(desk: Desk, log: (msg: string) => void = () => {}): Promise<SemanticIndex> {
  const docs = documents(desk);
  let cache: Record<string, number[]> = {};
  try {
    cache = JSON.parse(await readFile(CACHE_FILE, "utf8"));
  } catch {}

  const missing = [...new Set(docs.map((d) => d.text).filter((t) => !cache[hash(t)]))];
  if (missing.length) {
    log(`Embedding ${missing.length} new item${missing.length === 1 ? "" : "s"} with ${EMBED_MODEL}…`);
    const vectors = await embed(missing);
    missing.forEach((t, i) => (cache[hash(t)] = vectors[i].map((x) => Math.round(x * 1e5) / 1e5)));
    const live = new Set(docs.map((d) => hash(d.text)));
    await mkdir(".hf-cache", { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(Object.entries(cache).filter(([k]) => live.has(k)))));
  }
  return { docs: docs.map((d) => ({ ...d, v: cache[hash(d.text)] })) };
}

/** Update id → similarity to the query, for blending into keyword search. */
export async function updateSimilarities(index: SemanticIndex, query: string): Promise<Map<string, number>> {
  const [q] = await embed([query], "query");
  return new Map(index.docs.filter((d) => d.kind === "update").map((d) => [d.id, cosine(q, d.v)]));
}

function payload(desk: Desk, kind: Kind, id: string): unknown {
  switch (kind) {
    case "update": {
      const u = desk.updates.find((x) => x.id === id);
      return u && slimUpdate(u);
    }
    case "company":
      return desk.companies.find((x) => x.id === id);
    case "research":
      return desk.research.find((x) => x.id === id);
    case "idea":
      return desk.ideas.find((x) => x.id === id);
    case "sector": {
      const x = desk.sectors.find((y) => y.id === id);
      return x && { id: x.id, name: x.name, state: x.state, money: x.money };
    }
  }
}

export interface SemanticQuery {
  query: string;
  kinds?: Kind[];
  sector?: string;
  since?: string;
  limit?: number;
}

/** Finds the items closest in meaning to the query, across every kind of data. */
export async function semanticSearch(desk: Desk, index: SemanticIndex, f: SemanticQuery) {
  const [q] = await embed([f.query], "query");
  return index.docs
    .filter((d) => !f.kinds?.length || f.kinds.includes(d.kind))
    .filter((d) => !f.sector || d.sectors.includes(f.sector))
    .filter((d) => !f.since || !d.date || d.date >= f.since)
    .map((d) => ({ d, score: cosine(q, d.v) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(f.limit ?? 12, 1), 40))
    .map(({ d, score }) => ({ kind: d.kind, similarity: Math.round(score * 100) / 100, item: payload(desk, d.kind, d.id) }));
}

/** The updates most similar to one item (any kind), e.g. coverage of the same story elsewhere. */
export function related(desk: Desk, index: SemanticIndex, id: string, limit = 8) {
  const anchor = index.docs.find((d) => d.id === id);
  if (!anchor) return { error: `No item with id "${id}"` };
  return index.docs
    .filter((d) => d.kind === "update" && d.id !== id)
    .map((d) => ({ d, score: cosine(anchor.v, d.v) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(limit, 1), 20))
    .map(({ d, score }) => ({ similarity: Math.round(score * 100) / 100, update: payload(desk, "update", d.id) }));
}
