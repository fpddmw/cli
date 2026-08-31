import type { JsonSchema } from "../contracts.js";

const UTC_HOUR_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:00:00Z$";
const SOURCE_FILE_PATTERN = "^/airnow/\\d{4}/\\d{8}/HourlyAQObs_\\d{10}\\.dat$";

export const AIRNOW_HOURLY_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/airnow/hourly-observations-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["startDateTimeUtc", "endDateTimeUtc", "boundingBox", "parameters"],
  properties: {
    startDateTimeUtc: {
      type: "string",
      pattern: UTC_HOUR_PATTERN,
      description: "Inclusive first UTC hour to retrieve. Minutes and seconds must both be zero.",
      examples: ["2026-03-22T00:00:00Z"],
    },
    endDateTimeUtc: {
      type: "string",
      pattern: UTC_HOUR_PATTERN,
      description: "Inclusive last UTC hour to retrieve. It must not precede startDateTimeUtc.",
      examples: ["2026-03-22T06:00:00Z"],
    },
    boundingBox: {
      type: "object",
      additionalProperties: false,
      required: ["minLongitude", "minLatitude", "maxLongitude", "maxLatitude"],
      description:
        "Geographic filter in WGS84 decimal degrees; minimum coordinates must not exceed maximum coordinates.",
      examples: [
        {
          minLongitude: -123.5,
          minLatitude: 37,
          maxLongitude: -121.5,
          maxLatitude: 38.8,
        },
      ],
      properties: {
        minLongitude: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "Western longitude boundary in WGS84 decimal degrees.",
          examples: [-123.5],
        },
        minLatitude: {
          type: "number",
          minimum: -90,
          maximum: 90,
          description: "Southern latitude boundary in WGS84 decimal degrees.",
          examples: [37],
        },
        maxLongitude: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "Eastern longitude boundary in WGS84 decimal degrees.",
          examples: [-121.5],
        },
        maxLatitude: {
          type: "number",
          minimum: -90,
          maximum: 90,
          description: "Northern latitude boundary in WGS84 decimal degrees.",
          examples: [38.8],
        },
      },
    },
    parameters: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      uniqueItems: true,
      description:
        "Pollutant records to emit. PM25 means PM2.5 and OZONE is the AirNow file-product label.",
      examples: [["PM25", "OZONE"]],
      items: {
        enum: ["CO", "NO2", "OZONE", "PM10", "PM25", "SO2"],
        description: "One pollutant identifier supported by the HourlyAQObs product.",
      },
    },
  },
} as const satisfies JsonSchema;

const AIRNOW_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "aqsid",
    "siteName",
    "status",
    "epaRegion",
    "latitude",
    "longitude",
    "countryCode",
    "stateName",
    "observedAtUtc",
    "dataSource",
    "reportingAreas",
    "parameterName",
    "aqiValue",
    "aqiKind",
    "rawConcentration",
    "unit",
    "measured",
    "sourceFile",
  ],
  properties: {
    aqsid: {
      type: "string",
      description: "AirNow site identifier when supplied by the source row; otherwise empty.",
    },
    siteName: { type: "string" },
    status: { type: "string" },
    epaRegion: { type: "string" },
    latitude: { type: "number", minimum: -90, maximum: 90 },
    longitude: { type: "number", minimum: -180, maximum: 180 },
    countryCode: { type: "string" },
    stateName: { type: "string" },
    observedAtUtc: { type: "string", pattern: UTC_HOUR_PATTERN },
    dataSource: { type: "string" },
    reportingAreas: { type: "array", items: { type: "string", minLength: 1 } },
    parameterName: { enum: ["CO", "NO2", "OZONE", "PM10", "PM25", "SO2"] },
    aqiValue: { type: ["number", "null"] },
    aqiKind: { enum: ["nowcast-aqi", "hourly-aqi", null] },
    rawConcentration: { type: ["number", "null"] },
    unit: { type: ["string", "null"] },
    measured: { type: ["boolean", "null"] },
    sourceFile: { type: "string", pattern: SOURCE_FILE_PATTERN },
  },
} as const;

export const AIRNOW_HOURLY_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/airnow/hourly-observations-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "request", "files", "records"],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "product", "preliminary", "regulatoryUse"],
      properties: {
        providerId: { const: "airnow" },
        product: { const: "HourlyAQObs" },
        preliminary: { const: true },
        regulatoryUse: { const: false },
      },
    },
    request: {
      type: "object",
      additionalProperties: false,
      required: ["startDateTimeUtc", "endDateTimeUtc", "boundingBox", "parameters", "hourCount"],
      properties: {
        startDateTimeUtc: { type: "string", pattern: UTC_HOUR_PATTERN },
        endDateTimeUtc: { type: "string", pattern: UTC_HOUR_PATTERN },
        boundingBox: AIRNOW_HOURLY_INPUT_SCHEMA.properties.boundingBox,
        parameters: AIRNOW_HOURLY_INPUT_SCHEMA.properties.parameters,
        hourCount: { type: "integer", minimum: 1, maximum: 168 },
      },
    },
    files: {
      type: "array",
      minItems: 1,
      maxItems: 168,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "hourUtc",
          "sourceFile",
          "status",
          "responseBytes",
          "inputRows",
          "emittedRecords",
          "issues",
        ],
        properties: {
          hourUtc: { type: "string", pattern: UTC_HOUR_PATTERN },
          sourceFile: { type: "string", pattern: SOURCE_FILE_PATTERN },
          status: { enum: ["ok", "missing", "failed", "invalid"] },
          responseBytes: { type: "integer", minimum: 0 },
          inputRows: { type: "integer", minimum: 0 },
          emittedRecords: { type: "integer", minimum: 0 },
          issues: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
          errorCode: { type: "string", minLength: 1 },
        },
      },
    },
    records: { type: "array", items: AIRNOW_RECORD_SCHEMA },
  },
} as const satisfies JsonSchema;
