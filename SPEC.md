# The Deployer: architecture spec (v0.1, 2026-11-03)

**One line:** a non-coder describes the topics they want to follow in plain English. The Deployer turns that into an ANU-style site (daily brief, topic desks, data desk, videos, Ask) on their own GitHub account or computer, and keeps it up to date every day, all with no code.

Example: "Trends in retail, supply chain and geopolitics" → a site with sectors like *e-commerce, store formats, freight & shipping, ports & chokepoints, tariffs & trade policy, China–US, Red Sea / Panama*, fed by retail, logistics and geopolitics news, with a data desk of freight rates, retail sales and import prices.

## Decisions (2026-11-03)

1. **Hosting:** GitHub first (template repo + issue-form wizard, Actions + Pages). Local npx/Docker comes later (phase 5).
2. **AI:** GitHub Models (free, no key) for setup and the curator; Ollama locally; Claude API only if a user adds a key.
3. **ANU:** gets rebuilt on the Deployer core as the first pack (phases 0 and 6). The live ANU site stays untouched until the core reproduces it.
4. **Repo:** `Johnnyohay/the-deployer`, public.

---

## Proven on GitHub (2026-11-05)

Demo: [Johnnyohay/deployer-demo](https://github.com/Johnnyohay/deployer-demo), made with "Use this template" plus one "Set me up" issue, with no AI key (qwen3.5:4b runs inside the job): setup took 9 minutes, a daily refresh 10–18, and two "Change my setup" issues took about 4 minutes each. Found and fixed along the way:
- ask.yml had a YAML error, so Ask never ran. CI now runs actionlint on the template's workflows.
- The issue title went straight into the shell command; it is now passed through an env variable.
- The job token can't switch GitHub Pages on. The setup reply asks for the one click.
- The small model put lists where labels belong, and generic words in the scope. Fixed with label validation, a generic-word filter that `change` also applies to old setups, and scope terms that match either singular or plural.

## Phases 1–2 result (2026-11-05): any topic, alive

- **Ontology in the pack:** scope (core terms a story must contain), themes, story types, entity kinds, the site's vocabulary, per-mode suggested questions. The site, the Ask app and the docs page draw everything from it; ANU keeps its own pages as pack overrides and is unchanged (golden test, and byte-identical pages).
- **Wizard** (`deployer init`) and **change** (`deployer change`) work end to end; tested on "retail, supply chain and geopolitics" and "women's football business" with a small local model (about 6.5 minutes per setup). Small models do best with narrow questions, so scope is drafted and then self-checked in two short calls.
- **Curator** (`deployer curate`) keeps theme briefs, big picture, events, directory, momentum and ideas current.
- **Template repo** with issue-driven setup, change and Ask, plus a daily workflow; a shared composite action installs the engine at the same version, so user repos never need editing.
- **Change of plan:** GitHub Models was retired on 2026-07-30. AI is now Groq (free key, recommended), Gemini, any OpenAI-compatible service, or with no key Ollama inside the job. ANU's own GitHub Ask depended on GitHub Models and needs the same switch.

## Phase 0 result (2026-11-04)

Done. The engine is ANU's code with every domain-specific piece moved into `packs/anu-defense-housing`: 14 feeds, 20 sector rules and "why it matters" lines, 8 story types and weights, the noise filter, the brief title, the Ask persona, rules and 7 modes, the Claude research instructions and the tool examples. The sector and story-type lists are no longer constants; they are built from the pack.

- **Golden test** (`npm test`): recorded feeds from 2026-11-04 plus a snapshot of ANU's data, run through ANU's own code and through the engine. All 11 output files match (64 new stories, the same 5-story brief). The test fails if a rule changes.
- **Same API**: on ANU's full data, every file in `/api/v1/` matches what ANU publishes, except a new `pack` block in `all.json` (what Ask needs, so the browser app and GitHub issues read the same modes).
- **What changed from the plan**: one package, not a monorepo (`src/` engine, `site/` pages, `app/` Ask app, `packs/`). The pack splits into `topic.yaml` (what it follows) and `site.yaml` (how it looks). Sectors and story types take a raw regex `pattern` as well as `keywords`, so ANU's rules move over unchanged.
- **Still ANU-flavored, by plan**: the front-end pages (`site/index.html`, `app/src/App.tsx`) still have defense wording (phase 1), and the housing desk is a built-in preset (phase 3).
- **Found along the way**: GovConWire's feed returns HTTP 403, so ANU has probably been missing it. The source-health check (section 5, step 10) would flag this.

---

## 1. What ANU is today, and what has to change

ANU has three kinds of desks, and **about 80% of what makes it about defense is hardcoded in TypeScript, not YAML**:

| Piece | Where it lives in ANU | Configurable today? |
|---|---|---|
| News sources (14 RSS feeds) | `src/collect.ts` `FEEDS` | No, hardcoded |
| Sectors (20), keyword rules, "why it matters" | `collect.ts` `SECTOR_RULES`, `SECTOR_SO_WHAT`; `schema.ts` `SECTOR_IDS` (a fixed enum) | No |
| Story types, noise filter, scoring weights | `collect.ts` `TYPE_RULES`, `NOISE`, `TYPE_WEIGHT` | No |
| Brief wording ("Today's top defense-tech headlines") | `collect.ts` | No |
| Sector briefs (state / money / watch / heat) | `data/sectors.json` | Hand-written once, **never refreshed** |
| Companies (49), catalysts, ideas, research | `data/*.json` | Hand-written once, never refreshed (except NER tagging) |
| Ask modes and persona ("advise me as a founder") | `src/prompts.ts` `MODES` | No |
| Housing desk (Zillow, Freddie Mac, 900 metros) | `src/housing.ts`, `housing-kb.ts` | Partly (`config/anu.yaml`: weights, formulas, flags) |
| Videos | `config/videos.yaml` | Yes |
| Site name, tabs, flags | `config/anu.yaml` | Yes |
| Front end | `public/index.html` (74 defense/sector refs), `app/src/App.tsx` | No |

So the Deployer isn't "a YAML editor on top of ANU". It needs **one refactor of ANU into a domain-agnostic core**, plus a **topic pack** format that holds everything domain-specific, plus a **setup wizard** that writes the topic pack for the user.

---

## 2. Architecture overview

```
┌───────────────────────────── the-deployer (this repo, owned by Johnny) ─────────────────────────────┐
│                                                                                                     │
│  packages/core      domain-agnostic engine: collectors, tagger, brief writer, curator, API builder, │
│                     Ask agent, site + app. Reads ONLY the topic pack; knows nothing about defense.  │
│  packages/wizard    turns plain-English interests into a validated topic pack                       │
│  packages/cli       `deployer init | run daily | run weekly | doctor | serve | upgrade`               │
│  template/          the repo a user gets: topic/ + data/ + workflows, **zero code**               │
│  packs/             example packs: anu-defense-housing, retail-supply-geo, (more later)             │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
                     │ pinned by version (github:Johnnyohay/the-deployer#v1.x)
                     ▼
┌──────────── a user's deployment (their own repo, made from template/) ────────────┐
│  topic/topic.yaml      what to follow (written by the wizard, editable)           │
│  topic/sources.yaml    feeds, data series, YouTube channels                       │
│  topic/seed/*.yaml     entities, catalysts, ideas (wizard-drafted, curator-kept)  │
│  data/                 collected updates, briefs, series (committed by the bot)   │
│  .github/workflows/    setup.yml, daily.yml, weekly.yml, ask.yml, upgrade.yml     │
│  deployer.lock         core version this deployment runs                          │
└───────────────────────────────────────────────────────────────────────────────────┘
                     │ GitHub Pages (or `deployer serve` locally / Docker)
                     ▼
             https://<user>.github.io/<repo>/  +  /api/v1/*.json
```

**The rule that keeps it simple:** a user's repo contains no code. Each workflow runs one line, `npx -y github:Johnnyohay/the-deployer#<version> run daily`. Bug fixes and new features reach every deployment through `upgrade.yml` (section 7). Nobody merges code.

---

## 3. The topic pack (the only thing that differs between deployments)

All of it is YAML, validated by a zod schema in core. A mistake stops the build with a plain message naming the line, the same way ANU's `config/anu.yaml` works today.

### `topic/topic.yaml`
```yaml
site:
  name: Tradewinds
  owner: Dana
  tagline: Retail, supply chain and geopolitics, every morning
  audience: "an operator in retail strategy who wants to anticipate supply shocks"   # drives every "why it matters"
  language: en
  timezone: America/New_York
  briefTime: "06:00"                     # local time; converted to UTC cron by the CLI

desks:                                   # tabs, in order
  - { id: news,   kind: news,   label: Today }
  - { id: data,   kind: series, label: Indicators }
  - { id: watch,  kind: videos, label: Watch }
  - { id: ask,    kind: ask,    label: Ask }
  - { id: docs,   kind: docs,   label: Docs }

sectors:                                 # replaces SECTOR_IDS + SECTOR_RULES + SECTOR_SO_WHAT
  - id: freight
    name: Freight & shipping
    keywords: [container rates, freight, Maersk, shipping, TEU, Drewry, Freightos, carrier]
    exclude:  [freight train derailment]          # optional
    soWhat: "Shipping costs feed straight into landed cost and shelf price 6–10 weeks later."
  - id: chokepoints
    name: Ports & chokepoints
    keywords: [Red Sea, Suez, Panama Canal, Strait of Hormuz, port congestion, Houthi, strike at port]
    soWhat: "Chokepoint disruptions are the earliest warning of stockouts and rerouting costs."
  # … typically 8–20

storyTypes:                              # replaces TYPE_RULES / TYPE_WEIGHT
  - { id: policy,   label: "Policy & tariffs", keywords: [tariff, sanction, export control, executive order], weight: 3 }
  - { id: deal,     label: "Deals",            keywords: [acquires, merger, IPO, raises $],                  weight: 3 }
  - { id: earnings, label: "Earnings",         keywords: [earnings, guidance, same-store sales, comps],      weight: 2 }
  - { id: data,     label: "Data release",     keywords: [index, report, survey, CPI, PMI],                  weight: 2 }
  default: { id: news, label: News, weight: 1 }

noise: [appoints, webinar, podcast, week in review, sponsored]

brief:
  title: "Today in retail, supply chain and geopolitics"
  stories: 5
  spreadAcrossSectors: true
  include: [watch, idea]                 # next catalyst, one idea

ask:
  persona: "a sharp analyst briefing a retail strategy lead"
  modes:                                 # replaces MODES in prompts.ts
    - { id: learn,  label: Teach me,    instruction: "Teach me from the ground up …" }
    - { id: news,   label: What's new,  instruction: "Summarize the most important …" }
    - { id: advise, label: Advise me,   instruction: "Advise me: what should I do differently this quarter, with risks and a first step." }
```

### `topic/sources.yaml`
```yaml
feeds:                                   # kind: rss | google-news | sitemap
  - { name: Supply Chain Dive, url: https://www.supplychaindive.com/feeds/news/, tier: news }
  - { name: Retail Dive,       url: https://www.retaildive.com/feeds/news/,      tier: news }
  - { name: Freightos blog,    url: https://www.freightos.com/feed/,              tier: research }
  - { kind: google-news, name: "GN: Red Sea shipping", query: "Red Sea shipping OR Suez container", tier: aggregator }

series:                                  # generic data desk; replaces the Zillow-specific housing desk
  - id: retailSales
    label: US retail sales (monthly, $M)
    provider: fred                       # fred | csv-url | json-url | worldbank | eurostat
    code: RSAFS
    format: kmoney
    chart: line
  - id: importPrices
    label: Import price index
    provider: fred
    code: IR
  - id: brentOil
    label: Brent crude ($/bbl)
    provider: fred
    code: DCOILBRENTEU

videos:
  - { channel: "@CNBC", topics: [freight, retail] }

entities:                                # optional extra entity kinds beyond "companies"
  kinds: [company, country, port]
```

### `topic/seed/`
`entities.yaml` (companies, countries, ports…), `catalysts.yaml` (dated events), `ideas.yaml`, `sectors.md` (a starting "state / money / watch" for each sector). The wizard drafts them; the weekly curator keeps them current (section 6).

**Housing becomes a series-desk preset**, not special code: `provider: zillow` and `fred` adapters, a `geo: us-metro` map view, and the existing formula engine (`config.ts` custom attributes) generalized to work over any series. That's how ANU itself becomes "just a pack" (`packs/anu-defense-housing`).

---

## 4. The setup wizard: plain English in, working site out

Two equivalent front doors, sharing `packages/wizard`.

### A. GitHub, no install (default for end users)
1. User clicks **"Use this template"** on `the-deployer-template` → their own repo.
2. They open the **"Set me up"** issue (an issue form): *What do you want to follow? Who are you / why? Any sources you already read? Any YouTube channels? Countries/regions? When do you want the brief?*
3. `setup.yml` runs on that issue:
   1. **Draft**: an LLM (GitHub Models, free with the workflow token, the same thing ANU's `ask.yml` already uses) writes `topic.yaml`, `sources.yaml` and the seeds against the zod schema (JSON-schema structured output, retried until valid).
   2. **Verify every source** (the step that makes it reliable): fetch each feed and drop any that's dead, non-RSS or returns nothing from the last 30 days. For each sector with fewer than 2 live feeds, add a `google-news` query feed (works for any topic, no key). Check each FRED code exists. Resolve each YouTube handle to a channel ID.
   3. **Dry run**: collect the last 7 days, tag, and report coverage for each sector (`freight: 23 stories, chokepoints: 4, …`) plus the 10 most common untagged headlines. A sector with 0 hits gets its keywords re-drafted once.
   4. **Open a PR** "Your Tradewinds setup", with a preview brief rendered in the PR body and the coverage table.
4. User reads the preview and clicks **Merge**. Pages turns on, `daily.yml` runs right away, and the site is live.
5. Changing anything later: edit a YAML file in the GitHub web editor, or open a **"Change my setup"** issue in plain English ("drop sports retail, add Mexico nearshoring") → same pipeline → PR.

### B. Local, no GitHub needed
```bash
npx github:Johnnyohay/the-deployer init      # interactive questions in the terminal, same as the issue form
npx github:Johnnyohay/the-deployer serve     # http://localhost:8787
npx github:Johnnyohay/the-deployer schedule  # installs the daily/weekly job: launchd (mac), cron (linux), Task Scheduler (windows)
```
or `docker run -v ./my-desk:/desk -p 8787:8787 ghcr.io/johnnyohay/deployer` with the schedule built in. Locally the LLM is Ollama (as ANU does now), with an optional `ANTHROPIC_API_KEY` for richer setup and briefs.

**LLM engine order (both paths):** GitHub Models (in Actions) → Ollama (local) → Claude API if a key is set. Daily collection never needs an LLM, same as ANU today.

---

## 5. The daily refresh (`deployer run daily`), the generalized ANU daily job

Runs at `site.briefTime` (cron computed from the timezone), plus by hand (`workflow_dispatch`) and after a push to `topic/**`. Each step can fail on its own; a failed step keeps yesterday's data, as ANU's housing and video steps already do.

| # | Step | Generalized from | LLM? |
|---|---|---|---|
| 1 | **Collect news**: every feed in `sources.yaml`, last `lookbackDays`, dedupe by URL and title slug | `collect.ts` | No |
| 2 | **Tag**: sectors from `keywords` (word-boundary regex, built at runtime), type from `storyTypes`, drop `noise`, entities by name match plus HF NER | `collect.ts`, `companies.ts` | No (local HF model) |
| 3 | **Semantic fallback**: an untagged article within cosine 0.55 of a sector's centroid (bge-small, already in ANU) gets that sector, so coverage doesn't depend only on keywords | `semantic.ts` | No |
| 4 | **Score and brief**: type weight + entity hits + title-sector match + source tier, spread across sectors, `brief.stories` items, next catalyst, idea | `collect.ts` brief block | No (template). Optional: GitHub Models rewrites the "why it matters" lines for `site.audience`, falling back to `soWhat` |
| 5 | **Series**: fetch each series, compute change (MoM/YoY), custom formulas, flag moves bigger than 2σ as "notable" and send them to the brief | `housing.ts` | No |
| 6 | **Videos**: YouTube channel RSS | `videos.ts` | No |
| 7 | **Heat**: sector heat 1–5 from 7-day story volume compared with the 30-day baseline (today it's static in `sectors.json`) | new | No |
| 8 | **Build API** `public/api/v1/*` and **Pages** | `build-api.ts` | No |
| 9 | **Commit** `data/` as the bot, then deploy | `daily.yml` | No |
| 10 | **Health**: write `data/health.json` (feeds that failed today, sectors with 0 stories for 7 days, last good run). The site footer shows it; 3 failures in a row open an issue for the user | new | No |

Time and cost: about 1 minute, free (public repo Actions + Pages). Private repos are also fine: about 30 Action-minutes a month, well inside the free 2,000.

---

## 6. The weekly curator (`deployer run weekly`), what ANU doesn't have yet

ANU's sector briefs, company list, catalysts and ideas were written once and have gone stale. For a tool where the user never touches code, that slow-moving knowledge needs its own refresh. It runs Sunday and **always lands as a PR the user approves**, or is auto-merged if `curator.autoMerge: true`:

1. **Sector briefs**: rewrite each sector's `state / money / watch` from the last 30 days of its stories, with citations to update IDs. (LLM, GitHub Models)
2. **Entities**: new names the NER tagger saw 3 or more times in the week become candidate entities with a one-line profile; entities with no mentions for 90 days get marked dormant.
3. **Catalysts**: pull future dates mentioned in the week's stories ("vote on Nov 18", "tariffs take effect Jan 1") into `catalysts.yaml`; drop past ones.
4. **Keyword tuning**: the most common terms in untagged-but-relevant articles become suggested keyword additions for each sector. Keywords that matched nothing in 30 days are flagged.
5. **Source health**: dead feeds get replaced with a google-news query; new feeds suggested from domains that keep showing up in Google News results.
6. **Ideas**: 3 new ideas grounded in the week (when `brief.include` has `idea`).

The PR body is a short readable diff: "+2 entities (Flexport, Shein) · freight brief rewritten · 1 dead feed swapped."

---

## 7. Keeping every deployment on the latest core (`upgrade.yml`)

- Core is released by git tag (`v1.4.0`). `deployer.lock` pins `^1`.
- `upgrade.yml`, run weekly: if a newer compatible core exists, it runs `deployer doctor` against the user's pack (schema check plus a dry-run collect) and opens a PR bumping the lock. If the pack schema changed, the CLI's `migrate` rewrites the YAML in the same PR.
- Breaking changes (`v2`) need the user to merge, with plain-language release notes in the PR.

---

## 8. The front end

- One generic React site (merges ANU's `public/index.html` desk page and `app/`) rendered entirely from `/api/v1/config.json` + `all.json`. Sector names, colors, tabs, modes and series all come from the pack. **No string in the UI is domain-specific.**
- Desk kinds: `news` (brief + sector grid + feed), `series` (charts; a map when the series has `geo`), `videos` (grid/reels), `ask`, `docs` (auto-generated from the pack: "what you follow, where it comes from, how to change it").
- Ask works as in ANU: GitHub-issue Q&A via GitHub Models on Pages, or a local agent with Ollama/Claude via `deployer serve`. The tools (`kb.ts`) are generalized to sector/entity/series lookups.
- A theme block in `topic.yaml` (accent color, logo emoji/URL), and that's it.

---

## 9. Repo layout and build plan

```
the-deployer/
  packages/core/         src/{collect,tag,brief,series,videos,heat,curator,build-api,agent,kb}/ …
  packages/core/schema/  topic.schema.ts (zod) → topic.schema.json (also gives editor autocomplete)
  packages/wizard/       draft.ts, verify-sources.ts, dry-run.ts, report.ts
  packages/cli/          deployer.ts (init, run daily|weekly, doctor, serve, schedule, upgrade, migrate)
  packages/site/         React site + Ask app
  providers/             rss, google-news, fred, zillow, csv-url, json-url, worldbank, youtube
  template/              user repo skeleton: topic/, data/.gitkeep, .github/{workflows,ISSUE_TEMPLATE}
  packs/anu-defense-housing/   ANU's current content as a pack (the regression test)
  packs/retail-supply-geo/     the worked example
  Dockerfile
```

| Phase | Deliverable | Done when |
|---|---|---|
| **0. Extract** | Move ANU's hardcoded feeds/rules/modes/seed data into `packs/anu-defense-housing`; core reads only the pack | Core + ANU pack produces the same brief as ANU today on a fixed date (golden test) |
| **1. Generic news desk + site** | schema, collectors, tagger, heat, generic UI, `run daily`, template repo | Hand-written retail pack runs end to end on GitHub Pages |
| **2. Wizard** | issue-form setup, source verification, dry run, PR with preview; local `init` | A stranger goes from "Use this template" to a live site in under 10 minutes without typing code |
| **3. Series desk** | fred/csv/zillow providers, charts, notable-move flags; housing desk ported | ANU's housing tab runs from the pack |
| **4. Curator + upgrade** | `run weekly`, `upgrade.yml`, health issues | 2 weeks of unattended runs on 2 packs with no manual fixes |
| **5. Local/Docker** | `serve`, `schedule`, image | Runs on a clean Mac and Linux box with one command |
| **6. Move ANU** | ANU repo becomes a deployment (topic/ + data/ only) | ANU's site unchanged, codebase deleted from ANU |

---

## 10. Risks and the answer to each

| Risk | Answer |
|---|---|
| LLM makes up feed URLs or FRED codes | Every source is fetched and checked before the PR; Google News query feeds as a guaranteed fallback |
| Keyword tagging is bad for a fuzzy topic | Semantic fallback (step 3) plus the curator's weekly keyword tuning |
| GitHub Models free-tier limit | Setup/curator use a few calls a week; daily job uses none; a hit limit means retry tomorrow, never a broken site |
| User breaks YAML | Schema validation with line-numbered messages; the build refuses to deploy a broken config; issue-form edits avoid hand-editing entirely |
| Paywalled or no-RSS sources | Google News query feeds cover them by headline; no scraping (same stance as ANU on TikTok/Instagram) |
| Core update breaks a user | Lock file + doctor dry-run in the upgrade PR; nothing upgrades without a passing dry run |
