import { Fragment, type ReactNode } from "react";

// Small renderer for the subset ANU writes: paragraphs, "- " bullets, numbered
// lists, **bold**, [Source] tags and bare URLs. Everything is rendered as text nodes.

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|https?:\/\/[^\s)\]]+|\[[^\]]{2,60}\])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={m.index}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("http")) out.push(<a key={m.index} href={tok} target="_blank" rel="noreferrer">{new URL(tok).hostname.replace(/^www\./, "")}</a>);
    else out.push(<span key={m.index} className="src-tag">{tok.slice(1, -1)}</span>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; }
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    blocks.push(heading ? <h4 key={blocks.length}>{inline(heading[1])}</h4> : <p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <Fragment>{blocks}</Fragment>;
}
