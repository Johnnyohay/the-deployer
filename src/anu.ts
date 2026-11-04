import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { LlmError, PROVIDERS, type ChatMsg, type Provider } from "./llm.ts";
import { runToolLoop, type LoopTool } from "./loop.ts";
import { z } from "zod/v4";
import type { Desk } from "./store.ts";
import { KINDS, related, semanticSearch, updateSimilarities, type SemanticIndex } from "./semantic.ts";
import { toolSpecs, sectorEnum, type Evidence } from "./tools.ts";
import { systemPrompt } from "./prompts.ts";

const json = (v: unknown) => JSON.stringify(v);

// The Ask agent: a language model with read-only tools over the data. Used by the command
// line (src/agent.ts) and the web app's server (src/server.ts).
//
// Engines (all run the same tools), picked by which key is present:
// - "groq": an open-source model hosted online by Groq on its free tier (GROQ_API_KEY,
//   no credit card). This is what the online Hugging Face Space uses.
// - "ollama": a free model on this computer via Ollama, for offline use (no key).
// - "claude": the paid Claude API, only when ANTHROPIC_API_KEY is set.
// Force one with ANU_ENGINE=groq|ollama|claude.

export type Engine = "groq" | "ollama" | "claude";
const forced = process.env.ANU_ENGINE;
export const ENGINE: Engine =
  forced === "groq" || forced === "ollama" || forced === "claude"
    ? forced
    : process.env.ANTHROPIC_API_KEY
      ? "claude"
      : process.env.GROQ_API_KEY
        ? "groq"
        : "ollama";

const CLAUDE_MODEL = "claude-opus-5-5";
const MAX_STEPS = 10;
const provider: Provider | null = ENGINE === "groq" ? PROVIDERS.groq() : ENGINE === "ollama" ? PROVIDERS.ollama() : null;
// Free tiers cap tokens per minute, so lookup results sent back to the model are kept short.
const TOOL_RESULT_CHARS = ENGINE === "groq" ? 5000 : 12000;

/** What the app shows about the engine, and whether web search is available with it. */
export const engineInfo = () =>
  ENGINE === "claude"
    ? { engine: ENGINE, model: CLAUDE_MODEL, label: "Claude API (paid)", web: true }
    : { engine: ENGINE, model: provider!.model, label: provider!.label, web: false };

export type Effort = "low" | "medium" | "high";

export type { Evidence };

export interface RunHandlers {
  onText?: (text: string) => void;
  onTool?: (name: string, input: unknown) => void;
  /** The raw result of each lookup, kept so the answer can be fact-checked against it. */
  onToolResult?: (name: string, output: string) => void;
  onEvidence?: (items: Evidence[]) => void;
  /** Progress notes, e.g. waiting for the free tier's per-minute limit. */
  onStatus?: (note: string) => void;
}

export interface RunOptions {
  web?: boolean;
  /** Lets the agent search Hugging Face Papers (free) for technical research. */
  papers?: boolean;
  effort?: Effort;
  /** Semantic index from src/semantic.ts; without it, search is keyword-only. */
  index?: SemanticIndex;
}

/** A conversation turn in the active engine's format; the server stores and replays it as-is. */
export type ChatMessage = Anthropic.Beta.BetaMessageParam | ChatMsg;

export interface RunResult {
  history: ChatMessage[];
  stopReason: string | null;
  refusalCategory?: string | null;
}

function makeTools(desk: Desk, opts: RunOptions, on: RunHandlers) {
  const onEvidence = (items: Evidence[]) => on.onEvidence?.(items);
  const index = opts.index;
  const report = (updates: { id: string; date: string; title: string; source: string | null }[]) =>
    onEvidence(updates.map(({ id, date, title, source }) => ({ id, date, title, source })));
  const tools = toolSpecs(desk, { papers: opts.papers, similarities: index ? (q) => updateSimilarities(index, q) : undefined }, onEvidence).map((t) => betaZodTool(t));

  const semanticTools = index
    ? [
        betaZodTool({
          name: "semantic_search",
          description: "Find anything in the knowledge base by meaning, across updates, companies, research, build ideas and sectors. Best for concepts and questions phrased in your own words. Each result has a similarity from 0 to 1; below about 0.6 is weak.",
          inputSchema: z.object({
            query: z.string(),
            kinds: z.array(z.enum(KINDS)).optional().describe("Limit to these kinds of item"),
            sector: sectorEnum(desk).optional(),
            since: z.string().optional().describe("YYYY-MM-DD; applies to updates"),
            limit: z.number().int().optional().describe("Default 12, max 40"),
          }),
          run: async (input) => {
            const results = await semanticSearch(desk, index, input);
            report(results.filter((r) => r.kind === "update").map((r) => r.item as Evidence));
            return json(results);
          },
        }),
        betaZodTool({
          name: "related_updates",
          description: "The updates most similar in meaning to one item (an update, company, research, idea or sector id): other coverage of the same story, or the news most relevant to that company or idea.",
          inputSchema: z.object({ id: z.string(), limit: z.number().int().optional() }),
          run: async ({ id, limit }) => {
            const result = related(desk, index, id, limit);
            if (Array.isArray(result)) report(result.map((r) => r.update as Evidence));
            return json(result);
          },
        }),
      ]
    : [];

  // Record every lookup's output for the fact-checker (src/verify.ts).
  return [...tools, ...semanticTools].map((t) => {
    const run = t.run as (input: unknown) => Promise<string>;
    return { ...t, eager_input_streaming: true, run: async (input: unknown) => {
      const out = await run(input);
      on.onToolResult?.(t.name, out);
      return out;
    } };
  });
}


/** Runs one user turn to completion and returns the full history (tool turns included) for follow-ups. */
export function runAnu(desk: Desk, messages: ChatMessage[], opts: RunOptions = {}, on: RunHandlers = {}, signal?: AbortSignal): Promise<RunResult> {
  return ENGINE === "claude"
    ? runClaude(desk, messages as Anthropic.Beta.BetaMessageParam[], opts, on, signal)
    : runOpenAiCompatible(desk, messages as ChatMsg[], { ...opts, web: false }, on, signal);
}

async function runOpenAiCompatible(desk: Desk, messages: ChatMsg[], opts: RunOptions, on: RunHandlers, signal?: AbortSignal): Promise<RunResult> {
  // The same runnable tools the Claude engine uses, viewed through what the loop needs.
  const tools = (makeTools(desk, opts, on) as unknown as { name: string; description: string; input_schema: unknown; parse: (x: unknown) => unknown; run: (x: unknown) => Promise<unknown> }[]).map(
    (t): LoopTool => ({ name: t.name, description: t.description, parameters: t.input_schema, parse: t.parse, run: async (x) => String(await t.run(x)) }),
  );
  return runToolLoop(
    { provider: provider!, system: systemPrompt(desk, { ...opts, semantic: !!opts.index }), messages, tools, effort: opts.effort, maxSteps: MAX_STEPS, resultChars: TOOL_RESULT_CHARS },
    on,
    signal,
  );
}

async function runClaude(desk: Desk, messages: Anthropic.Beta.BetaMessageParam[], opts: RunOptions, on: RunHandlers, signal?: AbortSignal): Promise<RunResult> {
  const client = new Anthropic();
  const web = !!opts.web;
  const tools = makeTools(desk, opts, on);
  const runner = client.beta.messages.toolRunner(
    {
      model: CLAUDE_MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: opts.effort ?? "high" },
      cache_control: { type: "ephemeral" },
      system: systemPrompt(desk, { ...opts, semantic: !!opts.index }),
      tools: web ? [...tools, { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 8 }] : tools,
      messages,
      max_iterations: 20,
      stream: true,
    },
    { signal },
  );

  let last: Anthropic.Beta.BetaMessage | undefined;
  for await (const stream of runner) {
    stream.on("text", (t) => on.onText?.(t));
    last = await stream.finalMessage();
    for (const b of last.content) {
      if (b.type === "tool_use" || b.type === "server_tool_use") on.onTool?.(b.name, b.input);
    }
    if (last.stop_reason === "pause_turn") runner.pushMessages({ role: "assistant", content: last.content });
  }

  const history = [...runner.params.messages];
  if (last && history[history.length - 1]?.role !== "assistant") history.push({ role: "assistant", content: last.content });
  return {
    history,
    stopReason: last?.stop_reason ?? null,
    refusalCategory: last?.stop_reason === "refusal" ? (last.stop_details?.category ?? null) : undefined,
  };
}

export function describeApiError(err: unknown): string | null {
  if (err instanceof Error && err.name === "AbortError") return null;
  if (err instanceof LlmError) {
    if (err.status === 401) return `The ${ENGINE === "groq" ? "Groq" : "model"} key was rejected. Check GROQ_API_KEY.`;
    if (err.status === 429) return "The free tier's limit is used up for now. Wait a minute (or until tomorrow for the daily limit) and ask again.";
    return err.message;
  }
  if (ENGINE === "ollama" && err instanceof Error && /fetch failed|ECONNREFUSED/i.test(err.message + String((err as { cause?: unknown }).cause)))
    return "Can't reach the local model. Start Ollama (`brew services start ollama`), or set GROQ_API_KEY to answer online.";
  if (err instanceof Anthropic.AuthenticationError) return "No valid Claude API credentials. Set ANTHROPIC_API_KEY or run `ant auth login`.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API. Wait a minute and ask again.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  // Thrown by the client before any request when no credentials are configured at all.
  if (err instanceof Error && /authentication method/i.test(err.message)) return "No Claude API key found. Set ANTHROPIC_API_KEY (or run `ant auth login`) and restart ANU.";
  return null;
}
