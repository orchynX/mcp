/**
 * The parts of the server a host reads before it calls anything: the hints it
 * uses to decide whether a tool needs a confirmation, and the prompts it offers
 * a user who does not know any tool names.
 *
 * Both were measured against the live server before this existed: 11 of 24
 * tools carried annotations and `prompts/list` returned an empty array. The
 * gaps were invisible because nothing failed — a host simply prompted more
 * often than it needed to, and offered nothing up front.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/shared/tools.js";
import type { NooticrClient } from "../src/shared/nooticr.js";

function dummyClient(structured: unknown = {}): NooticrClient {
  return { callTool: async () => ({ contentBlocks: [], structured }) } as unknown as NooticrClient;
}

async function connect(structured: unknown = {}) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const server = createMcpServer(async () => dummyClient(structured));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return client;
}

// The one tool with a side effect: it opens a Stripe checkout session, and a
// second call is a second session.
const NOT_READ_ONLY = [
  "buy_nooticr_credits",
  // The watchlist tools write: two change stored state, and the catch-up also
  // moves every baseline forward, which is why it is not idempotent either.
  "watch_creator",
  "unwatch_creator",
  "catch_up_watchlist",
  // Same shape as the catch-up: it fetches, and for a creator already on the
  // watchlist it moves that creator's "last tracked" marker forward, so a
  // second call in a row does not answer the same question as the first.
  "track_competitor",
  // Creates a recurring watch (on confirm) / stops one — both change stored
  // state. list_brand_watches only reads, so it stays out of this list.
  "create_brand_watch",
  "stop_brand_watch",
  // Own-account generation: each spends the workspace's plan AI credits.
  "draft_post",
  "generate_captions",
  "generate_content_plan",
  // Same billing, same conclusion — this one was missed because it writes
  // nothing of the user's, but the credits alone put it here.
  "growth_brief",
  // Starts an async analysis job every call (a fresh jobId, spending plan AI
  // credits) — same conclusion as the generation tools above, for the same
  // reason connect_social_account is on this list: a retry is not a no-op.
  "analyze_product",
  // Each creates or patches a real row in the workspace's own products table.
  "create_product",
  "update_product",
  // The exception to the billing rule: free, and still not read-only.
  // Given a postId it saves the review and score onto that scheduled post,
  // overwriting the previous one.
  "review_post",
  // Mints a fresh OAuth state row every call — a retry is not a no-op.
  "connect_social_account",
];

describe("tool annotations", () => {
  it("every tool carries them", async () => {
    const { tools } = await (await connect()).listTools();
    const bare = tools.filter((t) => !t.annotations || Object.keys(t.annotations).length === 0);
    expect(bare.map((t) => t.name), "tools a host cannot reason about").toEqual([]);
    expect(tools).toHaveLength(64);
  });

  it("marks read-only exactly where it is true", async () => {
    const { tools } = await (await connect()).listTools();
    const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
    // A host auto-approves on readOnlyHint, so a wrong `true` here is worse
    // than a missing annotation: it waves through a real side effect.
    expect(writes).toEqual([...NOT_READ_ONLY].sort());
  });

  it("does not claim a checkout is idempotent", async () => {
    const { tools } = await (await connect()).listTools();
    const buy = tools.find((t) => t.name === "buy_nooticr_credits");
    expect(buy?.annotations?.idempotentHint).toBe(false);
    expect(buy?.annotations?.destructiveHint).toBe(false);
  });

  it("says which tools reach outside nooticr", async () => {
    const { tools } = await (await connect()).listTools();
    const closed = tools.filter((t) => t.annotations?.openWorldHint === false).map((t) => t.name);
    // Only the account tools stay inside nooticr; everything else hits a platform.
    // The watchlist tools that only touch stored state are closed-world too.
    expect(closed.sort()).toEqual([
      // Own-account tools: every one of these reads or generates for the
      // caller's own product, never a third party's — nothing here reaches
      // outside nooticr. analyze_product is the one exception (see below):
      // it fetches an excerpt of the product's own website, a real reach
      // outside nooticr, so it is deliberately absent from this list.
      "analyze_product_status",
      "check_nooticr_credits",
      // Mints a connect link (nooticr's own oauth_start), never a third-party
      // read or write.
      "connect_social_account",
      // All three touch nooticr's own stored watch state; the sweep a watch
      // schedules runs later, server-side, never inside the call itself.
      "create_brand_watch",
      "create_product",
      "draft_post",
      "generate_captions",
      "generate_content_plan",
      "get_brand_playbook",
      "get_content_plan",
      "get_post_performance",
      "get_scheduled_posts",
      "get_video_stats",
      "growth_brief",
      "list_brand_watches",
      "list_own_apps",
      // Reads nooticr's own connection records, not a third-party network.
      "list_social_connections",
      "nooticr_login",
      // Formats what the caller classified into text for a tracker on another
      // server. It holds no tracker credential and makes the call to nobody:
      // the filing happens on whichever server the host also has connected.
      "prepare_handoff",
      "review_post",
      // The show_* family: each draws what the caller already wrote/fetched
      // and reaches nothing.
      "show_analysis",
      // Renders drafts the caller already wrote; fetches nothing, and cannot
      // send them either — no connection carries comment-write permission.
      "show_audience_replies",
      // Renders scores the caller reached by reading a candidate's links —
      // and it is the caller that opened them, not us. See collab.ts for why
      // this server never fetches a URL out of a stranger's bio.
      "show_collab_shortlist",
      // Renders classifications the caller already made; fetches nothing.
      "show_comment_review",
      "show_comparison",
      "show_hooks",
      "show_repurposed_post",
      "show_variants",
      "stop_brand_watch",
      "unwatch_creator",
      "update_product",
      "watch_creator",
    ]);
  });
});

describe("prompts", () => {
  it("offers the workflows a user cannot guess tool names for", async () => {
    const { prompts } = await (await connect()).listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "check_my_draft",
      "monitor_my_brand",
      "niche_briefing",
      "post_teardown",
      "repurpose_everywhere",
      "set_up_my_product",
      "teardown_creator",
      "watch_a_competitor",
      "what_to_make_next",
      "why_this_won",
    ]);
    for (const p of prompts) {
      expect(p.title, `${p.name} has no title to show`).toBeTruthy();
      expect(p.description, `${p.name} has no description`).toBeTruthy();
    }
  });

  it("asks only for what it cannot infer", async () => {
    const { prompts } = await (await connect()).listPrompts();
    const required = Object.fromEntries(
      prompts.map((p) => [p.name, (p.arguments ?? []).filter((a) => a.required).map((a) => a.name)]),
    );
    expect(required).toEqual({
      teardown_creator: ["handle"],
      niche_briefing: ["niche"],
      check_my_draft: ["draft"],
      post_teardown: ["url"],
      why_this_won: ["urls"],
      what_to_make_next: ["url"],
      repurpose_everywhere: ["url"],
      set_up_my_product: [],
      watch_a_competitor: ["competitor"],
      monitor_my_brand: ["brand"],
    });
  });

  it("orders the work cheapest-evidence-first", async () => {
    const client = await connect();
    const got = await client.getPrompt({
      name: "post_teardown",
      arguments: { url: "https://www.tiktok.com/@a/video/1" },
    });
    const text = got.messages.map((m) => (m.content as { text: string }).text).join("\n");
    // The transcript is the cheap exact evidence, so it must come before the
    // analysis that would otherwise paraphrase it.
    expect(text.indexOf("get_post_transcript")).toBeLessThan(text.indexOf("analyze_post_fast"));
    expect(text).toContain("https://www.tiktok.com/@a/video/1");
  });

  it("only spends the expensive visual pass when asked for it", async () => {
    const client = await connect();
    const cheap = await client.getPrompt({
      name: "post_teardown",
      arguments: { url: "https://x.com/a/1" },
    });
    const rich = await client.getPrompt({
      name: "post_teardown",
      arguments: { url: "https://x.com/a/1", visuals: "yes" },
    });
    const textOf = (r: Awaited<ReturnType<Client["getPrompt"]>>) =>
      r.messages.map((m) => (m.content as { text: string }).text).join("\n");
    expect(textOf(cheap)).toContain("Skip analyze_post");
    expect(textOf(rich)).not.toContain("Skip analyze_post");
  });

  it("orders the competitor watch cheapest-evidence-first", async () => {
    const client = await connect();
    const got = await client.getPrompt({
      name: "watch_a_competitor",
      arguments: { competitor: "Acme, acme.com" },
    });
    const text = got.messages.map((m) => (m.content as { text: string }).text).join("\n");
    // Discovery before the teardown, the teardown before the free watchlist
    // write, and watching before the paid baseline check that depends on it.
    expect(text.indexOf("search_creators")).toBeLessThan(text.indexOf("analyze_creator_profile"));
    expect(text.indexOf("analyze_creator_profile")).toBeLessThan(text.indexOf("watch_creator"));
    expect(text.indexOf("watch_creator")).toBeLessThan(text.indexOf("track_competitor"));
    expect(text.indexOf("track_competitor")).toBeLessThan(text.indexOf("catch_up_watchlist"));
    expect(text).toContain("Acme, acme.com");
  });

  it("orders brand monitoring cheapest-evidence-first", async () => {
    const client = await connect();
    const got = await client.getPrompt({
      name: "monitor_my_brand",
      arguments: { brand: "nooticr" },
    });
    const text = got.messages.map((m) => (m.content as { text: string }).text).join("\n");
    // The cheaper typed-text sweep before the pricier spoken-mention pass,
    // and classification/filing before the standing watch is even offered.
    // Anchored on the numbered steps, not a bare substring — the prompt also
    // names search_spoken_mentions earlier, in the web-search framing.
    expect(text.indexOf("1. search_mentions")).toBeLessThan(text.indexOf("2. search_spoken_mentions"));
    expect(text.indexOf("2. search_spoken_mentions")).toBeLessThan(text.indexOf("4. prepare_handoff"));
    expect(text.indexOf("4. prepare_handoff")).toBeLessThan(text.indexOf("5. create_brand_watch"));
  });

  it("tells the model to resolve a name to a handle itself before spending anything", async () => {
    const client = await connect();
    const competitor = await client.getPrompt({
      name: "watch_a_competitor",
      arguments: { competitor: "Acme, acme.com" },
    });
    const brand = await client.getPrompt({
      name: "monitor_my_brand",
      arguments: { brand: "nooticr" },
    });
    const textOf = (r: Awaited<ReturnType<Client["getPrompt"]>>) =>
      r.messages.map((m) => (m.content as { text: string }).text).join("\n");
    for (const text of [textOf(competitor), textOf(brand)]) {
      expect(text).toMatch(/web-search/i);
      // Says what a wrong guess costs, so the model does not treat a bad
      // handle and a genuinely quiet account as the same finding.
      expect(text).toContain("2 credits");
      expect(text.toLowerCase()).toContain("returns nothing");
    }
  });

  it("gates create_brand_watch's recurring charge behind a person actually agreeing", async () => {
    const client = await connect();
    const got = await client.getPrompt({
      name: "monitor_my_brand",
      arguments: { brand: "nooticr" },
    });
    const text = got.messages.map((m) => (m.content as { text: string }).text).join("\n");
    expect(text).toContain("two-call quote-then-confirm");
    expect(text).toContain("confirm: true");
    expect(text).toMatch(/never happen without the user actually seeing/i);
  });

  it("is honest that set_up_my_product cannot create a product over MCP", async () => {
    const client = await connect();
    const got = await client.getPrompt({ name: "set_up_my_product", arguments: {} });
    const text = got.messages.map((m) => (m.content as { text: string }).text).join("\n");
    expect(text).toContain("there is no tool here that creates a product");
    expect(text).toContain("https://nooticr.com");
    expect(text).not.toMatch(/web-search/i);
  });
});

describe("output schemas", () => {
  it("every tool says what it returns", async () => {
    const { tools } = await (await connect()).listTools();
    const undeclared = tools.filter((t) => !t.outputSchema).map((t) => t.name);
    expect(undeclared, "tools an agent has to call before it can plan").toEqual([]);
  });

  // The shape belongs to the nooticr backend, not to this repo. The SDK throws
  // on structuredContent that fails its schema, so a schema that constrained
  // would turn a field added upstream into a tool that stopped working for
  // everyone — a self-inflicted outage on someone else's deploy schedule.
  it("survives a field the backend adds tomorrow", async () => {
    const client = await connect({
      platform: "tiktok",
      posts: [{ externalUrl: "https://www.tiktok.com/@a/video/1", views: 5, somethingNew: true }],
      mcpCredits: { cost: 2 },
      aFieldInventedNextQuarter: { nested: [1, 2, 3] },
    });
    const res = await client.callTool({
      name: "discover_social_posts",
      arguments: { niche: "fitness" },
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect((res.structuredContent as { platform?: string })?.platform).toBe("tiktok");
  });

  it("accepts an empty result rather than failing the call", async () => {
    // A niche with no posts is an answer, not an error.
    const client = await connect({});
    const res = await client.callTool({ name: "discover_social_posts", arguments: { niche: "zzz" } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  });

  it("describes the fields callers actually chain on", async () => {
    const { tools } = await (await connect()).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    // externalUrl is the join key: it is what you feed from a feed tool into
    // an analysis one, so it has to be in the declared shape.
    const feed = JSON.stringify(byName.discover_social_posts.outputSchema);
    expect(feed).toContain("externalUrl");
    expect(JSON.stringify(byName.get_post_transcript.outputSchema)).toContain("transcript");
    expect(JSON.stringify(byName.compare_posts.outputSchema)).toContain("winner");
  });
});

// Every tool declared taskSupport "forbidden" — the SDK default, never chosen —
// including analyze_post, which polls a video job for up to POLL_TIMEOUT_MS
// (five minutes). A host had no way to put that in the background.
describe("long-running tools", () => {
  const SLOW = ["analyze_post", "analyze_creator_profile", "understand_social_post"];

  it("accepts a task on the tools that watch a video", async () => {
    const { tools } = await (await connect()).listTools();
    const support = Object.fromEntries(
      tools.map((t) => [t.name, (t as { execution?: { taskSupport?: string } }).execution?.taskSupport]),
    );
    for (const name of SLOW) expect(support[name], name).toBe("optional");
  });

  it("leaves the quick tools alone", async () => {
    const { tools } = await (await connect()).listTools();
    // taskSupport is a floor on how fast a call can return, since the SDK
    // auto-polls at that interval. A tool that answers in a second should not
    // start waiting for one.
    const quick = tools.filter((t) => !SLOW.includes(t.name));
    for (const t of quick) {
      const support = (t as { execution?: { taskSupport?: string } }).execution?.taskSupport;
      expect(support, `${t.name} should not have been made a task tool`).not.toBe("optional");
    }
  });

  // "optional" rather than "required" is the whole compatibility story: a
  // client that knows nothing about tasks must see exactly what it saw before.
  it("still answers a client that asks for no task", async () => {
    const client = await connect({ post: { externalUrl: "https://x/1" }, analysis: { summary: "s" } });
    const res = await client.callTool({
      name: "understand_social_post",
      arguments: { url: "https://www.tiktok.com/@a/video/1" },
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect((res.structuredContent as { analysis?: { summary?: string } })?.analysis?.summary).toBe("s");
  }, 30_000);
});

// The view is sandboxed: a host enforcing the CSP blocks any media host not on
// this list, and ChatGPT logged exactly that ("violates ... media-src"). Adding
// a platform without adding its CDNs ships cards whose media silently fails.
describe("media CSP allowlist", () => {
  const cdnDomains = async () => {
    const client = await connect();
    const res = await client.readResource({ uri: "ui://nooticr/discover_social_posts" });
    const meta = res.contents[0]._meta as { ui?: { csp?: { resourceDomains?: string[] } } };
    return meta?.ui?.csp?.resourceDomains ?? [];
  };

  it.each([
    ["reddit", ["redd.it", "redditstatic.com"]],
    ["weibo", ["sinaimg.cn", "weibocdn.com"]],
    ["tiktok", ["tiktokcdn.com", "tiktokcdn-us.com"]],
    ["instagram", ["cdninstagram.com", "fbcdn.net"]],
  ])("%s media hosts are allowed", async (_platform, hosts) => {
    const domains = (await cdnDomains()).join(" ");
    for (const h of hosts) {
      expect(domains, `${h} is not in the CSP allowlist, so its media is blocked`).toContain(h);
    }
  });

  it("covers every platform the tools advertise", async () => {
    const domains = (await cdnDomains()).join(" ");
    // One representative CDN per platform we let a caller pick.
    const perPlatform: Record<string, string> = {
      tiktok: "tiktokcdn", instagram: "cdninstagram", youtube: "ytimg",
      douyin: "douyinpic", xiaohongshu: "xhscdn", bilibili: "hdslb",
      reddit: "redd.it", weibo: "sinaimg",
    };
    const missing = Object.entries(perPlatform)
      .filter(([, cdn]) => !domains.includes(cdn))
      .map(([p]) => p);
    expect(missing, "platforms whose media the view cannot load").toEqual([]);
  });
});

/**
 * A tool's prose and its schema have to agree about which networks it serves.
 *
 * They did not: search_creators advertised "TikTok, Instagram, Xiaohongshu,
 * YouTube or Douyin" while its enum accepted only the first three, so a model
 * that trusted the sentence and passed platform:"youtube" got a validation
 * error. nooticr-server keeps the canonical list next to the implementation
 * (CREATOR_SEARCH_PLATFORMS) and asserts its own enum against it — but that
 * assertion covers the enum only, in the other repo, so the description here
 * drifted unguarded. This is that missing half.
 *
 * The convention it enforces: name the networks a tool searches, and put the
 * ones it cannot behind "Not searchable here:" so the negative claim is
 * legible to a reader and to this test alike.
 */
describe("tool descriptions do not advertise platforms the schema rejects", () => {
  const PLATFORM_WORDS = [
    "tiktok",
    "instagram",
    "xiaohongshu",
    "youtube",
    "douyin",
    "twitter",
    "reddit",
    "linkedin",
    "weibo",
    "bilibili",
  ];

  it("every platform a description names is either accepted or explicitly excluded", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    const offenders: string[] = [];
    for (const tool of tools) {
      const enumValues = (
        tool.inputSchema as { properties?: { platform?: { enum?: string[] } } }
      )?.properties?.platform?.enum;
      // Only tools that constrain a platform can contradict themselves.
      if (!Array.isArray(enumValues)) continue;

      const description = (tool.description ?? "").toLowerCase();
      // Everything after the marker is a stated limitation, not a claim.
      const [claimed] = description.split("not searchable here:");
      const accepted = new Set(enumValues.map((v) => v.toLowerCase()));

      for (const word of PLATFORM_WORDS) {
        // Word-boundary match so "twitter" is not found inside a URL fragment.
        if (!new RegExp(`\\b${word}\\b`).test(claimed)) continue;
        if (!accepted.has(word)) {
          offenders.push(`${tool.name}: describes ${word}, schema accepts ${[...accepted].join("/")}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("search_creators serves exactly what nooticr-server says it can", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "search_creators");
    const enumValues = (
      tool?.inputSchema as { properties?: { platform?: { enum?: string[] } } }
    )?.properties?.platform?.enum;
    // Mirrors CREATOR_SEARCH_PLATFORMS in nooticr-server's social_import.rs.
    // YouTube 400s upstream; Douyin returns user objects with every field null.
    expect(enumValues).toEqual(["tiktok", "instagram", "xiaohongshu"]);
  });
});
