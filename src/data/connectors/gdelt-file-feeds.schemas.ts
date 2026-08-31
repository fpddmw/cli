import type { JsonSchema } from "../contracts.js";

const RFC3339_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$";

export const GDELT_FILE_FEED_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/gdelt/file-feed-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: {
      enum: ["latest", "range"],
      description:
        "Fetch the latest published file or select the first bounded files whose 15-minute timestamps fall in an inclusive UTC range.",
      examples: ["latest"],
    },
    startDateTime: {
      type: "string",
      pattern: RFC3339_PATTERN,
      description:
        "Inclusive canonical UTC lower bound; the first selected file is the first 15-minute snapshot at or after this instant.",
      examples: ["2026-03-01T12:00:00Z"],
    },
    endDateTime: {
      type: "string",
      pattern: RFC3339_PATTERN,
      description:
        "Inclusive canonical UTC upper bound; required only for range mode.",
      examples: ["2026-03-01T12:15:00Z"],
    },
    maxFiles: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description:
        "Hard ceiling for files selected from the latest index or a potentially larger range.",
      examples: [4],
    },
  },
} as const satisfies JsonSchema;

export const GDELT_EVENT_FIELDS = [
  "globalEventId",
  "day",
  "monthYear",
  "year",
  "fractionDate",
  "actor1Code",
  "actor1Name",
  "actor1CountryCode",
  "actor1KnownGroupCode",
  "actor1EthnicCode",
  "actor1Religion1Code",
  "actor1Religion2Code",
  "actor1Type1Code",
  "actor1Type2Code",
  "actor1Type3Code",
  "actor2Code",
  "actor2Name",
  "actor2CountryCode",
  "actor2KnownGroupCode",
  "actor2EthnicCode",
  "actor2Religion1Code",
  "actor2Religion2Code",
  "actor2Type1Code",
  "actor2Type2Code",
  "actor2Type3Code",
  "isRootEvent",
  "eventCode",
  "eventBaseCode",
  "eventRootCode",
  "quadClass",
  "goldsteinScale",
  "numMentions",
  "numSources",
  "numArticles",
  "averageTone",
  "actor1GeoType",
  "actor1GeoFullName",
  "actor1GeoCountryCode",
  "actor1GeoAdm1Code",
  "actor1GeoAdm2Code",
  "actor1GeoLatitude",
  "actor1GeoLongitude",
  "actor1GeoFeatureId",
  "actor2GeoType",
  "actor2GeoFullName",
  "actor2GeoCountryCode",
  "actor2GeoAdm1Code",
  "actor2GeoAdm2Code",
  "actor2GeoLatitude",
  "actor2GeoLongitude",
  "actor2GeoFeatureId",
  "actionGeoType",
  "actionGeoFullName",
  "actionGeoCountryCode",
  "actionGeoAdm1Code",
  "actionGeoAdm2Code",
  "actionGeoLatitude",
  "actionGeoLongitude",
  "actionGeoFeatureId",
  "dateAdded",
  "sourceUrl",
] as const;

export const GDELT_GKG_FIELDS = [
  "recordId",
  "date",
  "sourceCollectionIdentifier",
  "sourceCommonName",
  "documentIdentifier",
  "counts",
  "enhancedCounts",
  "themes",
  "enhancedThemes",
  "locations",
  "enhancedLocations",
  "persons",
  "enhancedPersons",
  "organizations",
  "enhancedOrganizations",
  "tone",
  "enhancedDates",
  "gcam",
  "sharingImage",
  "relatedImages",
  "socialImageEmbeds",
  "socialVideoEmbeds",
  "quotations",
  "allNames",
  "amounts",
  "translationInfo",
  "extrasXml",
] as const;

export const GDELT_MENTION_FIELDS = [
  "globalEventId",
  "eventTimeDate",
  "mentionTimeDate",
  "mentionType",
  "mentionSourceName",
  "mentionIdentifier",
  "sentenceId",
  "actor1CharacterOffset",
  "actor2CharacterOffset",
  "actionCharacterOffset",
  "inRawText",
  "confidence",
  "mentionDocumentLength",
  "mentionDocumentTone",
  "mentionDocumentTranslationInfo",
  "extras",
] as const;

function exactFieldsSchema(fields: readonly string[]): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: [...fields],
    properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }])),
  };
}

function fileFeedOutputSchema(
  dataset: "events" | "gkg" | "mentions",
  fields: readonly string[],
): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://schemas.tiangong.ai/data/gdelt/${dataset}-output.v1.json`,
    type: "object",
    additionalProperties: false,
    required: ["source", "query", "files", "records", "failures", "stopReason"],
    properties: {
      source: {
        type: "object",
        additionalProperties: false,
        required: ["providerId", "dataset", "cadence", "metadataOnly"],
        properties: {
          providerId: { const: "gdelt" },
          dataset: { const: dataset },
          cadence: { const: "15 minutes" },
          metadataOnly: { const: false },
        },
      },
      query: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "startDateTime", "endDateTime", "maxFiles"],
        properties: {
          mode: { enum: ["latest", "range"] },
          startDateTime: { type: ["string", "null"] },
          endDateTime: { type: ["string", "null"] },
          maxFiles: { type: "integer", minimum: 1, maximum: 20 },
        },
      },
      files: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "timestamp",
            "fileName",
            "compressedBytes",
            "sha256",
            "uncompressedBytes",
            "rowCount",
            "validRowCount",
            "invalidRowCount",
            "validationIssues",
            "verifiedMd5",
            "crc32Verified",
          ],
          properties: {
            timestamp: { type: "string", pattern: "^\\d{14}$" },
            fileName: { type: "string", minLength: 1 },
            compressedBytes: { type: "integer", minimum: 1 },
            sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            uncompressedBytes: { type: "integer", minimum: 0 },
            rowCount: { type: "integer", minimum: 0 },
            validRowCount: { type: "integer", minimum: 0 },
            invalidRowCount: { type: "integer", minimum: 0 },
            validationIssues: {
              type: "array",
              maxItems: 20,
              items: { type: "string", minLength: 1 },
            },
            verifiedMd5: { type: ["boolean", "null"] },
            crc32Verified: { const: true },
          },
        },
      },
      records: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["recordIndex", "sourceFileTimestamp", "sourceFileName", "fields"],
          properties: {
            recordIndex: { type: "integer", minimum: 0 },
            sourceFileTimestamp: { type: "string", pattern: "^\\d{14}$" },
            sourceFileName: { type: "string", minLength: 1 },
            fields: exactFieldsSchema(fields),
          },
        },
      },
      failures: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["fileName", "code", "retryable"],
          properties: {
            fileName: { type: "string", minLength: 1 },
            code: { type: "string", minLength: 1 },
            retryable: { type: "boolean" },
          },
        },
      },
      stopReason: {
        enum: ["completed", "no-results", "max-files", "max-records", "partial"],
      },
    },
  };
}

export const GDELT_EVENTS_OUTPUT_SCHEMA = fileFeedOutputSchema("events", GDELT_EVENT_FIELDS);
export const GDELT_GKG_OUTPUT_SCHEMA = fileFeedOutputSchema("gkg", GDELT_GKG_FIELDS);
export const GDELT_MENTIONS_OUTPUT_SCHEMA = fileFeedOutputSchema("mentions", GDELT_MENTION_FIELDS);
