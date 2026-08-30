import type { JsonSchema } from "../contracts.js";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

export const FEDERAL_REGISTER_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/federal-register/documents-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["publicationDate"],
  properties: {
    term: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Free-text term passed to the FederalRegister.gov documents search.",
      examples: ["clean air"],
    },
    publicationDate: {
      type: "object",
      additionalProperties: false,
      description:
        "Inclusive publication-date boundary. At least from or to is required by the operation.",
      examples: [{ from: "2026-01-01", to: "2026-03-31" }],
      properties: {
        from: {
          type: "string",
          pattern: DATE_PATTERN,
          description: "Earliest publication date to include, formatted YYYY-MM-DD.",
          examples: ["2026-01-01"],
        },
        to: {
          type: "string",
          pattern: DATE_PATTERN,
          description: "Latest publication date to include, formatted YYYY-MM-DD.",
          examples: ["2026-03-31"],
        },
      },
    },
    agencies: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      description: "FederalRegister.gov agency slugs used to narrow the search.",
      examples: [["environmental-protection-agency"]],
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    documentTypes: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      description: "Federal Register document-type codes to include.",
      examples: [["RULE", "PRORULE"]],
      items: { enum: ["NOTICE", "PRESDOCU", "PRORULE", "RULE"] },
    },
    topics: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      description: "FederalRegister.gov topic names used to narrow the search.",
      examples: [["Air Pollution Control"]],
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    docketId: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Exact docket identifier associated with matching documents.",
      examples: ["EPA-HQ-OAR-2024-0001"],
    },
    regulationIdNumber: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Exact Regulation Identifier Number (RIN) used to narrow matching documents.",
      examples: ["2060-AV01"],
    },
    order: {
      enum: ["newest", "oldest", "relevance"],
      description:
        "Provider result ordering. Relevance is most useful with term; newest is the default.",
      examples: ["newest"],
    },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: 1000,
      description:
        "Requested provider page size; the runtime record limit still caps emitted records.",
      examples: [100],
    },
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
