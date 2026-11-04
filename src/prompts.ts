import type { Desk } from "./store.ts";
import { overview } from "./kb.ts";

// Instructions shared by every way Ask runs: the local server, the command line and GitHub issues.

// The modes (Teach me, Advise me…) and who the assistant is come from the pack's
// topic/topic.yaml (ask:), carried on desk.pack so every way of asking reads the same ones.

export const modes = (desk: Desk) => desk.pack.ask.modes;
export type Mode = string;

export interface Focus {
  mode?: Mode;
  sector?: string;
  company?: string;
  days?: number;
}

export function focusLine(desk: Desk, f: Focus | undefined): string {
  if (!f) return "";
  const parts: string[] = [];
  const mode = modes(desk).find((m) => m.id === f.mode);
  if (mode) parts.push(`Mode: ${mode.label}. ${mode.instruction}`);
  const sector = desk.sectors.find((s) => s.id === f.sector);
  if (sector) parts.push(`Sector: ${sector.name} (${sector.id})`);
  const company = desk.companies.find((c) => c.id === f.company);
  if (company) parts.push(`Company: ${company.name}`);
  if (f.days) parts.push(`Time range: the last ${f.days} days (since ${new Date(Date.now() - f.days * 864e5).toISOString().slice(0, 10)})`);
  return parts.length ? `[Focus — ${parts.join(" · ")}]\n\n` : "";
}

export function systemPrompt(desk: Desk, opts: { web?: boolean; papers?: boolean; semantic?: boolean }) {
  const web = !!opts.web;
  const { name, owner, ask } = desk.pack;
  const who = owner || "the user";
  const housing = desk.housing
    ? `

${name} also has a housing desk, because ${who} wants to buy a US home and rent it out for more than it costs. housing_overview, rank_metros, get_metro and housing_news cover home values, rents, rent yield, rental cash flow at today's mortgage rate, trends and Zillow's forecast for about 900 metros (Zillow Research data as of ${desk.housing.market.asOf.prices}; Freddie Mac mortgage rate for the week of ${desk.housing.market.asOf.mortgage}). For housing questions:
- Lead with numbers from the tools and say which month they are for. Cite [Zillow Research], [Freddie Mac PMMS] or the news source.
- Cash flow and cap rate use flat assumptions (${desk.housing.market.assumptions.downPct}% down, ${desk.housing.market.assumptions.opexPct}% of rent for taxes, insurance, repairs, vacancy and management). Say so, and say what would change the answer (property taxes and insurance in that state, the exact neighborhood, landlord laws).
- Metro averages hide big differences between neighborhoods: tell ${who} what to check on the ground.
- Be direct about trade-offs (high yield often comes with slow appreciation or weak population growth). This is research support, not financial advice; say that once, briefly, when giving buy recommendations.`
    : "";
  const videos = desk.videos?.length ? ` find_videos recommends recent YouTube videos and Shorts from channels ${name} follows; ${who} learns best from short videos, so offer one or two when they fit.` : "";
  return `${ask.intro.trim()}${housing}

Your knowledge base is the data in this repo, reachable through your tools: sourced news updates, ${desk.sectors.length} sector briefs, a company directory, upcoming events, a research library, build ideas and daily briefs. Look things up before answering; search more than once when the first results are thin.${opts.semantic ? " semantic_search finds items by meaning, so use it for concepts and for questions in everyday words." : ""}${opts.papers ? ` search_papers finds technical research (arXiv via Hugging Face) when ${who} wants to understand how a technology works or where it is heading; label it as research, not news, and cite the paper.` : ""}${videos}

A question may start with a bracketed focus line set in ${who}'s app (mode, sector, company, time range). Treat it as the scope of the question and follow the mode's instruction.

How to answer:
- Ground claims in the tools' results and name the source after each one, e.g. ${ask.examples.cite}. Sources marked [aggregator] are unconfirmed; say so when you rely on one.
- Never guess names, founders, dates or numbers. If a fact is not in the tool results, look it up or leave it out; do not fill gaps from memory unless you label it.
- Anything beyond the stored data is labelled "(general knowledge, may be outdated)"${web ? ", unless you found it with web search, in which case cite the page" : ""}.
${ask.rules.map((r) => `- ${r}\n`).join("")}- Keep it skimmable: short paragraphs, "- " bullets and **bold** lead-ins, real numbers and names. No tables.

The stored data covers updates up to ${overview(desk).updatesCover?.to ?? "unknown"}.`;
}
