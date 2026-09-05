/**
 * Tools named after the job, not after the endpoint.
 *
 * ## What is wrong with a tool per endpoint
 *
 * Almost everything here wraps one backend call and returns what it returned.
 * That is a fine SDK and a poor product: the user's question is "who is asking
 * me things I have not answered", and answering it means knowing to call
 * `get_user_posts`, then `get_post_comments` once per post, then reading the
 * results for questions, then remembering which post each question came from.
 * A model can be talked through that. It usually is not, because nothing in
 * the tool list suggests the sequence exists.
 *
 * `search_mentions` is the one tool that already works the other way, and the
 * five here are built to its shape:
 *
 *   - it names a job ("monitor a brand") rather than a resource;
 *   - it fans out across the networks itself instead of being called nine
 *     times;
 *   - it returns evidence grouped by the unit of decision — the comment,
 *     under the post it was left on, because that is what you act on;
 *   - every item carries an addressable id, so a second tool can act on
 *     exactly the ones a person picked;
 *   - and it pages and windows, so a sweep is affordable.
 *
 * ## They are compositions, and they add no backend
 *
 * Every one of these is existing backend calls in a sequence, plus arithmetic
 * over what came back. Nothing here calls Gemini or asks the server for a
 * judgement, and no endpoint was added to serve them — where a tool wanted a
 * capability the backend does not have (audience overlap between two accounts,
 * a post's publication date on platforms that withhold it) it says so in the
 * result rather than pretending.
 *
 * The reasoning is handed to the calling model for the reason evidence.ts
 * gives: it is text over text, the model holding the conversation is better at
 * it than a Flash model behind another network hop, and it costs us nothing.
 * What we sell is the fetch.
 *
 * ## Billing
 *
 * The sum of the calls actually made, exactly as every other tool here is. That is a
 * real number here rather than a constant, because these fan out — twelve
 * posts is twelve comment fetches — so each tool caps its fan-out, makes the
 * cap an argument, prints the arithmetic in its description, and routes
 * anything above the established threshold through the same elicitation
 * `search_mentions` uses.
 *
 * ## Partial results
 *
 * A creator with no recent posts, a platform that declines, a post with its
 * comments switched off: all normal, none of them a reason to fail a call that
 * has already spent credits on the parts that worked. Every fan-out here
 * collects failures into `unavailable` and returns what it got.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { NooticrClient } from "./nooticr.js";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { platformFromUrl, postSlug } from "./comment-review.js";
import { handleMissGuidance, ownIt, PLATFORM_ARG } from "./evidence.js";
import {
  confirmSpend,
  costOf,
  declinedResult,
  MAX_SPOKEN_HANDLE_CALLS,
  MAX_SPOKEN_TRANSCRIPTS,
} from "./spend.js";
import {
  distributionOf,
  excluding,
  numberOf,
  standing,
  type Distribution,
  type Standing,
} from "./performance.js";
import { normaliseHandle, watchEntryId, watchlistOwner, type WatchStore } from "./watchlist.js";
import { viewMeta } from "./view-meta.js";
import { extractLinks, COLLAB_RUBRIC, vettingGuidance } from "./collab.js";

type Row = Record<string, unknown>;

/** Every fan-out is capped; the cap is an argument, and the argument is clamped. */
function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(numberOf(value ?? fallback));
  if (!n) return fallback;
  return Math.min(max, Math.max(min, n));
}

const rowsOf = (value: unknown): Row[] =>
  Array.isArray(value) ? (value.filter((r) => r && typeof r === "object") as Row[]) : [];

const structuredOf = (res: { structured?: unknown }): Row => (res.structured ?? {}) as Row;

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * An addressable id for a post.
 *
 * Qualified by platform, unlike the comment ids, because these tools put a
 * niche sweep and a creator's own feed in the same payload and the same
 * numeric video id exists on TikTok and on Douyin. `postSlug` handles the
 * YouTube case — the video id lives in `?v=`, so the last path segment is
 * "watch" for every video on the platform and ids built from it collided
 * across posts, which is the bug this scheme exists to avoid.
 */
export function postIdOf(post: Row, index: number): string {
  const url = String(post.externalUrl ?? post.url ?? "");
  const platform = String(post.platform ?? "") || platformFromUrl(url) || "unknown";
  const slug = url ? postSlug(url) : "";
  // postSlug falls back to the literal "post" for anything that is not a URL,
  // which would be the same string for every undated row in a feed. The
  // platform's own id, then the position, are unique where it is not.
  const key = slug && slug !== "post" ? slug : String(post.id ?? "") || `at${index}`;
  return `post:${platform}:${key}`;
}

/**
 * A comment's id, derived from the comment rather than from where it sat.
 *
 * The older schemes here are positional. `analyze_comments` mints
 * `comment:<postSlug>:<index>`, and `search_mentions` mints
 * `<platform>:<postId>:<index into the whole result>` — and an index moves.
 * Change `commentsPerPost`, page with a different `offset`, apply a `since`
 * window, or simply call again after three new comments have landed, and the
 * same id now names a different comment. That is worse than having no id: a
 * host that stored one to address a specific comment silently gets another.
 *
 * So this uses what the comment carries. The platform's own id where there is
 * one — TikTok's `cid` is the case that matters — and otherwise a fingerprint
 * of the post it is under, who wrote it and what it says, which are the three
 * things that do not change between two fetches of the same comment.
 *
 * The consequence, stated rather than hidden: two byte-identical comments by
 * the same author under the same post collapse to one id. They are
 * indistinguishable in the payload as well, so there is nothing to tell them
 * apart with; a positional id would merely have disguised that.
 */
export function commentIdFor(ownerPostId: string, comment: Row): string {
  const key = ownerPostId.replace(/^post:/, "");
  const upstream = String(comment.id ?? comment.cid ?? comment.commentId ?? "").trim();
  if (upstream) return `comment:${key}:${upstream}`;
  const author = String(comment.author ?? comment.username ?? "").replace(/^@/, "");
  const text = String(comment.text ?? "").trim();
  return `comment:${key}:h${fingerprint(`${key}\u0000${author}\u0000${text}`)}`;
}

/**
 * FNV-1a, 32-bit, base36. Not a hash for security — a short stable name for a
 * string, computed the same way in Node and in a Worker with nothing imported.
 * Thirty-two bits is ample for the few dozen comments under one post.
 */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Dates, where the platform gives one.
 *
 * `since` is a documented argument on these tools and it cannot always be
 * honoured: several platforms return a feed with no timestamp on it at all,
 * and the post schema has never declared one. So this probes the spellings
 * that do arrive and the caller reports whether the window was actually
 * applied — a silently ignored `since` is how a monitoring answer becomes
 * wrong without looking wrong.
 */
const DATE_KEYS = [
  "postedAt", "publishedAt", "createdAt", "created_at", "publishedTime",
  "takenAt", "timestamp", "createTime", "create_time", "date",
];

export function postDate(post: Row): string | null {
  for (const key of DATE_KEYS) {
    const raw = post[key];
    if (raw === null || raw === undefined || raw === "") continue;
    if (typeof raw === "number") {
      // Epoch seconds and epoch milliseconds both arrive, and a value below
      // 1e12 is not a plausible millisecond timestamp for a social post.
      const at = new Date(raw > 1e12 ? raw : raw * 1000);
      if (!Number.isNaN(at.getTime())) return at.toISOString();
      continue;
    }
    const at = new Date(String(raw));
    if (!Number.isNaN(at.getTime())) return at.toISOString();
  }
  return null;
}

/**
 * A comment's date, or null when it cannot be believed.
 *
 * Seven of the nine comment mappers in the importer end with
 * `unwrap_or_else(|| Utc::now())` when the upstream date will not parse, so on
 * most networks every comment comes back stamped with the moment it was
 * fetched. YouTube's mapper is the only one that returns null instead. A
 * fabricated timestamp is not a cosmetic problem: it renders as "2 minutes
 * ago" in the view and reads to a model as a fact about when someone wrote
 * something, and `search_mentions`'s own `since` filter passes everything on
 * those platforms because of it.
 *
 * Nothing in the payload distinguishes a fabricated date from a real one, so
 * the only signal available here is that it is indistinguishable from now.
 * Anything inside this window is dropped. It costs the true date of a genuinely
 * fresh comment, which is a much smaller error than asserting a date for every
 * comment on seven networks.
 */
export const FABRICATED_DATE_WINDOW_MS = 5 * 60 * 1000;

export function trustedCommentDate(raw: unknown, now = Date.now()): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const at = new Date(typeof raw === "number" ? (raw > 1e12 ? raw : raw * 1000) : String(raw));
  const ms = at.getTime();
  if (Number.isNaN(ms)) return null;
  if (Math.abs(now - ms) < FABRICATED_DATE_WINDOW_MS) return null;
  return at.toISOString();
}

export interface Windowed {
  posts: Row[];
  /** False when nothing carried a date, so `since` could not be honoured. */
  applied: boolean;
  /** Posts kept despite carrying no date — they cannot be proven outside it. */
  undated: number;
}

export function applySince(posts: Row[], since?: string): Windowed {
  if (!since) return { posts, applied: false, undated: 0 };
  const floor = new Date(since).getTime();
  if (Number.isNaN(floor)) return { posts, applied: false, undated: 0 };
  let dated = 0;
  let undated = 0;
  const kept = posts.filter((p) => {
    const at = postDate(p);
    if (!at) {
      undated += 1;
      return true;
    }
    dated += 1;
    return new Date(at).getTime() >= floor;
  });
  return { posts: kept, applied: dated > 0, undated };
}

/**
 * Which comments look like they want an answer.
 *
 * Deliberately a crude test over punctuation and stock phrasing, and
 * deliberately not a judgement: the judgement belongs to the model reading the
 * result, which can tell a rhetorical question from a real one and can read
 * the languages this cannot. What the flag buys is ordering — a creator with
 * two hundred comments wants the twelve that end in a question mark at the
 * top of the page — and the guidance says plainly that it is a sort, not a
 * verdict, so nothing downstream treats it as one.
 */
export function replySignals(text: string): string[] {
  const raw = String(text ?? "");
  const t = raw.toLowerCase();
  const signals: string[] = [];
  if (raw.includes("?") || raw.includes("？")) signals.push("question mark");
  if (/^(who|what|whats|when|where|why|how|which|can|could|do|does|did|is|are|will|would|should|any)\b/.test(t)) {
    signals.push("opens with a question word");
  }
  if (/\b(how do|how did|how can|how much|what is|what's|whats the|where do|where did|which one|any tips|any advice|recommend|link\b)/.test(t)) {
    signals.push("asks for information");
  }
  if (/\b(please|pls|plz|can you|could you|would you|do a|make a|make more|more of|video on|part 2|part two|tutorial|follow up|followup)\b/.test(t)) {
    signals.push("asks for something to be made");
  }
  if (/\b(not working|doesn'?t work|didn'?t work|broken|error|crash|refund|charged|stuck|won'?t load|failed)\b/.test(t)) {
    signals.push("reports something broken");
  }
  return signals;
}

/**
 * What a run of calls actually cost.
 *
 * The backend reports its own charge per call in `mcpCredits.cost`, and that
 * is the number to trust — a first free use, an admin bypass or a price change
 * upstream all show up there and in no table we keep. The local table is the
 * fallback for a response that omitted it, and the up-front estimate that the
 * spend confirmation is built on.
 */
class Spend {
  private total = 0;
  readonly calls: string[] = [];
  record(tool: string, structured: Row): void {
    this.calls.push(tool);
    const reported = (structured.mcpCredits ?? null) as Row | null;
    const cost = reported ? numberOf(reported.cost) : NaN;
    this.total += Number.isFinite(cost) && reported ? cost : costOf([tool]);
  }
  /** A call that threw. It may still have been billed, so it is not free. */
  attempted(tool: string): void {
    this.calls.push(tool);
    this.total += costOf([tool]);
  }
  get credits(): number {
    return Math.round(this.total * 100) / 100;
  }
  get payload(): Row {
    return { cost: this.credits, calls: this.calls.length };
  }
}

/** The stats a post carries, reduced to the metrics worth ranking on. */
export const METRICS = ["views", "likes", "comments", "shares", "engagementRate"] as const;
export type Metric = (typeof METRICS)[number];

export function metricOf(post: Row, metric: Metric): number {
  return numberOf(post[metric]);
}

/** A post trimmed to what a reader and a view both need, plus its standing. */
function scored(post: Row, index: number, metric: Metric, baseline: number[]): Row {
  const value = metricOf(post, metric);
  return {
    ...post,
    // The addressable id goes alongside the platform's own, never over it.
    // Overwriting `id` threw away the only value that lets a caller dedupe
    // against its own records or call the platform's API for this post, to
    // save a field — and `postId` is already the name the flat structures in
    // this file use for exactly this.
    postId: postIdOf(post, index),
    postedAt: postDate(post),
    metric,
    metricValue: value,
    standing: standing(value, baseline),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Guidance
//
// In the voice evidence.ts sets, and for the reason it gives: a tool result is
// the only channel to the calling model — prompts are user-selected and cannot
// steer anything — so this text is not documentation, it is the steering, and
// it lands in the model's context. Each block says what the material is, what
// to work out from it, that every claim must be tied to a quote or a number,
// and ends by telling the model the reasoning is its own.
// ─────────────────────────────────────────────────────────────────────────────

function audienceGuidance(a: {
  handle: string;
  posts: number;
  comments: number;
  flagged: number;
  failed: number;
  since?: string;
  sinceApplied: boolean;
}): string {
  const lines = [
    `${a.comments} comments from ${a.posts} recent post${a.posts === 1 ? "" : "s"} by @${a.handle}, ` +
      "grouped under the post each one was left on. Every comment carries an id.",
    "",
    `${a.flagged} are flagged wantsReply. That flag is a punctuation-and-phrasing test, not a ` +
      "judgement: it misses questions asked without a question mark, misses everything not in " +
      "English, and catches rhetorical ones. Use it as an ordering and read the rest yourself.",
    "",
    "Work out which comments actually want an answer from this creator, what each is really " +
      "asking, and draft a reply in their voice — short, specific, and quoting the comment it " +
      "answers. Where the answer already exists in one of these posts, name that post. Group the " +
      "ones asking the same thing: a single pinned reply beats twenty individual ones, and a " +
      "question that recurs across posts is a video rather than a reply.",
    "",
    "You are drafting, not sending. Nothing in nooticr can post a comment on any network — the " +
      "connections carry upload and read permission only — so these are for the creator to paste " +
      "in themselves. Say that rather than implying the replies will go out.",
    "",
    "Do not invent facts about the product, the price or the creator's plans to fill a gap. If a " +
      "comment cannot be answered from what is here, say what you would need.",
    "",
    "Do not date anything. Comment timestamps are fabricated as the moment of the fetch on most " +
      "networks, so any that could not be believed have been dropped to null — a comment with no " +
      "`postedAt` is one whose date is unknown, not one posted long ago.",
  ];
  if (a.since) {
    lines.push(
      "",
      a.sinceApplied
        ? `Only posts from ${a.since} onward are included.`
        : `A window from ${a.since} was asked for, but this platform returned no dates, so ` +
          "nothing was filtered — say so rather than implying the window held.",
    );
  }
  if (a.failed) {
    lines.push(
      "",
      `${a.failed} post${a.failed === 1 ? "" : "s"} could not be read and are listed under ` +
        "`unavailable`. Answer for the ones you have and name the ones you do not.",
    );
  }
  lines.push(
    "",
    "Then call show_audience_replies with your drafts so a person can read them one row at a " +
      "time, copy the ones they want and ignore the rest. It fetches nothing, sends nothing and " +
      "costs nothing.",
    ownIt,
  );
  return lines.join("\n");
}

function competitorGuidance(a: {
  handle: string;
  platform: string;
  metric: Metric;
  shipped: number;
  baseline: Distribution | null;
  outperformers: number;
  newSince: number | null;
  lastChecked?: string;
}): string {
  const lines = [
    // The network is named here, not just in the structured payload, because
    // the platform argument defaults silently: without this line an answer
    // about the wrong network is indistinguishable from the right one.
    `${a.shipped} recent post${a.shipped === 1 ? "" : "s"} by @${a.handle} on ${a.platform}, each ` +
      `scored against that account's own median ${a.metric} rather than against anyone else's ` +
      "numbers.",
    "",
    a.baseline
      ? `Their median is ${Math.round(a.baseline.median).toLocaleString("en-US")} ${a.metric}, ` +
        `with the middle half between ${Math.round(a.baseline.p25).toLocaleString("en-US")} and ` +
        `${Math.round(a.baseline.p75).toLocaleString("en-US")}. ${a.outperformers} post` +
        `${a.outperformers === 1 ? "" : "s"} beat it by a quarter or more.`
      : "There are too few posts here to call anything a baseline, so no post has been scored. " +
        "Say that rather than ranking them by raw numbers.",
    "",
    "A raw view count mostly measures follower count. What is worth reporting is which posts beat " +
      "this creator's own ordinary result and what those posts have in common that the rest do " +
      "not — format, hook, subject, length, posting time. Name the ratio for each claim " +
      "(`standing.ratio` is the post over their median) and quote the title or caption you are " +
      "reasoning from.",
    "",
    "One post above the median is noise. Say a pattern exists only when two or more of the " +
      "outperformers share the thing you are naming, and say which posts those are.",
  ];
  if (a.newSince !== null) {
    lines.push(
      "",
      `${a.newSince} of these are new since your last check on ${a.lastChecked}. Lead with those ` +
        "— the rest have been reported before. New means the post was not in the list last time, " +
        "which is an identity comparison rather than a date one; do not restate it as \"posted " +
        "in the last N days\", because the dates these platforms return are not good enough for " +
        "that claim.",
    );
  } else {
    lines.push(
      "",
      "This is the current window rather than a diff: this creator is not on the watchlist, so " +
        "there is no previous check to compare against. watch_creator them and the next call " +
        "will mark what is new.",
    );
  }
  lines.push(ownIt);
  return lines.join("\n");
}

function collabGuidance(a: { niche: string; found: number; seed?: string; platform: string }): string {
  return [
    `${a.found} creators in "${a.niche}" on ${a.platform}` +
      (a.seed ? `, from a keyword search and from the lookalikes of @${a.seed}` : "") +
      ". Each carries an id, a follower count and whichever of the two searches surfaced it.",
    "",
    "Shortlist the ones worth approaching and rank them. Reason from what is here: follower " +
      "count against this creator's own, whether both searches found them (which is a stronger " +
      "signal than either alone), what their bio actually says they do, and whether they are " +
      "verified. Give each one a reason a person could disagree with, and name the number or the " +
      "phrase from their bio you are reading it from.",
    "",
    "Say plainly what this evidence cannot settle. Audience overlap — whether the same people " +
      "comment under both accounts — is the signal that would decide this, and it is not here: " +
      "it needs a post list and several comment fetches per candidate, which is roughly nine " +
      "credits each and around eighty for a shortlist this size. That is a decision for the user " +
      "to make, not one to make silently on their behalf. For a finalist or two, " +
      "answer_my_audience on each account returns commenters with their handles, and the " +
      "intersection is the overlap; say so rather than guessing at it.",
    "",
    "Do not rank on follower count alone. A creator ten times the user's size is a different " +
      "conversation from a peer, and both can be right depending on what they want — say which " +
      "kind each one is.",
    ownIt,
  ].join("\n");
}

function underperformGuidance(a: {
  metric: Metric;
  where: Standing;
  baseline: Distribution | null;
  window: number;
}): string {
  const lines = [
    `This post, its stats, and the ${a.window} recent posts by the same creator it is being ` +
      "measured against. The post itself is excluded from that baseline, so it is not being " +
      "compared partly with itself.",
    "",
  ];
  if (!a.baseline || a.where.ratio === null) {
    lines.push(
      "There are too few comparable posts to build a baseline, so there is no verdict here. Say " +
        "that plainly rather than calling the post good or bad from its raw numbers, and say " +
        "what a bigger `window` would need to contain.",
    );
  } else {
    lines.push(
      `It did ${a.where.value.toLocaleString("en-US")} ${a.metric} against a median of ` +
        `${Math.round(a.where.median ?? 0).toLocaleString("en-US")} — ${a.where.ratio}× their ` +
        `normal result, ahead of ${a.where.percentile}% of the window.`,
      "",
      "The question is what is different about this post, not whether the number is low. Compare " +
        "it against the posts around and above it in `window`: hook, subject, format, length, " +
        "caption, hashtags, posting time. Name the specific post you are contrasting it with and " +
        "quote the difference.",
      "",
      "Be honest about the size of the gap. Within about a quarter of the median is the ordinary " +
        "spread of an account and not an underperformance at all — if that is what this is, say " +
        "so and stop, rather than manufacturing a cause for noise.",
    );
  }
  lines.push(
    "",
    "The stats here are reach, not quality. If a judgement needs the video itself, call " +
      "analyze_post with mode 'evidence' for the frames, or get_post_transcript for the exact " +
      "words, and look for yourself — the tools are yours to call, so nobody should be asked to " +
      "relay one back to you.",
    ownIt,
  );
  return lines.join("\n");
}

function nextGuidance(a: {
  handle: string;
  niche: string;
  nicheSource: string;
  demandComments: number;
  asks: number;
  supplyPosts: number;
  failed: number;
}): string {
  const lines = [
    `Two halves that only mean something together. Demand: ${a.demandComments} comments from ` +
      `@${a.handle}'s own recent posts, ${a.asks} of them flagged as asking for something. ` +
      `Supply: ${a.supplyPosts} recent posts in "${a.niche}"` +
      (a.nicheSource === "hashtags"
        ? " — a niche nobody named, taken from the hashtag this creator uses most, so check it is the right one before trusting the sweep."
        : "") +
      ".",
    "",
    "Work out what their audience keeps asking for that the niche is not already serving. A gap " +
      "in the sweep that nobody asked for is noise; a request that the sweep shows is already " +
      "answered ten times over is a crowded topic; the opportunity is the request with no good " +
      "answer in the supply half.",
    "",
    "For each idea you propose, give: the exact comment that asked for it, quoted, with its id; " +
      "how many separate commenters asked for something like it; what the sweep shows on that " +
      "topic — either the closest post and its numbers, or that there is none; and the hook you " +
      "would open with. An idea without a quote behind it is you inventing content strategy, " +
      "which is the failure mode this tool exists to prevent.",
    "",
    "Rank by demand against absence of supply, not by how good the idea sounds. Say when the " +
      "evidence is thin — one comment is one person, and a niche sweep of a dozen posts is a " +
      "sample of a platform, not a census of it.",
  ];
  if (a.failed) {
    lines.push(
      "",
      `${a.failed} of the fetches failed and are listed under \`unavailable\`; the demand half is ` +
        "that much thinner than it looks.",
    );
  }
  lines.push(ownIt);
  return lines.join("\n");
}

/** Regex metacharacters in a search term, escaped so the term is matched literally. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One occurrence of the term inside a transcript, with enough around it to read tone from. */
export interface TranscriptExcerpt {
  text: string;
  /** Character offset of the match inside the full transcript. */
  position: number;
  /** 1-based — which occurrence this is, of possibly more than are shown. */
  occurrence: number;
}

/**
 * Where a term is actually said, case-insensitively and on whole words —
 * "nike" must not fire inside "nikeisha". `\b` only means anything next to a
 * word character, so a term that starts or ends on punctuation (an ampersand,
 * a period) skips the boundary check on that side rather than failing to
 * match at all.
 *
 * Every occurrence is counted; only the first `maxExcerpts` carry the
 * surrounding text, because a transcript that says a name forty times does
 * not need forty near-identical quotes to make the point.
 */
export function matchExcerpts(
  transcript: string,
  term: string,
  maxExcerpts = 3,
  contextChars = 180,
): { excerpts: TranscriptExcerpt[]; matchCount: number } {
  const text = String(transcript ?? "");
  const needle = String(term ?? "").trim();
  if (!text || !needle) return { excerpts: [], matchCount: 0 };
  const startsWord = /^\w/.test(needle);
  const endsWord = /\w$/.test(needle);
  const pattern = new RegExp(
    `${startsWord ? "\\b" : ""}${escapeRegExp(needle)}${endsWord ? "\\b" : ""}`,
    "gi",
  );
  const excerpts: TranscriptExcerpt[] = [];
  let matchCount = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    matchCount++;
    if (excerpts.length < maxExcerpts) {
      const start = Math.max(0, match.index - contextChars);
      const end = Math.min(text.length, match.index + match[0].length + contextChars);
      let excerpt = text.slice(start, end).trim();
      if (start > 0) excerpt = `…${excerpt}`;
      if (end < text.length) excerpt = `${excerpt}…`;
      excerpts.push({ text: excerpt, position: match.index, occurrence: matchCount });
    }
    // The pattern carries no empty-match risk (`needle` is checked non-empty
    // above), but a stalled lastIndex on a zero-width match would loop
    // forever, so this guards it regardless.
    if (match[0].length === 0) pattern.lastIndex++;
  }
  return { excerpts, matchCount };
}

function spokenMentionGuidance(a: {
  term: string;
  platforms: string[];
  considered: number;
  transcribed: number;
  transcriptsAvailable: number;
  matched: number;
  maxTranscripts: number;
  ceilingReached: boolean;
  failed: number;
}): string {
  const networks = a.platforms.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" and ");
  const lines = [
    `${a.matched} of ${a.transcribed} transcribed post${a.transcribed === 1 ? "" : "s"} on ${networks} ` +
      `actually say "${a.term}" out loud. ${a.considered} candidate${a.considered === 1 ? "" : "s"} ` +
      `were found before the transcript ceiling was applied; ${a.transcriptsAvailable} of the ` +
      `${a.transcribed} checked carried a caption track at all.`,
    "",
  ];
  if (a.ceilingReached) {
    lines.push(
      `Only the ${a.maxTranscripts} most-viewed candidates were transcribed — ` +
        `${a.considered - a.maxTranscripts} more were found and never checked, not because they ` +
        "don't matter but because the ceiling stopped here. Raise `maxTranscripts` to look " +
        "further, at 1 credit each.",
      "",
    );
  }
  lines.push(
    "Read each excerpt for tone — praise, a complaint, a comparison, a passing mention — and " +
      "quote the line rather than paraphrasing it: it is exactly what was said, not a summary of " +
      "it. `matchCount` is how many times the term comes up in that transcript; only the first " +
      "few occurrences carry an excerpt, and the rest are still counted toward it.",
    "",
    "This covers TikTok and YouTube only, and even there only the videos that carry a caption " +
      "track. A silent or captionless video is invisible to this tool no matter how directly it " +
      "names the term, and no other network was attempted at all, because none of them expose a " +
      "caption track this cheaply — search_mentions is the tool for what people wrote there. Say " +
      "plainly that coverage is partial rather than treating an empty result as proof nobody said " +
      "it on camera.",
  );
  if (a.failed) {
    lines.push(
      "",
      `${a.failed} candidate${a.failed === 1 ? "" : "s"} could not be narrowed or transcribed and ` +
        "are listed under `unavailable`, with why.",
    );
  }
  lines.push("", ownIt);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

interface MakeClient {
  (ctx: { authInfo?: AuthInfo; requestId?: string | number; arguments?: unknown }):
    | Promise<NooticrClient>
    | NooticrClient;
}

const metricArg = z
  .enum(METRICS)
  .optional()
  .describe("Which stat to rank on (default views).");

export function registerJobTools(server: McpServer, makeClient: MakeClient, store: WatchStore): void {
  /** Guidance in the text block, evidence in the structured one — as every tool here does. */
  const evidence = (guidance: string, payload: Row) => ({
    content: [{ type: "text" as const, text: guidance }],
    structuredContent: payload,
  });

  const failed = (prefix: string, err: unknown) => ({
    content: [{ type: "text" as const, text: `${prefix}: ${reason(err)}` }],
    isError: true as const,
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. answer_my_audience — the mirror of search_mentions.
  //
  // The brand monitor asks what strangers are saying about you. This asks what
  // the people already under your own posts asked you and never got an answer
  // to, which is the same fan-out pointed the other way and the only one of
  // these that ends in something the user does rather than something they read.
  // ───────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "answer_my_audience",
    {
      title: "Answer My Audience",
      _meta: viewMeta("answer_my_audience"),
      description:
        "The questions waiting for you under your own posts. Fetches a creator's recent posts, " +
        "reads the comments on each, and returns them grouped under the post they were left on — " +
        "every comment with a stable id, and the ones that look like questions or requests " +
        "flagged and sorted to the top. This FINDS and helps you DRAFT answers; it cannot post " +
        "them. No nooticr connection carries comment-write permission on any network, so the " +
        "replies are for a person to paste in themselves — never promise the user they will be " +
        "sent. `since` filters on the POST's date, not the comments'. `limit` caps how many " +
        "posts are opened. Pair it with show_audience_replies to lay the drafts out for triage. " +
        "Costs 2 nooticr credits for the post list plus 2 per post opened — 14 credits at the " +
        "default of 6 posts. Use when the job is to answer people; search_mentions is for what " +
        "strangers say elsewhere.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      outputSchema: OUTPUT_SCHEMAS.answer_my_audience,
      inputSchema: z
        .object({
          username: z.string().describe("Your handle, with or without @."),
          platform: z.string().optional().describe(PLATFORM_ARG),
          limit: z
            .number()
            .int()
            .optional()
            .describe("Posts to open (default 6, max 12). Each one is a comment fetch, so this is the price."),
          commentsPerPost: z.number().int().optional().describe("Comments to read per post (default 20, max 50)."),
          since: z
            .string()
            .optional()
            .describe(
              "Only POSTS published on or after this date, as YYYY-MM-DD. It windows the posts, " +
                "not the comments — comment dates are fabricated as 'now' on most networks and " +
                "cannot be filtered on. Ignored where the platform returns no post dates either.",
            ),
        })
        .strict(),
    },
    async (
      args: { username: string; platform?: string; limit?: number; commentsPerPost?: number; since?: string },
      extra,
    ) => {
      const client = await makeClient({ ...extra, arguments: args });
      const handle = normaliseHandle(args.username);
      const platform = (args.platform || "tiktok").toLowerCase();
      const cap = clamp(args.limit, 6, 1, 12);
      const perPost = clamp(args.commentsPerPost, 20, 1, 50);
      const spend = new Spend();

      let feed: Row[];
      try {
        const res = await client.callTool("get_user_posts", { username: handle, platform, limit: cap });
        const structured = structuredOf(res);
        spend.record("get_user_posts", structured);
        feed = rowsOf(structured.posts);
      } catch (err) {
        return failed("answer_my_audience could not list the posts", err);
      }

      const windowed = applySince(feed, args.since);
      const posts = windowed.posts.slice(0, cap);
      if (!posts.length) {
        // Two credits spent and nothing to fan out over. Returning early is
        // both the honest answer and the cheap one.
        return evidence(
          `@${handle} has no recent posts on ${platform}` +
            (args.since ? ` in the window from ${args.since}` : "") +
            ". Nothing was opened, so nothing further was charged.",
          {
            mode: "evidence",
            tool: "answer_my_audience",
            term: `@${handle}`,
            username: handle,
            platform,
            postsChecked: 0,
            threads: [],
            posts: [],
            unavailable: [],
            mcpCredits: spend.payload,
          },
        );
      }

      // The fan-out is the price, and the number of posts is not knowable from
      // the tool description — it is an argument, and it is capped by what the
      // creator has actually posted. So the confirmation happens here, once
      // the real number is known, rather than on the worst case. The post list
      // that got us here cost 2, which is below the threshold this codebase
      // already decided is worth interrupting someone for.
      const fanOut = costOf(posts.map(() => "get_post_comments"));
      const decision = await confirmSpend(server.server, {
        credits: fanOut,
        summary: `Read the comments on ${posts.length} recent post${posts.length === 1 ? "" : "s"} by @${handle}.`,
        cheaper: 'Lower "limit" to open fewer posts.',
      });
      if (!decision.proceed) {
        return declinedResult(fanOut, `Reading ${posts.length} posts' comments`, 'Lower "limit" to open fewer posts.');
      }

      const threads: Row[] = [];
      const unavailable: Row[] = [];
      let totalComments = 0;
      let flagged = 0;

      for (const [index, post] of posts.entries()) {
        const url = String(post.externalUrl ?? post.url ?? "");
        const id = postIdOf(post, index);
        if (!url) {
          // Nothing to fetch comments for, and no reason to spend a credit
          // finding that out.
          unavailable.push({ postId: id, url: null, reason: "the post carries no permalink to fetch comments from" });
          continue;
        }
        try {
          const res = await client.callTool("get_post_comments", { url, limit: perPost });
          const structured = structuredOf(res);
          spend.record("get_post_comments", structured);
          const mentions = rowsOf(structured.comments)
            .map((c) => {
              const text = String(c.text ?? "").trim();
              if (!text) return null;
              const signals = replySignals(text);
              return {
                id: commentIdFor(id, c),
                text,
                username: String(c.author ?? c.username ?? "").replace(/^@/, ""),
                likes: numberOf(c.likes),
                replies: numberOf(c.replies),
                // Null rather than a date we cannot stand behind — see
                // trustedCommentDate. The view will simply omit the timestamp.
                postedAt: trustedCommentDate(c.postedAt ?? c.createdAt),
                avatarUrl: c.avatarUrl ?? null,
                avatarProxyUrl: c.avatarProxyUrl ?? null,
                wantsReply: signals.length > 0,
                signals,
                // Drives the view's filter chips. A label from a phrase test,
                // not a classification — the guidance says so to the model,
                // and the chip says "wants a reply" rather than "question".
                category: signals.length ? "wants_a_reply" : "unclear",
              };
            })
            .filter((c): c is NonNullable<typeof c> => c !== null)
            // Flagged first, then loudest. A creator with two hundred comments
            // reads the top of the page and stops.
            .sort((a, b) =>
              Number(b.wantsReply) - Number(a.wantsReply) ||
              b.signals.length - a.signals.length ||
              b.likes - a.likes,
            );
          totalComments += mentions.length;
          flagged += mentions.filter((m) => m.wantsReply).length;
          threads.push({
            post: { ...post, postId: id, postedAt: postDate(post) },
            postIsAboutTerm: false,
            mentionCount: mentions.length,
            mentions,
          });
        } catch (err) {
          // Comments switched off, a post the platform has since hidden, a
          // network that declined: normal, and no reason to lose the posts
          // that worked.
          spend.attempted("get_post_comments");
          unavailable.push({ postId: id, url, reason: reason(err) });
        }
      }

      const guidance = audienceGuidance({
        handle,
        posts: threads.length,
        comments: totalComments,
        flagged,
        failed: unavailable.length,
        since: args.since,
        sinceApplied: windowed.applied,
      });
      return evidence(guidance, {
        mode: "evidence",
        tool: "answer_my_audience",
        evidenceFrom: ["get_user_posts", "get_post_comments"],
        // `term` + `threads` is what the monitoring view keys off, so this
        // draws through the surface built for triaging comments rather than
        // needing a second one.
        term: `@${handle}`,
        username: handle,
        platform,
        since: args.since ?? null,
        sinceApplied: windowed.applied,
        postsChecked: threads.length,
        // Stated in the payload as well as the prose, because a model that
        // believes it can send will promise the user something that cannot
        // happen. No connection carries comment-write permission anywhere.
        repliesCanBeSent: false,
        totalMentions: totalComments,
        totalThreads: threads.length,
        wantsReplyCount: flagged,
        byCategory: { wants_a_reply: flagged, unclear: totalComments - flagged },
        threads,
        posts: threads.map((t) => t.post as Row),
        unavailable,
        creditsCharged: spend.credits,
        mcpCredits: spend.payload,
      });
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 2. track_competitor
  //
  // Writes, when the creator is on the watchlist: it moves a baseline forward
  // so the next call can say what is new. That baseline is deliberately not
  // the one catch_up_watchlist keeps — two tools sharing one "since I last
  // looked" means each silently consumes the other's answer.
  // ───────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "track_competitor",
    {
      title: "Track Competitor",
      _meta: viewMeta("track_competitor"),
      description:
        "What a creator shipped recently and which of it beat THEIR OWN baseline. Fetches their " +
        "recent posts once and scores each against the median of that same window, because a raw " +
        "view count mostly measures follower count — outperformance against themselves is the " +
        "signal. If they are on your watchlist it also marks what is new since your last " +
        "track_competitor call and moves that marker forward. " +
        "Consumes 2 nooticr credits — one post list, whatever the window size. Use for a rival you " +
        "follow; analyze_creator_profile is the full teardown of one you do not.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Moves the "last checked" marker for a watched creator, so the second
        // call in a row does not answer the same question as the first.
        idempotentHint: false,
        openWorldHint: true,
      },
      outputSchema: OUTPUT_SCHEMAS.track_competitor,
      inputSchema: z
        .object({
          username: z
            .string()
            .describe(
              "Creator handle, with or without @. This is a handle, not a brand name — if you " +
                "only have a company name, find the handle first (search_creators on TikTok, " +
                "Instagram or Xiaohongshu; a web search anywhere else).",
            ),
          platform: z.string().optional().describe(PLATFORM_ARG),
          limit: z.number().int().optional().describe("Posts in the window (default 12, max 30). One fetch either way."),
          metric: metricArg,
          since: z
            .string()
            .optional()
            .describe(
              "Only posts published on or after this date, as YYYY-MM-DD. Ignored where the " +
                "platform returns no post dates — `sinceApplied` says which happened.",
            ),
        })
        .strict(),
    },
    async (
      args: { username: string; platform?: string; limit?: number; metric?: Metric; since?: string },
      extra,
    ) => {
      const client = await makeClient({ ...extra, arguments: args });
      const handle = normaliseHandle(args.username);
      // Whether the network was chosen or merely fallen back to. An empty
      // result means something different in each case, and the caller cannot
      // tell them apart unless we say which happened.
      const platformDefaulted = !args.platform;
      const platform = (args.platform || "tiktok").toLowerCase();
      const cap = clamp(args.limit, 12, 1, 30);
      const metric: Metric = args.metric ?? "views";
      const spend = new Spend();

      let feed: Row[];
      try {
        const res = await client.callTool("get_user_posts", { username: handle, platform, limit: cap });
        const structured = structuredOf(res);
        spend.record("get_user_posts", structured);
        feed = rowsOf(structured.posts);
      } catch (err) {
        return failed("track_competitor could not list the posts", err);
      }

      // Nothing came back. Previously this fell through to the scoring path and
      // produced a baseline-less report about zero posts, which reads as "this
      // competitor has been quiet" — a claim the tool has no evidence for.
      if (feed.length === 0) {
        return evidence(handleMissGuidance({ handle, platform, defaulted: platformDefaulted }), {
          mode: "evidence",
          tool: "track_competitor",
          evidenceFrom: ["get_user_posts"],
          username: handle,
          platform,
          platformDefaulted,
          found: false,
          posts: [],
          unavailable: [],
          creditsCharged: spend.credits,
          mcpCredits: spend.payload,
        });
      }

      const windowed = applySince(feed, args.since);
      const posts = windowed.posts;
      const values = posts.map((p) => metricOf(p, metric));
      const baseline = distributionOf(values);

      // The watchlist is where "since I last checked" can live at all, and only
      // for creators the user already chose to watch. Adding them here would be
      // a side effect nobody asked for, so an untracked creator gets the
      // current window and is told how to get a diff next time.
      let previous: { capturedAt: string; postIds: string[] } | undefined;
      let tracked = false;
      let owner = "anonymous";
      try {
        owner = await watchlistOwner(client);
        const entry = (await store.list(owner)).find((e) => e.id === watchEntryId(platform, handle));
        tracked = Boolean(entry);
        previous = entry?.competitorBaseline;
        if (entry) {
          await store.put(owner, {
            ...entry,
            competitorBaseline: {
              capturedAt: new Date().toISOString(),
              postIds: posts.map((p, i) => String(p.id ?? p.externalUrl ?? postIdOf(p, i))),
            },
          });
        }
      } catch {
        // A store that will not answer costs the diff, not the tool. The
        // outperformance half is the point and it is already computed.
        tracked = false;
      }

      const seen = new Set(previous?.postIds ?? []);
      const scoredPosts: Row[] = posts.map((post, index) => {
        const row = scored(post, index, metric, values);
        return {
          ...row,
          isNew: previous ? !seen.has(String(post.id ?? post.externalUrl ?? postIdOf(post, index))) : null,
        };
      });
      // Loudest first against their own median, which is the ranking the
      // question asks for — not the platform's chronological order.
      scoredPosts.sort((a, b) => numberOf((b.standing as Row).ratio) - numberOf((a.standing as Row).ratio));
      const outperformers = scoredPosts.filter((p) => {
        const verdict = String((p.standing as Row).verdict ?? "");
        return verdict === "breakout" || verdict === "above_baseline";
      });
      const newSince = previous ? scoredPosts.filter((p) => p.isNew === true).length : null;

      return evidence(
        competitorGuidance({
          handle,
          platform,
          metric,
          shipped: scoredPosts.length,
          baseline,
          outperformers: outperformers.length,
          newSince,
          lastChecked: previous?.capturedAt,
        }),
        {
          mode: "evidence",
          tool: "track_competitor",
          evidenceFrom: ["get_user_posts"],
          username: handle,
          platform,
          metric,
          window: scoredPosts.length,
          since: args.since ?? null,
          sinceApplied: windowed.applied,
          tracked,
          lastCheckedAt: previous?.capturedAt ?? null,
          newSincePreviousCheck: newSince,
          baseline,
          // The addressable id, not the platform's own: this is a reference
          // into `posts` above, and `postId` is what identifies a row there
          // across calls.
          outperformers: outperformers.map((p) => p.postId),
          posts: scoredPosts,
          unavailable: [],
          creditsCharged: spend.credits,
          mcpCredits: spend.payload,
        },
      );
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 3. who_should_i_work_with
  // ───────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "who_should_i_work_with",
    {
      title: "Who Should I Work With",
      _meta: viewMeta("who_should_i_work_with"),
      description:
        "A shortlist of people to work with — collaborators, or anyone you are looking to hire or " +
        "commission: designers, developers, photographers, editors. Searches creators by craft or " +
        "keyword and, when you name someone who already fits, adds their lookalikes — then merges the " +
        "two, marks which search found each one, and gives every candidate an id. Every candidate also " +
        "carries the links pulled out of their bio, typed and sorted, so vetting is reading the work " +
        "rather than re-reading a follower count; those links are never fetched here, because they come " +
        "from a field the person being evaluated controls. " +
        "Searches tiktok, instagram, xiaohongshu. " +
        "Not searchable here: youtube, douyin, twitter, reddit, linkedin — if the ask names one of those, " +
        "say it cannot be searched rather than quietly substituting a network that can. " +
        "It does NOT measure audience " +
        "overlap: proving the same people comment under two accounts costs roughly nine credits " +
        "per candidate, so the result says so and tells you how to check a finalist yourself. " +
        "Consumes 2 nooticr credits, or 4 with a seed creator. Use to build a list to vet; " +
        "get_similar_creators is the raw lookalike call.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      outputSchema: OUTPUT_SCHEMAS.who_should_i_work_with,
      inputSchema: z
        .object({
          niche: z.string().describe("Niche or keyword, e.g. 'home fitness'."),
          platform: z
            // youtube 400s upstream and douyin returns user objects with every
            // field null (nooticr-server's CREATOR_SEARCH_PLATFORMS says so next
            // to the implementation). This tool runs the same keyword search, so
            // advertising them here only spends a paid call to fail.
            .enum(["tiktok", "instagram", "xiaohongshu"])
            .optional()
            .describe("Which platform (default tiktok). Lookalikes exist on tiktok and instagram only."),
          seed: z
            .string()
            .optional()
            .describe("A creator who already fits — their lookalikes are added to the shortlist. Costs 2 more credits."),
          count: z.number().int().optional().describe("Candidates from the keyword search (default 8, max 20)."),
        })
        .strict(),
    },
    async (args: { niche: string; platform?: string; seed?: string; count?: number }, extra) => {
      const client = await makeClient({ ...extra, arguments: args });
      const platform = (args.platform || "tiktok").toLowerCase();
      const count = clamp(args.count, 8, 1, 20);
      const spend = new Spend();
      const unavailable: Row[] = [];
      const bySource = new Map<string, Row>();

      const add = (raw: Row, source: string) => {
        const username = String(raw.username ?? raw.uniqueId ?? "").replace(/^@/, "");
        if (!username) return;
        const key = username.toLowerCase();
        const existing = bySource.get(key);
        if (existing) {
          // Found by both searches. That agreement is the strongest signal in
          // this payload, so it is recorded rather than deduplicated away.
          const already = String(existing.foundBy ?? "");
          if (already && already !== source) existing.foundBy = "both";
          return;
        }
        bySource.set(key, {
          ...raw,
          id: `creator:${platform}:${key}`,
          username,
          followers: numberOf(raw.followers ?? raw.followerCount),
          foundBy: source,
          // What the host should go and read. Pulled out of the bio here
          // rather than left for the model to spot inside prose — see
          // collab.ts for why they are typed and why we do not open them.
          links: extractLinks(
            String(raw.signature ?? raw.bio ?? ""),
            typeof raw.externalUrl === "string" ? raw.externalUrl : undefined,
          ),
        });
      };

      try {
        const res = await client.callTool("search_creators", { keyword: args.niche, platform, count });
        const structured = structuredOf(res);
        spend.record("search_creators", structured);
        for (const c of rowsOf(structured.creators)) add(c, "search");
      } catch (err) {
        spend.attempted("search_creators");
        unavailable.push({ via: "search_creators", reason: reason(err) });
      }

      if (args.seed) {
        try {
          const res = await client.callTool("get_similar_creators", {
            username: normaliseHandle(args.seed),
            platform,
          });
          const structured = structuredOf(res);
          spend.record("get_similar_creators", structured);
          for (const c of rowsOf(structured.creators)) add(c, "similar");
        } catch (err) {
          // A seed on a platform with no lookalike endpoint, or a handle that
          // does not resolve. The keyword half still stands on its own.
          spend.attempted("get_similar_creators");
          unavailable.push({ via: "get_similar_creators", reason: reason(err) });
        }
      }

      const creators = [...bySource.values()].sort(
        (a, b) =>
          (a.foundBy === "both" ? 0 : 1) - (b.foundBy === "both" ? 0 : 1) ||
          numberOf(b.followers) - numberOf(a.followers),
      );

      const withLinks = creators.filter(
        (c) => Array.isArray(c.links) && (c.links as unknown[]).length > 0,
      ).length;

      return evidence(
        [
          collabGuidance({ niche: args.niche, found: creators.length, seed: args.seed, platform }),
          "",
          vettingGuidance(creators.length, withLinks),
        ].join("\n"),
        {
          mode: "evidence",
          tool: "who_should_i_work_with",
          rubric: COLLAB_RUBRIC,
          withLinks,
          evidenceFrom: args.seed ? ["search_creators", "get_similar_creators"] : ["search_creators"],
          niche: args.niche,
          platform,
          seed: args.seed ? normaliseHandle(args.seed) : null,
          creators,
          foundBoth: creators.filter((c) => c.foundBy === "both").length,
          audienceOverlap: {
            attempted: false,
            reason:
              "Overlap needs a post list plus several comment fetches per candidate — about 9 " +
              `credits each, roughly ${creators.length * 9} for this shortlist — so it is the ` +
              "user's call, not a silent charge.",
            howTo:
              "For one or two finalists, call answer_my_audience on each account and intersect " +
              "the commenter handles. That is the real signal, measured rather than guessed.",
          },
          unavailable,
          creditsCharged: spend.credits,
          mcpCredits: spend.payload,
        },
      );
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 4. why_did_this_underperform
  //
  // Not compare_posts. That answers "why did A beat B" from two URLs a person
  // already suspects; this answers "is this even bad, and against what", which
  // needs the creator's own distribution rather than a second post.
  // ───────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "why_did_this_underperform",
    {
      title: "Why Did This Underperform",
      _meta: viewMeta("why_did_this_underperform"),
      description:
        "One post measured against the creator's own recent median rather than against another " +
        "post. Fetches the post, fetches that creator's recent window, excludes the post from its " +
        "own baseline, and returns where it actually sits in the distribution — median, " +
        "quartiles, ratio and percentile — so the answer can be 'this is a normal result, not a " +
        "failure'. Consumes 3 nooticr credits (1 for the post, 2 for the window). Use when you " +
        "have one post and no comparison; compare_posts is for two URLs you already picked.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      outputSchema: OUTPUT_SCHEMAS.why_did_this_underperform,
      inputSchema: z
        .object({
          url: z.string().describe("The post to explain."),
          username: z
            .string()
            .optional()
            .describe("Whose baseline to use. Read from the post when the platform names its creator."),
          platform: z.string().optional().describe("Platform of the creator's feed. Read from the post when it says."),
          window: z.number().int().optional().describe("Posts in the comparison window (default 12, max 30)."),
          metric: metricArg,
        })
        .strict(),
    },
    async (
      args: { url: string; username?: string; platform?: string; window?: number; metric?: Metric },
      extra,
    ) => {
      const client = await makeClient({ ...extra, arguments: args });
      const windowSize = clamp(args.window, 12, 3, 30);
      const metric: Metric = args.metric ?? "views";
      const spend = new Spend();

      let post: Row;
      try {
        const res = await client.callTool("get_social_media", { url: args.url });
        const structured = structuredOf(res);
        spend.record("get_social_media", structured);
        post = (structured.post ?? structured) as Row;
      } catch (err) {
        return failed("why_did_this_underperform could not fetch the post", err);
      }

      const handle = normaliseHandle(
        args.username || String(post.creatorHandle ?? post.author ?? post.username ?? ""),
      );
      const platform = (args.platform || String(post.platform ?? "") || platformFromUrl(args.url) || "tiktok").toLowerCase();
      const value = metricOf(post, metric);

      if (!handle) {
        // One credit spent, and the comparison this tool exists for is
        // impossible without knowing whose baseline to build. Say which
        // argument fixes it rather than comparing against nothing.
        return evidence(
          `This post's stats, but no creator to measure them against — the platform did not name ` +
            `one and no \`username\` was given. Pass \`username\` to build the baseline. The post ` +
            `did ${value.toLocaleString("en-US")} ${metric}, which on its own says nothing about ` +
            `whether that is good for this account.\n${ownIt}`,
          {
            mode: "evidence",
            tool: "why_did_this_underperform",
            url: args.url,
            post,
            metric,
            metricValue: value,
            baseline: null,
            standing: null,
            window: [],
            unavailable: [{ via: "get_user_posts", reason: "the post names no creator and no username was given" }],
            creditsCharged: spend.credits,
            mcpCredits: spend.payload,
          },
        );
      }

      let feed: Row[] = [];
      const unavailable: Row[] = [];
      try {
        const res = await client.callTool("get_user_posts", {
          username: handle,
          platform,
          limit: windowSize,
        });
        const structured = structuredOf(res);
        spend.record("get_user_posts", structured);
        feed = rowsOf(structured.posts);
      } catch (err) {
        spend.attempted("get_user_posts");
        unavailable.push({ via: "get_user_posts", reason: reason(err) });
      }

      // Measuring a post partly against itself flatters a flop and blunts a
      // breakout, and get_user_posts almost always returns the post in
      // question, so it comes back out before anything is computed.
      const others = excluding(feed, { url: args.url, id: String(post.id ?? "") });
      const values = others.map((p) => metricOf(p, metric));
      const baseline = distributionOf(values);
      const where = standing(value, values);
      const window = others
        .map((p, i) => scored(p, i, metric, values))
        .sort((a, b) => numberOf(b.metricValue) - numberOf(a.metricValue));

      return evidence(
        underperformGuidance({ metric, where, baseline, window: window.length }),
        {
          mode: "evidence",
          tool: "why_did_this_underperform",
          evidenceFrom: ["get_social_media", "get_user_posts"],
          url: args.url,
          username: handle,
          platform,
          metric,
          metricValue: value,
          // standing lives on the post too, not only as a sibling field —
          // postCard's standingBadge reads p.standing, and nesting it here is
          // what makes the ratio-vs-baseline verdict this tool computes
          // actually show up on the card instead of only in the chat text.
          post: { ...post, postId: postIdOf(post, 0), standing: where },
          baseline,
          standing: where,
          window,
          unavailable,
          creditsCharged: spend.credits,
          mcpCredits: spend.payload,
        },
      );
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 5. what_should_i_make_next — demand against supply.
  //
  // Either half alone is the familiar failure. A niche sweep produces "gaps"
  // that are gaps because nobody wants them; a comment read produces requests
  // with no way to know the topic is already saturated. The answer is in the
  // intersection, and the intersection needs both fetches in one result.
  // ───────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "what_should_i_make_next",
    {
      title: "What Should I Make Next",
      _meta: viewMeta("what_should_i_make_next"),
      description:
        "Demand and supply in one result. Reads the comments on a creator's own recent posts for " +
        "what their audience explicitly asks for, sweeps the niche for what is already being " +
        "made, and returns both with ids so an idea can be traced back to the comment that asked " +
        "for it. A gap nobody asked for is noise; a request nobody serves is the opportunity. " +
        "Names the niche from the creator's most-used hashtag when you do not give one. " +
        "Consumes 2 nooticr credits for the post list, 2 per post read for comments, and 2 for the " +
        "niche sweep — 12 at the default of 4 posts. Use to decide what to film; niche_report " +
        "covers the supply half alone.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      outputSchema: OUTPUT_SCHEMAS.what_should_i_make_next,
      inputSchema: z
        .object({
          username: z.string().describe("Your handle, with or without @."),
          platform: z.string().optional().describe(PLATFORM_ARG),
          niche: z
            .string()
            .optional()
            .describe("Niche for the supply sweep. Defaults to this creator's most frequent hashtag."),
          limit: z.number().int().optional().describe("Your posts to read comments on (default 4, max 8). This is the price."),
          commentsPerPost: z.number().int().optional().describe("Comments per post (default 25, max 50)."),
          supplyLimit: z.number().int().optional().describe("Posts in the niche sweep (default 12, max 30). One fetch either way."),
        })
        .strict(),
    },
    async (
      args: {
        username: string;
        platform?: string;
        niche?: string;
        limit?: number;
        commentsPerPost?: number;
        supplyLimit?: number;
      },
      extra,
    ) => {
      const client = await makeClient({ ...extra, arguments: args });
      const handle = normaliseHandle(args.username);
      const platform = (args.platform || "tiktok").toLowerCase();
      const cap = clamp(args.limit, 4, 1, 8);
      const perPost = clamp(args.commentsPerPost, 25, 1, 50);
      const supplyCap = clamp(args.supplyLimit, 12, 1, 30);
      const spend = new Spend();
      const unavailable: Row[] = [];

      let feed: Row[];
      try {
        const res = await client.callTool("get_user_posts", { username: handle, platform, limit: cap });
        const structured = structuredOf(res);
        spend.record("get_user_posts", structured);
        feed = rowsOf(structured.posts);
      } catch (err) {
        return failed("what_should_i_make_next could not list your posts", err);
      }

      const mine = feed.slice(0, cap);
      // A niche nobody named. The creator's own most-used hashtag is a
      // deterministic answer drawn from material already paid for, which is
      // better than guessing and much better than failing the call — and the
      // guidance tells the model to sanity-check it before trusting the sweep.
      const tally = new Map<string, number>();
      for (const post of mine) {
        for (const tag of Array.isArray(post.hashtags) ? post.hashtags : []) {
          const clean = String(tag ?? "").replace(/^#/, "").trim().toLowerCase();
          if (clean.length > 2) tally.set(clean, (tally.get(clean) ?? 0) + 1);
        }
      }
      const topTag = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
      const niche = args.niche || topTag?.[0] || "";
      const nicheSource = args.niche ? "argument" : topTag ? "hashtags" : "none";

      const fanOut = costOf([
        ...mine.map(() => "get_post_comments"),
        ...(niche ? ["discover_social_posts"] : []),
      ]);
      const decision = await confirmSpend(server.server, {
        credits: fanOut,
        summary:
          `Read the comments on ${mine.length} of @${handle}'s posts` +
          (niche ? ` and sweep the "${niche}" niche for what already exists.` : "."),
        cheaper: 'Lower "limit" to read fewer of your own posts.',
      });
      if (!decision.proceed) {
        return declinedResult(fanOut, "That demand-and-supply read", 'Lower "limit" to read fewer of your own posts.');
      }

      const demand: Row[] = [];
      let asks = 0;
      let commentCount = 0;
      for (const [index, post] of mine.entries()) {
        const url = String(post.externalUrl ?? post.url ?? "");
        const id = postIdOf(post, index);
        if (!url) {
          unavailable.push({ postId: id, url: null, reason: "the post carries no permalink" });
          continue;
        }
        try {
          const res = await client.callTool("get_post_comments", { url, limit: perPost });
          const structured = structuredOf(res);
          spend.record("get_post_comments", structured);
          const comments = rowsOf(structured.comments)
            .map((c) => {
              const text = String(c.text ?? "").trim();
              if (!text) return null;
              const signals = replySignals(text);
              return {
                id: commentIdFor(id, c),
                text,
                author: String(c.author ?? c.username ?? "").replace(/^@/, ""),
                likes: numberOf(c.likes),
                asking: signals.includes("asks for something to be made") || signals.includes("asks for information"),
                signals,
              };
            })
            .filter((c): c is NonNullable<typeof c> => c !== null)
            .sort((a, b) => Number(b.asking) - Number(a.asking) || b.likes - a.likes);
          commentCount += comments.length;
          asks += comments.filter((c) => c.asking).length;
          demand.push({
            postId: id,
            url,
            title: post.title ?? post.caption ?? "",
            views: numberOf(post.views),
            // The platform's own keyword clustering, already fetched and
            // already paid for. It is evidence too.
            themes: structured.themes ?? [],
            comments,
          });
        } catch (err) {
          spend.attempted("get_post_comments");
          unavailable.push({ postId: id, url, reason: reason(err) });
        }
      }

      let supply: Row[] = [];
      if (niche) {
        try {
          const res = await client.callTool("discover_social_posts", {
            niche,
            platform,
            limit: supplyCap,
          });
          const structured = structuredOf(res);
          spend.record("discover_social_posts", structured);
          supply = rowsOf(structured.posts).map((p, i) => ({
            ...p,
            postId: postIdOf(p, i),
            postedAt: postDate(p),
          }));
        } catch (err) {
          spend.attempted("discover_social_posts");
          unavailable.push({ via: "discover_social_posts", reason: reason(err) });
        }
      } else {
        unavailable.push({
          via: "discover_social_posts",
          reason: "no niche was given and the posts carry no hashtags to infer one from",
        });
      }

      const supplyValues = supply.map((p) => metricOf(p, "views"));
      const myValues = mine.map((p) => metricOf(p, "views"));

      return evidence(
        nextGuidance({
          handle,
          niche: niche || "(none)",
          nicheSource,
          demandComments: commentCount,
          asks,
          supplyPosts: supply.length,
          failed: unavailable.length,
        }),
        {
          mode: "evidence",
          tool: "what_should_i_make_next",
          evidenceFrom: ["get_user_posts", "get_post_comments", "discover_social_posts"],
          username: handle,
          platform,
          niche: niche || null,
          nicheSource,
          demand,
          demandComments: commentCount,
          askCount: asks,
          supply,
          // Both medians, so "already saturated" and "big for me" are numbers
          // rather than impressions.
          supplyBaseline: distributionOf(supplyValues),
          yourBaseline: distributionOf(myValues),
          posts: supply,
          unavailable,
          creditsCharged: spend.credits,
          mcpCredits: spend.payload,
        },
      );
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // The other half of answer_my_audience: the model hands back what it drafted
  // and this draws it, in the surface built for triaging comments. Costs
  // nothing and fetches nothing — everything it needs is already in context.
  // ───────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "show_audience_replies",
    {
      title: "Show Audience Replies",
      _meta: viewMeta("show_audience_replies"),
      description:
        "Lay out the replies you drafted from answer_my_audience so a person can read them. " +
        "Free, and makes no requests — it only draws what you pass it. It does NOT send " +
        "anything: no nooticr connection can post a comment, so each row is a draft for the " +
        "creator to copy into the app themselves. Each comment shows with what you decided to do " +
        "about it and your draft underneath, grouped under its post, so they can work through " +
        "them one at a time and skip the rest. Call this after you have drafted the replies, not " +
        "instead of drafting them.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // Draws what it is given; reaches nothing.
        openWorldHint: false,
      },
      outputSchema: OUTPUT_SCHEMAS.show_audience_replies,
      inputSchema: z
        .object({
          username: z.string().describe("Whose audience this is, with or without @."),
          summary: z.string().optional().describe("What the comment section is asking for, in a sentence or two."),
          replies: z
            .array(
              z.object({
                id: z.string().describe("The comment id from answer_my_audience, so the row addresses the same comment."),
                comment: z.string().describe("What they wrote."),
                author: z.string().optional(),
                likes: z.number().optional(),
                postUrl: z.string().optional().describe("The post it was left on — rows are grouped by it."),
                postTitle: z.string().optional(),
                postedAt: z.string().optional(),
                draft: z
                  .string()
                  .optional()
                  .describe("The reply, in the creator's voice, for them to paste in themselves."),
                kind: z
                  .enum(["answer", "pin", "make_a_video", "escalate", "ignore"])
                  .optional()
                  .describe(
                    "What the creator should do about it by hand — nothing here acts on their " +
                      "behalf. Becomes the filter chip they triage by.",
                  ),
                why: z.string().optional().describe("Why you decided that, if it is not obvious."),
              }),
            )
            .describe("One entry per comment you decided about."),
          themes: z.array(z.string()).optional().describe("What keeps coming up across them."),
          nextSteps: z.array(z.string()).optional().describe("What to do beyond replying."),
        })
        .strict(),
    },
    async (args: {
      username: string;
      summary?: string;
      replies: Array<Record<string, unknown>>;
      themes?: string[];
      nextSteps?: string[];
    }) => {
      const handle = normaliseHandle(args.username);
      const counts: Record<string, number> = {};
      for (const r of args.replies) {
        const kind = String(r.kind ?? "answer");
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
      // Grouped by the post, because that is the unit a person acts on: you
      // open one post and answer everything under it, not one comment from
      // each of six posts in turn.
      const groups = new Map<string, Row>();
      for (const r of args.replies) {
        const url = String(r.postUrl ?? "");
        const key = url || "(unknown post)";
        let group = groups.get(key);
        if (!group) {
          groups.set(
            key,
            (group = {
              post: {
                platform: platformFromUrl(url),
                title: String(r.postTitle ?? ""),
                externalUrl: url || null,
              },
              postIsAboutTerm: false,
              mentionCount: 0,
              mentions: [] as Row[],
            }),
          );
        }
        (group.mentions as Row[]).push({
          id: r.id,
          text: r.comment,
          username: r.author ?? "",
          likes: r.likes ?? 0,
          postedAt: r.postedAt ?? null,
          category: r.kind ?? "answer",
          // The view draws `note` under the comment, which is where the draft
          // has to be for a person to triage it without opening anything.
          note: r.draft ?? r.why ?? null,
          draft: r.draft ?? null,
          why: r.why ?? null,
          hits: 1,
        });
        group.mentionCount = (group.mentions as Row[]).length;
      }
      const threads = [...groups.values()];
      const drafted = args.replies.filter((r) => String(r.draft ?? "").trim()).length;

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Showing ${args.replies.length} comment${args.replies.length === 1 ? "" : "s"} with ` +
              `${drafted} drafted repl${drafted === 1 ? "y" : "ies"} for @${handle} to send ` +
              `themselves — nothing here posts them.` +
              (args.summary ? ` ${args.summary}` : ""),
          },
        ],
        // term + threads is what the monitoring view keys off, so this renders
        // through the surface a brand sweep and a comment review already use.
        structuredContent: {
          review: true,
          term: `@${handle}`,
          username: handle,
          summary: args.summary ?? null,
          totalMentions: args.replies.length,
          drafted,
          byCategory: counts,
          themes: args.themes ?? [],
          nextSteps: args.nextSteps ?? [],
          threads,
          // Nothing was fetched, so nothing was charged.
          mcpCredits: { cost: 0 },
        },
      };
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 7. search_spoken_mentions
  //
  // search_mentions reads captions, post bodies and comments — text a brand
  // can be named in without anyone ever saying it out loud, and it stays
  // silent about the rant that says the name three times on camera and never
  // once in writing. This closes that gap the way every tool here does:
  // existing calls, composed. Narrow to candidates with discover_social_posts
  // / get_user_posts, transcribe the survivors with get_post_transcript
  // (which reads a platform's own caption track, not our own speech
  // recognition — see its docstring in tools.ts), and search the words.
  // TikTok and YouTube only, because those are the only two networks that
  // call answers for; asking about anything else would bill for a fetch that
  // cannot succeed.
  //
  // The one thing this fan-out has to hold that the others do not: there is
  // no cheap first call that reveals how many candidates are worth
  // transcribing, the way a watchlist length or an already-fetched post list
  // does elsewhere in this file. A wide niche can return far more candidates
  // than are worth reading to find three hits, so `maxTranscripts` is a hard,
  // server-clamped ceiling (see MAX_SPOKEN_TRANSCRIPTS in spend.ts) rather
  // than a suggestion, and the whole worst case — narrowing plus the ceiling
  // — is confirmed before a single call is made, the same way search_mentions
  // confirms a worst case from its own arguments alone.
  // ───────────────────────────────────────────────────────────────────────────
  const SPOKEN_TRANSCRIBE_BUDGET_MS = 12_000;
  server.registerTool(
    "search_spoken_mentions",
    {
      title: "Search Spoken Mentions",
      _meta: viewMeta("search_spoken_mentions"),
      description:
        "Brand mentions people SAY but never type. search_mentions reads captions, post bodies " +
        "and comments — text — so a video that names a brand only out loud is invisible to it. " +
        "This reads the words actually spoken, from the platform's own caption track (not our own " +
        "speech recognition — see get_post_transcript), and searches them for a term. Narrows to " +
        "candidate posts first (a niche/keyword sweep, named creator handles, and/or your " +
        "watchlist), transcribes only the most-viewed survivors up to a hard ceiling you set, and " +
        "returns the matched line with surrounding context so tone can be judged. TikTok and " +
        "YouTube only — the only two networks whose posts carry a caption track this cheaply — " +
        "and even there a video with no captions is invisible to this tool; coverage is real but " +
        "partial, and the result says how many candidates were found, transcribed and matched so " +
        "the gap is never silent. Costs 2 nooticr credits per platform a niche is searched on, 2 " +
        "per creator handle checked (including ones added by useWatchlist), and 1 per transcript " +
        "actually fetched — never more than `maxTranscripts` transcripts, whatever the candidate " +
        "count. Above 6 credits worst-case it asks first, like search_mentions. Use when a term " +
        "might be spoken on camera but not written anywhere; search_mentions is for what people " +
        "typed.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      outputSchema: OUTPUT_SCHEMAS.search_spoken_mentions,
      inputSchema: z
        .object({
          term: z
            .string()
            .describe(
              "Brand, product or person to listen for, e.g. 'nooticr'. Matched case-insensitively " +
                "on whole words, so 'nike' will not match inside 'nikeisha'.",
            ),
          platforms: z
            .array(z.enum(["tiktok", "youtube"]))
            .optional()
            .describe(
              "Which networks to check (default: both). These are the only two whose posts carry " +
                "a caption track this tool can read.",
            ),
          niche: z
            .string()
            .optional()
            .describe(
              "Niche or keyword for a candidate sweep, e.g. 'skincare'. Provide this, usernames, " +
                "useWatchlist, or any combination — at least one is required.",
            ),
          usernames: z
            .array(z.string())
            .optional()
            .describe(
              "Specific creator handles to check, with or without @. Checked on every platform in " +
                "`platforms`.",
            ),
          useWatchlist: z
            .boolean()
            .optional()
            .describe(
              "Also check your watchlisted creators who are on tiktok or youtube. Looking the " +
                "list up is free; each creator it adds is still priced like any other handle.",
            ),
          candidateLimit: z
            .number()
            .int()
            .optional()
            .describe(
              "Posts pulled per narrowing call, before the transcript ceiling is applied (default " +
                "15, max 25). Finds more candidates at the same narrowing cost — does not raise " +
                "transcript spend on its own.",
            ),
          maxTranscripts: z
            .number()
            .int()
            .optional()
            .describe(
              "Hard ceiling on transcripts fetched, at 1 credit each (default 8, max " +
                `${MAX_SPOKEN_TRANSCRIPTS}). The most-viewed candidates are read first, so lowering ` +
                "this trades completeness for cost rather than dropping posts at random.",
            ),
        })
        .strict(),
    },
    async (
      args: {
        term: string;
        platforms?: string[];
        niche?: string;
        usernames?: string[];
        useWatchlist?: boolean;
        candidateLimit?: number;
        maxTranscripts?: number;
      },
      extra,
    ) => {
      const client = await makeClient({ ...extra, arguments: args });
      const term = String(args.term ?? "").trim();
      if (!term) {
        return {
          content: [{ type: "text" as const, text: "search_spoken_mentions needs a term to listen for." }],
          isError: true as const,
        };
      }
      const platforms = [
        ...new Set(
          (args.platforms && args.platforms.length ? args.platforms : ["tiktok", "youtube"]).map((p) =>
            String(p).toLowerCase(),
          ),
        ),
      ].filter((p) => p === "tiktok" || p === "youtube");
      const explicitHandles = [...new Set((args.usernames ?? []).map(normaliseHandle).filter(Boolean))];

      // A watchlist handle already knows its own platform, so it is checked
      // once there rather than once per requested platform — the same
      // precision track_competitor already applies when it reads this store.
      let watchlistUnits: Array<{ handle: string; platform: string }> = [];
      let watchlistTotal = 0;
      if (args.useWatchlist) {
        try {
          const owner = await watchlistOwner(client);
          const entries = await store.list(owner);
          const inScope = entries.filter((e) => (platforms as string[]).includes(e.platform));
          watchlistTotal = inScope.length;
          watchlistUnits = inScope.map((e) => ({ handle: e.handle, platform: e.platform }));
        } catch {
          // A watchlist that will not answer costs nothing added from it —
          // same as an empty one, not a reason to fail the whole call.
        }
      }

      const handleUnits: Array<{ handle: string; platform: string }> = [
        ...explicitHandles.flatMap((handle) => platforms.map((platform) => ({ handle, platform }))),
        ...watchlistUnits,
      ].slice(0, MAX_SPOKEN_HANDLE_CALLS);

      if (!args.niche && !handleUnits.length) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "search_spoken_mentions needs a niche/keyword, one or more creator handles, or " +
                "useWatchlist — nothing was fetched, so nothing was charged.",
            },
          ],
          isError: true as const,
        };
      }

      const candidateLimit = clamp(args.candidateLimit, 15, 1, 25);
      const maxTranscripts = clamp(args.maxTranscripts, 8, 1, MAX_SPOKEN_TRANSCRIPTS);

      // The full worst case, from arguments alone: every narrowing call runs,
      // and the ceiling's worth of transcripts is fetched. Confirmed before
      // any call is made — actual spend is very often less, and the guidance
      // says so, but nobody is ever asked to approve a number smaller than
      // what could actually happen.
      const worstCase = costOf([
        ...Array(args.niche ? platforms.length : 0).fill("discover_social_posts"),
        ...Array(handleUnits.length).fill("get_user_posts"),
        ...Array(maxTranscripts).fill("get_post_transcript"),
      ]);
      const decision = await confirmSpend(server.server, {
        credits: worstCase,
        summary:
          `Search for spoken mentions of "${term}" on ${platforms.join(" and ")}` +
          (args.niche ? `, sweeping "${args.niche}"` : "") +
          (handleUnits.length
            ? ` and checking ${handleUnits.length} creator${handleUnits.length === 1 ? "" : "s"}`
            : "") +
          `, transcribing up to ${maxTranscripts} of the results.`,
        cheaper: 'Lower "maxTranscripts", or narrow "platforms"/"usernames", to spend less.',
      });
      if (!decision.proceed) {
        return declinedResult(
          worstCase,
          "That spoken-mention search",
          'Lower "maxTranscripts", or narrow "platforms"/"usernames", to spend less.',
        );
      }

      const spend = new Spend();
      const candidatesByKey = new Map<string, Row>();
      const narrowingFailures: Row[] = [];
      const addCandidate = (raw: Row, source: string) => {
        const url = String(raw.externalUrl ?? raw.url ?? "");
        const key =
          url || `${String(raw.platform ?? "")}:${String(raw.title ?? raw.caption ?? "")}:${candidatesByKey.size}`;
        if (candidatesByKey.has(key)) return;
        candidatesByKey.set(key, { ...raw, foundVia: source });
      };

      if (args.niche) {
        for (const platform of platforms) {
          try {
            const res = await client.callTool("discover_social_posts", {
              niche: args.niche,
              platform,
              limit: candidateLimit,
            });
            const structured = structuredOf(res);
            spend.record("discover_social_posts", structured);
            for (const p of rowsOf(structured.posts)) addCandidate(p, "niche_search");
          } catch (err) {
            spend.attempted("discover_social_posts");
            narrowingFailures.push({ via: "discover_social_posts", platform, reason: reason(err) });
          }
        }
      }
      for (const { handle, platform } of handleUnits) {
        try {
          const res = await client.callTool("get_user_posts", { username: handle, platform, limit: candidateLimit });
          const structured = structuredOf(res);
          spend.record("get_user_posts", structured);
          for (const p of rowsOf(structured.posts)) addCandidate(p, `handle:${handle}`);
        } catch (err) {
          spend.attempted("get_user_posts");
          narrowingFailures.push({ via: "get_user_posts", handle, platform, reason: reason(err) });
        }
      }

      // Most-viewed first: the ceiling should spend its transcripts on the
      // candidates most likely to matter, not on whichever a platform
      // happened to return first.
      const candidates = [...candidatesByKey.values()].sort((a, b) => numberOf(b.views) - numberOf(a.views));
      const considered = candidates.length;
      const toCheck = candidates.slice(0, maxTranscripts);
      const ceilingReached = considered > toCheck.length;

      const baseFields = {
        mode: "evidence" as const,
        tool: "search_spoken_mentions",
        term,
        platforms,
        niche: args.niche ?? null,
        usernames: explicitHandles,
        watchlistChecked: watchlistTotal,
        maxTranscripts,
      };

      if (!toCheck.length) {
        return evidence(
          `No candidate posts were found on ${platforms.join(" and ")}` +
            (args.niche ? ` for "${args.niche}"` : "") +
            `. ${spend.credits} credit${spend.credits === 1 ? "" : "s"} were spent narrowing and ` +
            "none of it reached a transcript.",
          {
            ...baseFields,
            candidatesConsidered: 0,
            transcribed: 0,
            transcriptsAvailable: 0,
            matched: 0,
            ceilingReached: false,
            hits: [],
            posts: [],
            unavailable: narrowingFailures,
            creditsCharged: spend.credits,
            mcpCredits: spend.payload,
          },
        );
      }

      const hits: Row[] = [];
      const unavailable: Row[] = [...narrowingFailures];
      let transcribed = 0;
      let transcriptsAvailable = 0;

      for (const [index, post] of toCheck.entries()) {
        const url = String(post.externalUrl ?? post.url ?? "");
        const id = postIdOf(post, index);
        if (!url) {
          unavailable.push({ postId: id, reason: "the post carries no permalink to fetch a transcript from" });
          continue;
        }
        transcribed++;
        try {
          // A speech-to-text fallback can come back "transcribing: true,
          // retryAfterMs" — the job is accepted and running, not a caption-track
          // miss — and treating it as one would silently misreport every post
          // whose answer just hadn't finished yet. Poll it out under a bounded
          // budget so one slow job can't hang the whole search; the first
          // callTool above already spent this post's credit, and every retry
          // below re-reads the same cached job rather than spending again.
          let structured = structuredOf(await client.callTool("get_post_transcript", { url }));
          spend.record("get_post_transcript", structured);
          const pollStartedAt = Date.now();
          while (structured.transcribing && Date.now() - pollStartedAt < SPOKEN_TRANSCRIBE_BUDGET_MS) {
            const waitMs = Math.min(Number(structured.retryAfterMs) || 1000, 5000);
            await new Promise((r) => setTimeout(r, waitMs));
            structured = structuredOf(await client.callTool("get_post_transcript", { url }));
          }
          if (structured.transcribing) {
            unavailable.push({
              postId: id,
              url,
              reason: "still listening to this post's audio — try again shortly",
            });
            continue;
          }
          if (!structured.available) {
            unavailable.push({ postId: id, url, reason: String(structured.reason ?? "no caption track") });
            continue;
          }
          transcriptsAvailable++;
          const { excerpts, matchCount } = matchExcerpts(String(structured.transcript ?? ""), term);
          if (matchCount > 0) {
            hits.push({
              post: { ...post, postId: id, postedAt: postDate(post) },
              postId: id,
              matchCount,
              excerpts,
              wordCount: numberOf(structured.wordCount),
              language: structured.language ?? null,
              autoGenerated: !!structured.autoGenerated,
            });
          }
        } catch (err) {
          spend.attempted("get_post_transcript");
          unavailable.push({ postId: id, url, reason: reason(err) });
        }
      }

      // Loudest match first, then reach — the same ordering principle as the
      // rest of this file: what the sweep found, ranked by how much it says.
      hits.sort(
        (a, b) =>
          numberOf(b.matchCount) - numberOf(a.matchCount) ||
          numberOf((b.post as Row)?.views) - numberOf((a.post as Row)?.views),
      );

      return evidence(
        spokenMentionGuidance({
          term,
          platforms,
          considered,
          transcribed,
          transcriptsAvailable,
          matched: hits.length,
          maxTranscripts,
          ceilingReached,
          failed: unavailable.length,
        }),
        {
          ...baseFields,
          evidenceFrom: [
            ...(args.niche ? ["discover_social_posts"] : []),
            ...(handleUnits.length ? ["get_user_posts"] : []),
            "get_post_transcript",
          ],
          candidatesConsidered: considered,
          transcribed,
          transcriptsAvailable,
          matched: hits.length,
          ceilingReached,
          hits,
          posts: hits.map((h) => h.post as Row),
          unavailable,
          creditsCharged: spend.credits,
          mcpCredits: spend.payload,
        },
      );
    },
  );
}
