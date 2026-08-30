import type {
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
  DataSourceObservation,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  BLUESKY_CASCADE_INPUT_SCHEMA,
  BLUESKY_CASCADE_OUTPUT_SCHEMA,
} from "./bluesky-public-posts.schemas.js";

const XRPC_PREFIX = "/xrpc/";
const SEARCH_PATH = `${XRPC_PREFIX}app.bsky.feed.searchPosts`;
const AUTHOR_FEED_PATH = `${XRPC_PREFIX}app.bsky.feed.getAuthorFeed`;
const FEED_PATH = `${XRPC_PREFIX}app.bsky.feed.getFeed`;
const LIST_FEED_PATH = `${XRPC_PREFIX}app.bsky.feed.getListFeed`;
const THREAD_PATH = `${XRPC_PREFIX}app.bsky.feed.getPostThread`;

type SearchSource = {
  mode: "search";
  query: string;
  sort?: "latest" | "top";
  author?: string;
  mentions?: string;
  language?: string;
  domain?: string;
  url?: string;
  tags?: string[];
};
type AuthorSource = {
  mode: "author-feed";
  actor: string;
  filter?:
    | "posts_with_replies"
    | "posts_no_replies"
    | "posts_with_media"
    | "posts_and_author_threads"
    | "posts_with_video";
  includePins?: boolean;
};
type FeedSource = { mode: "feed"; feedUri: string };
type ListSource = { mode: "list-feed"; listUri: string };
type BlueskySource = SearchSource | AuthorSource | FeedSource | ListSource;

interface BlueskyCascadeInput {
  source: BlueskySource;
  startDateTime?: string;
  endDateTime?: string;
  pageSize?: number;
  expandThreads?: boolean;
  maxThreads?: number;
  threadDepth?: number;
  threadParentHeight?: number;
}

interface NormalizedQuery {
  source: BlueskySource;
  startDateTime: string | null;
  endDateTime: string | null;
  pageSize: number;
  expandThreads: boolean;
  maxThreads: number;
  threadDepth: number;
  threadParentHeight: number;
}

interface NormalizedPost {
  uri: string;
  cid: string | null;
  author: { did: string; handle: string; displayName: string | null };
  createdAt: string | null;
  indexedAt: string | null;
  timestampUtc: string | null;
  timestampSource: "record.createdAt" | "indexedAt" | null;
  text: string;
  languages: string[];
  reply: { rootUri: string | null; parentUri: string | null } | null;
  counters: {
    replyCount: number | null;
    repostCount: number | null;
    likeCount: number | null;
    quoteCount: number | null;
  };
}

interface ThreadNode {
  state: "post" | "blocked" | "not-found";
  uri: string;
  parentUri: string | null;
  depth: number;
  post: NormalizedPost | null;
}

interface SeedPage {
  pageNumber: number;
  inputRecords: number;
  selectedRecords: number;
}

export const blueskyPublicPostsConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "bluesky.public-posts",
  capabilityVersion: "1.0.0",
  minimumCliVersion: "0.0.55",
  provider: { providerId: "bluesky", name: "Bluesky AppView" },
  sourceCategory: "public-social-media-posts",
  endpoints: [
    {
      endpointId: "bluesky-public-appview",
      baseUrl: "https://public.api.bsky.app",
      pathPrefixes: [XRPC_PREFIX],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/json"],
    },
  ],
  license: {
    name: "Bluesky public-service terms and AT Protocol public content",
    url: "https://bsky.social/about/support/tos",
    restrictions: [
      "Public posts remain user-generated content and may be deleted, moderated, blocked, mislabeled, or unsafe.",
      "Respect Bluesky terms, community rules, privacy expectations, applicable law, and downstream research ethics.",
      "Do not use account or post data as identity verification, factual ground truth, or a representative-opinion sample.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 45_000,
    maxRequestBytes: 2_048,
    maxResponseBytes: 20_000_000,
    maxPages: 100,
    maxRecords: 5_000,
    maxRetries: 4,
    maxRetryDelayMs: 120_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-current",
    description:
      "Results are AppView snapshots at request time; indexing, federation, moderation, deletion, and counter updates can lag or change.",
  },
  limitations: [
    "Search syntax, ranking, hit counts, feed algorithms, and cursor reach are provider dependent and do not guarantee exhaustive retrieval.",
    "Author, custom, and list feeds are views rather than repository-complete archives and may contain reposts or algorithmically selected items.",
    "Thread responses can contain blocked or missing nodes and are not paginated; depth and record caps can truncate a cascade.",
    "Post timestamps are client-declared createdAt values when available, with indexedAt only as a fallback; neither proves when an event occurred.",
    "The connector reads public text and metadata only; it does not fetch media bytes, private views, authenticated viewer state, profiles, likes, or follower graphs.",
  ],
  discovery: {
    source: {
      maintainedBy: "Bluesky Social PBC and the AT Protocol open-source project",
      summary:
        "Public Bluesky AppView projections of posts, author/custom/list feeds, and reply-thread structures.",
      description:
        "Bluesky is a decentralized social application built on AT Protocol. The public AppView hydrates indexed public records into searchable post and feed views with mutable counters and moderation-dependent visibility.",
      coverage: {
        geographic:
          "Global public Bluesky/AT Protocol content visible through the selected AppView.",
        temporal:
          "Current indexed AppView holdings within caller filters and bounded cursor reach; no archive-completeness guarantee.",
        granularity:
          "One normalized public post seed plus optional flattened reply-thread nodes for each selected seed.",
      },
    },
    summary: "Fetch bounded public Bluesky post seeds and optionally expand their reply cascades.",
    description:
      "This read-only capability selects public post seeds from search, an author feed, a custom feed, or a list feed; applies an optional UTC timestamp window; and optionally flattens getPostThread results under shared request and record budgets.",
    provides: [
      "Public post text, author DID and handle, created/indexed timestamps, language tags, reply linkage, and mutable engagement counters when present.",
      "Four explicit public seed-source modes with cursor-bounded retrieval and client-side UTC filtering.",
      "Flattened reply cascades with parent URI, depth, blocked/not-found states, per-seed failures, and explicit truncation.",
    ],
    doesNotProvide: [
      "Private or authenticated feeds, viewer-specific state, direct messages, account credentials, or write actions.",
      "Media bytes, link targets, profile histories, follower graphs, complete firehose/repository archives, or deleted content recovery.",
      "Representative public opinion, verified identity, factual verification, causal diffusion claims, or sentiment labels.",
    ],
    selectionHints: [
      "Use search for topic discovery, author-feed for one public actor view, feed for a known generator AT-URI, and list-feed for a known public list AT-URI.",
      "Enable thread expansion only when reply topology matters; seed-only retrieval is cheaper and leaves more request budget for pagination.",
      "Treat counters, ranking, missing nodes, and moderation visibility as snapshot properties and retain the execution receipt.",
      "Use a repository/firehose-specific workflow when exhaustive AT Protocol records are required.",
    ],
    typicalUseCases: [
      "Collect a bounded set of public posts matching a research query and inspect their visible reply structures.",
      "Compare visible discussion cascades seeded from a known author, custom feed, or public list.",
    ],
    sourceDocumentation: [
      {
        title: "Bluesky API hosts and public AppView guidance",
        url: "https://docs.bsky.app/docs/advanced-guides/api-directory",
      },
      {
        title: "app.bsky.feed searchPosts Lexicon",
        url: "https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/searchPosts.json",
      },
      {
        title: "app.bsky.feed getPostThread Lexicon",
        url: "https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getPostThread.json",
      },
      {
        title: "Bluesky read-after-write and AppView indexing guidance",
        url: "https://docs.bsky.app/docs/advanced-guides/read-after-write",
      },
      { title: "Bluesky Terms of Service", url: "https://bsky.social/about/support/tos" },
      {
        title: "Bluesky Community Guidelines",
        url: "https://bsky.social/about/support/community-guidelines",
      },
    ],
  },
  operations: [
    {
      operationId: "fetch-cascades",
      operationVersion: "1.0.0",
      summary: "Fetch public Bluesky seed posts and optional reply cascades.",
      description:
        "Reads exactly one public seed-source mode, applies optional inclusive/exclusive UTC bounds, expands a bounded number of getPostThread snapshots, and reports missing, blocked, truncated, or failed portions without writing artifacts.",
      inputSchema: BLUESKY_CASCADE_INPUT_SCHEMA,
      outputSchema: BLUESKY_CASCADE_OUTPUT_SCHEMA,
      execute: executeBlueskyCascades,
    },
  ],
};

async function executeBlueskyCascades(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeQuery(context.input as BlueskyCascadeInput);
  const seedPosts: NormalizedPost[] = [];
  const seenSeeds = new Set<string>();
  const pages: SeedPage[] = [];
  const observations: DataSourceObservation[] = [];
  const failures: Array<{ seedUri: string; code: string }> = [];
  const failureValues: unknown[] = [];
  let cursor: string | undefined;
  let stopReason: "completed" | "no-results" | "max-pages" | "max-records" | "partial" =
    "completed";
  let seedFailure: unknown;
  let seedPageNumber = 0;
  let requestCount = 0;

  while (requestCount < context.limits.maxPages) {
    seedPageNumber += 1;
    requestCount += 1;
    try {
      const response = await context.http.request({
        endpointId: "bluesky-public-appview",
        method: "GET",
        path: sourcePath(query.source),
        query: sourceParameters(query, cursor),
      });
      const parsed = parseSeedPage(response.json(), query.source.mode);
      observations.push({
        ...response.observation,
        sourceId: `seed:${query.source.mode}:page:${seedPageNumber}`,
      });
      let selectedRecords = 0;
      for (const value of parsed.posts) {
        if (seedPosts.length >= context.limits.maxRecords) break;
        const record = normalizePost(value);
        if (!insideWindow(record, query)) continue;
        if (seenSeeds.has(record.uri)) continue;
        seenSeeds.add(record.uri);
        seedPosts.push(record);
        selectedRecords += 1;
      }
      pages.push({
        pageNumber: seedPageNumber,
        inputRecords: parsed.posts.length,
        selectedRecords,
      });

      if (seedPosts.length >= context.limits.maxRecords) {
        stopReason =
          parsed.cursor || parsed.posts.length > selectedRecords ? "max-records" : "completed";
        break;
      }
      if (!parsed.cursor) {
        stopReason = seedPageNumber === 1 && seedPosts.length === 0 ? "no-results" : "completed";
        break;
      }
      if (parsed.cursor === cursor) {
        throw providerInvalid("Bluesky returned a repeated pagination cursor.");
      }
      cursor = parsed.cursor;
      if (requestCount >= context.limits.maxPages) {
        stopReason = "max-pages";
        break;
      }
    } catch (error) {
      if (pages.length === 0) throw normalizeProviderFailure(error);
      seedFailure = error;
      stopReason = "partial";
      break;
    }
  }

  const cascades: Array<{
    seedUri: string;
    rootUri: string | null;
    nodes: ThreadNode[];
    truncated: boolean;
  }> = [];
  let emittedRecords = seedPosts.length;
  let expansionTruncated = false;
  if (query.expandThreads && stopReason !== "partial") {
    for (const seed of seedPosts.slice(0, query.maxThreads)) {
      if (requestCount >= context.limits.maxPages || emittedRecords >= context.limits.maxRecords) {
        expansionTruncated = true;
        break;
      }
      try {
        requestCount += 1;
        const response = await context.http.request({
          endpointId: "bluesky-public-appview",
          method: "GET",
          path: THREAD_PATH,
          query: {
            uri: seed.uri,
            depth: query.threadDepth,
            parentHeight: query.threadParentHeight,
          },
        });
        observations.push({ ...response.observation, sourceId: `thread:${seed.uri}` });
        const available = context.limits.maxRecords - emittedRecords;
        const parsed = parseThread(response.json(), seed.uri, available);
        emittedRecords += parsed.nodes.length;
        cascades.push({ seedUri: seed.uri, ...parsed });
        expansionTruncated ||= parsed.truncated;
      } catch (error) {
        const normalized = normalizeProviderFailure(error);
        failures.push({ seedUri: seed.uri, code: normalized.code });
        failureValues.push(normalized);
      }
    }
    if (seedPosts.length > query.maxThreads) expansionTruncated = true;
  }

  if (expansionTruncated && stopReason !== "partial") {
    stopReason = emittedRecords >= context.limits.maxRecords ? "max-records" : "max-pages";
  }
  const partial = seedFailure !== undefined || failures.length > 0;
  if (partial) stopReason = "partial";
  const missingIdentifiers = failures.map((item) => item.seedUri);
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message:
            seedFailure === undefined
              ? "Some Bluesky reply threads could not be retrieved or validated."
              : "A later Bluesky seed page could not be retrieved or validated.",
          retryable: [seedFailure, ...failureValues].some(
            (value) => value instanceof DataRuntimeError && (value.options.retryable ?? false),
          ),
          userActionRequired: false,
          details: {
            ...(missingIdentifiers.length > 0 ? { missingSeedUris: missingIdentifiers } : {}),
            ...(seedFailure === undefined ? {} : { failedSeedPage: seedPageNumber }),
          },
        },
      ]
    : [];
  const truncated = stopReason === "max-pages" || stopReason === "max-records";
  const missing =
    missingIdentifiers.length > 0
      ? [{ kind: "range" as const, identifiers: missingIdentifiers }]
      : seedFailure === undefined
        ? undefined
        : [{ kind: "page" as const, identifiers: [String(seedPageNumber)] }];

  return {
    status: partial ? "partial" : "success",
    data: {
      source: {
        providerId: "bluesky",
        baseUrl: "https://public.api.bsky.app",
        publicContent: true,
        userGeneratedContent: true,
      },
      query,
      pages,
      seedPosts,
      cascades,
      failures,
      stopReason,
    },
    summary: {
      recordCount: emittedRecords,
      pageCount: observations.length,
      chunkCount: cascades.length,
      truncated,
      completeness: partial ? "partial" : "complete",
      ...(missing ? { missing } : {}),
    },
    warnings: [
      "Bluesky posts are mutable user-generated content and can contain unsafe or personal information.",
      "Search ranking, feeds, moderation visibility, timestamps, and engagement counters are provider snapshots rather than representative or verified evidence.",
      ...(truncated ? ["The result stopped at an explicit request or record limit."] : []),
    ],
    errors,
    observations,
  };
}

function normalizeQuery(input: BlueskyCascadeInput): NormalizedQuery {
  const startDateTime = input.startDateTime ? exactDateTime(input.startDateTime) : null;
  const endDateTime = input.endDateTime ? exactDateTime(input.endDateTime) : null;
  if (startDateTime && endDateTime && startDateTime >= endDateTime) {
    throw new DataRuntimeError(
      "invalid-request",
      "Bluesky startDateTime must precede endDateTime.",
    );
  }
  return {
    source: normalizeSource(input.source),
    startDateTime,
    endDateTime,
    pageSize: input.pageSize ?? 50,
    expandThreads: input.expandThreads ?? true,
    maxThreads: input.maxThreads ?? 20,
    threadDepth: input.threadDepth ?? 8,
    threadParentHeight: input.threadParentHeight ?? 5,
  };
}

function normalizeSource(source: BlueskySource): BlueskySource {
  switch (source.mode) {
    case "search": {
      const query = nonBlankInput(source.query, "Bluesky search query");
      const tags = source.tags?.map((value) => nonBlankInput(value, "Bluesky search tag"));
      if (tags && new Set(tags).size !== tags.length) {
        throw new DataRuntimeError(
          "invalid-request",
          "Bluesky search tags must remain unique after whitespace normalization.",
        );
      }
      return {
        mode: "search",
        query,
        sort: source.sort ?? "latest",
        ...optionalText("author", source.author),
        ...optionalText("mentions", source.mentions),
        ...optionalText("language", source.language),
        ...optionalText("domain", source.domain),
        ...optionalText("url", source.url),
        ...(tags ? { tags: tags.sort(codePointOrder) } : {}),
      };
    }
    case "author-feed":
      return {
        mode: "author-feed",
        actor: nonBlankInput(source.actor, "Bluesky author-feed actor"),
        filter: source.filter ?? "posts_with_replies",
        includePins: source.includePins ?? false,
      };
    case "feed":
      return { mode: "feed", feedUri: source.feedUri.trim() };
    case "list-feed":
      return { mode: "list-feed", listUri: source.listUri.trim() };
  }
}

function optionalText<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  const normalized = value?.trim();
  return normalized ? ({ [key]: normalized } as Record<K, string>) : {};
}

function nonBlankInput(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DataRuntimeError("invalid-request", `${label} must not be blank.`);
  return normalized;
}

function sourcePath(source: BlueskySource): string {
  switch (source.mode) {
    case "search":
      return SEARCH_PATH;
    case "author-feed":
      return AUTHOR_FEED_PATH;
    case "feed":
      return FEED_PATH;
    case "list-feed":
      return LIST_FEED_PATH;
  }
}

function sourceParameters(
  query: NormalizedQuery,
  cursor: string | undefined,
): Record<string, boolean | number | string | string[]> {
  const common = { limit: query.pageSize, ...(cursor ? { cursor } : {}) };
  switch (query.source.mode) {
    case "search":
      return {
        ...common,
        q: query.source.query,
        sort: query.source.sort ?? "latest",
        ...(query.startDateTime ? { since: query.startDateTime } : {}),
        ...(query.endDateTime ? { until: query.endDateTime } : {}),
        ...(query.source.author ? { author: query.source.author } : {}),
        ...(query.source.mentions ? { mentions: query.source.mentions } : {}),
        ...(query.source.language ? { lang: query.source.language } : {}),
        ...(query.source.domain ? { domain: query.source.domain } : {}),
        ...(query.source.url ? { url: query.source.url } : {}),
        ...(query.source.tags ? { tag: query.source.tags } : {}),
      };
    case "author-feed":
      return {
        ...common,
        actor: query.source.actor,
        filter: query.source.filter ?? "posts_with_replies",
        includePins: query.source.includePins ?? false,
      };
    case "feed":
      return { ...common, feed: query.source.feedUri };
    case "list-feed":
      return { ...common, list: query.source.listUri };
  }
}

function parseSeedPage(
  value: unknown,
  mode: BlueskySource["mode"],
): { posts: unknown[]; cursor?: string } {
  const root = object(value, "Bluesky seed response");
  const rawItems = mode === "search" ? root.posts : root.feed;
  if (!Array.isArray(rawItems)) {
    throw providerInvalid("Bluesky seed response does not contain the expected item array.");
  }
  const posts = rawItems.map((item) => {
    if (mode === "search") return item;
    return object(item, "Bluesky feed item").post;
  });
  const cursor = root.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor)) {
    throw providerInvalid("Bluesky pagination cursor is invalid.");
  }
  return { posts, ...(typeof cursor === "string" ? { cursor } : {}) };
}

function normalizePost(value: unknown): NormalizedPost {
  const root = object(value, "Bluesky post view");
  const uri = requiredText(root.uri, "Bluesky post URI");
  const author = object(root.author, "Bluesky post author");
  const record = object(root.record, "Bluesky post record");
  const createdAt = optionalDateTime(record.createdAt);
  const indexedAt = optionalDateTime(root.indexedAt);
  const timestampUtc = createdAt ?? indexedAt;
  const reply = objectOrNull(record.reply);
  const replyRoot = reply ? objectOrNull(reply.root) : null;
  const replyParent = reply ? objectOrNull(reply.parent) : null;
  return {
    uri,
    cid: optionalString(root.cid),
    author: {
      did: requiredText(author.did, "Bluesky author DID"),
      handle: requiredText(author.handle, "Bluesky author handle"),
      displayName: optionalString(author.displayName),
    },
    createdAt,
    indexedAt,
    timestampUtc,
    timestampSource: createdAt ? "record.createdAt" : indexedAt ? "indexedAt" : null,
    text: typeof record.text === "string" ? record.text : "",
    languages: stringArray(record.langs),
    reply: reply
      ? {
          rootUri: optionalString(replyRoot?.uri),
          parentUri: optionalString(replyParent?.uri),
        }
      : null,
    counters: {
      replyCount: nonNegativeInteger(root.replyCount),
      repostCount: nonNegativeInteger(root.repostCount),
      likeCount: nonNegativeInteger(root.likeCount),
      quoteCount: nonNegativeInteger(root.quoteCount),
    },
  };
}

function insideWindow(post: NormalizedPost, query: NormalizedQuery): boolean {
  if (!query.startDateTime && !query.endDateTime) return true;
  if (!post.timestampUtc) return false;
  if (query.startDateTime && post.timestampUtc < query.startDateTime) return false;
  return !(query.endDateTime && post.timestampUtc >= query.endDateTime);
}

function parseThread(
  value: unknown,
  requestedUri: string,
  maxRecords: number,
): { rootUri: string | null; nodes: ThreadNode[]; truncated: boolean } {
  const root = object(value, "Bluesky thread response");
  if (!("thread" in root)) throw providerInvalid("Bluesky thread response is missing thread.");
  const nodes: ThreadNode[] = [];
  const visited = new Set<string>();
  const stack: Array<{ value: unknown; parentUri: string | null; depth: number }> = [
    { value: root.thread, parentUri: null, depth: 0 },
  ];
  let truncated = false;
  while (stack.length > 0) {
    if (nodes.length >= maxRecords) {
      truncated = true;
      break;
    }
    const current = stack.pop()!;
    const item = object(current.value, "Bluesky thread node");
    const type = typeof item.$type === "string" ? item.$type : "";
    if (type.endsWith("#threadViewPost") || (!type && item.post)) {
      const post = normalizePost(item.post);
      if (visited.has(post.uri)) continue;
      visited.add(post.uri);
      nodes.push({
        state: "post",
        uri: post.uri,
        parentUri: current.parentUri,
        depth: current.depth,
        post,
      });
      const replies = item.replies ?? [];
      if (!Array.isArray(replies)) throw providerInvalid("Bluesky thread replies are invalid.");
      for (let index = replies.length - 1; index >= 0; index -= 1) {
        stack.push({ value: replies[index], parentUri: post.uri, depth: current.depth + 1 });
      }
      continue;
    }
    if (type.endsWith("#blockedPost") || type.endsWith("#notFoundPost")) {
      const uri = requiredText(item.uri, "Bluesky missing thread-node URI");
      if (visited.has(uri)) continue;
      visited.add(uri);
      nodes.push({
        state: type.endsWith("#blockedPost") ? "blocked" : "not-found",
        uri,
        parentUri: current.parentUri,
        depth: current.depth,
        post: null,
      });
      continue;
    }
    throw providerInvalid(`Bluesky returned an unsupported thread node for ${requestedUri}.`);
  }
  return { rootUri: nodes[0]?.uri ?? null, nodes, truncated };
}

function exactDateTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DataRuntimeError(
      "invalid-request",
      "Bluesky datetime values must be valid UTC timestamps.",
    );
  }
  return parsed.toISOString();
}

function optionalDateTime(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerInvalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw providerInvalid(`${label} is missing.`);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeProviderFailure(error: unknown): DataRuntimeError {
  return error instanceof DataRuntimeError
    ? error
    : providerInvalid("Bluesky response could not be normalized.");
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}

function codePointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
