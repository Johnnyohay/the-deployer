import type { Desk } from "./store.ts";
import type { Update } from "./schema.ts";
import { tagOrganizations } from "./hf.ts";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Fills `companies` (and `orgs`, every organization mentioned) on updates using the
 * Hugging Face NER model. Names that match the company directory use the directory's
 * spelling, so the agent and the site can link them. Mutates the updates in place and
 * returns how many gained at least one company.
 */
export async function tagCompanies(desk: Desk, updates: Update[]): Promise<number> {
  const directory = desk.companies.map((c) => {
    const name = String(c.name);
    return { name, aliases: name.split(/ · | \/ /).map(norm).filter((a) => a.length > 2) };
  });
  const canonical = (org: string) => {
    const n = norm(org);
    return directory.find((d) => d.aliases.some((a) => n === a || n.startsWith(a + " ") || a.startsWith(n + " ")))?.name ?? org;
  };

  const tags = await tagOrganizations(updates.map((u) => `${u.title}. ${u.body}`));
  let gained = 0;
  updates.forEach((u, i) => {
    const before = u.companies.length;
    u.orgs = tags[i].orgs;
    u.companies = [...new Set([...u.companies, ...tags[i].companies.map(canonical)])];
    if (!before && u.companies.length) gained++;
  });
  return gained;
}
