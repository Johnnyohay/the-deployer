/**
 * `deployer curate`: keeps a pack's slow-moving knowledge alive, run after each daily collect.
 *
 * - Momentum (no AI): each theme's heat, 1-5, from this week's stories against its usual week.
 * - Theme briefs: rewrites a theme's state / money / watch from its latest stories when it has
 *   new ones (a few themes per run, so the free AI tier is never exhausted).
 * - Big picture: the headline and the forces at work, from the last two weeks, once a week.
 * - Coming up: dated future events picked out of the newest stories, linked to the story.
 * - Directory: names that keep showing up in stories but aren't tracked yet get a profile.
 * - Ideas: a few grounded ideas a week, when the pack wants them (topic.yaml curate.ideas).
 *
 * Without an AI only momentum runs; everything else waits for the next run that has one.
 */
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod/v4";
import { AiUnavailable, aiAvailable, askJson } from "./ai.ts";
import { loadDesk, slug, type Desk } from "./store.ts";
import { loadTopic } from "./topic.ts";

const today = process.env.DESK_DATE ?? new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.parse(today) - n * 864e5).toISOString().slice(0, 10);
const MAX_THEME_BRIEFS = Number(process.env.CURATE_THEMES ?? 6);

const desk = await loadDesk();
const topic = await loadTopic();
const { domain, audience, vocab } = desk.pack;
const known = JSON.parse(await readFile("data/sectors.json", "utf8").catch(() => "[]")) as Record<string, unknown>[];
const knowledge = new Map(known.map((s) => [String(s.id), s]));
const meta = desk.meta as Record<string, unknown>;
const lastCurated = String(meta.curatedAt ?? "").slice(0, 10) || "0000-00-00";
const line = (u: Desk["updates"][number]) => `- ${u.d} [${u.id}] ${u.title}${u.body && u.body !== u.title ? ` — ${u.body.slice(0, 160)}` : ""} (${u.src?.t ?? ""})`;
const changes: string[] = [];

// ---- momentum (no AI) ----
for (const s of desk.sectors) {
  const ups = desk.updates.filter((u) => u.sectors.includes(s.id));
  const week = ups.filter((u) => u.d > daysAgo(7)).length;
  const usual = ups.filter((u) => u.d > daysAgo(35) && u.d <= daysAgo(7)).length / 4;
  const ratio = (week + 1) / (usual + 1);
  const heat = week === 0 ? 1 : ratio > 2 ? 5 : ratio > 1.3 ? 4 : ratio > 0.8 ? 3 : 2;
  const k = knowledge.get(s.id) ?? { id: s.id };
  k.heat = heat;
  knowledge.set(s.id, k);
}

const ai = await aiAvailable();
if (!ai) console.log("No AI available: updated momentum only.");
else {
  console.log(`Curating with ${ai}.`);
  const step = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof AiUnavailable) throw err;
      console.warn(`${label} skipped: ${(err as Error).message.split("\n")[0]}`);
    }
  };

  // ---- theme briefs ----
  const Brief = z.object({
    state: z.string().describe("2-4 sentences: where this stands now, with names and numbers from the stories"),
    money: z.string().describe(`2-3 sentences for the heading "${vocab.money}"`),
    watch: z.string().describe(`1-2 sentences for the heading "${vocab.watch}": the next things that will move it`),
  });
  const due = desk.sectors
    .map((s) => {
      const k = knowledge.get(s.id) ?? {};
      const ups = desk.updates.filter((u) => u.sectors.includes(s.id) && u.d > daysAgo(30)).sort((x, y) => y.d.localeCompare(x.d));
      const fresh = ups.filter((u) => (u.addedAt ?? u.d) > String(k.briefedAt ?? "")).length;
      return { s, k, ups, fresh };
    })
    .filter((x) => x.ups.length >= 2 && (!x.k.state || x.fresh >= 3 || String(x.k.briefedAt ?? "") < daysAgo(7)))
    .sort((x, y) => Number(!!x.k.state) - Number(!!y.k.state) || y.fresh - x.fresh)
    .slice(0, MAX_THEME_BRIEFS);
  for (const { s, k, ups } of due) {
    await step(`Brief for ${s.name}`, async () => {
      const b = await askJson(Brief, {
        system: `You write short, plain-language briefs on one part of ${domain} for ${audience}. Use only facts from the stories given; no filler, no hype, no advice disclaimers.`,
        user: `${vocab.theme}: ${s.name}\n${k.state ? `Previous brief (update it, keep what still holds): ${k.state} ${k.money ?? ""} ${k.watch ?? ""}\n` : ""}Latest stories:\n${ups.slice(0, 25).map(line).join("\n")}`,
      });
      Object.assign(k, b, { briefedAt: new Date().toISOString() });
      knowledge.set(s.id, k);
      changes.push(`rewrote the ${s.name} brief`);
    });
  }

  // ---- big picture ----
  const recent = desk.updates.filter((u) => u.d > daysAgo(14)).sort((x, y) => y.d.localeCompare(x.d));
  if (recent.length >= 8 && String(meta.pictureAt ?? "") < daysAgo(6)) {
    await step("Big picture", async () => {
      const ids = desk.sectors.map((s) => s.id);
      const p = await askJson(
        z.object({
          headline: z.string().describe("One sentence: the single biggest story of these two weeks across the subject"),
          forces: z.array(z.object({ t: z.string().describe("Short title"), b: z.string().describe("2 sentences with specifics"), s: z.array(z.string()).describe(`theme ids from: ${ids.join(", ")}`) })).min(3).max(4),
        }),
        {
          tier: "smart",
          system: `You see the patterns in two weeks of news on ${domain}, for ${audience}. Use only what the stories say.`,
          user: `Themes: ${desk.sectors.map((s) => `${s.id} = ${s.name}`).join("; ")}\nStories:\n${recent.slice(0, 45).map(line).join("\n")}`,
        },
      );
      meta.headline = p.headline;
      meta.forces = p.forces.map((f) => ({ ...f, s: f.s.filter((id) => ids.includes(id)) }));
      meta.pictureAt = new Date().toISOString();
      changes.push("refreshed the big picture");
    });
  }

  // ---- coming up ----
  const newStories = desk.updates.filter((u) => (u.addedAt ?? u.d).slice(0, 10) >= lastCurated).sort((x, y) => y.d.localeCompare(x.d)).slice(0, 40);
  if (newStories.length) {
    await step("Coming up", async () => {
      const ids = desk.sectors.map((s) => s.id);
      const out = await askJson(
        z.object({
          events: z.array(z.object({
            d: z.string().describe("YYYY-MM-DD; the 15th when only the month is known"),
            approx: z.boolean(),
            title: z.string(),
            why: z.string().describe("One sentence on why it matters"),
            sectors: z.array(z.string()),
            ref: z.string().describe("id of the story it comes from"),
          })),
        }),
        {
          system: `You pick out dated future events (deadlines, votes, launches, releases, rulings, earnings dates, meetings) mentioned in news stories about ${domain}. Today is ${today}. Only events after today that a story states; never guess. Theme ids: ${ids.join(", ")}.`,
          user: newStories.map(line).join("\n"),
        },
      );
      const titles = new Set(desk.catalysts.map((c) => c.title.toLowerCase()));
      let added = 0;
      for (const ev of out.events) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.d) || ev.d <= today || titles.has(ev.title.toLowerCase())) continue;
        if (!desk.updates.some((u) => u.id === ev.ref)) continue;
        desk.catalysts.push({ id: `c-${ev.d.replace(/-/g, "")}-${slug(ev.title)}`, d: ev.d, approx: ev.approx, title: ev.title, why: ev.why, sectors: ev.sectors.filter((id) => ids.includes(id)), ref: ev.ref } as Desk["catalysts"][number]);
        titles.add(ev.title.toLowerCase());
        added++;
      }
      desk.catalysts = desk.catalysts.filter((c) => c.d >= daysAgo(30));
      if (added) changes.push(`added ${added} upcoming events`);
    });
  }

  // ---- directory: names that keep showing up ----
  const tracked = new Set(desk.companies.flatMap((c) => [String(c.name), ...((c.aliases as string[]) ?? [])].map((n) => n.toLowerCase())));
  const counts = new Map<string, number>();
  for (const u of desk.updates.filter((x) => x.d > daysAgo(14))) for (const n of new Set([...(u.orgs ?? []), ...u.companies])) if (!tracked.has(n.toLowerCase())) counts.set(n, (counts.get(n) ?? 0) + 1);
  const candidates = [...counts.entries()].filter(([, n]) => n >= 3).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([n]) => n);
  if (candidates.length) {
    await step("Directory", async () => {
      const kinds = desk.pack.entityKinds;
      const out = await askJson(
        z.object({ add: z.array(z.object({ name: z.string(), kind: z.string(), about: z.string(), sectors: z.array(z.string()) })) }),
        {
          system: `You maintain a directory of the ${kinds.map((k) => k.plural.toLowerCase()).join(", ")} that matter in ${domain}. From the candidate names (found in recent stories), keep only real ones of those kinds that matter here (not news outlets, not generic words), at most 5. Kinds: ${kinds.map((k) => k.id).join(", ")}. Theme ids: ${desk.sectors.map((s) => s.id).join(", ")}.`,
          user: `Candidates: ${candidates.join("; ")}\nStories mentioning them:\n${desk.updates.filter((u) => u.d > daysAgo(14) && candidates.some((c) => [...(u.orgs ?? []), ...u.companies].includes(c))).slice(0, 30).map(line).join("\n")}`,
        },
      );
      for (const x of out.add.slice(0, 5)) {
        if (tracked.has(x.name.toLowerCase())) continue;
        const kind = kinds.find((k) => k.id === x.kind) ?? kinds[0];
        desk.companies.push({ id: slug(x.name), name: x.name, kind: kind.id, type: kind.label, sectors: x.sectors.filter((id) => desk.sectors.some((s) => s.id === id)), about: x.about, aliases: [], latest: "", addedAt: new Date().toISOString() });
        tracked.add(x.name.toLowerCase());
        changes.push(`started tracking ${x.name}`);
      }
    });
  }

  // ---- ideas ----
  if (topic.curate.ideas && recent.length >= 8 && String(meta.ideasAt ?? "") < daysAgo(6)) {
    await step("Ideas", async () => {
      const out = await askJson(
        z.object({ ideas: z.array(z.object({ t: z.string(), what: z.string().describe("2 sentences"), why: z.string().describe("Why now, citing the stories"), sectors: z.array(z.string()) })).min(2).max(3) }),
        {
          tier: "smart",
          system: `You suggest concrete "${vocab.ideas}" for ${audience}, grounded in the latest news on ${domain}. ${vocab.ideasIntro}`,
          user: `Theme ids: ${desk.sectors.map((s) => `${s.id} = ${s.name}`).join("; ")}\nStories:\n${recent.slice(0, 35).map(line).join("\n")}`,
        },
      );
      const fresh = out.ideas.map((x) => ({ id: `i-${today.replace(/-/g, "")}-${slug(x.t)}`, ...x, at: today }));
      desk.ideas = [...fresh, ...desk.ideas].slice(0, 12);
      meta.ideasAt = new Date().toISOString();
      changes.push(`added ${fresh.length} ${vocab.ideas.toLowerCase()}`);
    });
  }
}

// Keep each tracked name's latest story line current (no AI).
for (const c of desk.companies) {
  const u = desk.updates.filter((x) => x.companies.includes(String(c.name))).sort((x, y) => y.d.localeCompare(x.d))[0];
  if (u) c.latest = `${u.d}: ${u.title}`;
}

meta.curatedAt = new Date().toISOString();
const order = desk.sectors.map((s) => s.id);
await writeFile("data/sectors.json", JSON.stringify(order.map((id) => knowledge.get(id) ?? { id }), null, 2) + "\n");
await writeFile("data/catalysts.json", JSON.stringify([...desk.catalysts].sort((a, b) => a.d.localeCompare(b.d)), null, 2) + "\n");
await writeFile("data/companies.json", JSON.stringify(desk.companies, null, 2) + "\n");
await writeFile("data/ideas.json", JSON.stringify(desk.ideas, null, 2) + "\n");
await writeFile("data/meta.json", JSON.stringify(meta, null, 2) + "\n");
console.log(changes.length ? `Curator: ${changes.join("; ")}.` : "Curator: momentum updated; nothing else was due.");
