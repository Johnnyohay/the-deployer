import { XMLParser } from "fast-xml-parser";

// Shared RSS/Atom reading for the free collectors (defense news, housing news, videos).

export const parser = new XMLParser({ ignoreAttributes: false });

export const strip = (s: unknown) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&#\d+;|&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const firstSentences = (s: string, max = 260) => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "));
  return end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
};

export interface FeedItem { title: string; link: string; date: string; summary: string; raw: Record<string, unknown> }

/** Fetches one RSS or Atom feed; on any failure logs and returns nothing so one bad feed never stops a run. */
export async function fetchFeed(name: string, url: string): Promise<FeedItem[]> {
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (anu news collector)" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = parser.parse(await res.text());
    const items = xml?.rss?.channel?.item ?? xml?.feed?.entry ?? [];
    return (Array.isArray(items) ? items : [items]).flatMap((it: Record<string, unknown>) => {
      const links = Array.isArray(it.link) ? it.link : [it.link];
      const alt = links.find((l) => typeof l === "string") ?? links.find((l) => (l as Record<string, string>)?.["@_rel"] === "alternate") ?? links[0];
      const link = typeof alt === "string" ? alt : (alt as Record<string, string>)?.["@_href"] ?? "";
      const raw = (it.pubDate ?? it.published ?? it.updated ?? it["dc:date"]) as string | undefined;
      const when = raw ? new Date(raw) : null;
      const title = strip(typeof it.title === "object" ? (it.title as Record<string, unknown>)?.["#text"] : it.title);
      if (!title || !/^https?:\/\//.test(link) || !when || isNaN(+when)) return [];
      const body = it.description ?? it.summary ?? it["content:encoded"] ?? it.content;
      const text = typeof body === "object" ? (body as Record<string, unknown>)?.["#text"] : body;
      return [{ title, link: link.trim(), date: when.toISOString().slice(0, 10), summary: firstSentences(strip(text)), raw: it }];
    });
  } catch (err) {
    console.warn(`Skipped ${name}: ${(err as Error).message}`);
    return [];
  }
}
