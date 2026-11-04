import { loadDesk } from "./store.ts";
import { findCompanies, getBrief, getSector, listIdeas, overview, searchResearch, searchUpdates, upcomingEvents } from "./kb.ts";
import { buildIndex, related, semanticSearch, KINDS, type Kind } from "./semantic.ts";
import { searchPapers } from "./hf.ts";
import { getMetro, housingOverview, rankMetros, searchHousingNews, searchVideos, type Sort } from "./housing-kb.ts";

// Free, offline lookups over data/ — no API key. Prints JSON.
//   npm run kb -- overview
//   npm run kb -- updates "counter-drone contract" --sector cuas --since 2026-10-01
//   npm run kb -- sector space
//   npm run kb -- companies anduril
//   npm run kb -- events --sector policy --days 60
//   npm run kb -- research autonomy
//   npm run kb -- ideas --sector air
//   npm run kb -- brief [YYYY-MM-DD]
//   npm run kb -- semantic "cheap ways to stop drone swarms" [--kinds update,company] [--sector id]
//   npm run kb -- related <id>
//   npm run kb -- papers "drone swarm coordination" [--since YYYY-MM-DD]
//   npm run kb -- housing
//   npm run kb -- metros [--sort score|grossYield|cashFlow|rentYoY|priceYoY|forecast12m|…] [--state TX,FL] [--max-price 300000] [--largest 100]
//   npm run kb -- metro "Cleveland"
//   npm run kb -- housing-news "rents" [--state FL] [--topic rates]
//   npm run kb -- videos "drones" [--topic defense|housing] [--shorts 1]
// semantic/related use a local Hugging Face embedding model; papers queries Hugging Face Papers.

const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i] ?? "";
  else positional.push(rest[i]);
}
const query = positional.join(" ") || undefined;
const num = (k: string) => (flags[k] ? Number(flags[k]) : undefined);

const desk = await loadDesk();
const noHousing = { error: "No housing data yet: run `npm run housing` first." };
const index = () => buildIndex(desk, (m) => console.error(m));
const commands: Record<string, () => unknown> = {
  semantic: async () =>
    semanticSearch(desk, await index(), {
      query: query ?? "",
      kinds: flags.kinds?.split(",").filter((k): k is Kind => (KINDS as readonly string[]).includes(k)),
      sector: flags.sector,
      since: flags.since,
      limit: num("limit"),
    }),
  related: async () => related(desk, await index(), query ?? "", num("limit")),
  papers: () => searchPapers(query ?? "", { since: flags.since, limit: num("limit") }),
  overview: () => overview(desk),
  updates: () =>
    searchUpdates(desk, {
      query,
      sectors: flags.sector ? flags.sector.split(",") : undefined,
      type: flags.type,
      company: flags.company,
      since: flags.since,
      until: flags.until,
      limit: num("limit"),
    }),
  sector: () => getSector(desk, query ?? ""),
  companies: () => findCompanies(desk, { query, sector: flags.sector, limit: num("limit") }),
  events: () => upcomingEvents(desk, { sector: flags.sector, days: num("days") }),
  research: () => searchResearch(desk, { query, sector: flags.sector, limit: num("limit") }),
  ideas: () => listIdeas(desk, { sector: flags.sector }),
  brief: () => getBrief(desk, query),
  housing: () => (desk.housing ? housingOverview(desk.housing) : noHousing),
  metros: () =>
    desk.housing
      ? rankMetros(desk.housing, {
          sortBy: flags.sort as Sort | undefined,
          ascending: flags.asc === "1",
          states: flags.state?.split(","),
          maxPrice: num("max-price"),
          minPrice: num("min-price"),
          largestOnly: num("largest"),
          limit: num("limit"),
        })
      : noHousing,
  metro: () => (desk.housing ? getMetro(desk.housing, query ?? "") : noHousing),
  "housing-news": () => (desk.housing ? searchHousingNews(desk.housing, { query, state: flags.state, topic: flags.topic, since: flags.since, limit: num("limit") }) : noHousing),
  videos: () => searchVideos(desk.videos ?? [], { query, topic: flags.topic, shortsOnly: flags.shorts === "1", limit: num("limit") }),
};

const run = commands[cmd ?? ""];
if (!run) {
  console.error(`Usage: npm run kb -- <${Object.keys(commands).join("|")}> [query] [--sector id] [--type T] [--company name] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--days N] [--limit N]`);
  process.exit(1);
}
console.log(JSON.stringify(await run(), null, 2));
