export interface Sector { id: string; order: number; name: string; heat: number; state: string; money: string; watch: string }
export interface CompanyLite { id: string; name: string; sectors: string[]; type: string }
export interface UpdateLite { id: string; date: string; title: string; body: string; why: string; sectors: string[]; type: string; companies: string[]; source: string | null }
export interface Catalyst { id: string; d: string; approx: boolean; title: string; sectors: string[]; why: string }
export interface Brief { date: string; title: string; big: string; stories: { tag: string; h: string; what: string; you: string; ref: string }[]; watch: { h: string; why: string }; idea: { h: string; why: string } }
export interface Overview {
  headline: string;
  forces: { t: string; b: string }[];
  asOf: string;
  counts: Record<string, number>;
  updatesCover: { from: string; to: string } | null;
  latestBrief: string | null;
}
export interface Meta { overview: Overview; sectors: Sector[]; companies: CompanyLite[]; modes: { id: string; label: string }[]; sources: { id: string; label: string }[]; semantic: boolean; engine: { engine: string; model: string; label: string; web: boolean }; checker: string | null; brief: Brief; upcoming: Catalyst[] }
export interface Paper { id: string; title: string; summary: string; published: string; upvotes: number; url: string; arxiv: string }
export interface SectorDetail extends Sector {
  recentUpdates: UpdateLite[];
  companies: { name: string; type: string; edge: string }[];
  upcoming: Catalyst[];
  research: { t: string; who: string; why: string; u: string }[];
}
export interface CompanyDetail { id: string; name: string; sectors: string[]; type: string; hq: string; status: string; edge: string; latest: string; src?: string; updates: UpdateLite[] }
export interface Evidence { id: string; date: string; title: string; source: string | null }
export interface Check { checker: string; confidence: number; summary: string; claims: { claim: string; verdict: "supported" | "not_in_evidence" | "contradicted"; note: string }[] }

export interface AskRequest {
  conversationId: string | null;
  question: string;
  focus: { mode: string; sector?: string; company?: string; days?: number };
  effort: "low" | "medium" | "high";
  sources: string;
}

export type AskEvent =
  | { event: "start"; data: { conversationId: string } }
  | { event: "text"; data: { text: string } }
  | { event: "tool"; data: { name: string; input: Record<string, unknown> } }
  | { event: "evidence"; data: { items: Evidence[] } }
  | { event: "status"; data: { note: string } }
  | { event: "done"; data: { stopReason: string | null; refusalCategory: string | null } }
  | { event: "error"; data: { message: string } };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} failed (${res.status})`);
  return res.json() as Promise<T>;
}

const serverApi = {
  meta: () => getJson<Meta>("/api/meta"),
  sector: (id: string) => getJson<SectorDetail>(`/api/sector?id=${encodeURIComponent(id)}`),
  company: (id: string) => getJson<CompanyDetail>(`/api/company?id=${encodeURIComponent(id)}`),
  papers: (q: string, limit = 5) => getJson<Paper[]>(`/api/papers?q=${encodeURIComponent(q)}&limit=${limit}`),
  async grokPrompt(conversationId: string): Promise<string> {
    const res = await fetch("/api/grok-prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId }) });
    const body = (await res.json()) as { prompt?: string; error?: string };
    if (!res.ok || !body.prompt) throw new Error(body.error ?? `Couldn't build the Grok prompt (${res.status})`);
    return body.prompt;
  },
  async verify(conversationId: string): Promise<Check> {
    const res = await fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId }) });
    const body = (await res.json()) as Check & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `Verify failed (${res.status})`);
    return body;
  },
  reset: (conversationId: string) =>
    fetch("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId }) }),

  /** POSTs a question and yields the server-sent events as they arrive. */
  async *ask(body: AskRequest, signal: AbortSignal): AsyncGenerator<AskEvent> {
    const res = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) throw new Error(`Ask failed (${res.status})`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += value;
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (event && data) yield { event, data: JSON.parse(data) } as AskEvent;
      }
    }
  },
};

export type Api = typeof serverApi;

// The GitHub Pages build (VITE_STATIC=1) has no server, so everything runs in the page.
import { browserApi } from "./browser.ts";
export const api: Api = import.meta.env.VITE_STATIC ? browserApi : serverApi;
