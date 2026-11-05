/**
 * Turns suggested sources into ones that work. An AI can name the right publications but
 * often guesses feed URLs, so every source is checked here: the given feed, then the feed
 * the homepage advertises, then the usual feed paths. A feed counts only if it parses and
 * has stories from the last 30 days. YouTube handles are resolved to channel ids the same way.
 */
import { fetchFeed } from "./rss.ts";

const UA = { "user-agent": "Mozilla/5.0 (compatible; deployer feed check)" };
const RECENT_DAYS = 30;

export interface FeedCheck { url: string; items: number; recent: number; latest: string | null }

/** Reads a feed quietly; null when it doesn't parse or has nothing recent. */
export async function checkFeed(url: string): Promise<FeedCheck | null> {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const items = await fetchFeed(url, url);
    const since = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString().slice(0, 10);
    const recent = items.filter((i) => i.date >= since).length;
    if (!items.length || !recent) return null;
    return { url, items: items.length, recent, latest: items.map((i) => i.date).sort().at(-1) ?? null };
  } finally {
    console.warn = warn;
  }
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(15000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** Feed links a page advertises with <link rel="alternate" type="application/rss+xml">. */
function advertisedFeeds(html: string, base: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel=["']?alternate/i.test(tag) || !/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || /comments/i.test(href)) continue;
    try {
      out.push(new URL(href, base).href);
    } catch {}
  }
  return out;
}

/** An AI often writes "supplychaindive.com" or a deep link; make it a site URL. */
export function siteUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim().replace(/^\/+/, "")}`);
  } catch {
    return null;
  }
}

/** Finds a working feed for a source, from a feed URL and/or a homepage. */
export async function discoverFeed(src: { feed?: string; homepage?: string }): Promise<FeedCheck | null> {
  const tried = new Set<string>();
  const attempt = async (url: string) => {
    if (tried.has(url)) return null;
    tried.add(url);
    return checkFeed(url);
  };
  const feed = siteUrl(src.feed);
  if (feed) {
    const ok = await attempt(feed.href);
    if (ok) return ok;
  }
  const home = siteUrl(src.homepage) ?? (feed ? new URL(feed.origin) : null);
  if (!home) return null;
  // The page given, then the site's front page: both may advertise their feeds.
  for (const page of [...new Set([home.href, `${home.origin}/`])]) {
    const html = await getText(page);
    for (const url of html ? advertisedFeeds(html, page).slice(0, 3) : []) {
      const ok = await attempt(url);
      if (ok) return ok;
    }
  }
  for (const p of ["/feed/", "/feeds/news/", "/rss", "/feed", "/rss.xml", "/index.xml", "/atom.xml", "/news/rss", "/blog/feed/"]) {
    const ok = await attempt(new URL(p, home.origin).href);
    if (ok) return ok;
  }
  return null;
}

/** A YouTube channel id (UC…) from a handle like "@CNBC", a channel URL or an id. */
export async function resolveYouTube(handle: string): Promise<{ id: string; recent: number } | null> {
  let id = /UC[\w-]{22}/.exec(handle)?.[0];
  if (!id) {
    const h = handle.replace(/^https?:\/\/(www\.)?youtube\.com\//, "").replace(/^@?/, "@").split(/[/?]/)[0];
    const html = await getText(`https://www.youtube.com/${h}`);
    id = html ? (/"channelId":"(UC[\w-]{22})"/.exec(html)?.[1] ?? /channel\/(UC[\w-]{22})/.exec(html)?.[1]) : undefined;
  }
  if (!id) return null;
  const feed = await checkFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  return feed ? { id, recent: feed.recent } : null;
}

/** Runs `fn` over `items` with at most `limit` at a time, keeping order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}
