import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { dailyOutput, type DailyOutput } from "./schema.ts";
import type { Desk } from "./store.ts";
import { loadTopic } from "./topic.ts";
import { loadSiteConfig } from "./config.ts";

const MODEL = "claude-opus-5";
const MAX_CONTINUATIONS = 6;

const client = new Anthropic();

function deskContext(desk: Desk, today: string) {
  const recent = [...desk.updates].sort((a, b) => b.d.localeCompare(a.d)).slice(0, 80);
  const lastBrief = [...desk.briefs].sort((a, b) => b.date.localeCompare(a.date))[0];
  return {
    today,
    sinceDate: lastBrief?.date ?? recent[0]?.d ?? today,
    sectors: desk.sectors.map((s) => `${s.id}: ${s.name}`).join("\n"),
    knownUpdates: recent.map((u) => `${u.d} | ${u.title} | ${u.src?.u ?? ""}`).join("\n"),
    upcoming: desk.catalysts.filter((c) => c.d >= today).map((c) => `${c.d} | ${c.title}`).join("\n"),
  };
}

/**
 * Step 1: research the news since the last brief with web search.
 * Returns a plain-text research memo with a URL for every item.
 */
export async function research(desk: Desk, today: string): Promise<string> {
  const ctx = deskContext(desk, today);
  const topic = await loadTopic();
  const { site } = await loadSiteConfig();
  if (!topic.research) throw new Error("topic/topic.yaml has no research section, which the Claude-written brief needs.");
  const prompt = `Today is ${ctx.today}. You are the researcher for ${site.name}, a personal daily brief on ${topic.domain} for ${topic.audience}.

${topic.research.scope.replaceAll("{{since}}", ctx.sinceDate)}

Sectors:
${ctx.sectors}

Already on the desk (skip these unless there is material new information):
${ctx.knownUpdates}

Already on the upcoming-events calendar:
${ctx.upcoming}

${topic.research.preferredSources}

Write a research memo. For each development give: the date it happened, what happened, why it matters, which sectors it touches, the companies involved, and the exact source URL and publication name. Also list any newly announced dated upcoming events (deadlines, decisions, launches, reports due). Include only what you found sources for; if a sector had no real news, say so in one line rather than padding it.`;

  let messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const msg = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 40 }],
        messages,
      })
      .finalMessage();

    if (msg.stop_reason === "refusal") {
      throw new Error(`Research request was declined (${msg.stop_details?.category ?? "no category"}).`);
    }
    if (msg.stop_reason === "pause_turn") {
      // The server-side search loop hit its iteration limit; send the turn back to resume.
      messages = [messages[0], { role: "assistant", content: msg.content }];
      continue;
    }
    const memo = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!memo) throw new Error(`Research returned no text (stop_reason: ${msg.stop_reason}).`);
    return memo;
  }
  throw new Error(`Research did not finish after ${MAX_CONTINUATIONS} continuations.`);
}

/**
 * Step 2: turn the memo into schema-checked updates, the morning brief and new calendar events.
 */
export async function structure(desk: Desk, today: string, memo: string): Promise<DailyOutput> {
  const ctx = deskContext(desk, today);
  const topic = await loadTopic();
  const { site } = await loadSiteConfig();
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(dailyOutput(topic)) },
    messages: [
      {
        role: "user",
        content: `Today is ${ctx.today}. Turn this research memo into the day's entries for ${site.name}, a personal helper for following ${topic.domain}.

Rules:
- updates: one entry per significant new development in the memo, with its exact source URL. Skip anything already on the desk (listed below). Sector ids must come from: ${topic.sectors.map((s) => s.id).join(", ")}.
- brief: the morning read. Three to five stories, most important first, chosen across every sector. Write for a smart non-expert: plain words, short sentences, very few numbers, no unexplained acronyms. "you" says why it matters to ${topic.audience}. Each story's updateIndex points at the update it is based on.
- newCatalysts: only genuinely new dated upcoming events, not ones already on the calendar.
- Never invent facts, dates or URLs that are not in the memo.

Already on the desk:
${ctx.knownUpdates}

Already on the calendar:
${ctx.upcoming}

Research memo:
${memo}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Structuring request was declined.");
  }
  if (!response.parsed_output) {
    throw new Error(`Structuring returned no parseable output (stop_reason: ${response.stop_reason}).`);
  }
  return response.parsed_output;
}
