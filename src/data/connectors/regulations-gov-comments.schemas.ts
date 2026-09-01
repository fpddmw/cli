import type { JsonSchema } from "../contracts.js";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const RFC3339_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$";
const COMMENT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$";

const POSTED_DATE_WINDOW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  description:
    "Inclusive Regulations.gov posted-date window. Do not combine it with lastModifiedDate.",
  examples: [{ from: "2026-03-01", to: "2026-03-07" }],
  properties: {
    from: {
      type: "string",
      pattern: DATE_PATTERN,
      description: "Inclusive lower posted date in YYYY-MM-DD form.",
      examples: ["2026-03-01"],
    },
    to: {
      type: "string",
      pattern: DATE_PATTERN,
      description: "Inclusive upper posted date in YYYY-MM-DD form.",
      examples: ["2026-03-07"],
    },
  },
} as const;

const LAST_MODIFIED_WINDOW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  description:
    "Inclusive RFC3339 last-modified instant window. The CLI converts it to the provider's documented America/New_York wall-clock filter and does not combine it with postedDate.",
  examples: [{ from: "2026-03-01T05:00:00Z", to: "2026-03-02T04:59:59Z" }],
  properties: {
    from: {
      type: "string",
      pattern: RFC3339_PATTERN,
      description: "Inclusive lower last-modified instant in RFC3339 form.",
      examples: ["2026-03-01T05:00:00Z"],
    },
    to: {
      type: "string",
      pattern: RFC3339_PATTERN,
      description: "Inclusive upper last-modified instant in RFC3339 form.",
      examples: ["2026-03-02T04:59:59Z"],
    },
  },
} as const;

export const REGULATIONS_GOV_SEARCH_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/regulations-gov/comment-search-input.v1.json",
  type: "object",
  additionalProperties: false,
  oneOf: [
    { required: ["postedDate"], properties: { postedDate: {} } },
    { required: ["lastModifiedDate"], properties: { lastModifiedDate: {} } },
  ],
  properties: {
    postedDate: POSTED_DATE_WINDOW_SCHEMA,
    lastModifiedDate: LAST_MODIFIED_WINDOW_SCHEMA,
    agencyId: {
      type: "string",
      pattern: "^[A-Z][A-Z0-9_-]{0,31}$",
      description: "Optional Regulations.gov agency acronym filter.",
      examples: ["EPA"],
    },
    commentOnId: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Optional internal commentOnId/objectId filter for comments attached to one document.",
      examples: ["09000064846eebaf"],
    },
    searchTerm: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Optional provider full-text search term used to narrow comment metadata.",
      examples: ["air quality"],
    },
    pageSize: {
      type: "integer",
      minimum: 5,
      maximum: 250,
      description: "Provider records requested per page. Regulations.gov permits 5 through 250.",
      examples: [250],
    },
    sortOrder: {
      enum: ["asc", "desc"],
      description:
        "Sort direction for the selected date field; documentId is always added as a deterministic tie-breaker.",
      examples: ["asc"],
    },
  },
} as const satisfies JsonSchema;

export const REGULATIONS_GOV_DETAIL_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/regulations-gov/comment-detail-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["commentIds", "includeAttachments"],
  properties: {
    commentIds: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: "string", pattern: COMMENT_ID_PATTERN },
      description:
        "One to 100 exact Regulations.gov public comment IDs, fetched in caller-supplied order.",
      examples: [["EPA-HQ-OAR-2026-0001-0002"]],
    },
    includeAttachments: {
      type: "boolean",
      description:
        "When true, request and normalize attachment metadata and file links; attachment bytes are never downloaded.",
      examples: [true],
    },
  },
} as const satisfies JsonSchema;

const NULLABLE_STRING = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const NULLABLE_BOOLEAN = { anyOf: [{ type: "boolean" }, { type: "null" }] } as const;
const NULLABLE_NON_NEGATIVE_INTEGER = {
  anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
} as const;
const SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["providerId", "service", "apiVersion", "publicComments"],
  properties: {
    providerId: { const: "regulations-gov" },
    service: { const: "Regulations.gov API" },
    apiVersion: { const: "v4" },
    publicComments: { const: true },
  },
} as const;
const PROVIDER_META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "hasNextPage",
    "hasPreviousPage",
    "numberOfElements",
    "pageNumber",
    "pageSize",
    "totalElements",
    "totalPages",
    "firstPage",
    "lastPage",
  ],
  properties: {
    hasNextPage: { type: "boolean" },
    hasPreviousPage: { type: "boolean" },
    numberOfElements: { type: "integer", minimum: 0 },
    pageNumber: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 5, maximum: 250 },
    totalElements: { type: "integer", minimum: 0 },
    totalPages: { type: "integer", minimum: 0, maximum: 20 },
    firstPage: { type: "boolean" },
    lastPage: { type: "boolean" },
  },
} as const;
const PAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pageNumber", "inputRecords", "emittedRecords"],
  properties: {
    pageNumber: { type: "integer", minimum: 1 },
    inputRecords: { type: "integer", minimum: 0 },
    emittedRecords: { type: "integer", minimum: 0 },
  },
} as const;
const STOP_REASON_SCHEMA = {
  enum: ["completed", "no-results", "max-pages", "max-records", "partial"],
} as const;

const SEARCH_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "recordIndex",
    "sourcePageNumber",
    "commentId",
    "agencyId",
    "documentType",
    "highlightedContent",
    "lastModifiedDateTime",
    "objectId",
    "postedDateTime",
    "title",
    "withdrawn",
  ],
  properties: {
    recordIndex: { type: "integer", minimum: 0 },
    sourcePageNumber: { type: "integer", minimum: 1 },
    commentId: { type: "string", pattern: COMMENT_ID_PATTERN },
    agencyId: NULLABLE_STRING,
    documentType: NULLABLE_STRING,
    highlightedContent: NULLABLE_STRING,
    lastModifiedDateTime: {
      anyOf: [{ type: "string", pattern: RFC3339_PATTERN }, { type: "null" }],
    },
    objectId: NULLABLE_STRING,
    postedDateTime: {
      anyOf: [{ type: "string", pattern: RFC3339_PATTERN }, { type: "null" }],
    },
    title: NULLABLE_STRING,
    withdrawn: NULLABLE_BOOLEAN,
  },
} as const;

export const REGULATIONS_GOV_SEARCH_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/regulations-gov/comment-search-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "query", "provider", "pages", "records", "stopReason"],
  properties: {
    source: SOURCE_SCHEMA,
    query: {
      type: "object",
      additionalProperties: false,
      required: [
        "dateMode",
        "postedDate",
        "lastModifiedDate",
        "providerTimeZone",
        "agencyId",
        "commentOnId",
        "searchTerm",
        "pageSize",
        "sortOrder",
      ],
      properties: {
        dateMode: { enum: ["posted", "last-modified"] },
        postedDate: { anyOf: [POSTED_DATE_WINDOW_SCHEMA, { type: "null" }] },
        lastModifiedDate: { anyOf: [LAST_MODIFIED_WINDOW_SCHEMA, { type: "null" }] },
        providerTimeZone: { const: "America/New_York" },
        agencyId: NULLABLE_STRING,
        commentOnId: NULLABLE_STRING,
        searchTerm: NULLABLE_STRING,
        pageSize: { type: "integer", minimum: 5, maximum: 250 },
        sortOrder: { enum: ["asc", "desc"] },
      },
    },
    provider: PROVIDER_META_SCHEMA,
    pages: { type: "array", maxItems: 20, items: PAGE_SCHEMA },
    records: { type: "array", maxItems: 5000, items: SEARCH_RECORD_SCHEMA },
    stopReason: STOP_REASON_SCHEMA,
  },
} as const satisfies JsonSchema;

const RESTRICTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "reason"],
  properties: { type: NULLABLE_STRING, reason: NULLABLE_STRING },
} as const;
const ATTACHMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "attachmentId",
    "title",
    "agencyNote",
    "authors",
    "abstract",
    "order",
    "modifiedDateTime",
    "publication",
    "restriction",
    "fileFormats",
  ],
  properties: {
    attachmentId: { type: "string", minLength: 1 },
    title: NULLABLE_STRING,
    agencyNote: NULLABLE_STRING,
    authors: { type: "array", items: { type: "string" } },
    abstract: NULLABLE_STRING,
    order: NULLABLE_NON_NEGATIVE_INTEGER,
    modifiedDateTime: {
      anyOf: [{ type: "string", pattern: RFC3339_PATTERN }, { type: "null" }],
    },
    publication: NULLABLE_STRING,
    restriction: RESTRICTION_SCHEMA,
    fileFormats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "format", "sizeBytes"],
        properties: {
          url: NULLABLE_STRING,
          format: NULLABLE_STRING,
          sizeBytes: NULLABLE_NON_NEGATIVE_INTEGER,
        },
      },
    },
  },
} as const;
const DETAIL_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "recordIndex",
    "requestIndex",
    "commentId",
    "agencyId",
    "commentText",
    "commentOnDocumentId",
    "docketId",
    "documentType",
    "postedDateTime",
    "modifiedDateTime",
    "receivedDateTime",
    "title",
    "trackingNumber",
    "withdrawn",
    "reasonWithdrawn",
    "restriction",
    "submitterContext",
    "duplicateComments",
    "attachments",
  ],
  properties: {
    recordIndex: { type: "integer", minimum: 0 },
    requestIndex: { type: "integer", minimum: 0 },
    commentId: { type: "string", pattern: COMMENT_ID_PATTERN },
    agencyId: { type: "string", minLength: 1 },
    commentText: { type: "string" },
    commentOnDocumentId: { type: "string", minLength: 1 },
    docketId: { type: "string", minLength: 1 },
    documentType: { type: "string", minLength: 1 },
    postedDateTime: { type: "string", pattern: RFC3339_PATTERN },
    modifiedDateTime: {
      anyOf: [{ type: "string", pattern: RFC3339_PATTERN }, { type: "null" }],
    },
    receivedDateTime: { type: "string", pattern: RFC3339_PATTERN },
    title: { type: "string" },
    trackingNumber: { type: "string" },
    withdrawn: { type: "boolean" },
    reasonWithdrawn: NULLABLE_STRING,
    restriction: RESTRICTION_SCHEMA,
    submitterContext: {
      type: "object",
      additionalProperties: false,
      required: ["organization", "governmentAgency", "governmentAgencyType"],
      properties: {
        organization: NULLABLE_STRING,
        governmentAgency: NULLABLE_STRING,
        governmentAgencyType: NULLABLE_STRING,
      },
    },
    duplicateComments: NULLABLE_NON_NEGATIVE_INTEGER,
    attachments: { type: "array", items: ATTACHMENT_SCHEMA },
  },
} as const;

export const REGULATIONS_GOV_DETAIL_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/regulations-gov/comment-detail-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "query", "records", "failures", "stopReason"],
  properties: {
    source: SOURCE_SCHEMA,
    query: {
      type: "object",
      additionalProperties: false,
      required: ["commentIds", "includeAttachments"],
      properties: {
        commentIds: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: { type: "string", pattern: COMMENT_ID_PATTERN },
        },
        includeAttachments: { type: "boolean" },
      },
    },
    records: { type: "array", maxItems: 100, items: DETAIL_RECORD_SCHEMA },
    failures: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["commentId", "code"],
        properties: {
          commentId: { type: "string", pattern: COMMENT_ID_PATTERN },
          code: { type: "string", minLength: 1 },
        },
      },
    },
    stopReason: { enum: ["completed", "partial"] },
  },
} as const satisfies JsonSchema;
