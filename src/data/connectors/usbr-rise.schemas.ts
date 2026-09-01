import type { JsonSchema } from "../contracts.js";

const NULLABLE_STRING = { type: ["string", "null"] } as const;
const NULLABLE_NUMBER = { type: ["number", "null"] } as const;

export const USBR_RISE_DISCOVER_ITEMS_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/usbr/rise-discover-items-input.v1.json",
  type: "object",
  additionalProperties: false,
  properties: {
    queryTerms: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      description:
        "Case-insensitive words or phrases that must all occur in the normalized catalog item's searchable metadata.",
      examples: [["Lake Powell", "release"]],
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    itemTitleContains: {
      type: "string",
      minLength: 1,
      maxLength: 300,
      description: "Case-insensitive substring required in the RISE catalog item title.",
      examples: ["Lake Powell"],
    },
    locationNameContains: {
      type: "string",
      minLength: 1,
      maxLength: 300,
      description: "Case-insensitive substring required in the catalog location name.",
      examples: ["Glen Canyon"],
    },
    parameterNameContains: {
      type: "string",
      minLength: 1,
      maxLength: 300,
      description: "Case-insensitive substring required in the catalog parameter name.",
      examples: ["release"],
    },
    parameterId: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "Exact provider parameter identifier used as a client-side catalog filter.",
      examples: ["3001"],
    },
    locationId: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "Exact provider location identifier used as a client-side catalog filter.",
      examples: ["2001"],
    },
    sourceCode: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "Exact case-insensitive USBR RISE source code used as a catalog filter.",
      examples: ["UC"],
    },
    startPage: {
      type: "integer",
      minimum: 1,
      description: "One-based provider catalog page at which the bounded scan starts.",
      examples: [1],
    },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Number of provider catalog members requested per page.",
      examples: [100],
    },
  },
} as const satisfies JsonSchema;

export const USBR_RISE_FETCH_RESULTS_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/usbr/rise-fetch-results-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["itemIds"],
  properties: {
    itemIds: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      description:
        "Explicit RISE catalog item identifiers grounded through discovery or another official source.",
      examples: [["10835"]],
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
    locationId: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "Optional exact RISE location identifier applied to every requested item.",
      examples: ["2001"],
    },
    parameterId: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "Optional exact RISE parameter identifier applied to every requested item.",
      examples: ["3001"],
    },
    afterUtc: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "Optional inclusive lower RFC3339 dateTime filter with an explicit UTC offset.",
      examples: ["2025-01-01T00:00:00Z"],
    },
    beforeUtc: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "Optional inclusive upper RFC3339 dateTime filter with an explicit UTC offset.",
      examples: ["2025-01-31T23:59:59Z"],
    },
    orderDateTime: {
      enum: ["asc", "desc"],
      description: "Provider ordering for result timestamps; descending is the default.",
      examples: ["desc"],
    },
    includeItemMetadata: {
      type: "boolean",
      description:
        "Whether to request each catalog item's metadata and use it to enrich result rows.",
      examples: [true],
    },
    startPage: {
      type: "integer",
      minimum: 1,
      description: "One-based provider result page at which each item scan starts.",
      examples: [1],
    },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Number of provider result rows requested per page.",
      examples: [100],
    },
  },
} as const satisfies JsonSchema;

const SPATIAL_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["type", "coordinates"],
  properties: {
    type: { const: "Point" },
    coordinates: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      prefixItems: [{ type: "number" }, { type: "number" }],
      items: false,
    },
  },
} as const;

const ITEM_METADATA_PROPERTIES = {
  itemId: { type: "string", minLength: 1 },
  itemTitle: NULLABLE_STRING,
  itemDescription: NULLABLE_STRING,
  locationId: NULLABLE_STRING,
  locationName: NULLABLE_STRING,
  locationSourceCode: NULLABLE_STRING,
  parameterId: NULLABLE_STRING,
  parameterName: NULLABLE_STRING,
  parameterUnit: NULLABLE_STRING,
  parameterGroup: NULLABLE_STRING,
  parameterTimestep: NULLABLE_STRING,
  parameterTransformation: NULLABLE_STRING,
  sourceCode: NULLABLE_STRING,
  temporalStartDate: NULLABLE_STRING,
  temporalEndDate: NULLABLE_STRING,
  landingPage: NULLABLE_STRING,
  providerDisclaimer: NULLABLE_STRING,
  spatial: SPATIAL_SCHEMA,
} as const;

const ITEM_METADATA_REQUIRED = Object.keys(ITEM_METADATA_PROPERTIES);

const ITEM_METADATA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ITEM_METADATA_REQUIRED,
  properties: ITEM_METADATA_PROPERTIES,
} as const;

const CATALOG_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "itemId",
    "itemApiPath",
    "itemTitle",
    "itemDescription",
    "locationId",
    "locationName",
    "locationSourceCode",
    "parameterId",
    "parameterName",
    "parameterUnit",
    "parameterGroup",
    "parameterTimestep",
    "parameterTransformation",
    "sourceCode",
    "temporalStartDate",
    "temporalEndDate",
    "landingPage",
    "spatial",
    "sourcePageNumber",
  ],
  properties: {
    ...ITEM_METADATA_PROPERTIES,
    itemApiPath: NULLABLE_STRING,
    sourcePageNumber: { type: "integer", minimum: 1 },
  },
} as const;

const SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["providerId", "endpoint", "interpretationBoundary"],
  properties: {
    providerId: { const: "usbr-rise" },
    endpoint: { type: "string", minLength: 1 },
    interpretationBoundary: { type: "string", minLength: 1 },
  },
} as const;

export const USBR_RISE_DISCOVER_ITEMS_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/usbr/rise-discover-items-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "source",
    "query",
    "candidateItemIds",
    "records",
    "pages",
    "listSemantics",
    "stopReason",
  ],
  properties: {
    source: SOURCE_SCHEMA,
    query: {
      type: "object",
      additionalProperties: false,
      required: [
        "queryTerms",
        "itemTitleContains",
        "locationNameContains",
        "parameterNameContains",
        "parameterId",
        "locationId",
        "sourceCode",
        "startPage",
        "pageSize",
      ],
      properties: {
        queryTerms: { type: "array", items: { type: "string", minLength: 1 } },
        itemTitleContains: NULLABLE_STRING,
        locationNameContains: NULLABLE_STRING,
        parameterNameContains: NULLABLE_STRING,
        parameterId: NULLABLE_STRING,
        locationId: NULLABLE_STRING,
        sourceCode: NULLABLE_STRING,
        startPage: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    candidateItemIds: { type: "array", items: { type: "string", minLength: 1 } },
    records: { type: "array", items: CATALOG_RECORD_SCHEMA },
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pageNumber", "providerTotalItems", "providerMemberCount", "matchedRecordCount"],
        properties: {
          pageNumber: { type: "integer", minimum: 1 },
          providerTotalItems: { type: ["integer", "null"], minimum: 0 },
          providerMemberCount: { type: "integer", minimum: 0 },
          matchedRecordCount: { type: "integer", minimum: 0 },
        },
      },
    },
    listSemantics: { type: "string", minLength: 1 },
    stopReason: {
      enum: ["completed", "no-results", "max-pages", "max-records", "partial"],
    },
  },
} as const satisfies JsonSchema;

const RESULT_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "recordId",
    "itemId",
    "locationId",
    "locationName",
    "parameterId",
    "parameterName",
    "parameterUnit",
    "parameterGroup",
    "parameterTimestep",
    "parameterTransformation",
    "sourceCode",
    "observedAtUtc",
    "value",
    "status",
    "lastUpdate",
    "createDate",
    "updateDate",
    "latitude",
    "longitude",
    "itemTitle",
    "itemDescription",
    "landingPage",
    "providerDisclaimer",
    "sourcePageNumber",
  ],
  properties: {
    recordId: { type: "string", minLength: 1 },
    itemId: { type: "string", minLength: 1 },
    locationId: NULLABLE_STRING,
    locationName: NULLABLE_STRING,
    parameterId: NULLABLE_STRING,
    parameterName: NULLABLE_STRING,
    parameterUnit: NULLABLE_STRING,
    parameterGroup: NULLABLE_STRING,
    parameterTimestep: NULLABLE_STRING,
    parameterTransformation: NULLABLE_STRING,
    sourceCode: NULLABLE_STRING,
    observedAtUtc: NULLABLE_STRING,
    value: {
      anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }],
    },
    status: NULLABLE_STRING,
    lastUpdate: NULLABLE_STRING,
    createDate: NULLABLE_STRING,
    updateDate: NULLABLE_STRING,
    latitude: NULLABLE_NUMBER,
    longitude: NULLABLE_NUMBER,
    itemTitle: NULLABLE_STRING,
    itemDescription: NULLABLE_STRING,
    landingPage: NULLABLE_STRING,
    providerDisclaimer: NULLABLE_STRING,
    sourcePageNumber: { type: "integer", minimum: 1 },
  },
} as const;

export const USBR_RISE_FETCH_RESULTS_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/usbr/rise-fetch-results-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["source", "query", "itemMetadata", "records", "pages", "stopReason"],
  properties: {
    source: SOURCE_SCHEMA,
    query: {
      type: "object",
      additionalProperties: false,
      required: [
        "itemIds",
        "locationId",
        "parameterId",
        "afterUtc",
        "beforeUtc",
        "orderDateTime",
        "includeItemMetadata",
        "startPage",
        "pageSize",
      ],
      properties: {
        itemIds: { type: "array", items: { type: "string", minLength: 1 } },
        locationId: NULLABLE_STRING,
        parameterId: NULLABLE_STRING,
        afterUtc: NULLABLE_STRING,
        beforeUtc: NULLABLE_STRING,
        orderDateTime: { enum: ["asc", "desc"] },
        includeItemMetadata: { type: "boolean" },
        startPage: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    itemMetadata: {
      type: "object",
      propertyNames: { type: "string", minLength: 1, maxLength: 100 },
      additionalProperties: ITEM_METADATA_SCHEMA,
    },
    records: { type: "array", items: RESULT_RECORD_SCHEMA },
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["itemId", "pageNumber", "providerTotalItems", "recordCount"],
        properties: {
          itemId: { type: "string", minLength: 1 },
          pageNumber: { type: "integer", minimum: 1 },
          providerTotalItems: { type: ["integer", "null"], minimum: 0 },
          recordCount: { type: "integer", minimum: 0 },
        },
      },
    },
    stopReason: {
      enum: ["completed", "no-results", "max-pages", "max-records", "partial"],
    },
  },
} as const satisfies JsonSchema;
