/**
 * The AI the setup wizard and the curator use to write a pack and keep it current. It uses
 * whatever is available, best first:
 *   1. Groq (GROQ_API_KEY: free at console.groq.com, no card)
 *   2. Google Gemini (GEMINI_API_KEY: free at aistudio.google.com)
 *   3. Any OpenAI-compatible service (DEPLOYER_AI_URL, DEPLOYER_AI_KEY, DEPLOYER_AI_MODEL)
 *   4. Ollama, a free model on this computer or inside the GitHub job (no key; slower)
 * Force one with DEPLOYER_AI=groq|gemini|custom|ollama. (GitHub Models, the old free option,
 * was retired on 2026-07-30.)
 *
 * Every answer is JSON checked against a zod schema; a reply that doesn't fit is sent back
 * with the problems until it does. Ollama is asked through its own API with the schema as
 * the output format, so even a small model can only answer in the right shape.
 */
import { z } from "zod/v4";
import { chat, PROVIDERS, type Provider } from "./llm.ts";

export type Tier = "smart" | "fast";
const env = (k: string) => process.env[k] || undefined;

const GROQ: Record<Tier, string[]> = {
  smart: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  fast: ["openai/gpt-oss-20b", "llama-3.1-8b-instant", "openai/gpt-oss-120b"],
};
const GEMINI: Record<Tier, string[]> = { smart: ["gemini-2.5-flash"], fast: ["gemini-2.5-flash-lite", "gemini-2.5-flash"] };

/** The providers to try for a tier, best first. */
export function providers(tier: Tier): Provider[] {
  const forced = env("DEPLOYER_AI");
  const want = (id: string) => !forced || forced === id;
  const out: Provider[] = [];
  if (want("groq") && env("GROQ_API_KEY")) out.push(...GROQ[tier].map((m) => PROVIDERS.groq(env("GROQ_MODEL") ?? m)));
  if (want("gemini") && env("GEMINI_API_KEY"))
    out.push(...GEMINI[tier].map((m) => ({ id: "groq" as const, label: `${m} on Google Gemini (free tier)`, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: env("GEMINI_API_KEY"), model: env("GEMINI_MODEL") ?? m })));
  if (want("custom") && env("DEPLOYER_AI_URL"))
    out.push({ id: "groq", label: `${env("DEPLOYER_AI_MODEL")} at ${env("DEPLOYER_AI_URL")}`, baseUrl: env("DEPLOYER_AI_URL")!, apiKey: env("DEPLOYER_AI_KEY"), model: env("DEPLOYER_AI_MODEL") ?? "" });
  if (want("ollama")) out.push(PROVIDERS.ollama(env("OLLAMA_MODEL") ?? "qwen3.5:9b"));
  return out;
}

const ollamaBase = (p: Provider) => p.baseUrl.replace(/\/v1$/, "");

/** Whether any AI answers right now. Returns its label. */
export async function aiAvailable(): Promise<string | null> {
  for (const p of providers("fast")) {
    try {
      if (p.id === "ollama") {
        const res = await fetch(`${ollamaBase(p)}/api/tags`, { signal: AbortSignal.timeout(5000) });
        const { models } = (await res.json()) as { models: { name: string }[] };
        if (models.some((m) => m.name === p.model || m.name === `${p.model}:latest`)) return p.label;
        continue;
      }
      await chat(p, { messages: [{ role: "user", content: "Reply with the JSON {\"ok\":true}" }], json: true, temperature: 0 }, { signal: AbortSignal.timeout(20000) });
      return p.label;
    } catch {}
  }
  return null;
}

/** One JSON request. Ollama gets the schema as its output format (constrained decoding). */
async function complete(p: Provider, messages: { role: "system" | "user" | "assistant"; content: string }[], schema: unknown, temperature: number): Promise<string> {
  if (p.id !== "ollama") return (await chat(p, { messages: messages as never, json: true, temperature }, { signal: AbortSignal.timeout(180000) })).content;
  // Some models can't take a schema as the format; plain JSON mode still works, and the
  // reply is validated (and sent back to fix) the same way.
  for (const format of [schema, "json", undefined]) {
    const res = await fetch(`${ollamaBase(p)}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: p.model, messages, format, stream: false, think: false, options: { temperature, num_ctx: 16384 } }),
      signal: AbortSignal.timeout(1800000),
    });
    if (res.status === 501 && format !== undefined) continue;
    if (!res.ok) throw new Error(`${p.label}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { message: { content: string } }).message.content;
  }
  throw new Error(`${p.label}: no answer`);
}

export class AiUnavailable extends Error {}

/**
 * Asks for JSON matching `schema`. Tries each provider in turn (a missing model or a used-up
 * daily limit moves on to the next) and retries a provider whose reply doesn't validate.
 */
export async function askJson<S extends z.ZodType>(
  schema: S,
  task: { system: string; user: string; tier?: Tier; retries?: number; temperature?: number },
): Promise<z.infer<S>> {
  const list = providers(task.tier ?? "fast");
  if (!list.length) throw new AiUnavailable("No AI is available: set GROQ_API_KEY (free at console.groq.com) or run Ollama.");
  const jsonSchema = z.toJSONSchema(schema);
  const system = `${task.system}\n\nReply with one JSON object only, matching this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
  const errors: string[] = [];
  for (const p of list) {
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [{ role: "system", content: system }, { role: "user", content: task.user }];
    for (let attempt = 0; attempt <= (task.retries ?? 2); attempt++) {
      let content: string;
      try {
        content = await complete(p, messages, jsonSchema, task.temperature ?? 0.3);
      } catch (err) {
        errors.push(`${p.label}: ${(err as Error).message}`);
        break; // this provider is down, unknown or out of quota: try the next one
      }
      let parsed: unknown;
      try {
        // The outermost {...}, so a reply wrapped in prose or a code fence still parses.
        parsed = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
      } catch {
        messages.push({ role: "assistant", content }, { role: "user", content: "That was not valid JSON. Reply with the JSON object only." });
        continue;
      }
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
      const problems = result.error.issues.slice(0, 12).map((i) => `- ${i.path.join(".") || "(top)"}: ${i.message}`).join("\n");
      messages.push({ role: "assistant", content }, { role: "user", content: `Fix these problems and reply with the whole corrected JSON object:\n${problems}` });
      errors.push(`${p.label}: reply didn't fit the schema`);
    }
  }
  throw new Error(`The AI couldn't produce a valid answer.\n${errors.slice(-6).join("\n")}`);
}
