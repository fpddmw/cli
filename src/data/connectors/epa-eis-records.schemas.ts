import type { JsonSchema } from "../contracts.js";

export const EPA_EIS_COMMON_SEARCHES = [
  "lastWeek",
  "openComment",
  "last60Issued",
  "last30Published",
] as const;

export const EPA_EIS_RECORDS_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/epa/eis-records-search-input.v1.json",
  type: "object",
  additionalProperties: false,
  properties: {
    commonSearches: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      description: "Official EPA EIS Database common-search pages to retrieve in caller order.",
      examples: [["openComment", "last30Published"]],
      items: { enum: EPA_EIS_COMMON_SEARCHES },
    },
    searchUrls: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
      description:
        "Explicit HTTPS search URLs copied from the official cdxapps.epa.gov EIS Database UI; other origins and paths are rejected.",
      examples: [
        [
          "https://cdxapps.epa.gov/cdx-enepa-II/public/action/eis/search?search=Glen+Canyon&state=CO",
        ],
      ],
      items: { type: "string", minLength: 1, maxLength: 4_096 },
    },
  },
} as const satisfies JsonSchema;

const NULLABLE_STRING = { type: ["string", "null"] } as const;

const DOWNLOAD_LINK_SCHEMA = {
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
    "title",
    "ceqNumber",
    "uniqueIdentificationNumber",
    "documentType",
    "epaCommentLetterDate",
    "federalRegisterDate",
    "leadAgency",
    "federalCooperatingAgencies",
    "state",
    "detailUrl",
    "downloadLinks",
    "downloadDocumentIds",
    "sourcePageUrl",
  ],
  properties: {
    recordId: { type: "string", minLength: 1 },
    title: { type: "string" },
    ceqNumber: NULLABLE_STRING,
    uniqueIdentificationNumber: NULLABLE_STRING,
    documentType: NULLABLE_STRING,
    epaCommentLetterDate: NULLABLE_STRING,
    federalRegisterDate: NULLABLE_STRING,
    leadAgency: NULLABLE_STRING,
    federalCooperatingAgencies: NULLABLE_STRING,
    state: NULLABLE_STRING,
    detailUrl: NULLABLE_STRING,
    downloadLinks: { type: "array", items: DOWNLOAD_LINK_SCHEMA },
    downloadDocumentIds: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    sourcePageUrl: { type: "string", minLength: 1 },
  },
} as const;

const PAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "searchNumber",
    "sourceKind",
    "commonSearch",
    "requestedUrl",
    "providerResultCount",
    "recordCount",
    "responseBytes",
    "responseDigest",
  ],
  properties: {
    searchNumber: { type: "integer", minimum: 1 },
    sourceKind: { enum: ["common-search", "explicit-search-url"] },
    commonSearch: {
      anyOf: [{ enum: EPA_EIS_COMMON_SEARCHES }, { type: "null" }],
    },
    requestedUrl: { type: "string", minLength: 1 },
    providerResultCount: { type: ["integer", "null"], minimum: 0 },
    recordCount: { type: "integer", minimum: 0 },
    responseBytes: { type: "integer", minimum: 0 },
    responseDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;

export const EPA_EIS_RECORDS_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/epa/eis-records-search-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "query", "pages", "records", "stopReason"],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "endpoint", "interpretationBoundary"],
      properties: {
        providerId: { const: "epa-eis-database" },
        endpoint: { const: "/cdx-enepa-II/public/action/eis/search" },
        interpretationBoundary: { type: "string", minLength: 1 },
      },
    },
    query: {
      type: "object",
      additionalProperties: false,
      required: ["commonSearches", "searchUrls"],
      properties: {
        commonSearches: { type: "array", items: { enum: EPA_EIS_COMMON_SEARCHES } },
        searchUrls: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    pages: { type: "array", items: PAGE_SCHEMA },
    records: { type: "array", items: RECORD_SCHEMA },
    stopReason: {
      enum: ["completed", "no-results", "max-pages", "max-records", "partial"],
    },
  },
} as const satisfies JsonSchema;
