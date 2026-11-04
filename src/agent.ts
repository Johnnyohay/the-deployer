import readline from "node:readline/promises";
import { loadDesk } from "./store.ts";
import { describeApiError, engineInfo, runAnu, type ChatMessage, type RunHandlers } from "./anu.ts";
import { buildIndex } from "./semantic.ts";

// ANU on the command line. For the app with dropdowns and panels, use `npm run app`.
//   npm run ask -- "What should I learn first about counter-drone?"
//   npm run ask                      (conversation; type "exit" to quit)
//   npm run ask -- --web "…"         (also lets ANU search the web for news newer than the data)
//   npm run ask -- --no-papers "…"   (turns off Hugging Face Papers research search)
// Free by default: a local model through Ollama. Uses the paid Claude API only when ANTHROPIC_API_KEY is set.

const desk = await loadDesk();
const args = process.argv.slice(2);
const web = args.includes("--web") && engineInfo().web;
const papers = !args.includes("--no-papers");
const question = args.filter((a) => !a.startsWith("--")).join(" ").trim();
const index = await buildIndex(desk, (m) => console.error(m)).catch((err) => {
  console.error(`Semantic search off (${err instanceof Error ? err.message : err}); using keyword search.`);
  return undefined;
});

console.error(`Answering with ${engineInfo().label}.`);

const handlers: RunHandlers = {
  onText: (t) => process.stdout.write(t),
  onTool: (name, input) => process.stderr.write(`\n  · ${name} ${JSON.stringify(input)}\n`),
};

async function turn(messages: ChatMessage[]) {
  const res = await runAnu(desk, messages, { web, papers, index }, handlers);
  process.stdout.write("\n");
  if (res.stopReason === "refusal") console.error(`\n[Declined: ${res.refusalCategory ?? "no category"}]`);
  else if (res.stopReason === "max_tokens") console.error("\n[Answer was cut off at the length limit.]");
  return res.history;
}

try {
  if (question) {
    await turn([{ role: "user", content: question }]);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`ANU here. ${desk.updates.length} updates, ${desk.companies.length} companies, ${desk.sectors.length} sectors loaded${web ? ", web search on" : ""}. Ask anything; "exit" to quit.`);
    let history: ChatMessage[] = [];
    for (;;) {
      const q = (await rl.question("\nyou › ")).trim();
      if (!q) continue;
      if (/^(exit|quit)$/i.test(q)) break;
      process.stdout.write("\nanu › ");
      history = await turn([...history, { role: "user", content: q }]);
    }
    rl.close();
  }
} catch (err) {
  const msg = describeApiError(err);
  if (!msg) throw err;
  console.error(msg);
  process.exit(1);
}
