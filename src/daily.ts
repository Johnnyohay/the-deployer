import { writeFile, mkdir } from "node:fs/promises";
import { loadDesk, saveDaily, slug } from "./store.ts";
import { research, structure } from "./pipeline.ts";
import { buildApi } from "./build-api.ts";
import type { Brief, Update } from "./schema.ts";

const today = process.env.DESK_DATE ?? new Date().toISOString().slice(0, 10);
const desk = await loadDesk();

if (desk.briefs.some((b) => b.date === today) && !process.env.FORCE) {
  console.log(`A brief for ${today} already exists; set FORCE=1 to redo it.`);
  process.exit(0);
}

console.log(`Researching developments for ${today}…`);
const memo = await research(desk, today);
await mkdir("logs", { recursive: true });
await writeFile(`logs/${today}-research.md`, memo + "\n");

console.log("Structuring the day's entries…");
const out = await structure(desk, today, memo);

const knownIds = new Set(desk.updates.map((u) => u.id));
const knownUrls = new Set(desk.updates.map((u) => u.src?.u).filter(Boolean));
const addedAt = new Date().toISOString();
const idForIndex = new Map<number, string>();
const added: Update[] = [];

out.updates.forEach((draft, i) => {
  const id = `u-${draft.d.replace(/-/g, "")}-${slug(draft.title)}`;
  if (knownIds.has(id) || knownUrls.has(draft.src.u) || !/^https?:\/\//.test(draft.src.u)) {
    // Duplicate or unsourced: point any story at the existing entry when we can.
    const existing = desk.updates.find((u) => u.id === id || u.src?.u === draft.src.u);
    if (existing) idForIndex.set(i, existing.id);
    return;
  }
  knownIds.add(id);
  knownUrls.add(draft.src.u);
  idForIndex.set(i, id);
  added.push({ ...draft, id, addedAt });
});
desk.updates.push(...added);

const knownCatalysts = new Set(desk.catalysts.map((c) => c.title.toLowerCase()));
for (const c of out.newCatalysts) {
  if (c.d < today || knownCatalysts.has(c.title.toLowerCase())) continue;
  desk.catalysts.push({ ...c, id: `c-${c.d.replace(/-/g, "")}-${slug(c.title)}` });
  knownCatalysts.add(c.title.toLowerCase());
}

const brief: Brief = {
  date: today,
  title: out.brief.title,
  big: out.brief.big,
  stories: out.brief.stories.map(({ updateIndex, ...s }) => ({ ...s, ref: idForIndex.get(updateIndex) ?? "" })),
  watch: out.brief.watch,
  idea: out.brief.idea,
};
desk.briefs.push(brief);
desk.meta = { ...desk.meta, asOf: today };

await saveDaily(desk, brief);
await buildApi(desk);
console.log(`Done: ${added.length} new updates, ${brief.stories.length} stories in the brief.`);
