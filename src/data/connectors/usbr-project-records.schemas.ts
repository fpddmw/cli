import type { JsonSchema } from "../contracts.js";

export const USBR_PROJECT_RECORDS_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/usbr/project-records-fetch-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["urls"],
  properties: {
    urls: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
      description:
        "Caller-ordered HTTPS project or program page URLs on the exact www.usbr.gov origin.",
      examples: [
        [
          "https://www.usbr.gov/uc/progact/amp/index.html",
          "https://www.usbr.gov/lc/region/programs/crbstudy.html",
        ],
      ],
      items: { type: "string", minLength: 1, maxLength: 4_096 },
    },
    maxLinkedRecordsPerPage: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description:
        "Maximum same-origin links to inventory from each supplied page, in document order; defaults to 50.",
      examples: [25],
    },
  },
} as const satisfies JsonSchema;

const NULLABLE_STRING = { type: ["string", "null"] } as const;
const NULLABLE_INTEGER = { type: ["integer", "null"], minimum: 0 } as const;

const LINK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["url", "text"],
  properties: {
    url: { type: "string", minLength: 1 },
    text: { type: "string" },
  },
} as const;

const RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "recordId",
    "recordType",
    "title",
    "summary",
    "url",
    "documentUrl",
    "documentType",
    "sourcePageUrl",
    "linkIndex",
    "links",
    "contentSha256",
    "contentByteLength",
    "contentType",
    "lastModified",
    "etag",
  ],
  properties: {
    recordId: { type: "string", minLength: 1 },
    recordType: { enum: ["project-page", "linked-document"] },
    title: { type: "string" },
    summary: NULLABLE_STRING,
    url: { type: "string", minLength: 1 },
    documentUrl: { type: "string", minLength: 1 },
    documentType: { type: "string", minLength: 1 },
    sourcePageUrl: NULLABLE_STRING,
    linkIndex: NULLABLE_INTEGER,
    links: { type: "array", items: LINK_SCHEMA },
    contentSha256: {
      anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }],
    },
    contentByteLength: NULLABLE_INTEGER,
    contentType: NULLABLE_STRING,
    lastModified: NULLABLE_STRING,
    etag: NULLABLE_STRING,
  },
} as const;

const PAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "pageNumber",
    "url",
    "title",
    "linkCount",
    "recordCount",
    "responseBytes",
    "responseDigest",
  ],
  properties: {
    pageNumber: { type: "integer", minimum: 1 },
    url: { type: "string", minLength: 1 },
    title: { type: "string" },
    linkCount: { type: "integer", minimum: 0 },
    recordCount: { type: "integer", minimum: 1 },
    responseBytes: { type: "integer", minimum: 0 },
    responseDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;

export const USBR_PROJECT_RECORDS_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/usbr/project-records-fetch-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "query", "pages", "records", "stopReason"],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "endpoint", "interpretationBoundary"],
      properties: {
        providerId: { const: "usbr-project-records" },
        endpoint: { const: "https://www.usbr.gov" },
        interpretationBoundary: { type: "string", minLength: 1 },
      },
    },
    query: {
      type: "object",
      additionalProperties: false,
      required: ["urls", "maxLinkedRecordsPerPage"],
      properties: {
        urls: { type: "array", items: { type: "string", minLength: 1 } },
        maxLinkedRecordsPerPage: { type: "integer", minimum: 0, maximum: 100 },
      },
    },
    pages: { type: "array", items: PAGE_SCHEMA },
    records: { type: "array", items: RECORD_SCHEMA },
    stopReason: {
      enum: ["completed", "max-pages", "max-records", "max-linked-records", "partial"],
    },
  },
} as const satisfies JsonSchema;
