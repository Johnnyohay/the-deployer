import { chat, LlmError, PROVIDERS, type Provider } from "./llm.ts";

const env = (name: string) => (typeof process !== "undefined" ? process.env?.[name] : undefined);

// Second-opinion fact check: an independent model reads ANU's answer and the exact
// lookup results ANU saw, and rates each factual claim. Checker, in order of preference:
// xAI Grok when XAI_API_KEY is set (paid); otherwise a different model on Groq's free
// tier than the one that wrote the answer; otherwise the local Ollama model.

export type Verdict = "supported" | "not_in_evidence" | "contradicted";

export interface Check {
  checker: string;
  confidence: number;
  summary: string;
  claims: { claim: string; verdict: Verdict; note: string }[];
}

// Evidence sent to the checker is capped to fit free-tier per-minute token limits.
const EVIDENCE_CHARS = 14000;

export function checkerProvider(): Provider | null {
  if (env("XAI_API_KEY")) return PROVIDERS.xai();
  if (env("GROQ_API_KEY")) return PROVIDERS.groq(env("VERIFY_MODEL") ?? "qwen/qwen3.8-27b");
  if (env("ANU_ENGINE") !== "claude") return PROVIDERS.ollama(env("VERIFY_MODEL"));
  return null;
}

export async function verifyAnswer(
  input: { question: string; answer: string; evidence: { tool: string; output: string }[]; domain?: string },
  opts: { signal?: AbortSignal; onWait?: (s: number) => void; provider?: Provider } = {},
): Promise<Check> {
  const p = opts.provider ?? checkerProvider();
  if (!p) throw new Error("No checker model is configured. Set GROQ_API_KEY (free) or XAI_API_KEY.");

  let evidence = input.evidence.map((e, i) => `[${i + 1}] ${e.tool}:\n${e.output}`).join("\n\n");
  if (evidence.length > EVIDENCE_CHARS) evidence = evidence.slice(0, EVIDENCE_CHARS) + "\n…(evidence truncated)";

  const ask = (json: boolean) =>
    chat(
    p,
    {
      json,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are a strict fact-checker for a research assistant${input.domain ? ` on ${input.domain}` : ""}. You get a QUESTION, the assistant's ANSWER, and the EVIDENCE (raw lookup results) the assistant had. Check the answer only against the evidence.

List the answer's specific factual claims (names, numbers, dates, contracts, who did what), at most 12, most important first. For each give:
- "verdict": "supported" (the evidence states it), "not_in_evidence" (the evidence doesn't say; may still be true), or "contradicted" (the evidence says otherwise)
- "note": one short sentence; for supported claims quote or paraphrase the evidence, for the others say what the evidence shows instead.
Opinions and recommendations are not claims; skip them.

Then give "confidence" (0-100, how far the answer can be trusted as grounded in the evidence) and a one-sentence "summary".

Reply with JSON only: {"confidence": number, "summary": string, "claims": [{"claim": string, "verdict": string, "note": string}]}`,
        },
        { role: "user", content: `QUESTION:\n${input.question}\n\nANSWER:\n${input.answer}\n\nEVIDENCE:\n${evidence || "(no lookups were made)"}` },
      ],
    },
    opts,
  );
  // Some models (e.g. local ones) don't support JSON mode; the prompt already asks for JSON only.
  const reply = await ask(true).catch((err) => {
    if (err instanceof LlmError && (err.status === 400 || err.status === 501)) return ask(false);
    throw err;
  });

  const raw = JSON.parse(/\{[\s\S]*\}/.exec(reply.content)?.[0] ?? "{}") as Partial<Check>;
  const verdicts: Verdict[] = ["supported", "not_in_evidence", "contradicted"];
  return {
    checker: p.label,
    confidence: Math.max(0, Math.min(100, Math.round(Number(raw.confidence) || 0))),
    summary: String(raw.summary ?? ""),
    claims: (Array.isArray(raw.claims) ? raw.claims : []).slice(0, 12).map((c) => ({
      claim: String(c?.claim ?? ""),
      verdict: verdicts.includes(c?.verdict as Verdict) ? (c.verdict as Verdict) : "not_in_evidence",
      note: String(c?.note ?? ""),
    })),
  };
}

// Prompts pasted into a chat app are kept shorter than API requests.
const PASTE_EVIDENCE_CHARS = 8000;

/**
 * A ready-to-paste prompt for checking an answer in the free Grok app (grok.com or X),
 * which has no free API. Grok checks each claim against the evidence ANU used and
 * against its own live web and X search, so it can catch what the stored data missed.
 */
export function grokPrompt(input: { question: string; answer: string; evidence: { tool: string; output: string }[]; domain?: string }): string {
  let evidence = input.evidence.map((e, i) => `[${i + 1}] ${e.tool}:\n${e.output}`).join("\n\n");
  if (evidence.length > PASTE_EVIDENCE_CHARS) evidence = evidence.slice(0, PASTE_EVIDENCE_CHARS) + "\n…(evidence truncated)";
  return `Please fact-check this answer from my research assistant${input.domain ? ` on ${input.domain}` : ""}.

For each specific factual claim (names, numbers, dates, contracts, who did what):
1. Say whether the EVIDENCE below supports it.
2. Check it independently with your own web and X search, and link what you find.
Then give a verdict per claim (confirmed / unconfirmed / wrong), an overall trust score from 0 to 100, and anything important the answer missed or got out of date.

QUESTION:
${input.question}

ANSWER:
${input.answer}

EVIDENCE THE ASSISTANT USED:
${evidence || "(no lookups were made)"}`;
}
