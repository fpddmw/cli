import type { JsonSchema } from "../contracts.js";

const RFC3339_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$";
const UTC_SECOND_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$";
const PERIOD_PATTERN =
  "^P(?=.*\\d)(?:\\d+(?:\\.\\d+)?Y)?(?:\\d+(?:\\.\\d+)?M)?(?:\\d+(?:\\.\\d+)?W)?(?:\\d+(?:\\.\\d+)?D)?(?:T(?=\\d)(?:\\d+(?:\\.\\d+)?H)?(?:\\d+(?:\\.\\d+)?M)?(?:\\d+(?:\\.\\d+)?S)?)?$";

const BOUNDING_BOX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["minLongitude", "minLatitude", "maxLongitude", "maxLatitude"],
  description:
    "USGS bBox major filter in WGS84-style decimal degrees. The coordinate-span product must not exceed 25 square degrees.",
  examples: [
    {
      minLongitude: -77.3,
      minLatitude: 38.8,
      maxLongitude: -77,
      maxLatitude: 39.1,
    },
  ],
  properties: {
    minLongitude: {
      type: "number",
      minimum: -180,
      maximum: 180,
      description: "Western longitude boundary in decimal degrees.",
      examples: [-77.3],
    },
    minLatitude: {
      type: "number",
      minimum: -90,
      maximum: 90,
      description: "Southern latitude boundary in decimal degrees.",
      examples: [38.8],
    },
    maxLongitude: {
      type: "number",
      minimum: -180,
      maximum: 180,
      description: "Eastern longitude boundary in decimal degrees.",
      examples: [-77],
    },
    maxLatitude: {
      type: "number",
      minimum: -90,
      maximum: 90,
      description: "Northern latitude boundary in decimal degrees.",
      examples: [39.1],
    },
  },
} as const;

const PARAMETER_CODES_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 8,
  uniqueItems: true,
  description:
    "Five-digit USGS parameter codes to retrieve. Defaults to discharge 00060 and gage height 00065.",
  examples: [["00060", "00065"]],
  items: {
    type: "string",
    pattern: "^\\d{5}$",
    description: "One five-digit USGS time-series parameter code.",
    examples: ["00060"],
  },
} as const;

export const USGS_WATER_IV_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/usgs/water-instantaneous-values-input.v1.json",
  type: "object",
  additionalProperties: false,
  properties: {
    boundingBox: BOUNDING_BOX_SCHEMA,
    siteNumbers: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      description:
        "Explicit numeric USGS site identifiers. Use instead of boundingBox; at most 100 are accepted by WaterServices.",
      examples: [["01646500", "01646000"]],
      items: {
        type: "string",
        pattern: "^\\d+$",
        description: "One numeric USGS site identifier, preserving any leading zeroes.",
        examples: ["01646500"],
      },
    },
    period: {
      type: "string",
      minLength: 2,
      maxLength: 64,
      pattern: PERIOD_PATTERN,
      description:
        "Positive ISO-8601 duration ending at the provider's most recent value. Week notation cannot be mixed with other duration components. Use instead of an explicit start/end window.",
      examples: ["P1D", "PT2H"],
    },
    startDateTimeUtc: {
      type: "string",
      pattern: RFC3339_PATTERN,
      description:
        "Inclusive explicit start instant with timezone. It must be paired with endDateTimeUtc and must not follow it.",
      examples: ["2026-03-21T00:00:00Z"],
    },
    endDateTimeUtc: {
      type: "string",
      pattern: RFC3339_PATTERN,
      description:
        "Inclusive explicit end instant with timezone. It must be paired with startDateTimeUtc.",
      examples: ["2026-03-22T23:59:59Z"],
    },
    parameterCodes: PARAMETER_CODES_SCHEMA,
    siteType: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9-]+(?:,[A-Za-z0-9-]+)*$",
      description:
        "Comma-separated USGS site-type filter. Defaults to ST, which selects streams and its subtypes.",
      examples: ["ST", "ST,LA-OU"],
    },
    siteStatus: {
      enum: ["all", "active", "inactive"],
      description:
        "USGS activity-status filter. Defaults to active to preserve this Skill's bounded monitoring behavior.",
      examples: ["active"],
    },
    agencyCode: {
      type: "string",
      minLength: 1,
      maxLength: 32,
      pattern: "^[A-Za-z0-9-]+$",
      description: "Optional organization code used by USGS to filter site maintainers.",
      examples: ["USGS"],
    },
  },
  allOf: [
    {
      oneOf: [
        {
          required: ["boundingBox"],
          properties: { boundingBox: {}, siteNumbers: false },
        },
        {
          required: ["siteNumbers"],
          properties: { boundingBox: false, siteNumbers: {} },
        },
      ],
    },
    {
      oneOf: [
        {
          required: ["period"],
          properties: { period: {}, startDateTimeUtc: false, endDateTimeUtc: false },
        },
        {
          required: ["startDateTimeUtc", "endDateTimeUtc"],
          properties: { period: false, startDateTimeUtc: {}, endDateTimeUtc: {} },
        },
      ],
    },
  ],
} as const satisfies JsonSchema;

const NULLABLE_TEXT = { type: ["string", "null"] } as const;
const NULLABLE_COORDINATE = { type: ["number", "null"] } as const;

const SERIES_IDENTITY_PROPERTIES = {
  siteNumber: { type: "string", minLength: 1 },
  siteName: { type: "string" },
  agencyCode: NULLABLE_TEXT,
  siteType: NULLABLE_TEXT,
  stateCode: NULLABLE_TEXT,
  countyCode: NULLABLE_TEXT,
  hucCode: NULLABLE_TEXT,
  latitude: { ...NULLABLE_COORDINATE, minimum: -90, maximum: 90 },
  longitude: { ...NULLABLE_COORDINATE, minimum: -180, maximum: 180 },
  parameterCode: { type: "string", pattern: "^\\d{5}$" },
  variableName: { type: "string" },
  variableDescription: { type: "string" },
  statisticCode: NULLABLE_TEXT,
  unit: NULLABLE_TEXT,
} as const;

const SERIES_IDENTITY_REQUIRED = [
  "siteNumber",
  "siteName",
  "agencyCode",
  "siteType",
  "stateCode",
  "countyCode",
  "hucCode",
  "latitude",
  "longitude",
  "parameterCode",
  "variableName",
  "variableDescription",
  "statisticCode",
  "unit",
] as const;

const RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...SERIES_IDENTITY_REQUIRED, "observedAtUtc", "value", "qualifiers", "provisional"],
  properties: {
    ...SERIES_IDENTITY_PROPERTIES,
    observedAtUtc: { type: "string", pattern: UTC_SECOND_PATTERN },
    value: { type: "number" },
    qualifiers: { type: "array", items: { type: "string", minLength: 1 } },
    provisional: { type: "boolean" },
  },
} as const;

export const USGS_WATER_IV_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/usgs/water-instantaneous-values-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "request", "validation", "series", "records", "stopReason"],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: [
        "providerId",
        "service",
        "endpoint",
        "provisionalPossible",
        "legacyService",
        "decommissionExpected",
        "officialReplacement",
      ],
      properties: {
        providerId: { const: "usgs" },
        service: { const: "WaterServices Instantaneous Values" },
        endpoint: { const: "/nwis/iv/" },
        provisionalPossible: { const: true },
        legacyService: { const: true },
        decommissionExpected: { const: "2027-Q1" },
        officialReplacement: { const: "https://api.waterdata.usgs.gov/ogcapi/" },
      },
    },
    request: {
      type: "object",
      additionalProperties: false,
      required: ["selection", "time", "parameterCodes", "siteType", "siteStatus", "agencyCode"],
      properties: {
        selection: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "boundingBox", "siteNumbers"],
          properties: {
            kind: { enum: ["bounding-box", "sites"] },
            boundingBox: { anyOf: [BOUNDING_BOX_SCHEMA, { type: "null" }] },
            siteNumbers: {
              anyOf: [USGS_WATER_IV_INPUT_SCHEMA.properties.siteNumbers, { type: "null" }],
            },
          },
        },
        time: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "period", "startDateTimeUtc", "endDateTimeUtc"],
          properties: {
            kind: { enum: ["period", "window"] },
            period: { type: ["string", "null"] },
            startDateTimeUtc: { type: ["string", "null"], pattern: UTC_SECOND_PATTERN },
            endDateTimeUtc: { type: ["string", "null"], pattern: UTC_SECOND_PATTERN },
          },
        },
        parameterCodes: PARAMETER_CODES_SCHEMA,
        siteType: { type: "string", minLength: 1 },
        siteStatus: { enum: ["all", "active", "inactive"] },
        agencyCode: NULLABLE_TEXT,
      },
    },
    validation: {
      type: "object",
      additionalProperties: false,
      required: ["issueCount", "issues"],
      properties: {
        issueCount: { type: "integer", minimum: 0 },
        issues: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "message"],
            properties: {
              path: { type: "string", minLength: 1 },
              message: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    series: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          ...SERIES_IDENTITY_REQUIRED,
          "recordCount",
          "provisionalRecordCount",
          "firstObservedAtUtc",
          "lastObservedAtUtc",
        ],
        properties: {
          ...SERIES_IDENTITY_PROPERTIES,
          recordCount: { type: "integer", minimum: 0 },
          provisionalRecordCount: { type: "integer", minimum: 0 },
          firstObservedAtUtc: { type: ["string", "null"], pattern: UTC_SECOND_PATTERN },
          lastObservedAtUtc: { type: ["string", "null"], pattern: UTC_SECOND_PATTERN },
        },
      },
    },
    records: { type: "array", items: RECORD_SCHEMA },
    stopReason: { enum: ["completed", "max-records", "partial"] },
  },
} as const satisfies JsonSchema;
