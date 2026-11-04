import { loadDesk, saveDaily } from "./store.ts";
import { buildApi } from "./build-api.ts";
import { tagCompanies } from "./companies.ts";

// Backfill: tag companies and organizations on stored updates that have never been
// tagged, using the local Hugging Face NER model. `npm run enrich` (ALL=1 to redo all).

const desk = await loadDesk();
const todo = desk.updates.filter((u) => process.env.ALL || u.orgs === undefined);
if (!todo.length) {
  console.log("Every update is already tagged.");
  process.exit(0);
}
console.log(`Tagging ${todo.length} updates…`);
const gained = await tagCompanies(desk, todo);
await saveDaily(desk, null);
await buildApi(desk);
console.log(`Done: ${gained} updates that had no companies now have at least one.`);
