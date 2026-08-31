import type { JsonSchema } from "../contracts.js";

const RFC3339_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$";

export const GDELT_DOC_SEARCH_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/gdelt/doc-search-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["query", "mode"],
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 1_000,
      description:
        "GDELT DOC 2.0 search expression, including supported quoted phrases and filters.",
      examples: ['"climate change" sourcecountry:us'],
    },
    mode: {
      enum: [
        "artlist",
        "tonechart",
        "timelinevol",
        "timelinevolraw",
        "timelinetone",
        "timelinelang",
        "timelinesourcecountry",
      ],
      description:
        "Closed DOC JSON output mode: article metadata, tone-distribution bins, or a supported timeline.",
      examples: ["artlist"],
    },
    relativeWindow: {
      type: "object",
      additionalProperties: false,
      required: ["value", "unit"],
      description:
        "Rolling lookback ending at provider request time; mutually exclusive with absoluteWindow.",
      examples: [{ value: 24, unit: "hours" }],
      properties: {
        value: {
          type: "integer",
          minimum: 1,
          description:
            "Positive integer lookback amount; minute windows must span at least 15 minutes.",
          examples: [24],
        },
        unit: {
          enum: ["minutes", "hours", "days", "weeks", "months", "years"],
          description: "Time unit encoded by the DOC API TIMESpan parameter.",
          examples: ["hours"],
        },
      },
    },
    absoluteWindow: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      description: "Inclusive UTC search window; mutually exclusive with relativeWindow.",
      examples: [{ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" }],
      properties: {
        from: {
          type: "string",
          pattern: RFC3339_PATTERN,
          description: "UTC lower bound in RFC 3339 form.",
          examples: ["2026-03-01T00:00:00Z"],
        },
        to: {
          type: "string",
          pattern: RFC3339_PATTERN,
          description: "UTC upper bound in RFC 3339 form.",
          examples: ["2026-03-02T00:00:00Z"],
        },
      },
    },
    maxRecords: {
      type: "integer",
      minimum: 1,
      maximum: 250,
      description: "Article-list result limit accepted only when mode is artlist.",
      examples: [75],
    },
    sort: {
      enum: ["datedesc", "dateasc", "tonedesc", "toneasc", "hybridrel"],
      description: "Article-list ordering accepted only when mode is artlist.",
      examples: ["datedesc"],
    },
    timelineSmooth: {
      type: "integer",
      minimum: 0,
      maximum: 30,
      description: "Timeline smoothing window accepted only for timeline modes.",
      examples: [5],
    },
    domains: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      description:
        "Bare domains converted to separate domain: query batches and merged with URL/title de-duplication.",
      examples: [["example.org"]],
      items: { type: "string", minLength: 1, maxLength: 253 },
    },
    exactDomains: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      description:
        "Bare domains converted to separate exact domainis: query batches and merged with URL/title de-duplication.",
      examples: [["epa.gov", "airnow.gov"]],
      items: { type: "string", minLength: 1, maxLength: 253 },
    },
    continueOnQueryError: {
      type: "boolean",
      description:
        "Whether successful split-domain batches remain usable as a partial result when another batch fails.",
      examples: [true],
    },
  },
} as const satisfies JsonSchema;

const NULLABLE_STRING = { type: ["string", "null"] } as const;

const ARTICLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "recordIndex",
    "sourceQuery",
    "url",
    "mobileUrl",
    "title",
    "seenDateTime",
    "socialImageUrl",
    "domain",
    "language",
    "sourceCountry",
  ],
  properties: {
    recordIndex: { type: "integer", minimum: 0 },
    sourceQuery: { type: "string", minLength: 1 },
    url: NULLABLE_STRING,
    mobileUrl: NULLABLE_STRING,
    title: { type: "string" },
    seenDateTime: {
      anyOf: [{ type: "string", pattern: RFC3339_PATTERN }, { type: "null" }],
    },
    socialImageUrl: NULLABLE_STRING,
    domain: { type: "string" },
    language: { type: "string" },
    sourceCountry: { type: "string" },
  },
} as const;

const TIMELINE_POINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dateTime", "value", "norm"],
  properties: {
    dateTime: { type: "string", pattern: RFC3339_PATTERN },
    value: { type: "number" },
    norm: { type: ["number", "null"] },
  },
} as const;

export const GDELT_DOC_SEARCH_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/gdelt/doc-search-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "source",
    "query",
    "kind",
    "queryDetails",
    "batchQueries",
    "queryErrors",
    "articles",
    "timelines",
    "toneBins",
    "stopReason",
  ],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "endpoint", "metadataOnly"],
      properties: {
        providerId: { const: "gdelt" },
        endpoint: { const: "/api/v2/doc/doc" },
        metadataOnly: { const: true },
      },
    },
    query: {
      type: "object",
      additionalProperties: false,
      required: [
        "query",
        "mode",
        "relativeWindow",
        "absoluteWindow",
        "maxRecords",
        "sort",
        "timelineSmooth",
        "domainFilters",
        "continueOnQueryError",
      ],
      properties: {
        query: { type: "string", minLength: 1 },
        mode: {
          enum: [
            "artlist",
            "tonechart",
            "timelinevol",
            "timelinevolraw",
            "timelinetone",
            "timelinelang",
            "timelinesourcecountry",
          ],
        },
        relativeWindow: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["value", "unit"],
              properties: {
                value: { type: "integer", minimum: 1 },
                unit: { enum: ["minutes", "hours", "days", "weeks", "months", "years"] },
              },
            },
          ],
        },
        absoluteWindow: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["from", "to"],
              properties: {
                from: { type: "string", pattern: RFC3339_PATTERN },
                to: { type: "string", pattern: RFC3339_PATTERN },
              },
            },
          ],
        },
        maxRecords: { type: ["integer", "null"], minimum: 1, maximum: 250 },
        sort: {
          anyOf: [
            { enum: ["datedesc", "dateasc", "tonedesc", "toneasc", "hybridrel"] },
            { type: "null" },
          ],
        },
        timelineSmooth: { type: ["integer", "null"], minimum: 0, maximum: 30 },
        domainFilters: { type: "array", items: { type: "string", minLength: 1 } },
        continueOnQueryError: { type: "boolean" },
      },
    },
    kind: { enum: ["articles", "timeline", "tone-chart"] },
    queryDetails: {
      type: ["object", "null"],
      additionalProperties: {
        anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
      },
    },
    batchQueries: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["query", "queryDetails"],
        properties: {
          query: { type: "string", minLength: 1 },
          queryDetails: {
            type: ["object", "null"],
            additionalProperties: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "null" },
              ],
            },
          },
        },
      },
    },
    queryErrors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["query", "code"],
        properties: {
          query: { type: "string", minLength: 1 },
          code: { type: "string", minLength: 1 },
        },
      },
    },
    articles: { type: "array", items: ARTICLE_SCHEMA },
    timelines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["query", "series", "data"],
        properties: {
          query: { type: "string", minLength: 1 },
          series: { type: "string", minLength: 1 },
          data: { type: "array", items: TIMELINE_POINT_SCHEMA },
        },
      },
    },
    toneBins: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "recordIndex",
          "sourceQuery",
          "toneBin",
          "articleCount",
          "representativeArticles",
        ],
        properties: {
          recordIndex: { type: "integer", minimum: 0 },
          sourceQuery: { type: "string", minLength: 1 },
          toneBin: { type: "string", minLength: 1 },
          articleCount: { type: "number", minimum: 0 },
          representativeArticles: { type: "array", items: ARTICLE_SCHEMA },
        },
      },
    },
    stopReason: { enum: ["completed", "no-results", "max-records", "partial"] },
  },
} as const satisfies JsonSchema;
