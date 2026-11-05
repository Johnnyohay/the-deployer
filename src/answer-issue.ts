import { writeFile } from "node:fs/promises";
import { z } from "zod/v4";
import { loadDesk, type Desk } from "./store.ts";
import { toolSpecs } from "./tools.ts";
import { focusLine, modes, systemPrompt, type Focus } from "./prompts.ts";
import { runToolLoop, type LoopTool } from "./loop.ts";
import type { ChatMsg } from "./llm.ts";
import { providers } from "./ai.ts";
import { grokPrompt, verifyAnswer } from "./verify.ts";

// Answers a question asked as a GitHub issue ("Ask <name>: …"), run by .github/workflows/ask.yml.
// Everything happens on GitHub for free: the data is this repo's data/, the model is
// whatever ai.ts finds (Groq with a GROQ_API_KEY secret, else Ollama in the job), and the
// answer is posted back as a comment. Follow-up comments on the issue continue the conversation.
//
// Env: ISSUE_TITLE, ISSUE_BODY, THREAD (JSON [{author, body}] of earlier comments), GITHUB_TOKEN.

const BOT_MARK = "<!-- ask-answer -->";

/** Focus settings the site's Ask form writes into the issue body as "Key: value" lines. */
function parseFocus(desk: Desk, body: string): Focus {
  const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "mi").exec(body)?.[1]?.trim();
  const modeLabel = get("Mode");
  const mode = modes(desk).find((m) => m.id === modeLabel || m.label === modeLabel)?.id;
  const days = Number(get("Days"));
  return { mode, sector: get("Sector id"), company: get("Company id"), days: Number.isFinite(days) && days > 0 ? days : undefined };
}

const desk = await loadDesk();
const { name, domain } = desk.pack;
const title = (process.env.ISSUE_TITLE ?? "").replace(/^\s*Ask\b[^:]*:\s*/i, "").trim();
const body = process.env.ISSUE_BODY ?? "";
const thread = JSON.parse(process.env.THREAD || "[]") as { author: string; body: string }[];
const question = (body.split(/^---$/m)[0].trim() || title).trim();
const focus = parseFocus(desk, body);

// Earlier exchanges on this issue become the conversation history.
const history: ChatMsg[] = [];
let latest = focusLine(desk, focus) + question;
for (const c of thread) {
  if (c.body.includes(BOT_MARK)) {
    history.push({ role: "user", content: latest }, { role: "assistant", content: c.body.split("<details>")[0].replace(BOT_MARK, "").trim() });
  } else latest = c.body.trim();
}
const isFollowUp = thread.length > 0 && !thread.at(-1)!.body.includes(BOT_MARK);
const ask = isFollowUp ? latest : focusLine(desk, focus) + question;

// A second, different model checks the answer when one is available.
const [answerModel] = providers("smart");
const checkModel = providers("fast").find((p) => p.model !== answerModel.model) ?? answerModel;

const evidence: { tool: string; output: string }[] = [];
const sources: string[] = [];
const tools: LoopTool[] = toolSpecs(desk, { papers: true }, (items) =>
  items.forEach((e) => {
    const url = /https?:\/\/\S+/.exec(e.source ?? "")?.[0];
    const line = `- ${e.date} — ${url ? `[${e.title}](${url})` : e.title}${e.source ? ` (${e.source.replace(/\s*https?:\/\/\S+/, "")})` : ""}`;
    if (!sources.includes(line)) sources.push(line);
  }),
).map((t) => ({
  name: t.name,
  description: t.description,
  parameters: z.toJSONSchema(t.inputSchema),
  parse: (x) => t.inputSchema.parse(x),
  run: async (x) => {
    const out = await t.run(x);
    evidence.push({ tool: t.name, output: out });
    return out;
  },
}));

let answer = "";
let out: string;
try {
  const res = await runToolLoop({ provider: answerModel, system: systemPrompt(desk, { papers: true }), messages: [...history, { role: "user", content: ask }], tools, maxSteps: 8, resultChars: 6000 }, { onText: (t) => (answer += t) });
  answer = answer.trim() || "I couldn't put together an answer this time. Try rephrasing the question.";
  if (res.stopReason === "max_steps") answer += "\n\n_(Stopped after the maximum number of lookups.)_";

  let checkMd = "";
  try {
    const check = await verifyAnswer({ question: isFollowUp ? latest : question, answer, evidence, domain }, { provider: checkModel });
    const icon = { supported: "✅", not_in_evidence: "⚠️", contradicted: "❌" } as const;
    checkMd = `**Fact-check: ${check.confidence}/100** by ${check.checker}. ${check.summary}\n\n${check.claims.map((c) => `- ${icon[c.verdict]} ${c.claim}${c.note ? ` — _${c.note}_` : ""}`).join("\n")}`;
  } catch (err) {
    checkMd = `_Fact-check unavailable: ${err instanceof Error ? err.message : String(err)}_`;
  }

  out = `${BOT_MARK}
${answer}

<details><summary>Second-opinion fact-check</summary>

${checkMd}
</details>

<details><summary>Sources ${name} looked at (${sources.length})</summary>

${sources.join("\n") || "_No stored sources were used._"}
</details>

<details><summary>Check with Grok (free): copy this into grok.com</summary>

\`\`\`text
${grokPrompt({ question: isFollowUp ? latest : question, answer, evidence, domain }).replace(/```/g, "'''")}
\`\`\`
</details>

<sub>Answered by ${answerModel.label} from ${name}'s data (updates to ${desk.updates.map((u) => u.d).sort().at(-1)}). Reply on this issue to ask a follow-up.</sub>`;
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  out = `${BOT_MARK}\n${name} couldn't answer right now: ${/429/.test(msg) ? "the free AI's limit is used up for now. Ask again later." : msg}`;
}
await writeFile("answer.md", out);
console.log(out.slice(0, 2000));
