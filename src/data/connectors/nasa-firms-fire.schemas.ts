import type { JsonSchema } from "../contracts.js";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const UTC_MINUTE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00Z$";

export const NASA_FIRMS_SOURCES = [
  "LANDSAT_NRT",
  "MODIS_NRT",
  "MODIS_SP",
  "VIIRS_NOAA20_NRT",
  "VIIRS_NOAA20_SP",
  "VIIRS_NOAA21_NRT",
  "VIIRS_SNPP_NRT",
  "VIIRS_SNPP_SP",
] as const;

const BOUNDING_BOX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["west", "south", "east", "north"],
  description:
    "One non-antimeridian WGS84 bounding box. The CLI rejects boxes larger than 3,600 square degrees and world-scale scans.",
  examples: [{ west: 115.8, south: -8.9, east: 116.3, north: -8.3 }],
  properties: {
    west: {
      type: "number",
      minimum: -180,
      maximum: 180,
      description: "Western longitude in decimal degrees; it must be lower than east.",
      examples: [115.8],
    },
    south: {
      type: "number",
      minimum: -90,
      maximum: 90,
      description: "Southern latitude in decimal degrees; it must be lower than north.",
      examples: [-8.9],
    },
    east: {
      type: "number",
      minimum: -180,
      maximum: 180,
      description: "Eastern longitude in decimal degrees; it must be greater than west.",
      examples: [116.3],
    },
    north: {
      type: "number",
      minimum: -90,
      maximum: 90,
      description: "Northern latitude in decimal degrees; it must be greater than south.",
      examples: [-8.3],
    },
  },
} as const;

export const NASA_FIRMS_FIRE_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/nasa-firms/active-fire-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "boundingBox", "startDate", "endDate", "checkAvailability"],
  properties: {
    source: {
      enum: NASA_FIRMS_SOURCES,
      description:
        "One reviewed FIRMS active-fire source. NRT prioritizes timeliness and is replaced by SP; SP is better suited to consistent historical analysis.",
      examples: ["VIIRS_NOAA20_NRT"],
    },
    boundingBox: BOUNDING_BOX_SCHEMA,
    startDate: {
      type: "string",
      pattern: DATE_PATTERN,
      description:
        "Inclusive first acquisition date in UTC. Together with endDate, the window may contain at most 31 dates.",
      examples: ["2026-03-01"],
    },
    endDate: {
      type: "string",
      pattern: DATE_PATTERN,
      description:
        "Inclusive last acquisition date in UTC. It must not precede startDate; the CLI splits the window into at most five-day provider requests.",
      examples: ["2026-03-07"],
    },
    checkAvailability: {
      type: "boolean",
      description:
        "When true, query the provider's source availability first and block if the requested dates are outside its advertised window.",
      examples: [true],
    },
  },
} as const satisfies JsonSchema;

const NULLABLE_NUMBER = { type: ["number", "null"] } as const;
const NULLABLE_STRING = { type: ["string", "null"] } as const;

const ISSUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "message"],
  properties: {
    path: { type: "string", minLength: 1 },
    message: { type: "string", minLength: 1 },
  },
} as const;

export const NASA_FIRMS_FIRE_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/nasa-firms/active-fire-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "request", "availability", "validation", "chunks", "records", "stopReason"],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "service", "endpoint", "activeFireDetections", "timezone"],
      properties: {
        providerId: { const: "nasa-firms" },
        service: { const: "Fire Information for Resource Management System" },
        endpoint: { const: "/api/area/csv" },
        activeFireDetections: { const: true },
        timezone: { const: "UTC" },
      },
    },
    request: {
      type: "object",
      additionalProperties: false,
      required: [
        "source",
        "boundingBox",
        "startDate",
        "endDate",
        "checkAvailability",
        "dayCount",
        "chunkCount",
        "estimatedTransactions",
      ],
      properties: {
        source: NASA_FIRMS_FIRE_INPUT_SCHEMA.properties.source,
        boundingBox: BOUNDING_BOX_SCHEMA,
        startDate: NASA_FIRMS_FIRE_INPUT_SCHEMA.properties.startDate,
        endDate: NASA_FIRMS_FIRE_INPUT_SCHEMA.properties.endDate,
        checkAvailability: { type: "boolean" },
        dayCount: { type: "integer", minimum: 1, maximum: 31 },
        chunkCount: { type: "integer", minimum: 1, maximum: 7 },
        estimatedTransactions: { type: "integer", minimum: 1, maximum: 250 },
      },
    },
    availability: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["source", "minDate", "maxDate"],
      properties: {
        source: { enum: NASA_FIRMS_SOURCES },
        minDate: { type: "string", pattern: DATE_PATTERN },
        maxDate: { type: "string", pattern: DATE_PATTERN },
      },
    },
    validation: {
      type: "object",
      additionalProperties: false,
      required: ["issueCount", "issues"],
      properties: {
        issueCount: { type: "integer", minimum: 0 },
        issues: { type: "array", maxItems: 50, items: ISSUE_SCHEMA },
      },
    },
    chunks: {
      type: "array",
      maxItems: 7,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "chunkIndex",
          "startDate",
          "endDate",
          "dayCount",
          "estimatedTransactions",
          "status",
          "responseBytes",
          "inputRows",
          "emittedRecords",
          "issues",
        ],
        properties: {
          chunkIndex: { type: "integer", minimum: 0, maximum: 6 },
          startDate: { type: "string", pattern: DATE_PATTERN },
          endDate: { type: "string", pattern: DATE_PATTERN },
          dayCount: { type: "integer", minimum: 1, maximum: 5 },
          estimatedTransactions: { type: "integer", minimum: 1 },
          status: { enum: ["failed", "invalid", "ok"] },
          responseBytes: { type: "integer", minimum: 0 },
          inputRows: { type: "integer", minimum: 0 },
          emittedRecords: { type: "integer", minimum: 0 },
          issues: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
        },
      },
    },
    records: {
      type: "array",
      maxItems: 50000,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "recordIndex",
          "chunkIndex",
          "source",
          "latitude",
          "longitude",
          "acquiredAtUtc",
          "satellite",
          "instrument",
          "confidence",
          "version",
          "dayNight",
          "fireRadiativePowerMw",
          "scanKm",
          "trackKm",
          "brightnessKelvin",
          "brightT31Kelvin",
          "brightTi4Kelvin",
          "brightTi5Kelvin",
        ],
        properties: {
          recordIndex: { type: "integer", minimum: 0 },
          chunkIndex: { type: "integer", minimum: 0, maximum: 6 },
          source: { enum: NASA_FIRMS_SOURCES },
          latitude: { type: "number", minimum: -90, maximum: 90 },
          longitude: { type: "number", minimum: -180, maximum: 180 },
          acquiredAtUtc: { type: "string", pattern: UTC_MINUTE_PATTERN },
          satellite: NULLABLE_STRING,
          instrument: NULLABLE_STRING,
          confidence: NULLABLE_STRING,
          version: NULLABLE_STRING,
          dayNight: { enum: ["D", "N", null] },
          fireRadiativePowerMw: NULLABLE_NUMBER,
          scanKm: NULLABLE_NUMBER,
          trackKm: NULLABLE_NUMBER,
          brightnessKelvin: NULLABLE_NUMBER,
          brightT31Kelvin: NULLABLE_NUMBER,
          brightTi4Kelvin: NULLABLE_NUMBER,
          brightTi5Kelvin: NULLABLE_NUMBER,
        },
      },
    },
    stopReason: { enum: ["completed", "max-records", "no-results", "partial"] },
  },
} as const satisfies JsonSchema;
