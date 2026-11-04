/**
 * Free housing collector (`npm run housing`): no AI, no API key. Pulls Zillow Research's
 * public data (home values, rents, forecasts, for-sale inventory), Freddie Mac's weekly
 * mortgage rates and housing news RSS, works out rental-investor metrics per metro, and
 * writes data/housing/market.json and data/housing/news.json.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fetchFeed } from "./rss.ts";
import { slug } from "./store.ts";
import { rentalMath, type Assumptions, type HousingMarket, type HousingNews, type Metro, type StateRow } from "./housing-kb.ts";
import { loadSiteConfig } from "./config.ts";

const Z = "https://files.zillowstatic.com/research/public_csvs";
export const ZILLOW = {
  zhviMetro: `${Z}/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv`,
  zhviState: `${Z}/zhvi/State_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv`,
  zoriMetro: `${Z}/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv`,
  forecastMetro: `${Z}/zhvf_growth/Metro_zhvf_growth_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv`,
  inventoryMetro: `${Z}/invt_fs/Metro_invt_fs_uc_sfrcondo_sm_month.csv`,
};
const PMMS = "https://www.freddiemac.com/pmms/docs/PMMS_history.csv";

type Tier = HousingNews["src"]["q"];
const NEWS_FEEDS: { name: string; url: string; tier: Tier }[] = [
  { name: "HousingWire", url: "https://www.housingwire.com/feed/", tier: "news" },
  { name: "Realtor.com Research", url: "https://www.realtor.com/research/feed/", tier: "research" },
  { name: "Mortgage News Daily", url: "https://www.mortgagenewsdaily.com/rss/news", tier: "news" },
  { name: "BiggerPockets", url: "https://www.biggerpockets.com/blog/feed", tier: "news" },
];

const TOPIC_RULES: Record<string, RegExp> = {
  rates: /\b(mortgage rates?|rates?|Fed|Federal Reserve|Treasury|yields?|refinanc\w*|MBA)\b/i,
  prices: /\b(home prices?|house prices?|home values?|Case-Shiller|FHFA|appreciation|price cuts?|median (sale|list)\w* price)\b/i,
  rents: /\b(rents?|rental|landlords?|tenants?|apartments?|multifamily|vacanc\w*|single-family rental)\b/i,
  inventory: /\b(inventory|listings?|new listings|days on market|supply|delistings?|months of supply)\b/i,
  sales: /\b(existing-home sales|pending (home )?sales|home sales|buyers?|sellers?|closings?)\b/i,
  construction: /\b(housing starts|permits|builders?|new-home|new home|construction|NAHB)\b/i,
  investing: /\b(investors?|investing|cash flow|BRRRR|cap rate|flip\w*|short-term rental|Airbnb|portfolio|1031)\b/i,
  policy: /\b(policy|Congress|HUD|FHA|Fannie|Freddie|GSE|tax|zoning|legislation|bill|tariffs?|insurance|midterms?|election|regulat\w*)\b/i,
};
// Industry personnel moves and promotions, not market news.
const NOISE = /\b(adds|hires|names|appoints?|appointed|joins|promote[sd]?|to lead|steps down|webinar|podcast|sponsored|award winners?)\b/i;
const RELEVANT = /\b(hous\w*|homes?|mortgage\w*|rent\w*|real estate|propert\w*|landlord\w*|apartment\w*|realtor\w*|buyers?|sellers?|listings?|builder\w*)\b/i;

export const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

// Rental-math defaults and score weights come from topic/site.yaml (housing.rental, housing.score).
const SERIES_MONTHS = 61;

/** Minimal CSV parser for Zillow's files (quoted fields may contain commas). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (anu housing collector)" }, signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const isDate = (k: string) => /^\d{4}-\d{2}-\d{2}$/.test(k);
const num = (s: string | undefined) => (s === undefined || s === "" ? null : Number(s));
const pct = (now: number | null, then: number | null) => (now && then ? +(((now / then - 1) * 100).toFixed(1)) : null);

/** A region's monthly values, oldest first, with the month list they belong to. */
function seriesOf(row: Record<string, string>, months: string[]) {
  return months.map((m) => num(row[m]));
}

async function loadZillow(url: string) {
  const rows = parseCsv(await getText(url));
  const months = Object.keys(rows[0] ?? {}).filter(isDate).sort();
  return { rows, months, byId: new Map(rows.map((r) => [r.RegionID, r])) };
}

async function mortgageRates() {
  const rows = parseCsv(await getText(PMMS))
    .map((r) => {
      const [m, d, y] = r.date.split("/").map(Number);
      return { date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, r30: num(r.pmms30), r15: num(r.pmms15) };
    })
    .filter((r) => r.r30 !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = rows[rows.length - 1];
  const yearAgo = rows.filter((r) => r.date <= new Date(Date.parse(last.date) - 365 * 864e5).toISOString().slice(0, 10)).pop();
  return {
    rate30: last.r30!,
    rate15: last.r15,
    week: last.date,
    rate30YearAgo: yearAgo?.r30 ?? null,
    history: rows.slice(-260).map((r) => [r.date, r.r30!] as [string, number]),
  };
}

/** Percentile (0–1) of each value among the given values; higher value → higher percentile. */
function percentiles(values: (number | null | undefined)[]): (number | null)[] {
  const sorted = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  return values.map((v) => {
    if (typeof v !== "number" || sorted.length < 2) return null;
    let lo = 0;
    while (lo < sorted.length && sorted[lo] < v) lo++;
    return lo / (sorted.length - 1);
  });
}

export async function collectMarket(): Promise<HousingMarket> {
  const { rental, score: weights } = (await loadSiteConfig()).housing;
  const [zhvi, zhviState, zori, forecast, inventory, mortgage] = await Promise.all([
    loadZillow(ZILLOW.zhviMetro),
    loadZillow(ZILLOW.zhviState),
    loadZillow(ZILLOW.zoriMetro),
    loadZillow(ZILLOW.forecastMetro).catch((e) => (console.warn(`Forecast skipped: ${e.message}`), null)),
    loadZillow(ZILLOW.inventoryMetro).catch((e) => (console.warn(`Inventory skipped: ${e.message}`), null)),
    mortgageRates(),
  ]);
  let coords: Record<string, [number, number]> = {};
  try {
    coords = JSON.parse(await readFile("data/housing/metro-coords.json", "utf8"));
  } catch {
    console.warn("No data/housing/metro-coords.json yet: run `npm run housing:coords` to place metros on the map.");
  }

  const assumptions: Assumptions = { downPct: rental.downPct, rate: mortgage.rate30, years: rental.years, opexPct: rental.opexPct };
  const pMonths = zhvi.months.slice(-SERIES_MONTHS);
  const lastP = pMonths[pMonths.length - 1];
  const forecastKey = forecast ? forecast.months[forecast.months.length - 1] : null;
  const invMonths = inventory?.months ?? [];
  const series: NonNullable<HousingMarket["series"]> = {};

  const metros: Metro[] = [];
  let national: HousingMarket["national"] | null = null;
  for (const row of zhvi.rows) {
    const p = seriesOf(row, pMonths);
    const price = p[p.length - 1];
    if (!price) continue;
    const rentRow = zori.byId.get(row.RegionID);
    const r = rentRow ? seriesOf(rentRow, pMonths) : pMonths.map(() => null);
    const rent = r[r.length - 1];
    const rentYoY = pct(rent, r[r.length - 13]);
    const priceYoY = pct(price, p[p.length - 13]);
    const fc = forecast && forecastKey ? num(forecast.byId.get(row.RegionID)?.[forecastKey]) : null;
    if (row.RegionType === "country") {
      national = { price: Math.round(price), priceYoY, price5y: pct(price, p[0]), rent: rent ? Math.round(rent) : null, rentYoY, forecast12m: fc };
      continue;
    }
    if (row.RegionType !== "msa") continue;
    const [name, state] = row.RegionName.split(/, (?=[A-Z]{2}$)/);
    const inv = inventory?.byId.get(row.RegionID);
    const invNow = inv ? num(inv[invMonths[invMonths.length - 1]]) : null;
    const invYearAgo = inv ? num(inv[invMonths[invMonths.length - 13]]) : null;
    const peak = Math.max(...p.filter((x): x is number => x !== null));
    const m: Metro = {
      id: row.RegionID,
      name,
      state: state ?? row.StateName,
      rank: Number(row.SizeRank),
      ...(coords[row.RegionID] ? { lat: coords[row.RegionID][0], lon: coords[row.RegionID][1] } : {}),
      price: Math.round(price),
      priceMoM: pct(price, p[p.length - 2]),
      priceYoY,
      price5y: pct(price, p[0]),
      fromPeak: pct(price, peak),
      forecast12m: fc,
      ...(invNow ? { inventory: Math.round(invNow), inventoryYoY: pct(invNow, invYearAgo) } : {}),
    };
    if (rent) {
      const math = rentalMath(price, rent, assumptions);
      Object.assign(m, { rent: Math.round(rent), rentYoY, grossYield: +((rent * 12 * 100) / price).toFixed(2), capRate: math.capRate, cashFlow: math.cashFlow });
    }
    metros.push(m);
    series[m.id] = { p: p.map((x) => (x === null ? null : Math.round(x))), r: r.map((x) => (x === null ? null : Math.round(x))) };
  }

  // Score only metros with rent data, against each other.
  const rentals = metros.filter((m) => m.rent);
  const ranks = {
    y: percentiles(rentals.map((m) => m.grossYield)),
    rg: percentiles(rentals.map((m) => m.rentYoY)),
    f: percentiles(rentals.map((m) => m.forecast12m)),
    py: percentiles(rentals.map((m) => m.priceYoY)),
    inv: percentiles(rentals.map((m) => (m.inventoryYoY == null ? null : -m.inventoryYoY))),
  };
  rentals.forEach((m, i) => {
    const parts: [number | null, number][] = [[ranks.y[i], weights.grossYield], [ranks.rg[i], weights.rentYoY], [ranks.f[i], weights.forecast12m], [ranks.py[i], weights.priceYoY], [ranks.inv[i], weights.inventoryDrop]];
    const have = parts.filter(([v]) => v !== null) as [number, number][];
    const w = have.reduce((s, [, w]) => s + w, 0);
    const total = parts.reduce((s, [, w]) => s + w, 0);
    if (total && w >= total * 0.6) m.score = Math.round((have.reduce((s, [v, w]) => s + v * w, 0) / w) * 100);
  });

  const states: StateRow[] = zhviState.rows.flatMap((row) => {
    const code = Object.keys(STATES).find((k) => STATES[k] === row.RegionName);
    if (!code) return [];
    const p = seriesOf(row, zhviState.months.slice(-SERIES_MONTHS));
    const price = p[p.length - 1];
    if (!price) return [];
    const yields = metros.filter((m) => m.state === code && m.grossYield).map((m) => m.grossYield!).sort((a, b) => a - b);
    return [{
      code,
      name: row.RegionName,
      price: Math.round(price),
      priceYoY: pct(price, p[p.length - 13]),
      price5y: pct(price, p[0]),
      medianYield: yields.length ? yields[Math.floor(yields.length / 2)] : null,
      metros: metros.filter((m) => m.state === code).length,
    }];
  });

  const ym = (d: string | null | undefined) => (d ? d.slice(0, 7) : null);
  return {
    collectedAt: new Date().toISOString(),
    asOf: { prices: ym(lastP)!, rents: ym(zori.months[zori.months.length - 1])!, forecast: forecast ? ym(forecast.rows[0]?.BaseDate) : null, inventory: ym(invMonths[invMonths.length - 1]), mortgage: mortgage.week },
    mortgage,
    assumptions,
    national: national ?? { price: 0, priceYoY: null, price5y: null, rent: null, rentYoY: null, forecast12m: null },
    states,
    metros: metros.sort((a, b) => a.rank - b.rank),
    series,
    seriesStart: ym(pMonths[0])!,
  };
}

/** Pulls housing news, tags topics and the states each story is about, and merges with what's stored. */
export async function collectNews(market: HousingMarket, existing: HousingNews[]): Promise<HousingNews[]> {
  const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  // City names of the 150 largest metros point a story at a state ("Austin" → TX).
  const cities = market.metros.filter((m) => m.rank <= 150).flatMap((m) => m.name.split("-").filter((c) => c.length > 3).map((c) => [c, m.state] as const));
  const stateNames = Object.entries(STATES).map(([code, name]) => [name, code] as const);
  const known = new Set(existing.map((n) => n.src.u));
  const added: HousingNews[] = [];
  for (const feed of NEWS_FEEDS) {
    // Newest 25 per source per run, so one long feed can't crowd out the rest.
    const items = (await fetchFeed(feed.name, feed.url)).sort((x, y) => y.date.localeCompare(x.date)).slice(0, 25);
    for (const a of items) {
      const text = `${a.title} ${a.summary}`;
      if (a.date < since || known.has(a.link) || !RELEVANT.test(text) || NOISE.test(a.title)) continue;
      known.add(a.link);
      const found = new Set<string>();
      for (const [name, code] of [...stateNames, ...cities]) if (new RegExp(`\\b${name}\\b`).test(text)) found.add(code);
      added.push({
        id: `h-${a.date.replace(/-/g, "")}-${slug(a.title)}`,
        d: a.date,
        title: a.title,
        body: a.summary || a.title,
        topics: Object.entries(TOPIC_RULES).filter(([, re]) => re.test(text)).map(([t]) => t),
        states: [...found],
        src: { t: feed.name, u: a.link, q: feed.tier },
      });
    }
  }
  console.log(`Added ${added.length} housing news items.`);
  return [...existing, ...added].filter((n) => n.d >= since).sort((a, b) => b.d.localeCompare(a.d)).slice(0, 500);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await mkdir("data/housing", { recursive: true });
  const market = await collectMarket();
  const placed = market.metros.filter((m) => m.lat !== undefined).length;
  console.log(`Housing data as of ${market.asOf.prices}: ${market.metros.length} metros (${placed} on the map), ${market.states.length} states, 30-year rate ${market.mortgage.rate30}% (week of ${market.mortgage.week}).`);
  let news: HousingNews[] = [];
  try {
    news = JSON.parse(await readFile("data/housing/news.json", "utf8"));
  } catch {}
  news = await collectNews(market, news);
  await writeFile("data/housing/market.json", JSON.stringify(market) + "\n");
  await writeFile("data/housing/news.json", JSON.stringify(news, null, 1) + "\n");
}
