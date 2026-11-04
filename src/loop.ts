import { chat, type ChatMsg, type Provider, type ToolDef } from "./llm.ts";

// The question-and-lookup loop for OpenAI-compatible models (Groq, Pollinations, Ollama):
// ask the model, run the tools it calls, feed back the results, repeat until it answers.
// No server dependencies, so the in-browser app runs exactly this.

export interface LoopTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: unknown;
  /** Validates arguments (throws when invalid). */
  parse: (input: unknown) => unknown;
  run: (input: unknown) => Promise<string>;
}

export interface LoopHandlers {
  onText?: (text: string) => void;
  onTool?: (name: string, input: unknown) => void;
  onStatus?: (note: string) => void;
}

const json = (v: unknown) => JSON.stringify(v);

/**
 * Small open models often send arrays and numbers as strings ('["update"]', "15").
 * Validate as sent first; if that fails, decode such strings and validate again.
 */
function parseLenient(parse: (x: unknown) => unknown, args: Record<string, unknown>): unknown {
  try {
    return parse(args);
  } catch (err) {
    const decoded = Object.fromEntries(
      Object.entries(args).map(([k, v]) => {
        if (typeof v !== "string") return [k, v];
        if (/^\s*[[{]/.test(v)) {
          try {
            return [k, JSON.parse(v)];
          } catch {}
        }
        if (/^-?\d+(\.\d+)?$/.test(v.trim())) return [k, Number(v)];
        if (v === "") return [k, undefined];
        return [k, v];
      }),
    );
    try {
      return parse(decoded);
    } catch {
      throw err;
    }
  }
}

export async function runToolLoop(
  cfg: { provider: Provider; system: string; messages: ChatMsg[]; tools: LoopTool[]; effort?: "low" | "medium" | "high"; maxSteps?: number; resultChars?: number },
  on: LoopHandlers = {},
  signal?: AbortSignal,
): Promise<{ history: ChatMsg[]; stopReason: string }> {
  const byName = new Map(cfg.tools.map((t) => [t.name, t]));
  const defs: ToolDef[] = cfg.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const system: ChatMsg = { role: "system", content: cfg.system };
  const history = [...cfg.messages];
  const limit = cfg.resultChars ?? 5000;
  const onWait = (s: number) => on.onStatus?.(`Free tier is busy; continuing in ${s}s…`);

  for (let step = 0; step < (cfg.maxSteps ?? 10); step++) {
    const reply = await chat(cfg.provider, { messages: [system, ...history], tools: defs, reasoningEffort: cfg.effort ?? "medium" }, { signal, onWait });
    const calls = reply.toolCalls;
    history.push({ role: "assistant", content: reply.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (reply.content) on.onText?.(reply.content + (calls.length ? "\n\n" : ""));
    if (!calls.length) return { history, stopReason: reply.finishReason === "length" ? "max_tokens" : "end_turn" };

    for (const call of calls) {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {}
      on.onTool?.(name, args);
      const tool = byName.get(name);
      let result: string;
      try {
        result = tool ? await tool.run(parseLenient(tool.parse, args)) : json({ error: `Unknown tool "${name}". Available: ${[...byName.keys()].join(", ")}` });
      } catch (err) {
        result = json({ error: `Invalid call to ${name}: ${err instanceof Error ? err.message : String(err)}` });
      }
      if (result.length > limit) result = result.slice(0, limit) + "…(truncated; narrow the search for more)";
      history.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  return { history, stopReason: "max_steps" };
}
