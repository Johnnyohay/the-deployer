import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AskRequest, type Catalyst, type Check, type CompanyDetail, type Evidence, type Meta, type Paper, type SectorDetail } from "./api.ts";
import { Markdown } from "./Markdown.tsx";

type Effort = AskRequest["effort"];

interface Turn {
  question: string;
  focusLabel: string;
  answer: string;
  tools: { name: string; input: Record<string, unknown> }[];
  evidence: Evidence[];
  status: "streaming" | "done" | "error" | "stopped";
  note?: string;
  progress?: string;
  check?: { state: "loading" } | { state: "done"; result: Check } | { state: "error"; message: string };
}

const RANGES = [
  { days: 0, label: "All time" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];
const DEPTHS: { id: Effort; label: string }[] = [
  { id: "low", label: "Quick" },
  { id: "medium", label: "Standard" },
  { id: "high", label: "Deep" },
];
const TOOL_LABELS: Record<string, string> = {
  overview: "Read the overview",
  search_updates: "Searched updates",
  get_sector: "Opened sector",
  find_companies: "Looked up companies",
  upcoming_events: "Checked the calendar",
  search_research: "Searched research",
  list_ideas: "Reviewed build ideas",
  get_brief: "Read a brief",
  semantic_search: "Searched by meaning",
  related_updates: "Found related stories",
  search_papers: "Searched AI research papers",
  web_search: "Searched the web",
};

function toolLabel(name: string, input: Record<string, unknown>) {
  const detail = [input.query, input.id, input.company, input.sector, ...((input.sectors as string[] | undefined) ?? [])].filter(Boolean).join(", ");
  return `${TOOL_LABELS[name] ?? name}${detail ? ` · ${detail}` : ""}`;
}

function suggestions(mode: string, scope: string, companyName: string | undefined, days: number, papers: boolean): string[] {
  const research = papers ? [`What does recent AI and robotics research say about ${scope}?`] : [];
  const when = days ? `the last ${days} days` : "recently";
  switch (mode) {
    case "learn":
      return [`Explain ${scope} to me like I'm new to it`, `What acronyms and programs do I need to know in ${scope}?`, `How does the Pentagon buy in ${scope}, and who decides?`, `What should I read first to understand ${scope}?`, ...research];
    case "news":
      return [`What happened in ${scope} ${when}?`, `Which development in ${scope} matters most for a founder, and why?`, `What's coming up next in ${scope}?`, `Give me the 60-second briefing on ${scope}`];
    case "advise":
      return [`What should I build in ${scope}?`, `Where are the incumbents in ${scope} weakest?`, `If I had $1M and 12 months in ${scope}, what would you do?`, `Who is the buyer and budget line for a startup in ${scope}?`, ...(papers ? [`Which new research in ${scope} is close to being a product?`] : [])];
    case "company":
      return companyName
        ? [`Who is ${companyName} and how do they make money?`, `Who competes with ${companyName}, and who is winning?`, `Where is ${companyName} vulnerable to a startup?`, `What's the latest on ${companyName}?`]
        : ["Pick a company in the Focus panel to get tailored questions.", "Which companies matter most in defense tech right now?"];
    case "compare":
      return [`Compare the top companies in ${scope}`, `Compare primes vs new entrants in ${scope}`, `Compare the build ideas in ${scope}: which is strongest?`, "Compare drones and counter-drone as places to build"];
    default:
      return [];
  }
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState("learn");
  const [sector, setSector] = useState("");
  const [company, setCompany] = useState("");
  const [days, setDays] = useState(0);
  const [effort, setEffort] = useState<Effort>("medium");
  const [sources, setSources] = useState("papers");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sectorDetail, setSectorDetail] = useState<SectorDetail | null>(null);
  const [companyDetail, setCompanyDetail] = useState<CompanyDetail | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // Follow new text only while the reader is at the bottom; scrolling up stops the follow.
  const followRef = useRef(true);

  useEffect(() => {
    api.meta().then(setMeta, (e: Error) => setLoadError(e.message));
  }, []);
  useEffect(() => {
    setSectorDetail(null);
    if (sector) api.sector(sector).then(setSectorDetail, () => {});
  }, [sector]);
  useEffect(() => {
    setCompanyDetail(null);
    if (company) api.company(company).then(setCompanyDetail, () => {});
  }, [company]);
  useEffect(() => {
    if (followRef.current) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns]);

  const companies = useMemo(() => (meta?.companies ?? []).filter((c) => !sector || c.sectors.includes(sector)), [meta, sector]);
  const sectorName = meta?.sectors.find((s) => s.id === sector)?.name;
  const companyName = meta?.companies.find((c) => c.id === company)?.name;
  const scope = companyName ?? sectorName ?? "defense tech";
  const busy = turns.at(-1)?.status === "streaming";
  const focusLabel = [meta?.modes.find((m) => m.id === mode)?.label, sectorName, companyName, RANGES.find((r) => r.days === days)?.label].filter(Boolean).join(" · ");

  const patchLast = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? fn(t) : t)));

  async function ask(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setQuestion("");
    followRef.current = true;
    setTurns((ts) => [...ts, { question: text, focusLabel, answer: "", tools: [], evidence: [], status: "streaming" }]);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const req: AskRequest = { conversationId, question: text, focus: { mode, sector: sector || undefined, company: company || undefined, days: days || undefined }, effort, sources };
      for await (const ev of api.ask(req, ctl.signal)) {
        if (ev.event === "start") setConversationId(ev.data.conversationId);
        else if (ev.event === "text") patchLast((t) => ({ ...t, answer: t.answer + ev.data.text, progress: undefined }));
        else if (ev.event === "status") patchLast((t) => ({ ...t, progress: ev.data.note }));
        else if (ev.event === "tool") patchLast((t) => ({ ...t, tools: [...t.tools, ev.data] }));
        else if (ev.event === "evidence")
          patchLast((t) => {
            const seen = new Set(t.evidence.map((e) => e.id));
            return { ...t, evidence: [...t.evidence, ...ev.data.items.filter((e) => !seen.has(e.id))] };
          });
        else if (ev.event === "done") {
          const note = ev.data.stopReason === "refusal" ? "ANU declined this question." : ev.data.stopReason === "max_tokens" ? "The answer hit the length limit." : undefined;
          patchLast((t) => ({ ...t, status: "done", note }));
        } else if (ev.event === "error") patchLast((t) => ({ ...t, status: "error", note: ev.data.message }));
      }
      patchLast((t) => (t.status === "streaming" ? { ...t, status: "done" } : t));
    } catch (e) {
      patchLast((t) => (ctl.signal.aborted ? { ...t, status: "stopped", note: "Stopped." } : { ...t, status: "error", note: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function verifyLast() {
    if (!conversationId) return;
    patchLast((t) => ({ ...t, check: { state: "loading" } }));
    try {
      const result = await api.verify(conversationId);
      patchLast((t) => ({ ...t, check: { state: "done", result } }));
    } catch (e) {
      patchLast((t) => ({ ...t, check: { state: "error", message: e instanceof Error ? e.message : String(e) } }));
    }
  }

  function newConversation() {
    abortRef.current?.abort();
    if (conversationId) void api.reset(conversationId);
    setConversationId(null);
    setTurns([]);
  }

  if (loadError) return <div className="fatal">Couldn't reach the ANU server ({loadError}). Start it with <code>npm run app</code>.</div>;
  if (!meta) return <div className="fatal">Loading ANU…</div>;

  return (
    <div className="shell">
      <header className="top">
        <div>
          <div className="eyebrow">Your personal guide to learning and following defense tech</div>
          <h1>AN<span>U</span></h1>
        </div>
        <div className="stamp">
          {meta.overview.counts.updates} updates · {meta.overview.counts.companies} companies · data to {meta.overview.updatesCover?.to}
        </div>
      </header>

      <div className="grid">
        <aside className="panel focus" aria-label="Focus">
          <h2>Focus</h2>
          <label>
            What do you want?
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              {meta.modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label>
            Sector
            <select value={sector} onChange={(e) => { setSector(e.target.value); setCompany(""); }}>
              <option value="">All of defense tech</option>
              {meta.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>
            Company
            <select value={company} onChange={(e) => setCompany(e.target.value)}>
              <option value="">Any company</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>
            Time range
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
            </select>
          </label>
          <label>
            Answer depth
            <select value={effort} onChange={(e) => setEffort(e.target.value as Effort)}>
              {DEPTHS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </label>
          <label>
            Research sources
            <select value={sources} onChange={(e) => setSources(e.target.value)}>
              {meta.sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <p className="hint">
            {meta.semantic ? "Semantic search on: ANU matches by meaning, not just keywords." : "Keyword search only (the local model didn't load)."}
            {sources !== "data" && " AI papers come from Hugging Face."}
          </p>
          <p className="hint">Answering with: <strong>{meta.engine.label}</strong></p>
          <button className="btn ghost" onClick={newConversation} disabled={!turns.length}>New conversation</button>
        </aside>

        <main className="panel chat">
          <div
            className="log"
            ref={logRef}
            aria-live="polite"
            onScroll={(e) => {
              const el = e.currentTarget;
              followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {!turns.length && (
              <div className="empty">
                <p className="lead">Ask anything about {scope}. Pick a starting point:</p>
                <div className="chips">
                  {suggestions(mode, scope, companyName, days, sources !== "data").map((s) => (
                    <button key={s} className="chip" onClick={() => void ask(s)}>{s}</button>
                  ))}
                </div>
                {!sector && !company && (
                  <>
                    <p className="lead small">Or start from today's brief:</p>
                    <div className="stories">
                      {meta.brief.stories.map((s) => (
                        <button key={s.h} className="story" onClick={() => void ask(`Explain this story and why it matters: "${s.h}"`)}>
                          <span className="tag">{s.tag}</span>
                          <span>{s.h}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className="turn">
                <div className="q">
                  <div className="who">You {t.focusLabel && <span className="focus-tag">{t.focusLabel}</span>}</div>
                  <p>{t.question}</p>
                </div>
                <div className="a">
                  <div className="who">ANU</div>
                  {!!t.tools.length && (
                    <div className="tools">
                      {t.tools.map((tool, j) => <span key={j} className="tool">{toolLabel(tool.name, tool.input)}</span>)}
                    </div>
                  )}
                  {t.answer ? <Markdown text={t.answer} /> : t.status === "streaming" && <p className="thinking">{meta.engine.engine === "ollama" ? "Thinking on your Mac and looking through your data…" : "Looking through your data…"}</p>}
                  {t.progress && t.status === "streaming" && <p className="note">{t.progress}</p>}
                  {t.note && <p className={`note ${t.status}`}>{t.note}</p>}
                  {i === turns.length - 1 && t.status === "done" && t.answer && conversationId && (
                    <>
                      <GrokButton conversationId={conversationId} />
                      {meta.checker && <CheckPanel check={t.check} checker={meta.checker} onVerify={() => void verifyLast()} />}
                    </>
                  )}
                  {!!t.evidence.length && t.status !== "streaming" && (
                    <details className="evidence">
                      <summary>Evidence ANU looked at ({t.evidence.length})</summary>
                      <ul>
                        {t.evidence.map((e) => (
                          <li key={e.id}>
                            <span className="date">{e.date}</span> {e.title}
                            {e.source && <SourceLink source={e.source} />}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </div>
            ))}
          </div>
          {!!turns.length && !busy && (
            <div className="chips follow">
              {suggestions(mode, scope, companyName, days, sources !== "data").slice(0, 3).map((s) => (
                <button key={s} className="chip" onClick={() => void ask(s)}>{s}</button>
              ))}
            </div>
          )}
          <form className="composer" onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(question); } }}
              placeholder={`Ask ANU about ${scope}…`}
              aria-label="Your question"
              rows={2}
            />
            {busy ? (
              <button type="button" className="btn ghost" onClick={() => abortRef.current?.abort()}>Stop</button>
            ) : (
              <button type="submit" className="btn" disabled={!question.trim()}>Ask</button>
            )}
          </form>
        </main>

        <aside className="panel context" aria-label="Context">
          {companyDetail ? <CompanyCard c={companyDetail} onAsk={ask} /> : sectorDetail ? <SectorCard s={sectorDetail} onAsk={ask} /> : <OverviewCard meta={meta} />}
        </aside>
      </div>
    </div>
  );
}

/**
 * The free Grok app has no API, so this copies a fact-check prompt (question, answer and
 * the evidence ANU used) and opens grok.com to paste it into.
 */
function GrokButton({ conversationId }: { conversationId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "blocked" | "error">("idle");
  const [prompt, setPrompt] = useState("");
  async function go() {
    try {
      const text = await api.grokPrompt(conversationId);
      setPrompt(text);
      await navigator.clipboard.writeText(text);
      const tab = window.open("https://grok.com/", "_blank", "noopener");
      setState(tab === null ? "blocked" : "copied");
    } catch {
      setState("error");
    }
  }
  return (
    <div className="grok">
      <button className="btn ghost verify" onClick={() => void go()}>Check with Grok (free)</button>
      {state === "copied" && <span className="note"> Copied. In the Grok tab, paste (⌘V) and send.</span>}
      {state === "blocked" && <span className="note"> Copied. Open <a href="https://grok.com/" target="_blank" rel="noreferrer">grok.com</a>, paste (⌘V) and send.</span>}
      {state === "error" && (
        <span className="note error">
          {" "}Couldn't copy automatically.{" "}
          {prompt ? <button className="linkish" onClick={() => setState("idle")}>Select the prompt below and copy it</button> : "Try again."}
        </span>
      )}
      {state === "error" && prompt && <textarea className="grok-prompt" readOnly value={prompt} onFocus={(e) => e.currentTarget.select()} />}
    </div>
  );
}

const VERDICTS = {
  supported: { label: "Supported", cls: "ok" },
  not_in_evidence: { label: "Not in evidence", cls: "warn" },
  contradicted: { label: "Contradicted", cls: "bad" },
} as const;

function CheckPanel({ check, checker, onVerify }: { check: Turn["check"]; checker: string; onVerify: () => void }) {
  if (!check) return <button className="btn ghost verify" onClick={onVerify}>Verify this answer with a second model</button>;
  if (check.state === "loading") return <p className="note thinking">Checking every claim against the evidence with {checker}…</p>;
  if (check.state === "error") return <p className="note error">Couldn't verify: {check.message} <button className="linkish" onClick={onVerify}>Try again</button></p>;
  const r = check.result;
  const level = r.confidence >= 75 ? "ok" : r.confidence >= 45 ? "warn" : "bad";
  return (
    <div className="check">
      <div className="check-head">
        <span className={`score ${level}`}>{r.confidence}/100</span>
        <span>
          <strong>Second opinion</strong> by {r.checker}. {r.summary}
        </span>
      </div>
      <ul>
        {r.claims.map((c, i) => (
          <li key={i}>
            <span className={`verdict ${VERDICTS[c.verdict].cls}`}>{VERDICTS[c.verdict].label}</span> {c.claim}
            {c.note && <span className="why"> — {c.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceLink({ source }: { source: string }) {
  const url = /https?:\/\/\S+/.exec(source)?.[0];
  const name = source.replace(/\s*https?:\/\/\S+/, "");
  return url ? <a className="src" href={url} target="_blank" rel="noreferrer">{name}</a> : <span className="src">{name}</span>;
}

function Heat({ n }: { n: number }) {
  return (
    <span className="heat" aria-label={`Momentum ${n} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => <span key={i} className={i <= n ? "pip on" : "pip"} />)}
    </span>
  );
}

function Events({ items }: { items: Catalyst[] }) {
  if (!items.length) return <p className="muted">Nothing dated coming up.</p>;
  return (
    <ul className="events">
      {items.slice(0, 6).map((c) => (
        <li key={c.id}><span className="date">{c.approx ? "~" : ""}{c.d}</span> {c.title}</li>
      ))}
    </ul>
  );
}

function OverviewCard({ meta }: { meta: Meta }) {
  return (
    <>
      <h2>Big picture</h2>
      <p className="thesis">{meta.overview.headline}</p>
      <h3>Forces moving the industry</h3>
      <ul className="forces">
        {meta.overview.forces.slice(0, 4).map((f) => <li key={f.t}><strong>{f.t}.</strong> {f.b}</li>)}
      </ul>
      <h3>Coming up (60 days)</h3>
      <Events items={meta.upcoming} />
    </>
  );
}

function SectorCard({ s, onAsk }: { s: SectorDetail; onAsk: (q: string) => void }) {
  return (
    <>
      <h2>{s.name}</h2>
      <div className="row">Momentum <Heat n={s.heat} /></div>
      <p>{s.state}</p>
      <h3>Where the money is</h3>
      <p>{s.money}</p>
      <h3>What to watch</h3>
      <p>{s.watch}</p>
      <h3>Coming up</h3>
      <Events items={s.upcoming} />
      <h3>Companies</h3>
      <div className="chips">
        {s.companies.slice(0, 10).map((c) => <button key={c.name} className="chip small" onClick={() => onAsk(`Who is ${c.name} and why do they matter in ${s.name}?`)}>{c.name}</button>)}
      </div>
      <h3>Latest</h3>
      <ul className="events">
        {s.recentUpdates.slice(0, 5).map((u) => <li key={u.id}><span className="date">{u.date}</span> {u.title}</li>)}
      </ul>
      <Papers query={s.name} onAsk={onAsk} />
    </>
  );
}

function Papers({ query, onAsk }: { query: string; onAsk: (q: string) => void }) {
  const [papers, setPapers] = useState<Paper[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setPapers(null);
    setFailed(false);
    api.papers(query.replace(/&/g, " "), 4).then(setPapers, () => setFailed(true));
  }, [query]);
  return (
    <>
      <h3>Research papers (Hugging Face)</h3>
      {failed ? <p className="muted">Couldn't reach Hugging Face Papers.</p> : !papers ? <p className="muted">Loading…</p> : !papers.length ? <p className="muted">No matching papers.</p> : (
        <ul className="events">
          {papers.map((p) => (
            <li key={p.id}>
              <span className="date">{p.published}</span> <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a>{" "}
              <button className="linkish" onClick={() => onAsk(`Explain this research paper in plain words and what it could mean for defense tech: "${p.title}" (${p.url})`)}>Explain</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CompanyCard({ c, onAsk }: { c: CompanyDetail; onAsk: (q: string) => void }) {
  return (
    <>
      <h2>{c.name}</h2>
      <p className="muted">{c.type} · {c.hq}</p>
      <p>{c.status}</p>
      <h3>Edge</h3>
      <p>{c.edge}</p>
      <h3>Latest</h3>
      <p>{c.latest}</p>
      <h3>In the news</h3>
      {c.updates.length ? (
        <ul className="events">
          {c.updates.slice(0, 6).map((u) => <li key={u.id}><span className="date">{u.date}</span> {u.title}</li>)}
        </ul>
      ) : <p className="muted">No stored updates mention {c.name} yet.</p>}
      <button className="btn ghost wide" onClick={() => onAsk(`Where is ${c.name} vulnerable to a startup, and what would you build against them?`)}>Find an opening against {c.name}</button>
    </>
  );
}
