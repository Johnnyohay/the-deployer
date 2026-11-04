// The housing desk's data shapes and read-only queries. No file or network access, so the
// collector (src/housing.ts), the agent's tools (src/tools.ts) and the CLI share them.

export interface Metro {
  id: string;
  name: string;
  state: string;
  /** Zillow's size rank: 1 is the largest metro. */
  rank: number;
  lat?: number;
  lon?: number;
  /** Typical home value (Zillow ZHVI, mid-tier, all homes), dollars. */
  price: number;
  priceMoM: number | null;
  priceYoY: number | null;
  price5y: number | null;
  /** % below the highest value of the last five years (0 = at the peak). */
  fromPeak: number | null;
  /** Typical asking rent (Zillow ZORI), dollars a month. */
  rent?: number;
  rentYoY?: number | null;
  /** Annual rent ÷ price, %. */
  grossYield?: number;
  /** Annual rent after operating costs ÷ price, %. */
  capRate?: number;
  /** Monthly rent after costs minus the mortgage payment, with the default assumptions. */
  cashFlow?: number;
  /** Zillow's forecast for home values over the next 12 months, %. */
  forecast12m?: number | null;
  /** Homes listed for sale. */
  inventory?: number;
  inventoryYoY?: number | null;
  /** 0–100 ranking aid for rental investors (see SCORE_NOTE). */
  score?: number;
  /** Custom attributes from topic/site.yaml, by id (added by src/config.ts). */
  custom?: Record<string, number | null>;
}

export interface StateRow { code: string; name: string; price: number; priceYoY: number | null; price5y: number | null; medianYield: number | null; metros: number; custom?: Record<string, number | null> }

export interface HousingMarket {
  collectedAt: string;
  asOf: { prices: string; rents: string; forecast: string | null; inventory: string | null; mortgage: string };
  mortgage: { rate30: number; rate15: number | null; week: string; rate30YearAgo: number | null; history: [string, number][] };
  assumptions: Assumptions;
  national: { price: number; priceYoY: number | null; price5y: number | null; rent: number | null; rentYoY: number | null; forecast12m: number | null };
  states: StateRow[];
  metros: Metro[];
  /** Monthly price (p) and rent (r) history per metro id, oldest first, starting at seriesStart. */
  series?: Record<string, { p: (number | null)[]; r: (number | null)[] }>;
  seriesStart?: string;
}

export interface HousingNews {
  id: string;
  d: string;
  title: string;
  body: string;
  topics: string[];
  states: string[];
  src: { t: string; u: string; q: "primary" | "news" | "research" | "aggregator" };
}

export interface Video {
  id: string;
  title: string;
  channel: string;
  topic: string;
  /** Published, ISO date-time. */
  d: string;
  short: boolean;
  views: number | null;
  desc: string;
}

export interface Housing { market: HousingMarket; news: HousingNews[] }

export interface Assumptions { downPct: number; rate: number; years: number; opexPct: number }

export const SCORE_NOTE =
  "Score (0–100) ranks metros against each other for buy-to-rent: 40% gross rent yield, 20% rent growth, 20% Zillow's 12-month price forecast, 10% price momentum, 10% falling inventory. It's a sorting aid, not advice.";

export const COST_NOTE =
  "Operating costs (property tax, insurance, repairs, vacancy, management) are a flat share of rent; real costs vary a lot by state and property, so check local taxes and insurance before trusting a cash-flow number.";

/** Monthly principal and interest on a fixed-rate loan. */
export function mortgagePayment(loan: number, ratePct: number, years: number): number {
  const r = ratePct / 100 / 12, n = years * 12;
  return r === 0 ? loan / n : (loan * r) / (1 - Math.pow(1 + r, -n));
}

export function rentalMath(price: number, rent: number, a: Assumptions) {
  const loan = price * (1 - a.downPct / 100);
  const payment = mortgagePayment(loan, a.rate, a.years);
  const noi = rent * (1 - a.opexPct / 100);
  return {
    downPayment: Math.round(price * (a.downPct / 100)),
    payment: Math.round(payment),
    netRent: Math.round(noi),
    cashFlow: Math.round(noi - payment),
    capRate: +((noi * 12 * 100) / price).toFixed(2),
    cashOnCash: +((((noi - payment) * 12) / (price * (a.downPct / 100))) * 100).toFixed(2),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const clamp = (n: number | undefined, def: number, max: number) => Math.min(Math.max(n ?? def, 1), max);

export const SORTS = ["score", "grossYield", "capRate", "cashFlow", "rentYoY", "priceYoY", "price5y", "forecast12m", "price", "fromPeak", "inventoryYoY"] as const;
export type Sort = (typeof SORTS)[number];

export interface MetroQuery { sortBy?: Sort; ascending?: boolean; states?: string[]; maxPrice?: number; minPrice?: number; largestOnly?: number; limit?: number }

export function rankMetros(h: Housing, q: MetroQuery) {
  const key = q.sortBy ?? "score";
  const states = q.states?.map((s) => s.toUpperCase());
  const rows = h.market.metros
    .filter((m) => !states?.length || states.includes(m.state))
    .filter((m) => (!q.maxPrice || m.price <= q.maxPrice) && (!q.minPrice || m.price >= q.minPrice))
    .filter((m) => !q.largestOnly || m.rank <= q.largestOnly)
    .filter((m) => typeof m[key] === "number")
    .sort((a, b) => ((a[key] as number) - (b[key] as number)) * (q.ascending ? 1 : -1));
  return { asOf: h.market.asOf, total: rows.length, sortedBy: key, metros: rows.slice(0, clamp(q.limit, 15, 60)).map(slimMetro) };
}

const slimMetro = ({ lat, lon, ...m }: Metro) => m;

export function findMetro(h: Housing, name: string): Metro | undefined {
  const q = norm(name);
  const metros = h.market.metros;
  return (
    metros.find((m) => norm(`${m.name}`) === q || norm(`${m.name}, ${m.state}`) === q) ??
    metros.find((m) => norm(m.name).startsWith(q) || q.startsWith(norm(m.name))) ??
    [...metros].sort((a, b) => a.rank - b.rank).find((m) => norm(`${m.name} ${m.state}`).includes(q))
  );
}

export function getMetro(h: Housing, name: string) {
  const m = findMetro(h, name);
  if (!m) return { error: `No metro matches "${name}". Try the main city name, e.g. "Austin" or "Tampa, FL".` };
  const state = h.market.states.find((s) => s.code === m.state);
  const s = h.market.series?.[m.id];
  // One point a year keeps the history short enough to read.
  const yearly = s && h.market.seriesStart
    ? s.p.flatMap((p, i) => (i % 12 === (s.p.length - 1) % 12 ? [{ month: addMonths(h.market.seriesStart!, i), price: p, rent: s.r[i] }] : []))
    : undefined;
  const city = m.name.split(/[-,]/)[0].toLowerCase();
  return {
    asOf: h.market.asOf,
    metro: slimMetro(m),
    rental: m.rent ? rentalMath(m.price, m.rent, h.market.assumptions) : null,
    assumptions: h.market.assumptions,
    state,
    national: h.market.national,
    yearlyHistory: yearly,
    news: h.news.filter((n) => n.states.includes(m.state) || n.title.toLowerCase().includes(city)).slice(0, 8),
    notes: [SCORE_NOTE, COST_NOTE],
  };
}

function addMonths(ym: string, n: number) {
  const [y, mo] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function housingOverview(h: Housing) {
  const m = h.market;
  const big = m.metros.filter((x) => x.rank <= 100);
  const top = (key: Sort, dir = -1, list = big) => [...list].filter((x) => typeof x[key] === "number").sort((a, b) => ((a[key] as number) - (b[key] as number)) * dir).slice(0, 5).map((x) => ({ name: `${x.name}, ${x.state}`, [key]: x[key], price: x.price }));
  return {
    asOf: m.asOf,
    mortgage: { ...m.mortgage, history: undefined },
    national: m.national,
    assumptions: m.assumptions,
    metrosTracked: m.metros.length,
    among100Largest: {
      bestScore: top("score"),
      highestYield: top("grossYield"),
      fastestRentGrowth: top("rentYoY"),
      biggestPriceGains: top("priceYoY"),
      biggestPriceDrops: top("priceYoY", 1),
      strongestForecast: top("forecast12m"),
      cashFlowPositive: big.filter((x) => (x.cashFlow ?? -1) > 0).length,
    },
    states: [...m.states].sort((a, b) => (b.priceYoY ?? 0) - (a.priceYoY ?? 0)).map((s) => ({ code: s.code, price: s.price, priceYoY: s.priceYoY, medianYield: s.medianYield })),
    latestNews: h.news.slice(0, 6).map((n) => ({ d: n.d, title: n.title, source: n.src.t })),
    notes: [SCORE_NOTE, COST_NOTE],
  };
}

export function searchHousingNews(h: Housing, f: { query?: string; state?: string; topic?: string; since?: string; limit?: number }) {
  const words = norm(f.query ?? "").split(" ").filter((w) => w.length > 1);
  const hits = h.news
    .filter((n) => !f.state || n.states.includes(f.state.toUpperCase()))
    .filter((n) => !f.topic || n.topics.includes(f.topic))
    .filter((n) => !f.since || n.d >= f.since)
    .map((n) => ({ n, s: words.length ? words.filter((w) => norm(`${n.title} ${n.body}`).includes(w)).length / words.length : 1 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.n.d.localeCompare(a.n.d));
  return { total: hits.length, news: hits.slice(0, clamp(f.limit, 12, 40)).map((x) => ({ ...x.n, source: `${x.n.src.t} [${x.n.src.q}] ${x.n.src.u}` })) };
}

export function searchVideos(videos: Video[], f: { query?: string; topic?: string; shortsOnly?: boolean; limit?: number }) {
  const words = norm(f.query ?? "").split(" ").filter((w) => w.length > 1);
  return videos
    .filter((v) => (!f.topic || v.topic === f.topic) && (!f.shortsOnly || v.short))
    .map((v) => ({ v, s: words.length ? words.filter((w) => norm(`${v.title} ${v.desc} ${v.channel}`).includes(w)).length / words.length : 1 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.v.d.localeCompare(a.v.d))
    .slice(0, clamp(f.limit, 10, 30))
    .map(({ v }) => ({ ...v, url: `https://www.youtube.com/${v.short ? "shorts/" : "watch?v="}${v.id}` }));
}
