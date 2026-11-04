import { getBrief, getSector, overview, searchUpdates, upcomingEvents } from "../../src/kb.ts";
import { searchPapers } from "../../src/papers.ts";
import type { Desk } from "../../src/store.ts";
import type { Api, AskEvent, AskRequest, CompanyDetail, Meta, Paper, SectorDetail } from "./api.ts";

// ANU for the static GitHub Pages build (VITE_STATIC=1). Browsing (sectors, companies,
// briefs, papers) runs in the page from the site's JSON API. Nothing is saved on the
// device, and nothing here costs money. Asking is off until a free model is connected.

const DATA_URL = import.meta.env.VITE_DATA_URL ?? new URL("../api/v1/all.json", location.href).href;
const SOURCES = { data: { label: "My data only", papers: false }, papers: { label: "Data + AI papers", papers: true } } as const;

let deskPromise: Promise<Desk> | null = null;
function loadDesk(): Promise<Desk> {
  deskPromise ??= fetch(DATA_URL, { cache: "no-store" }).then(async (res) => {
    if (!res.ok) throw new Error(`Couldn't load ANU's data (${res.status})`);
    return (await res.json()) as Desk;
  });
  deskPromise.catch(() => (deskPromise = null));
  return deskPromise;
}

const NO_MODEL =
  "Asking isn't available on the website yet: right now there's no AI model that's free, online and needs no account. Everything else here (briefs, sectors, companies, research papers) works.";

/** No free, account-free model is connected, so questions get a clear note instead of a detour. */
// eslint-disable-next-line require-yield
async function* ask(_body: AskRequest, _signal: AbortSignal): AsyncGenerator<AskEvent> {
  yield { event: "error", data: { message: NO_MODEL } };
}

export const browserApi: Api = {
  async meta(): Promise<Meta> {
    const desk = await loadDesk();
    return {
      overview: overview(desk) as Meta["overview"],
      sectors: [...desk.sectors].sort((a, b) => a.order - b.order),
      companies: desk.companies
        .map((c) => ({ id: String(c.id), name: String(c.name), sectors: (c.sectors as string[]) ?? [], type: String(c.type) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      modes: desk.pack.ask.modes.map(({ id, label }) => ({ id, label })),
      sources: Object.entries(SOURCES).map(([id, s]) => ({ id, label: s.label })),
      semantic: false,
      engine: { engine: "github", model: "GitHub Models", label: "GitHub Models, answered on GitHub (free)", web: false },
      checker: null,
      brief: getBrief(desk) as Meta["brief"],
      upcoming: upcomingEvents(desk, { days: 60 }) as Meta["upcoming"],
    };
  },
  sector: async (id) => getSector(await loadDesk(), id) as SectorDetail,
  async company(id) {
    const desk = await loadDesk();
    const company = desk.companies.find((c) => c.id === id);
    if (!company) throw new Error("Unknown company");
    return { ...company, updates: searchUpdates(desk, { company: String(company.name), limit: 12 }).updates } as unknown as CompanyDetail;
  },
  papers: (q, limit = 5) => searchPapers(q, { limit }) as Promise<Paper[]>,
  grokPrompt: () => Promise.reject(new Error(NO_MODEL)),
  verify: () => Promise.reject(new Error("The fact-check is included in ANU's reply on GitHub.")),
  reset: async () => new Response(null),
  ask,
};
