import type { JsonSchema } from "../contracts.js";

const DATETIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$";
const AT_URI_PATTERN = "^at://[^/]+/[^/]+/[^/]+$";

const SEARCH_SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "query"],
  properties: {
    mode: {
      const: "search",
      description: "Selects the public app.bsky.feed.searchPosts seed source.",
      examples: ["search"],
    },
    query: {
      type: "string",
      minLength: 1,
      maxLength: 1_000,
      description:
        "Provider search query; Bluesky documents search syntax and ranking as implementation dependent.",
      examples: ["climate policy"],
    },
    sort: {
      enum: ["latest", "top"],
      description: "Bluesky search ranking order; latest is the default.",
      examples: ["latest"],
    },
    author: {
      type: "string",
      minLength: 1,
      maxLength: 253,
      description: "Optional Bluesky handle or DID whose posts must match.",
      examples: ["alice.bsky.social"],
    },
    mentions: {
      type: "string",
      minLength: 1,
      maxLength: 253,
      description: "Optional Bluesky handle or DID that matching posts must mention.",
      examples: ["climate.bsky.social"],
    },
    language: {
      type: "string",
      minLength: 2,
      maxLength: 35,
      description: "Optional BCP 47 language tag used by the provider search filter.",
      examples: ["en"],
    },
    domain: {
      type: "string",
      minLength: 1,
      maxLength: 253,
      description: "Optional hostname that matching posts must link to.",
      examples: ["example.org"],
    },
    url: {
      type: "string",
      minLength: 1,
      maxLength: 2_048,
      description: "Optional absolute URL that matching posts must link to.",
      examples: ["https://example.org/report"],
    },
    tags: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      description:
        "Hashtag filters without a leading #; repeated values use the provider's documented AND matching.",
      examples: [["climate", "policy"]],
      items: { type: "string", minLength: 1, maxLength: 64 },
    },
    applyServerTimeFilter: {
      type: "boolean",
      description:
        "Whether searchPosts receives since/until. Set false only for a historical-coverage diagnostic; the client-side UTC window still applies.",
      examples: [true],
    },
  },
} as const;

const AUTHOR_SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "actor"],
  properties: {
    mode: {
      const: "author-feed",
      description: "Selects the public app.bsky.feed.getAuthorFeed seed source.",
      examples: ["author-feed"],
    },
    actor: {
      type: "string",
      minLength: 1,
      maxLength: 253,
      description: "Bluesky handle or DID whose public author feed is requested.",
      examples: ["alice.bsky.social"],
    },
    filter: {
      enum: [
        "posts_with_replies",
        "posts_no_replies",
        "posts_with_media",
        "posts_and_author_threads",
        "posts_with_video",
      ],
      description: "Provider-defined combination of post and repost types to include.",
      examples: ["posts_with_replies"],
    },
    includePins: {
      type: "boolean",
      description: "Whether the provider may include pinned posts in the author feed.",
      examples: [false],
    },
  },
} as const;

const FEED_SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "feedUri"],
  properties: {
    mode: {
      const: "feed",
      description: "Selects app.bsky.feed.getFeed for one public feed-generator AT-URI.",
      examples: ["feed"],
    },
    feedUri: {
      type: "string",
      pattern: AT_URI_PATTERN,
      maxLength: 2_048,
      description: "AT-URI of the public feed-generator record to read.",
      examples: ["at://did:plc:example/app.bsky.feed.generator/news"],
    },
  },
} as const;

const LIST_SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "listUri"],
  properties: {
    mode: {
      const: "list-feed",
      description: "Selects app.bsky.feed.getListFeed for one public list AT-URI.",
      examples: ["list-feed"],
    },
    listUri: {
      type: "string",
      pattern: AT_URI_PATTERN,
      maxLength: 2_048,
      description: "AT-URI of the public list record whose recent feed is requested.",
      examples: ["at://did:plc:example/app.bsky.graph.list/news"],
    },
  },
} as const;

export const BLUESKY_CASCADE_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/bluesky/public-post-cascades-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source"],
  properties: {
    source: {
      oneOf: [SEARCH_SOURCE_SCHEMA, AUTHOR_SOURCE_SCHEMA, FEED_SOURCE_SCHEMA, LIST_SOURCE_SCHEMA],
      description:
        "Exactly one public Bluesky seed source: search, author feed, feed generator, or list feed.",
      examples: [{ mode: "search", query: "climate policy", sort: "latest" }],
    },
    startDateTime: {
      type: "string",
      pattern: DATETIME_PATTERN,
      description:
        "Optional inclusive UTC bound applied to the post record createdAt timestamp, falling back to indexedAt only when createdAt is unavailable.",
      examples: ["2026-03-10T00:00:00Z"],
    },
    endDateTime: {
      type: "string",
      pattern: DATETIME_PATTERN,
      description:
        "Optional exclusive UTC bound applied to the post record createdAt timestamp, falling back to indexedAt only when createdAt is unavailable.",
      examples: ["2026-03-11T00:00:00Z"],
    },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Maximum seed posts requested from the provider per source page.",
      examples: [50],
    },
    expandThreads: {
      type: "boolean",
      description:
        "Whether each selected seed should be expanded through app.bsky.feed.getPostThread.",
      examples: [true],
    },
    maxThreads: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description:
        "Maximum selected seed threads to expand; the operation request and record limits remain authoritative.",
      examples: [20],
    },
    threadDepth: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Maximum reply depth requested from app.bsky.feed.getPostThread.",
      examples: [8],
    },
    threadParentHeight: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Maximum parent-chain height requested for each expanded thread.",
      examples: [5],
    },
  },
} as const satisfies JsonSchema;

const NULLABLE_STRING = { type: ["string", "null"] } as const;

const AUTHOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["did", "handle", "displayName"],
  properties: {
    did: NULLABLE_STRING,
    handle: NULLABLE_STRING,
    displayName: NULLABLE_STRING,
  },
} as const;

const COUNTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["replyCount", "repostCount", "likeCount", "quoteCount"],
  properties: {
    replyCount: { type: ["integer", "null"], minimum: 0 },
    repostCount: { type: ["integer", "null"], minimum: 0 },
    likeCount: { type: ["integer", "null"], minimum: 0 },
    quoteCount: { type: ["integer", "null"], minimum: 0 },
  },
} as const;

const POST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "uri",
    "cid",
    "author",
    "createdAt",
    "indexedAt",
    "timestampUtc",
    "timestampSource",
    "text",
    "languages",
    "reply",
    "counters",
  ],
  properties: {
    uri: { type: "string", minLength: 1 },
    cid: NULLABLE_STRING,
    author: AUTHOR_SCHEMA,
    createdAt: NULLABLE_STRING,
    indexedAt: NULLABLE_STRING,
    timestampUtc: NULLABLE_STRING,
    timestampSource: { enum: ["record.createdAt", "indexedAt", null] },
    text: { type: "string" },
    languages: { type: "array", items: { type: "string", minLength: 1 } },
    reply: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["rootUri", "parentUri"],
          properties: { rootUri: NULLABLE_STRING, parentUri: NULLABLE_STRING },
        },
        { type: "null" },
      ],
    },
    counters: COUNTER_SCHEMA,
  },
} as const;

const THREAD_NODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state", "uri", "parentUri", "depth", "post"],
  properties: {
    state: { enum: ["post", "blocked", "not-found"] },
    uri: NULLABLE_STRING,
    parentUri: NULLABLE_STRING,
    depth: { type: "integer", minimum: 0 },
    post: { anyOf: [POST_SCHEMA, { type: "null" }] },
  },
} as const;

export const BLUESKY_CASCADE_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/bluesky/public-post-cascades-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "source",
    "query",
    "pages",
    "hitsTotal",
    "seedPosts",
    "cascades",
    "failures",
    "stopReason",
  ],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: [
        "providerId",
        "baseUrl",
        "fallbackBaseUrl",
        "fallbackUsed",
        "publicContent",
        "userGeneratedContent",
      ],
      properties: {
        providerId: { const: "bluesky" },
        baseUrl: { const: "https://public.api.bsky.app" },
        fallbackBaseUrl: { const: "https://api.bsky.app" },
        fallbackUsed: { type: "boolean" },
        publicContent: { const: true },
        userGeneratedContent: { const: true },
      },
    },
    query: {
      type: "object",
      additionalProperties: false,
      required: [
        "source",
        "startDateTime",
        "endDateTime",
        "pageSize",
        "expandThreads",
        "maxThreads",
        "threadDepth",
        "threadParentHeight",
      ],
      properties: {
        source: {
          oneOf: [
            SEARCH_SOURCE_SCHEMA,
            AUTHOR_SOURCE_SCHEMA,
            FEED_SOURCE_SCHEMA,
            LIST_SOURCE_SCHEMA,
          ],
        },
        startDateTime: NULLABLE_STRING,
        endDateTime: NULLABLE_STRING,
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
        expandThreads: { type: "boolean" },
        maxThreads: { type: "integer", minimum: 1, maximum: 100 },
        threadDepth: { type: "integer", minimum: 0, maximum: 100 },
        threadParentHeight: { type: "integer", minimum: 0, maximum: 100 },
      },
    },
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pageNumber", "inputRecords", "selectedRecords", "invalidRecords"],
        properties: {
          pageNumber: { type: "integer", minimum: 1 },
          inputRecords: { type: "integer", minimum: 0 },
          selectedRecords: { type: "integer", minimum: 0 },
          invalidRecords: { type: "integer", minimum: 0 },
        },
      },
    },
    hitsTotal: {
      type: ["integer", "null"],
      minimum: 0,
      description: "Provider-reported search hit estimate when searchPosts supplies hitsTotal.",
    },
    seedPosts: { type: "array", items: POST_SCHEMA },
    cascades: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seedUri", "rootUri", "nodes", "truncated", "validation"],
        properties: {
          seedUri: { type: "string", minLength: 1 },
          rootUri: NULLABLE_STRING,
          nodes: { type: "array", items: THREAD_NODE_SCHEMA },
          truncated: { type: "boolean" },
          validation: {
            type: "object",
            additionalProperties: false,
            required: [
              "maxDepth",
              "maxBranchingFactor",
              "orphanCount",
              "missingNodeCount",
              "issues",
            ],
            properties: {
              maxDepth: { type: "integer", minimum: 0 },
              maxBranchingFactor: { type: "integer", minimum: 0 },
              orphanCount: { type: "integer", minimum: 0 },
              missingNodeCount: { type: "integer", minimum: 0 },
              issues: {
                type: "array",
                maxItems: 100,
                items: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
    failures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seedUri", "code"],
        properties: {
          seedUri: { type: "string", minLength: 1 },
          code: { type: "string", minLength: 1 },
        },
      },
    },
    stopReason: {
      enum: ["completed", "no-results", "max-pages", "max-records", "partial"],
    },
  },
} as const satisfies JsonSchema;
