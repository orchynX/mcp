/**
 * What each backend capability can actually reach, declared once.
 *
 * Every platform claim in this server is a claim about code in a different
 * repository: nooticr-server dispatches the upstream call, and this repo only
 * describes it. The two drifted repeatedly and in both directions —
 * search_creators advertised YouTube and Douyin that its own enum rejected;
 * get_post_comments served Reddit and Weibo and mentioned neither;
 * get_post_transcript claimed a TikTok/YouTube ceiling it does not have. None
 * of it failed a test, because the tests compared this repo's files to each
 * other rather than to the thing that serves the call.
 *
 * So the platforms live here, once, with the dispatcher that backs them named,
 * and `platform-claims.test.ts` holds every tool description to this table.
 * When a capability changes upstream, this file is the one edit, and the test
 * names every description that now disagrees.
 *
 * PROVENANCE — verify against nooticr-server before changing a list. A
 * dispatcher's match arms are evidence of what it PREFERS, not of what it
 * supports: where the fallback arm errors, the arms are the whole set; where
 * the fallback does real work, they are not. Both shapes appear below.
 */

export type Capability = {
  /** The nooticr-server function that serves it. */
  readonly source: string;
  /** Platforms the dispatcher genuinely serves. */
  readonly platforms: readonly string[];
  /** What happens for platforms outside the list, when anything does. */
  readonly beyondList?: string;
  /**
   * True when that fallback is a first-class route rather than a degraded
   * one — the list is then a fast path and no description may present it as
   * the boundary. get_post_transcript did, and was wrong for every platform
   * whose audio is transcribed by listening.
   */
  readonly listIsFastPath?: boolean;
  /** Platforms served, but with a caveat every description must carry. */
  readonly caveats?: Readonly<Record<string, string>>;
  /**
   * Tools whose description enumerates platforms. These must name every
   * platform above and no others — the check that catches a capability the
   * server has and no host is told about.
   */
  readonly enumerating: readonly string[];
  /** Tools backed by this capability that do not list platforms in prose. */
  readonly quiet?: readonly string[];
};

const TEN = [
  "tiktok",
  "instagram",
  "youtube",
  "douyin",
  "xiaohongshu",
  "twitter",
  "bilibili",
  "linkedin",
  "reddit",
  "weibo",
] as const;

export const CAPABILITIES: Readonly<Record<string, Capability>> = {
  /** One post, by URL. */
  postDetail: {
    source: "social_import.rs :: import_social_post → tikhub_post_detail",
    platforms: TEN,
    // The TikHub gate is followed by an ungated oEmbed attempt, so a URL from
    // somewhere else can still come back — thinly. The ten are what is served
    // properly, not a hard ceiling.
    // An ungated oEmbed attempt follows the TikHub gate, but it returns a
    // title and a thumbnail rather than a post, so the ten are still what this
    // serves and a description may name them as the set.
    beyondList: "an ungated oEmbed tail returns thin data for other hosts",
    enumerating: ["get_social_media", "understand_social_post"],
    quiet: ["analyze_post", "analyze_post_fast", "compare_posts", "get_post_frames"],
  },

  /** A post's comment section. */
  comments: {
    source: "social_import.rs :: fetch_post_comments",
    // Ends in `_ => Err(\"unsupported platform\")`, so these nine are the set.
    // Xiaohongshu is absent: TikHub publishes no comment endpoint for it.
    platforms: [
      "tiktok",
      "instagram",
      "youtube",
      "douyin",
      "twitter",
      "bilibili",
      "linkedin",
      "reddit",
      "weibo",
    ],
    enumerating: ["get_post_comments"],
    quiet: ["analyze_comments"],
  },

  /** A named creator's recent posts. */
  userPosts: {
    source: "social_import.rs :: discover_user_posts",
    // Ends in `other => return Err(\"unsupported platform\")`.
    platforms: TEN,
    enumerating: ["analyze_creator_profile"],
    quiet: [
      "get_user_posts",
      "find_hook_pattern",
      "watch_creator",
      "unwatch_creator",
      "track_competitor",
      "catch_up_watchlist",
      "what_should_i_make_next",
      "why_did_this_underperform",
      "answer_my_audience",
    ],
  },

  /** Finding creators by keyword. */
  creatorSearch: {
    source: "social_import.rs :: search_creators (CREATOR_SEARCH_PLATFORMS)",
    platforms: ["tiktok", "instagram", "xiaohongshu"],
    enumerating: ["search_creators", "who_should_i_work_with"],
  },

  /** Lookalikes for a creator who already fits. */
  similarCreators: {
    source: "social_import.rs :: similar_creators",
    platforms: ["tiktok", "instagram"],
    enumerating: ["get_similar_creators"],
  },

  /** Trending audio. */
  sounds: {
    source: "social_import.rs :: discover_sounds",
    platforms: ["tiktok", "instagram"],
    enumerating: ["discover_sounds"],
  },

  /** Surveying a niche. */
  discovery: {
    source: "social_import.rs :: DISCOVERABLE_PLATFORMS",
    platforms: [
      "youtube",
      "tiktok",
      "instagram",
      "douyin",
      "xiaohongshu",
      "twitter",
      "bilibili",
      "reddit",
      "weibo",
    ],
    enumerating: [],
    quiet: ["discover_social_posts", "niche_report", "discover_hashtags"],
  },

  /** The words spoken in a post. */
  transcript: {
    source: "social_import.rs :: fetch_post_transcript",
    // The three arms are the caption-track fast path. The match ends in
    // `_ => transcribe_by_listening(...)`, so everything else is transcribed
    // from the audio — naming these three as a limit is the bug this caught.
    platforms: ["tiktok", "douyin", "youtube"],
    beyondList: "every other platform falls through to speech-to-text",
    listIsFastPath: true,
    enumerating: [],
    quiet: ["get_post_transcript"],
  },

  /** Sweeping networks for a term. */
  mentions: {
    source: "social_import.rs :: search_mentions_across → mentions_under_post",
    platforms: [
      "tiktok",
      "instagram",
      "youtube",
      "twitter",
      "reddit",
      "douyin",
      "xiaohongshu",
      "weibo",
      "bilibili",
    ],
    // The sweep reads each post's comments, and there is no Xiaohongshu comment
    // endpoint. mentions_under_post swallows the failure on purpose, so the
    // gap is silent unless a description says it.
    caveats: { xiaohongshu: "post text only — its comments cannot be fetched" },
    enumerating: ["search_mentions"],
    quiet: ["create_brand_watch", "search_spoken_mentions"],
  },
  /**
   * Writing FOR a platform rather than reading from one. No upstream fetch
   * happens, so nothing here can be unreachable — a target is just a shape the
   * text is written into.
   */
  authoringTarget: {
    source: "no upstream call — the platform is a target, not a source",
    platforms: TEN,
    enumerating: [],
    quiet: ["score_draft", "repurpose_post", "write_hooks", "create_variants", "draft_post"],
  },

  /**
   * Linking an account the workspace owns, which is a different question from
   * whether a network can be read. Gated at runtime on whether the deployment
   * has OAuth credentials for that provider (mcp_tools.rs checks
   * `oauth_config(...).is_none()`), so the list below is what the domain
   * enum permits, not what any given deployment offers.
   */
  accountLink: {
    source: "nooticr_domain::Platform, gated by nooticr_publish::oauth_config",
    platforms: ["tiktok", "instagram", "youtube", "twitter"],
    beyondList: "availability is per-deployment; list_social_connections is the live answer",
    enumerating: [],
    quiet: ["connect_social_account", "list_social_connections"],
  },
} as const;

/** Every platform name the checks know about. */
export const KNOWN_PLATFORMS: readonly string[] = [
  ...new Set(Object.values(CAPABILITIES).flatMap((c) => c.platforms)),
];

/** Which capability a tool belongs to, or undefined when it declares none. */
export function capabilityOf(tool: string): [string, Capability] | undefined {
  for (const [name, cap] of Object.entries(CAPABILITIES)) {
    if (cap.enumerating.includes(tool) || (cap.quiet ?? []).includes(tool)) {
      return [name, cap];
    }
  }
  return undefined;
}
