import type { JsonSchema } from "../contracts.js";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

export const FEDERAL_REGISTER_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/federal-register/documents-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["publicationDate"],
  properties: {
    term: { type: "string", minLength: 1, maxLength: 500 },
    publicationDate: {
      type: "object",
      additionalProperties: false,
      properties: {
        from: { type: "string", pattern: DATE_PATTERN },
        to: { type: "string", pattern: DATE_PATTERN },
      },
    },
    agencies: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    documentTypes: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: { enum: ["NOTICE", "PRESDOCU", "PRORULE", "RULE"] },
    },
    topics: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    docketId: { type: "string", minLength: 1, maxLength: 200 },
    regulationIdNumber: { type: "string", minLength: 1, maxLength: 200 },
    order: { enum: ["newest", "oldest", "relevance"] },
    pageSize: { type: "integer", minimum: 1, maximum: 1000 },
  },
} as const satisfies JsonSchema;

const NULLABLE_STRING = { type: ["string", "null"] } as const;
const STRING_ARRAY = { type: "array", items: { type: "string", minLength: 1 } } as const;

const FEDERAL_REGISTER_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "type",
    "abstract",
    "documentNumber",
    "htmlUrl",
    "pdfUrl",
    "publicInspectionPdfUrl",
    "publicationDate",
    "effectiveOn",
    "agencies",
    "topics",
    "docketIds",
    "regulationIdNumbers",
    "significant",
    "sourcePageNumber",
  ],
  properties: {
    title: { type: "string", minLength: 1 },
    type: { type: "string", minLength: 1 },
    abstract: NULLABLE_STRING,
    documentNumber: { type: "string", minLength: 1 },
    htmlUrl: NULLABLE_STRING,
    pdfUrl: NULLABLE_STRING,
    publicInspectionPdfUrl: NULLABLE_STRING,
    publicationDate: { type: "string", pattern: DATE_PATTERN },
    effectiveOn: {
      anyOf: [{ type: "string", pattern: DATE_PATTERN }, { type: "null" }],
    },
    agencies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "slug"],
        properties: {
          id: { type: ["integer", "null"] },
          name: { type: "string", minLength: 1 },
          slug: { type: "string", minLength: 1 },
        },
      },
    },
    topics: STRING_ARRAY,
    docketIds: STRING_ARRAY,
    regulationIdNumbers: STRING_ARRAY,
    significant: { type: ["boolean", "null"] },
    sourcePageNumber: { type: "integer", minimum: 1 },
  },
} as const;

export const FEDERAL_REGISTER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/federal-register/documents-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "query", "provider", "pages", "records", "stopReason"],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "endpoint", "metadataOnly", "legalStatus"],
      properties: {
        providerId: { const: "federal-register" },
        endpoint: { const: "/api/v1/documents.json" },
        metadataOnly: { const: true },
        legalStatus: { type: "string", minLength: 1 },
      },
    },
    query: {
      type: "object",
      additionalProperties: false,
      required: [
        "term",
        "publicationDate",
        "agencies",
        "documentTypes",
        "topics",
        "docketId",
        "regulationIdNumber",
        "order",
        "pageSize",
      ],
      properties: {
        term: NULLABLE_STRING,
        publicationDate: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: { type: "string", pattern: DATE_PATTERN },
            to: { type: "string", pattern: DATE_PATTERN },
          },
        },
        agencies: STRING_ARRAY,
        documentTypes: STRING_ARRAY,
        topics: STRING_ARRAY,
        docketId: NULLABLE_STRING,
        regulationIdNumber: NULLABLE_STRING,
        order: { enum: ["newest", "oldest", "relevance"] },
        pageSize: { type: "integer", minimum: 1, maximum: 1000 },
      },
    },
    provider: {
      type: "object",
      additionalProperties: false,
      required: ["description", "count", "totalPages"],
      properties: {
        description: { type: "string" },
        count: { type: "integer", minimum: 0 },
        totalPages: { type: "integer", minimum: 0 },
      },
    },
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pageNumber", "recordCount"],
        properties: {
          pageNumber: { type: "integer", minimum: 1 },
          recordCount: { type: "integer", minimum: 0 },
        },
      },
    },
    records: { type: "array", items: FEDERAL_REGISTER_RECORD_SCHEMA },
    stopReason: {
      enum: ["completed", "no-results", "max-pages", "max-records", "partial"],
    },
  },
} as const satisfies JsonSchema;
