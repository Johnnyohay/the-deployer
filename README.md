# The Deployer

Describe what you want to follow in plain words ("trends in retail, supply chain and geopolitics", "women's football and the business around it", anything) and get your own briefing site: a brief every morning, themes with summaries rewritten from the news, the names that matter, dated events coming up, videos, and answers to your questions. It sets itself up, refreshes itself every day, and changes when you ask in plain words. No code.

**For users:** start from the template, **[the-deployer-template](https://github.com/Johnnyohay/the-deployer-template)**. Its README has the three steps.

## How it works

```
 "I want to follow …"  ──►  wizard (AI)  ──►  pack: topic/*.yaml + data/   ──►  daily: collect → curate → site
                             │                     ▲                                        │
                             └ checks every source │                                        ▼
 "Change my setup: …"  ──►  change (AI) ───────────┘                          GitHub Pages + JSON API + Ask
```

- **The pack is the ontology.** `topic/topic.yaml` says what the subject is made of: its **scope** (core terms a story must contain), **themes** (with keywords and why each matters), **story types**, the **kinds of things tracked** (companies, clubs, ports, people…), the **words the site uses** ("Sector" or "Market", "Company" or "Club"), the brief, and how Ask talks. `sources.yaml` lists feeds and Google News searches. The engine has no subject of its own; everything on the site comes from the pack.
- **`deployer init`** (`src/wizard.ts`) drafts the pack with an AI in small, focused questions, finds a working feed for every suggested source (or a Google News search limited to that site), adds a Google News search per theme, tests the keywords on this week's news and redrafts weak themes, lists the key names, and runs the first refresh.
- **`deployer daily`** collects, tags (scope → themes → type → names), writes the brief, then **`deployer curate`** (`src/curate.ts`) rewrites theme briefs that have new stories, refreshes the big picture, picks dated events out of new stories, adds names that keep coming up, scores momentum, and suggests ideas when the pack wants them.
- **`deployer change`** (`src/change.ts`) turns a plain request into specific edits (add/remove/rename themes, keywords, sources, names, scope), validates them (or puts the old files back), and cleans stored stories that no longer fit.
- **AI:** Groq with a free `GROQ_API_KEY` (recommended), Gemini (`GEMINI_API_KEY`), any OpenAI-compatible service, or with no key a small open model (Ollama) running locally or inside the GitHub job. GitHub Models, the earlier free option, was retired on 2026-07-30.

## Running it on your computer

```bash
npm ci
npx tsx src/cli.ts init --pack ~/my-desk --describe "What I want to follow, and why"
npx tsx src/cli.ts daily --pack ~/my-desk     # each morning (or schedule it)
npx tsx src/cli.ts change --pack ~/my-desk --request "also follow …"
npx tsx src/cli.ts serve --pack ~/my-desk     # Ask app at http://localhost:8787
```

`npx tsx src/cli.ts` lists every command. Without an AI key it uses Ollama (`brew install ollama && ollama pull qwen3.5:9b`).

## In this repo

| Folder | What's in it |
|---|---|
| `src/` | The engine: wizard, change, collector, curator, AI layer, source discovery, JSON API, Ask agent |
| `site/`, `app/` | The site's pages and the Ask app, both drawn entirely from the pack |
| `template/` | The user repo: issue forms (Set me up, Change my setup, Ask) and workflows; published as the-deployer-template |
| `.github/actions/setup` | Shared setup step every user workflow calls: installs this engine at the same version and an AI |
| `packs/anu-defense-housing` | ANU as a pack, with its own hand-made pages in `site/` |
| `test/golden` | Recorded feeds and ANU's own output: `npm test` checks the engine still does exactly what ANU does |
