import type { JsonSchema } from "../contracts.js";

const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$";
const DIGEST_PATTERN = "^[0-9a-f]{64}$";
const NULLABLE_STRING = { type: ["string", "null"] } as const;
const NULLABLE_INTEGER = { type: ["integer", "null"], minimum: 0 } as const;

export const REGULATIONS_GOV_ATTACHMENTS_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/regulations-gov/attachment-download-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["commentIds", "maxFiles", "maxTotalBytes"],
  properties: {
    commentIds: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", pattern: ID_PATTERN },
      description:
        "One to 20 exact Regulations.gov public comment IDs whose attachment metadata and files should be retrieved in caller order.",
      examples: [["EPA-HQ-OAR-2026-0001-0002"]],
    },
    attachmentIds: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", pattern: ID_PATTERN },
      description:
        "Optional exact attachment-ID allowlist applied across the selected comments; omitted means all returned attachments are eligible.",
      examples: [["EPA-HQ-OAR-2026-0001-0002-ATTACHMENT-1"]],
    },
    maxFiles: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description:
        "Maximum number of attachment file formats to download after metadata filtering, in provider relationship and format order.",
      examples: [10],
    },
    maxTotalBytes: {
      type: "integer",
      minimum: 1,
      maximum: 500000000,
      description:
        "Maximum cumulative bytes committed for downloaded attachment files, excluding the generated manifest.",
      examples: [10000000],
    },
  },
} as const satisfies JsonSchema;

const ARTIFACT_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["relativePath", "sha256", "byteSize"],
  properties: {
    relativePath: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$" },
    sha256: { type: "string", pattern: DIGEST_PATTERN },
    byteSize: { type: "integer", minimum: 0 },
  },
} as const;

const FILE_FORMAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["url", "format", "sizeBytes"],
  properties: {
    url: { type: "string", minLength: 1 },
    format: { type: "string", minLength: 1 },
    sizeBytes: { type: "integer", minimum: 0 },
  },
} as const;

const ATTACHMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "commentId",
    "attachmentId",
    "title",
    "abstract",
    "order",
    "modifiedDateTime",
    "restrictionType",
    "restrictionReason",
    "fileFormats",
  ],
  properties: {
    commentId: { type: "string", pattern: ID_PATTERN },
    attachmentId: { type: "string", pattern: ID_PATTERN },
    title: NULLABLE_STRING,
    abstract: NULLABLE_STRING,
    order: NULLABLE_INTEGER,
    modifiedDateTime: NULLABLE_STRING,
    restrictionType: NULLABLE_STRING,
    restrictionReason: NULLABLE_STRING,
    fileFormats: { type: "array", items: FILE_FORMAT_SCHEMA },
  },
} as const;

const FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "commentId",
    "attachmentId",
    "formatIndex",
    "format",
    "sourceUrl",
    "contentType",
    "providerSizeBytes",
    "sizeMatchesProvider",
    "relativePath",
    "sha256",
    "byteSize",
  ],
  properties: {
    commentId: { type: "string", pattern: ID_PATTERN },
    attachmentId: { type: "string", pattern: ID_PATTERN },
    formatIndex: { type: "integer", minimum: 1 },
    format: { type: "string", minLength: 1 },
    sourceUrl: { type: "string", minLength: 1 },
    contentType: { type: "string", minLength: 1 },
    providerSizeBytes: { type: "integer", minimum: 0 },
    sizeMatchesProvider: { type: "boolean" },
    ...ARTIFACT_RECORD_SCHEMA.properties,
  },
} as const;

export const REGULATIONS_GOV_ATTACHMENTS_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/regulations-gov/attachment-download-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "query", "comments", "attachments", "files", "manifest", "stopReason"],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: [
        "providerId",
        "service",
        "apiVersion",
        "downloadsOrigin",
        "interpretationBoundary",
      ],
      properties: {
        providerId: { const: "regulations-gov" },
        service: { const: "Regulations.gov API" },
        apiVersion: { const: "v4" },
        downloadsOrigin: { const: "https://downloads.regulations.gov" },
        interpretationBoundary: { type: "string", minLength: 1 },
      },
    },
    query: {
      type: "object",
      additionalProperties: false,
      required: ["commentIds", "attachmentIds", "maxFiles", "maxTotalBytes"],
      properties: {
        commentIds: { type: "array", items: { type: "string", pattern: ID_PATTERN } },
        attachmentIds: {
          anyOf: [
            { type: "array", items: { type: "string", pattern: ID_PATTERN } },
            { type: "null" },
          ],
        },
        maxFiles: { type: "integer", minimum: 1, maximum: 20 },
        maxTotalBytes: { type: "integer", minimum: 1, maximum: 500000000 },
      },
    },
    comments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["commentId", "attachmentIds"],
        properties: {
          commentId: { type: "string", pattern: ID_PATTERN },
          attachmentIds: { type: "array", items: { type: "string", pattern: ID_PATTERN } },
        },
      },
    },
    attachments: { type: "array", items: ATTACHMENT_SCHEMA },
    files: { type: "array", maxItems: 20, items: FILE_SCHEMA },
    manifest: ARTIFACT_RECORD_SCHEMA,
    stopReason: {
      enum: ["completed", "max-comments", "max-files", "max-total-bytes", "partial"],
    },
  },
} as const satisfies JsonSchema;
