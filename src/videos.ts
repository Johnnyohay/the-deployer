/**
 * Free video collector (`npm run videos`): reads the public YouTube feed of every channel
 * in topic/videos.yaml (no API key), keeps recent videos and Shorts, and writes
 * data/videos.json. Channels with topic "mixed" (general business news) only contribute
 * videos that match one of the topics' keywords in that file.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fetchFeed, firstSentences, strip } from "./rss.ts";
import type { Video } from "./housing-kb.ts";
import { loadVideoConfig } from "./config.ts";

const { channels, keepDays: KEEP_DAYS, maxVideos: MAX_VIDEOS, match } = await loadVideoConfig();
const TOPIC_MATCH = Object.fromEntries(Object.entries(match).map(([t, re]) => [t, new RegExp(re, "i")]));
let stored: Video[] = [];
try {
  stored = JSON.parse(await readFile("data/videos.json", "utf8"));
} catch {}
const byId = new Map(stored.map((v) => [v.id, v]));
const since = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
let added = 0;

await Promise.all(
  channels.map(async (ch) => {
    for (const item of await fetchFeed(ch.name, `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`)) {
      const it = item.raw;
      const id = String(it["yt:videoId"] ?? "");
      const group = (it["media:group"] ?? {}) as Record<string, any>;
      const desc = firstSentences(strip(group["media:description"]), 280);
      const topic = ch.topic === "mixed" ? Object.keys(TOPIC_MATCH).find((t) => TOPIC_MATCH[t].test(`${item.title} ${desc}`)) : ch.topic;
      const published = String(it.published ?? "");
      if (!id || !topic || published < since) continue;
      const views = Number(group["media:community"]?.["media:statistics"]?.["@_views"]);
      if (!byId.has(id)) added++;
      byId.set(id, {
        id,
        title: item.title,
        channel: ch.name,
        topic,
        d: published,
        short: item.link.includes("/shorts/"),
        views: Number.isFinite(views) ? views : null,
        desc,
      });
    }
  }),
);

const videos = [...byId.values()].filter((v) => v.d >= since).sort((a, b) => b.d.localeCompare(a.d)).slice(0, MAX_VIDEOS);
await writeFile("data/videos.json", JSON.stringify(videos, null, 1) + "\n");
const count = (t: string) => videos.filter((v) => v.topic === t).length;
console.log(`Added ${added} videos. Stored ${videos.length} (${videos.filter((v) => v.short).length} Shorts): ${count("defense")} defense, ${count("housing")} housing.`);
