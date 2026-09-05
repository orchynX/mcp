/**
 * Every platform a tool's description names must be one the server can serve,
 * and a tool that enumerates platforms must name all of them.
 *
 * The second half is the one nothing checked before. The tests here compared
 * tools.ts to tools-def.ts, which catches the two files disagreeing but not the
 * two files being wrong together — and they were, for as long as
 * get_post_transcript claimed a TikTok/YouTube ceiling it does not have.
 *
 * The truth lives in src/shared/platform-capabilities.ts, which names the
 * nooticr-server dispatcher behind each list. This drives the checks off the
 * built server, so it reads what a host actually receives.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/shared/tools.js";
import type { NooticrClient } from "../src/shared/nooticr.js";
import { CAPABILITIES, KNOWN_PLATFORMS, capabilityOf } from "../src/shared/platform-capabilities.js";

async function shippedTools() {
  const client = new Client({ name: "platform-claims", version: "1.0.0" });
  const server = createMcpServer(
    async () =>
      ({ callTool: async () => ({ contentBlocks: [], structured: {} }) }) as unknown as NooticrClient,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return (await client.listTools()).tools;
}

/** "x" is how a description spells the network the API calls "twitter". */
const ALIASES: Record<string, string> = { x: "twitter" };

/** Text a tool puts in front of a host: its description plus every describe(). */
function proseOf(tool: { description?: string; inputSchema?: unknown }): string {
  const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> })
    ?.properties;
  const hints = Object.values(props ?? {})
    .map((v) => v?.description ?? "")
    .join(" ");
  return `${tool.description ?? ""} ${hints}`.toLowerCase();
}

/**
 * Platforms a piece of prose claims. Anything after "not searchable here:" is
 * a stated limitation, so it is a claim about absence, not presence.
 */
function claimed(prose: string): Set<string> {
  const [positive] = prose.split("not searchable here:");
  const found = new Set<string>();
  for (const p of KNOWN_PLATFORMS) {
    if (new RegExp(`\\b${p}\\b`).test(positive)) found.add(p);
  }
  for (const [alias, real] of Object.entries(ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(positive)) found.add(real);
  }
  return found;
}

describe("platform claims match what the server serves", () => {
  it("no tool names a platform its capability cannot reach", async () => {
    const offenders: string[] = [];
    for (const tool of await shippedTools()) {
      const found = capabilityOf(tool.name);
      if (!found) continue; // covered by the undeclared-capability test below
      const [capName, cap] = found;
      const serves = new Set(cap.platforms);
      for (const p of claimed(proseOf(tool))) {
        if (!serves.has(p)) {
          offenders.push(`${tool.name} claims ${p}, but ${capName} cannot reach it`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a tool that enumerates platforms names every one its capability serves", async () => {
    // The under-advertising check: a capability the server has and no host is
    // told about is invisible until someone reads the Rust.
    const offenders: string[] = [];
    for (const tool of await shippedTools()) {
      const found = capabilityOf(tool.name);
      if (!found || !found[1].enumerating.includes(tool.name)) continue;
      const [capName, cap] = found;
      const named = claimed(proseOf(tool));
      const missing = cap.platforms.filter((p) => !named.has(p));
      if (missing.length) {
        offenders.push(`${tool.name} does not mention ${missing.join(", ")} — ${capName} serves them`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a capability whose list is only a fast path is not described as a limit", async () => {
    // get_post_transcript named three platforms that are the caption-track
    // route, not the boundary; everything else is transcribed by listening.
    const offenders: string[] = [];
    for (const [capName, cap] of Object.entries(CAPABILITIES)) {
      if (!cap.listIsFastPath) continue;
      for (const name of cap.enumerating) {
        offenders.push(
          `${name} enumerates ${capName}, whose list is a fast path, not a ceiling (${cap.beyondList})`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a caveated platform is caveated in the prose of every tool that reaches it", async () => {
    // Xiaohongshu is swept for mentions and charged the most, and its comments
    // cannot be fetched — silence there means the endpoint, not the audience.
    const offenders: string[] = [];
    const tools = await shippedTools();
    for (const [capName, cap] of Object.entries(CAPABILITIES)) {
      for (const platform of Object.keys(cap.caveats ?? {})) {
        for (const name of [...cap.enumerating, ...(cap.quiet ?? [])]) {
          const tool = tools.find((t) => t.name === name);
          if (!tool) continue;
          const prose = proseOf(tool);
          if (!prose.includes(platform)) continue; // does not raise it at all
          if (!/cannot be fetched|post text only/.test(prose)) {
            offenders.push(`${name} mentions ${platform} without ${capName}'s caveat`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a tool that talks about platforms declares which capability it uses", async () => {
    // Forces a new tool making platform claims to be placed, rather than
    // silently escaping every check above.
    const undeclared: string[] = [];
    for (const tool of await shippedTools()) {
      if (capabilityOf(tool.name)) continue;
      const named = claimed(proseOf(tool));
      if (named.size) {
        undeclared.push(`${tool.name} names ${[...named].sort().join(", ")} but declares no capability`);
      }
    }
    expect(undeclared).toEqual([]);
  });
});
