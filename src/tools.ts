import { z } from "zod/v4";
import type { Desk } from "./store.ts";
import { findCompanies, getBrief, getSector, listIdeas, overview, searchResearch, searchUpdates, upcomingEvents } from "./kb.ts";
import { searchPapers } from "./papers.ts";
import { getMetro, housingOverview, rankMetros, searchHousingNews, searchVideos, SORTS } from "./housing-kb.ts";

// ANU's lookup tools over the data, with no server dependencies, so the local server
// (wrapped for Claude via betaZodTool, or sent to an open model) and the in-browser app
// use the same definitions.

export interface Evidence {
  id: string;
  date: string;
  title: string;
  source: string | null;
}

export interface ToolSpec<I = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  run: (input: I) => Promise<string>;
}

const spec = <S extends z.ZodType>(t: { name: string; description: string; inputSchema: S; run: (input: z.infer<S>) => Promise<string> }): ToolSpec => t;

/** The pack's sector ids, so the model can only ask for sectors that exist. */
export const sectorEnum = (desk: Desk) => z.enum(desk.sectors.map((s) => s.id) as [string, ...string[]]);
const json = (v: unknown) => JSON.stringify(v);

export interface ToolOptions {
  /** Adds the Hugging Face Papers search tool. */
  papers?: boolean;
  /** Update id → similarity to a query, from the semantic index (server only). */
  similarities?: (query: string) => Promise<Map<string, number>>;
}

export function toolSpecs(desk: Desk, opts: ToolOptions, onEvidence: (items: Evidence[]) => void): ToolSpec[] {
  const report = (updates: { id: string; date: string; title: string; source: string | null }[]) =>
    onEvidence(updates.map(({ id, date, title, source }) => ({ id, date, title, source })));

  const Sector = sectorEnum(desk);
  const ex = desk.pack.ask.examples;
  const tools: ToolSpec[] = [
    spec({
      name: "overview",
      description: `The big picture: the headline thesis, the forces moving ${desk.pack.domain}, how much data is stored and the ${desk.sectors.length} sectors with their ids. Call this first when you need orientation.`,
      inputSchema: z.object({}),
      run: async () => json(overview(desk)),
    }),
    spec({
      name: "search_updates",
      description: `Search the dated, sourced news updates (contracts, funding, policy, milestones, deals). Every filter is optional. ${opts.similarities ? "Results are ranked by meaning and keywords together, so concept queries work." : "Results are ranked by keyword match, then newest first."}`,
      inputSchema: z.object({
        query: z.string().optional().describe(`Keywords, e.g. ${ex.query}`),
        sectors: z.array(Sector).optional(),
        type: z.enum(desk.pack.types as [string, ...string[]]).optional(),
        company: z.string().optional().describe(`Company name, e.g. ${ex.company}`),
        since: z.string().optional().describe("YYYY-MM-DD"),
        until: z.string().optional().describe("YYYY-MM-DD"),
        limit: z.number().int().optional().describe("Default 15, max 50"),
      }),
      run: async (input) => {
        const result = searchUpdates(desk, input, opts.similarities && input.query ? await opts.similarities(input.query) : undefined);
        report(result.updates);
        return json(result);
      },
    }),
    spec({
      name: "get_sector",
      description: "Everything on one sector: its current state, where the money is, what to watch, recent updates, companies, upcoming events and research.",
      inputSchema: z.object({ id: Sector }),
      run: async ({ id }) => {
        const result = getSector(desk, id);
        if ("recentUpdates" in result) report(result.recentUpdates);
        return json(result);
      },
    }),
    spec({
      name: "find_companies",
      description: "Company directory: type (prime, new entrant, startup), HQ, status, competitive edge and latest news.",
      inputSchema: z.object({ query: z.string().optional(), sector: Sector.optional(), limit: z.number().int().optional() }),
      run: async (input) => json(findCompanies(desk, input)),
    }),
    spec({
      name: "upcoming_events",
      description: "Dated upcoming events: budget deadlines, decisions, earnings, launches and reports due.",
      inputSchema: z.object({ sector: Sector.optional(), days: z.number().int().optional().describe("Look-ahead window, default 120") }),
      run: async (input) => json(upcomingEvents(desk, input)),
    }),
    spec({
      name: "search_research",
      description: "Research library: think-tank reports, budget documents, filings and data sources, each with why it is worth reading.",
      inputSchema: z.object({ query: z.string().optional(), sector: Sector.optional(), limit: z.number().int().optional() }),
      run: async (input) => json(searchResearch(desk, input)),
    }),
    spec({
      name: "list_ideas",
      description: "Build ideas already identified: what it is, why now, capital needed, time to revenue and how crowded it is.",
      inputSchema: z.object({ sector: Sector.optional() }),
      run: async (input) => json(listIdeas(desk, input)),
    }),
    spec({
      name: "get_brief",
      description: "A daily morning brief. Omit date for the latest.",
      inputSchema: z.object({ date: z.string().optional().describe("YYYY-MM-DD") }),
      run: async ({ date }) => json(getBrief(desk, date)),
    }),
  ];
  const housing = desk.housing;
  if (housing)
    tools.push(
      spec({
        name: "housing_overview",
        description: "The US housing market for a rental investor: current mortgage rates and a year ago, national home value and rent with yearly change, Zillow's 12-month forecast, standout metros among the 100 largest (best score, highest rent yield, fastest rent growth, biggest price gains and drops), every state's typical price and change, and the latest housing headlines. Call this first for any housing question.",
        inputSchema: z.object({}),
        run: async () => json(housingOverview(housing)),
      }),
      spec({
        name: "rank_metros",
        description: "Rank US metro areas by an investor metric, with filters. Metrics: score (ANU's buy-to-rent ranking), grossYield (annual rent ÷ price, %), capRate (after operating costs, %), cashFlow (monthly, after costs and mortgage at today's rate with 25% down), rentYoY, priceYoY, price5y, forecast12m (Zillow), price, fromPeak (% below 5-year high), inventoryYoY (listings change). Sorted high to low unless ascending.",
        inputSchema: z.object({
          sortBy: z.enum(SORTS).optional().describe("Default score"),
          ascending: z.boolean().optional(),
          states: z.array(z.string()).optional().describe("Two-letter state codes, e.g. ['TX','FL']"),
          maxPrice: z.number().optional().describe("Typical home value at most this, dollars"),
          minPrice: z.number().optional(),
          largestOnly: z.number().int().optional().describe("Only the N largest metros, e.g. 100 for big, liquid markets"),
          limit: z.number().int().optional().describe("Default 15, max 60"),
        }),
        run: async (input) => json(rankMetros(housing, input)),
      }),
      spec({
        name: "get_metro",
        description: "Everything on one metro area: typical price and rent, their trends (month, year, five years, from peak), yearly history, rent yield, rental math at today's mortgage rate (down payment, payment, cash flow, cap rate, cash-on-cash), Zillow forecast, inventory, ANU score, its state, and related housing news.",
        inputSchema: z.object({ name: z.string().describe("Metro or main city, e.g. 'Cleveland' or 'Tampa, FL'") }),
        run: async ({ name }) => json(getMetro(housing, name)),
      }),
      spec({
        name: "housing_news",
        description: "Search recent housing and mortgage news (HousingWire, Realtor.com Research, Mortgage News Daily, BiggerPockets). Topics: rates, prices, rents, inventory, sales, construction, investing, policy.",
        inputSchema: z.object({
          query: z.string().optional(),
          state: z.string().optional().describe("Two-letter state code"),
          topic: z.enum(["rates", "prices", "rents", "inventory", "sales", "construction", "investing", "policy"]).optional(),
          since: z.string().optional().describe("YYYY-MM-DD"),
          limit: z.number().int().optional(),
        }),
        run: async (input) => {
          const result = searchHousingNews(housing, input);
          onEvidence(result.news.map((n) => ({ id: n.id, date: n.d, title: n.title, source: n.source })));
          return json(result);
        },
      }),
    );
  if (desk.videos?.length) {
    const videos = desk.videos;
    tools.push(
      spec({
        name: "find_videos",
        description: `Find recent YouTube videos and Shorts from the channels ${desk.pack.name} follows, to recommend something to watch. Returns title, channel, date, views and link.`,
        inputSchema: z.object({
          query: z.string().optional(),
          topic: z.enum([...new Set(videos.map((v) => v.topic))] as [string, ...string[]]).optional(),
          shortsOnly: z.boolean().optional(),
          limit: z.number().int().optional().describe("Default 10, max 30"),
        }),
        run: async (input) => json(searchVideos(videos, input)),
      }),
    );
  }
  if (opts.papers)
    tools.push(
        spec({
          name: "search_papers",
          description: "Search Hugging Face Papers: recent arXiv research with community upvotes. Use it to explain the technology behind a trend or to see what is technically possible now. Results are research, not news: say so when you use them.",
          inputSchema: z.object({
            query: z.string().describe(`Technical topic, e.g. ${ex.paper}`),
            since: z.string().optional().describe("YYYY-MM-DD, only papers published on or after"),
            limit: z.number().int().optional().describe("Default 8, max 20"),
          }),
          run: async (input) => {
            try {
              const papers = await searchPapers(input.query, input);
              onEvidence(papers.map((p) => ({ id: `paper-${p.id}`, date: p.published, title: p.title, source: `Hugging Face Papers [research] ${p.url}` })));
              return json(papers);
            } catch (err) {
              return json({ error: err instanceof Error ? err.message : String(err) });
            }
          },
        }),
    );
  return tools;
}
