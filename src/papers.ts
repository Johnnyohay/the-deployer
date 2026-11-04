// Hugging Face Papers search (arXiv research with community upvotes). Public API, no
// key; works from Node and from the browser (the API allows cross-origin requests).

const env = (name: string) => (typeof process !== "undefined" ? process.env?.[name] : undefined);

export interface Paper {
  id: string;
  title: string;
  summary: string;
  published: string;
  upvotes: number;
  url: string;
  arxiv: string;
}

/** Searches Hugging Face Papers (arXiv research with community upvotes). Public API, no key. */
export async function searchPapers(query: string, opts: { since?: string; limit?: number } = {}): Promise<Paper[]> {
  const res = await fetch(`https://huggingface.co/api/papers/search?q=${encodeURIComponent(query)}`, {
    headers: env("HF_TOKEN") ? { authorization: `Bearer ${env("HF_TOKEN")}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Hugging Face papers search failed (${res.status})`);
  const rows = (await res.json()) as { paper: { id: string; title?: string; summary?: string; publishedAt?: string; upvotes?: number }; title?: string; summary?: string; publishedAt?: string }[];
  return rows
    .map(({ paper, title, summary, publishedAt }) => ({
      id: paper.id,
      title: (title ?? paper.title ?? "").replace(/\s+/g, " ").trim(),
      summary: (summary ?? paper.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 700),
      published: (publishedAt ?? paper.publishedAt ?? "").slice(0, 10),
      upvotes: paper.upvotes ?? 0,
      url: `https://huggingface.co/papers/${paper.id}`,
      arxiv: `https://arxiv.org/abs/${paper.id}`,
    }))
    .filter((p) => !opts.since || p.published >= opts.since)
    .slice(0, Math.min(Math.max(opts.limit ?? 8, 1), 20));
}
