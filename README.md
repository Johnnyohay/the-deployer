# The Deployer

Describe the topics you want to follow in plain English and get your own ANU-style site: a daily brief, topic desks, data charts, videos and Ask. It runs free on GitHub and updates itself every morning. No code needed.

**Status:** Phase 0 of [the plan](SPEC.md#9-repo-layout-and-build-plan) is done. The engine is ANU's code with every defense- and housing-specific piece moved into a *pack* of YAML files, and a golden test proves it still does exactly what ANU does. The setup wizard for new users is not built yet.

## How it's organized

| Folder | What's in it |
|---|---|
| `src/`, `app/`, `site/` | The engine: collectors, brief writer, JSON API, Ask agent, the Ask app and the site's pages. Nothing about any one topic. |
| `packs/<name>/topic/` | A pack: `topic.yaml` (sectors, keywords, story types, the brief, how Ask talks), `sources.yaml` (news feeds), `site.yaml` (tabs, flags, housing settings), `videos.yaml`, `requests.yaml` |
| `packs/<name>/data/` | What the pack has collected, plus its starting knowledge (sector briefs, companies, events, ideas) |
| `test/golden/` | Recorded feeds, a starting snapshot and ANU's own output for them |

`packs/anu-defense-housing` is ANU, rebuilt as the first pack.

## Run it on a pack

```bash
npm ci
export DEPLOYER_PACK=packs/anu-defense-housing   # or pass --pack <dir>, or run inside the pack
npm run collect        # fetch news, sort it, write today's brief and the API into the pack's public/
npm run housing        # housing desk (only for packs that have it)
npm run videos
npm run build:api      # check the pack's YAML and rebuild public/
npm run app            # Ask app at http://localhost:8787 (Ollama, or Claude with ANTHROPIC_API_KEY)
npm run kb -- overview # free lookups
```

`npm run deployer` lists every command. Installed from GitHub, the same commands are `npx github:Johnnyohay/the-deployer <command>`.

## Tests

`npm test` runs the engine with the ANU pack on recorded feeds (offline) and checks every output file against what ANU's own code produced from the same input. CI runs it on every push.
