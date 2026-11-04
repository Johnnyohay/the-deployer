import { pipeline, env, type FeatureExtractionPipeline, type TokenClassificationPipeline } from "@huggingface/transformers";

// Hugging Face models that run locally through transformers.js (ONNX, CPU): free, no API
// key. Weights download once into .hf-cache/ (about 150 MB) and are reused after that.

env.cacheDir = ".hf-cache";

export const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const NER_MODEL = "Xenova/bert-base-NER";

// bge models expect this prefix on search queries (not on the documents being searched).
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let embedder: Promise<FeatureExtractionPipeline> | null = null;
let tagger: Promise<TokenClassificationPipeline> | null = null;

async function getEmbedder() {
  embedder ??= pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" });
  return embedder;
}

async function getTagger() {
  tagger ??= pipeline("token-classification", NER_MODEL, { dtype: "q8" });
  return tagger;
}

/** Unit-length 384-dimension vectors, so a dot product is the cosine similarity. */
export async function embed(texts: string[], kind: "query" | "document" = "document"): Promise<number[][]> {
  const model = await getEmbedder();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32).map((t) => (kind === "query" ? QUERY_PREFIX + t : t));
    const tensor = await model(batch, { pooling: "cls", normalize: true });
    out.push(...(tensor.tolist() as number[][]));
  }
  return out;
}

export const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

// Organizations the tagger finds that are governments, militaries or publishers, not companies.
const NOT_A_COMPANY =
  /\b(Army|Navy|Air Force|Space Force|Marines?|Marine Corps|Coast Guard|Guard|Pentagon|Department|Ministry|DoD|DOD|DoW|DOW|Congress|Senate|House|Parliament|NATO|NASA|ESA|Command|Agency|Office|Administration|Government|Forces|DARPA|DIU|CDAO|SDA|GAO|CBO|CRS|White House|Kremlin|EU|UN|Reuters|Bloomberg|Breaking Defense|Defense News|DefenseScoop|Defense One|SpaceNews|C4ISRNET|USNI|CSIS|War Zone|Associated Press|AP|AUSA|Association|Institute|University|Council|Committee)\b/;

/**
 * The span as it is written in the text ("U . S . Army" → "U.S. Army"), or null when it
 * is only part of a word ("Surve" from "Surveillance") or not found.
 */
function inText(text: string, span: string): string | null {
  const pattern = span
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  return new RegExp(`(?<![\\w])${pattern}(?![\\w])`).exec(text)?.[0] ?? null;
}

/**
 * Organization names mentioned in each text, split into likely companies and other bodies.
 * Uses bert-base-NER; word pieces ("Kong", "##sberg") are joined back into words.
 */
export async function tagOrganizations(texts: string[]): Promise<{ orgs: string[]; companies: string[] }[]> {
  const model = await getTagger();
  const results: { orgs: string[]; companies: string[] }[] = [];
  for (const text of texts) {
    const tokens = (await model(text)) as { entity: string; word: string; score: number }[];
    const spans: string[] = [];
    let current = "";
    for (const t of tokens) {
      const isOrg = t.entity.endsWith("ORG") && t.score > 0.8;
      const continues = isOrg && (t.entity.startsWith("I-") || t.word.startsWith("##")) && current;
      if (!isOrg) {
        if (current) spans.push(current);
        current = "";
      } else if (continues) {
        current += t.word.startsWith("##") ? t.word.slice(2) : ` ${t.word}`;
      } else {
        if (current) spans.push(current);
        current = t.word.replace(/^##/, "");
      }
    }
    if (current) spans.push(current);
    // The model sometimes runs two names together ("General Atomics and Teledyne FLIR").
    const found = spans
      .flatMap((s) => s.split(/\s+and\s+/))
      .map((s) => inText(text, s))
      .filter((s): s is string => !!s && s.length > 2);
    // Keep the longest form of a name ("Teledyne FLIR Defense", not also "Teledyne").
    const orgs = [...new Set(found)].filter((o, _, all) => !all.some((x) => x !== o && x.includes(o)));
    results.push({ orgs, companies: orgs.filter((o) => !NOT_A_COMPANY.test(o)) });
  }
  return results;
}

export { searchPapers, type Paper } from "./papers.ts";
