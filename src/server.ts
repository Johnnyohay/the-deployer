import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadDesk, loadDeskRemote, type Desk } from "./store.ts";
import { getBrief, getSector, overview, searchUpdates, upcomingEvents } from "./kb.ts";
import { focusLine, modes, type Focus } from "./prompts.ts";
import { describeApiError, engineInfo, runAnu, type ChatMessage, type Effort } from "./anu.ts";
import { buildIndex, type SemanticIndex } from "./semantic.ts";
import { searchPapers } from "./hf.ts";
import { checkerProvider, grokPrompt, verifyAnswer } from "./verify.ts";

// Server for the Ask app: serves the React UI from app-dist/, the data endpoints, and
// streams agent answers over server-sent events. Model keys stay on the server.
//
// Online (the Hugging Face Space): ANU_DATA_URL points at the published JSON API, so the
// data is read from the web and refreshed every 30 minutes; nothing is kept on a device.
// Locally without ANU_DATA_URL, it reads data/.

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
// The built app lives with the engine, not the pack (`npm run app` builds it).
const STATIC_DIR = fileURLToPath(new URL("../app-dist", import.meta.url));
const DATA_URL = process.env.ANU_DATA_URL;
const REFRESH_MS = 30 * 60 * 1000;

interface Turn {
  question: string;
  answer: string;
  evidence: { tool: string; output: string }[];
}
const conversations = new Map<string, { history: ChatMessage[]; turns: Turn[] }>();

let desk: Desk;
// Semantic search runs a Hugging Face model in this process; if it can't load, ANU falls back to keywords.
let index: SemanticIndex | undefined;

async function loadData() {
  const next = DATA_URL ? await loadDeskRemote(DATA_URL) : await loadDesk();
  let nextIndex: SemanticIndex | undefined;
  try {
    nextIndex = await buildIndex(next, console.log);
  } catch (err) {
    console.warn(`Semantic search off (${err instanceof Error ? err.message : err}); using keyword search.`);
  }
  desk = next;
  index = nextIndex;
  console.log(`Data loaded from ${DATA_URL ?? "data/"}: ${desk.updates.length} updates${index ? `, semantic index ${index.docs.length} items` : ""}.`);
}
await loadData();
if (DATA_URL) setInterval(() => loadData().catch((err) => console.warn(`Data refresh failed: ${err instanceof Error ? err.message : err}`)), REFRESH_MS).unref();

export const SOURCES = {
  data: { label: "My data only", papers: false, web: false },
  papers: { label: "Data + AI papers", papers: true, web: false },
  all: { label: "Data + papers + web", papers: true, web: true },
} as const;
type SourceId = keyof typeof SOURCES;


interface AskBody {
  conversationId?: string;
  question: string;
  focus?: Focus;
  effort?: Effort;
  sources?: SourceId;
}


function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody<T>(req: http.IncomingMessage): Promise<T> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}") as T;
}

function companyDetail(id: string) {
  const company = desk.companies.find((c) => c.id === id);
  if (!company) return null;
  const name = String(company.name);
  return { ...company, updates: searchUpdates(desk, { company: name, limit: 12 }).updates };
}

async function ask(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readBody<AskBody>(req);
  if (!body.question?.trim()) return sendJson(res, 400, { error: "Empty question" });
  const id = body.conversationId && conversations.has(body.conversationId) ? body.conversationId : randomUUID();
  const convo = conversations.get(id) ?? { history: [], turns: [] };
  const turn: Turn = { question: body.question.trim(), answer: "", evidence: [] };

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("start", { conversationId: id });

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  try {
    const result = await runAnu(
      desk,
      [...convo.history, { role: "user", content: focusLine(desk, body.focus) + body.question.trim() }],
      { ...(SOURCES[body.sources ?? "papers"] ?? SOURCES.papers), effort: body.effort, index },
      {
        onText: (text) => {
          turn.answer += text;
          send("text", { text });
        },
        onTool: (name, input) => send("tool", { name, input }),
        onToolResult: (tool, output) => turn.evidence.push({ tool, output }),
        onStatus: (note) => send("status", { note }),
        onEvidence: (items) => send("evidence", { items }),
      },
      abort.signal,
    );
    conversations.set(id, { history: result.history, turns: [...convo.turns, turn] });
    send("done", { stopReason: result.stopReason, refusalCategory: result.refusalCategory ?? null });
  } catch (err) {
    if (!abort.signal.aborted) send("error", { message: describeApiError(err) ?? (err instanceof Error ? err.message : String(err)) });
  }
  res.end();
}

/** Fact-checks the conversation's latest answer with an independent model. */
async function verify(req: http.IncomingMessage, res: http.ServerResponse) {
  const { conversationId } = await readBody<{ conversationId?: string }>(req);
  const turn = conversationId ? conversations.get(conversationId)?.turns.at(-1) : undefined;
  if (!turn) return sendJson(res, 404, { error: "Nothing to check yet. Ask a question first." });
  try {
    sendJson(res, 200, await verifyAnswer({ ...turn, domain: desk.pack.domain }));
  } catch (err) {
    sendJson(res, 502, { error: describeApiError(err) ?? (err instanceof Error ? err.message : String(err)) });
  }
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

async function serveStatic(pathname: string, res: http.ServerResponse) {
  const rel = path.normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  for (const file of [path.join(STATIC_DIR, rel), path.join(STATIC_DIR, "index.html")]) {
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      return res.end(data);
    } catch {}
  }
  res.writeHead(404).end("Build the app first: npm run app");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/meta") {
      return sendJson(res, 200, {
        overview: overview(desk),
        sectors: [...desk.sectors].sort((a, b) => a.order - b.order),
        companies: desk.companies.map((c) => ({ id: c.id, name: c.name, sectors: c.sectors, type: c.type })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        modes: modes(desk).map(({ id, label, suggest }) => ({ id, label, suggest })),
        pack: { name: desk.pack.name, tagline: desk.pack.tagline, domain: desk.pack.domain, vocab: desk.pack.vocab },
        engine: engineInfo(),
        checker: checkerProvider()?.label ?? null,
        sources: Object.entries(SOURCES).filter(([, s]) => !s.web || engineInfo().web).map(([id, s]) => ({ id, label: s.label })),
        semantic: !!index,
        brief: getBrief(desk),
        upcoming: upcomingEvents(desk, { days: 60 }),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/sector") return sendJson(res, 200, getSector(desk, url.searchParams.get("id") ?? ""));
    if (req.method === "GET" && url.pathname === "/api/company") {
      const c = companyDetail(url.searchParams.get("id") ?? "");
      return c ? sendJson(res, 200, c) : sendJson(res, 404, { error: "Unknown company" });
    }
    if (req.method === "GET" && url.pathname === "/api/papers") {
      try {
        return sendJson(res, 200, await searchPapers(url.searchParams.get("q") ?? "", { limit: Number(url.searchParams.get("limit") ?? 5) }));
      } catch (err) {
        return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/ask") return await ask(req, res);
    if (req.method === "POST" && url.pathname === "/api/verify") return await verify(req, res);
    if (req.method === "POST" && url.pathname === "/api/grok-prompt") {
      const { conversationId } = await readBody<{ conversationId?: string }>(req);
      const turn = conversationId ? conversations.get(conversationId)?.turns.at(-1) : undefined;
      return turn ? sendJson(res, 200, { prompt: grokPrompt({ ...turn, domain: desk.pack.domain }) }) : sendJson(res, 404, { error: "Nothing to check yet. Ask a question first." });
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      const { conversationId } = await readBody<{ conversationId?: string }>(req);
      if (conversationId) conversations.delete(conversationId);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET") return await serveStatic(url.pathname, res);
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => console.log(`${desk.pack.name} is running at http://localhost:${PORT} (${engineInfo().label})`));
