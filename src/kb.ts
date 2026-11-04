import type { Desk } from "./store.ts";
import type { Update } from "./schema.ts";

// Read-only queries over the stored data. Shared by the ANU agent (src/agent.ts)
// and the free command line (src/kb-cli.ts), so both answer from the same evidence.

type Row = Record<string, unknown>;

const words = (q: string) => q.toLowerCase().split(/[^a-z0-9$.]+/).filter((w) => w.length > 1);

/** Share of query words found in the text; 0 when nothing matches. */
function score(text: string, q: string[]): number {
  if (!q.length) return 1;
  const t = text.toLowerCase();
  return q.filter((w) => t.includes(w)).length / q.length;
}

const clamp = (n: number | undefined, def: number, max: number) => Math.min(Math.max(n ?? def, 1), max);

export function overview(desk: Desk) {
  const dates = desk.updates.map((u) => u.d).sort();
  const latest = [...desk.briefs].sort((a, b) => b.date.localeCompare(a.date))[0];
  return {
    headline: desk.meta.headline,
    forces: desk.meta.forces,
    asOf: desk.meta.asOf,
    counts: {
      updates: desk.updates.length,
      companies: desk.companies.length,
      upcomingEvents: desk.catalysts.length,
      research: desk.research.length,
      ideas: desk.ideas.length,
      briefs: desk.briefs.length,
    },
    updatesCover: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    latestBrief: latest?.date ?? null,
    sectors: [...desk.sectors].sort((a, b) => a.order - b.order).map((s) => ({ id: s.id, name: s.name, momentum: s.heat })),
  };
}

export interface UpdateQuery {
  query?: string;
  sectors?: string[];
  type?: string;
  company?: string;
  since?: string;
  until?: string;
  limit?: number;
}

/** Similarity at or above which a semantic match counts even with no shared keywords. */
export const SEMANTIC_MIN = 0.62;

/**
 * Ranks updates by keyword match, or, when `semantic` (update id → similarity to the
 * query, from src/semantic.ts) is given, by a blend that also finds matches by meaning.
 */
export function searchUpdates(desk: Desk, f: UpdateQuery, semantic?: Map<string, number>) {
  const q = words(f.query ?? "");
  const company = f.company?.toLowerCase();
  const hits = desk.updates
    .filter((u) => !f.sectors?.length || u.sectors.some((s) => f.sectors!.includes(s)))
    .filter((u) => !f.type || u.type === f.type)
    .filter((u) => !company || u.companies.some((c) => c.toLowerCase().includes(company)) || u.title.toLowerCase().includes(company))
    .filter((u) => (!f.since || u.d >= f.since) && (!f.until || u.d <= f.until))
    .map((u) => {
      const kw = score(`${u.title} ${u.body} ${u.why} ${u.companies.join(" ")}`, q);
      const sem = semantic?.get(u.id);
      return { u, kw, sem, s: sem === undefined || !q.length ? kw : 0.65 * sem + 0.35 * kw };
    })
    .filter((x) => x.kw > 0 || (x.sem ?? 0) >= SEMANTIC_MIN)
    .sort((a, b) => b.s - a.s || b.u.d.localeCompare(a.u.d));
  return { total: hits.length, updates: hits.slice(0, clamp(f.limit, 15, 50)).map((x) => slimUpdate(x.u)) };
}

export function slimUpdate(u: Update) {
  return { id: u.id, date: u.d, title: u.title, body: u.body, why: u.why, sectors: u.sectors, type: u.type, companies: u.companies, source: u.src ? `${u.src.t} [${u.src.q}] ${u.src.u}` : null };
}

export function getSector(desk: Desk, id: string) {
  const sector = desk.sectors.find((s) => s.id === id);
  if (!sector) return { error: `No sector "${id}". Valid ids: ${desk.sectors.map((s) => s.id).join(", ")}` };
  const today = new Date().toISOString().slice(0, 10);
  return {
    ...sector,
    recentUpdates: desk.updates
      .filter((u) => (u.sectors as string[]).includes(id))
      .sort((a, b) => b.d.localeCompare(a.d))
      .slice(0, 12)
      .map(slimUpdate),
    companies: desk.companies.filter((c) => (c.sectors as string[] | undefined)?.includes(id)).map((c) => ({ name: c.name, type: c.type, edge: c.edge })),
    upcoming: desk.catalysts.filter((c) => c.sectors.includes(id as never) && c.d >= today),
    research: desk.research.filter((r) => (r.sectors as string[] | undefined)?.includes(id)).map((r) => ({ t: r.t, who: r.who, why: r.why, u: r.u })),
  };
}

function searchRows(rows: Row[], query: string | undefined, sector: string | undefined, fields: string[], limit: number) {
  const q = words(query ?? "");
  return rows
    .filter((r) => !sector || (r.sectors as string[] | undefined)?.includes(sector))
    .map((r) => ({ r, s: score(fields.map((k) => String(r[k] ?? "")).join(" "), q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}

export const findCompanies = (desk: Desk, f: { query?: string; sector?: string; limit?: number }) =>
  searchRows(desk.companies, f.query, f.sector, ["name", "type", "hq", "status", "edge", "latest"], clamp(f.limit, 15, 50));

export const searchResearch = (desk: Desk, f: { query?: string; sector?: string; limit?: number }) =>
  searchRows(desk.research, f.query, f.sector, ["t", "who", "why"], clamp(f.limit, 10, 30));

export const listIdeas = (desk: Desk, f: { sector?: string }) =>
  searchRows(desk.ideas, undefined, f.sector, [], 50);

export function upcomingEvents(desk: Desk, f: { sector?: string; days?: number }) {
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + clamp(f.days, 120, 730) * 864e5).toISOString().slice(0, 10);
  return desk.catalysts
    .filter((c) => c.d >= today && c.d <= end && (!f.sector || c.sectors.includes(f.sector as never)))
    .sort((a, b) => a.d.localeCompare(b.d));
}

export function getBrief(desk: Desk, date?: string) {
  const briefs = [...desk.briefs].sort((a, b) => b.date.localeCompare(a.date));
  const brief = date ? briefs.find((b) => b.date === date) : briefs[0];
  return brief ?? { error: `No brief for ${date}. Available: ${briefs.map((b) => b.date).join(", ")}` };
}
