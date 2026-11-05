import { z } from "zod/v4";
import { askJson } from "./ai.ts";

/**
 * The subject's core terms (topic.yaml `scope`), asked as one focused question: small models
 * get this wrong when it is one field among many. A story must contain one of these terms to be
 * kept, so they have to be both specific to the subject and broad enough to miss nothing in it.
 */
export async function draftScope(domain: string, themes: string[], hint = ""): Promise<string[]> {
  const out = await askJson(
    z.object({ terms: z.array(z.string().min(2)).min(10).max(40) }),
    {
      system:
        "You list the words and names that mark a news story as being about one subject. Every story truly about the subject contains at least one of them; stories from other fields almost never do. Include the subject's defining words and their variants, its main organizations, leagues, bodies, markets or programs. Exclude generic words (market, growth, community, development, deal, company, news).",
      user: `Subject: ${domain}\nIts themes: ${themes.join("; ")}${hint ? `\nAlso: ${hint}` : ""}`,
    },
  );
  const terms = [...new Set(out.terms.map((t) => t.trim()).filter((t) => t.length > 1))];
  // A second, narrower look: drop terms that also show up in news about other subjects.
  const check = await askJson(z.object({ generic: z.array(z.string()) }), {
    system: "You check a list of terms meant to identify news about one subject. Return the terms that would ALSO commonly appear in headlines about other subjects (other sports, other industries, general business or finance), copied exactly.",
    user: `Subject: ${domain}
Terms:
${terms.map((t) => `- ${t}`).join("\n")}`,
  }).catch(() => ({ generic: [] as string[] }));
  const generic = new Set(check.generic.map((t) => t.toLowerCase()));
  const kept = terms.filter((t) => !generic.has(t.toLowerCase()));
  return kept.length >= 5 ? kept : terms;
}
