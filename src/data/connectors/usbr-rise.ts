import type {
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
  DataSourceObservation,
  JsonValue,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  USBR_RISE_DISCOVER_ITEMS_INPUT_SCHEMA,
  USBR_RISE_DISCOVER_ITEMS_OUTPUT_SCHEMA,
  USBR_RISE_FETCH_RESULTS_INPUT_SCHEMA,
  USBR_RISE_FETCH_RESULTS_OUTPUT_SCHEMA,
} from "./usbr-rise.schemas.js";

const CATALOG_PATH = "/rise/api/catalog-item";
const RESULT_PATH = "/rise/api/result";
const DEFAULT_PAGE_SIZE = 100;
const LIST_SEMANTICS =
  "Catalog candidates are returned in provider scan order after client-side filtering; this is not source ranking or evidence weighting.";

interface DiscoverItemsInput {
  queryTerms?: string[];
  itemTitleContains?: string;
  locationNameContains?: string;
  parameterNameContains?: string;
  parameterId?: string;
  locationId?: string;
  sourceCode?: string;
  startPage?: number;
  pageSize?: number;
}

interface NormalizedDiscoverItemsInput {
  queryTerms: string[];
  itemTitleContains: string | null;
  locationNameContains: string | null;
  parameterNameContains: string | null;
  parameterId: string | null;
  locationId: string | null;
  sourceCode: string | null;
  startPage: number;
  pageSize: number;
}

interface FetchResultsInput {
  itemIds: string[];
  locationId?: string;
  parameterId?: string;
  afterUtc?: string;
  beforeUtc?: string;
  orderDateTime?: "asc" | "desc";
  includeItemMetadata?: boolean;
  startPage?: number;
  pageSize?: number;
}

interface NormalizedFetchResultsInput {
  itemIds: string[];
  locationId: string | null;
  parameterId: string | null;
  afterUtc: string | null;
  beforeUtc: string | null;
  orderDateTime: "asc" | "desc";
  includeItemMetadata: boolean;
  startPage: number;
  pageSize: number;
}

interface RiseItemMetadata {
  itemId: string;
  itemTitle: string | null;
  itemDescription: string | null;
  locationId: string | null;
  locationName: string | null;
  locationSourceCode: string | null;
  parameterId: string | null;
  parameterName: string | null;
  parameterUnit: string | null;
  parameterGroup: string | null;
  parameterTimestep: string | null;
  parameterTransformation: string | null;
  sourceCode: string | null;
  temporalStartDate: string | null;
  temporalEndDate: string | null;
  landingPage: string | null;
  providerDisclaimer: string | null;
  spatial: { type: "Point"; coordinates: [number, number] } | null;
}

interface RiseCatalogRecord extends Omit<RiseItemMetadata, "providerDisclaimer"> {
  itemApiPath: string | null;
  sourcePageNumber: number;
}

interface RiseResultRecord {
  recordId: string;
  itemId: string;
  locationId: string | null;
  locationName: string | null;
  parameterId: string | null;
  parameterName: string | null;
  parameterUnit: string | null;
  parameterGroup: string | null;
  parameterTimestep: string | null;
  parameterTransformation: string | null;
  sourceCode: string | null;
  observedAtUtc: string | null;
  value: number | string | null;
  status: string | null;
  lastUpdate: string | null;
  createDate: string | null;
  updateDate: string | null;
  latitude: number | null;
  longitude: number | null;
  itemTitle: string | null;
  itemDescription: string | null;
  landingPage: string | null;
  providerDisclaimer: string | null;
  sourcePageNumber: number;
}

interface ParsedProviderPage {
  members: Record<string, unknown>[];
  totalItems: number | null;
  hasNext: boolean;
}

export const usbrRiseConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "usbr.rise",
  capabilityVersion: "1.0.0",
  minimumCliVersion: "0.0.55",
  provider: {
    providerId: "usbr-rise",
    name: "Bureau of Reclamation Research and Information Sharing Environment",
  },
  sourceCategory: "water-operations-time-series",
  endpoints: [
    {
      endpointId: "usbr-rise-api",
      baseUrl: "https://data.usbr.gov",
      pathPrefixes: ["/rise/api/"],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/json", "application/ld+json"],
    },
  ],
  license: {
    name: "USBR RISE public data",
    url: "https://data.usbr.gov/rise",
    restrictions: [
      "Catalog and result metadata remain subject to the source-specific disclaimer published with each RISE item.",
      "A catalog candidate is not provider ranking, evidence weighting, or proof of record completeness.",
      "Operational values require item metadata and domain context before interpretation.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 60_000,
    maxRequestBytes: 2_048,
    maxResponseBytes: 20_000_000,
    maxPages: 20,
    maxRecords: 2_000,
    maxRetries: 4,
    maxRetryDelayMs: 120_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-current",
    description:
      "Catalog metadata and result rows reflect the public RISE API at request time and may be updated by the Bureau of Reclamation.",
  },
  limitations: [
    "Catalog discovery scans provider pages and applies filters client-side; a page cap can omit later matching items.",
    "Result retrieval requires explicit catalog item identifiers and is bounded by item, page, record, byte, and timeout limits.",
    "Sparse or missing rows can reflect item selection, date filters, provider latency, page limits, or metadata availability.",
    "The connector does not determine shortage severity, operating compliance, attribution, governance responsibility, or report readiness.",
  ],
  discovery: {
    source: {
      maintainedBy: "United States Bureau of Reclamation",
      summary:
        "Public RISE catalog metadata and operational or water-environment time-series result rows.",
      description:
        "The Research and Information Sharing Environment exposes catalog items describing USBR locations and parameters and result rows associated with explicit item identifiers.",
      coverage: {
        geographic:
          "Bureau of Reclamation projects, facilities, monitoring locations, and program datasets represented in RISE.",
        temporal:
          "Item-specific temporal coverage published in catalog metadata and current result availability in the RISE API.",
        granularity: "One catalog item or one item/location/parameter/timestamp result row.",
      },
    },
    summary: "Discover USBR RISE item IDs and fetch bounded result rows for explicit items.",
    description:
      "This capability separates client-filtered catalog discovery from explicit-item result retrieval so an Agent can ground item identifiers before requesting operational time series.",
    provides: [
      "Bounded catalog-page scanning with item, location, parameter, source, unit, temporal, landing-page, and spatial metadata.",
      "Explicit item-ID result retrieval with optional location, parameter, timestamp, and ordering filters.",
      "Optional item metadata enrichment plus item/page-level partial coverage and core execution receipts.",
    ],
    doesNotProvide: [
      "Full-text project documents, USBR-wide website search, field definitions beyond provider metadata, or cross-source joins.",
      "Shortage, drought, flood, compliance, causality, policy, or governance conclusions.",
      "Evidence ranking, automatic selection of the correct item ID, or proof that a bounded catalog scan is exhaustive.",
    ],
    selectionHints: [
      "Use discover-items when a place or parameter is known but an official RISE item ID has not been grounded.",
      "Use fetch-results only with explicit item IDs supported by catalog discovery or another official record.",
      "Increase the approved page limit or refine terms when discovery stops at a page cap; do not interpret zero candidates as real-world absence.",
      "Retain item-level disclaimer, unit, timestep, transformation, and source-code context when interpreting result values.",
    ],
    typicalUseCases: [
      "Discover candidate Lake Powell elevation, storage, inflow, or release item identifiers.",
      "Retrieve a bounded time window of result rows for a known reservoir or dam operation item.",
    ],
    sourceDocumentation: [
      {
        title: "USBR RISE",
        url: "https://data.usbr.gov/rise",
      },
      {
        title: "USBR RISE API entry point",
        url: "https://data.usbr.gov/rise/api",
      },
    ],
  },
  operations: [
    {
      operationId: "discover-items",
      operationVersion: "1.0.0",
      summary: "Scan bounded RISE catalog pages and return client-filtered candidate item IDs.",
      description:
        "Retrieves catalog-item pages in provider order, normalizes public item metadata, applies all requested terms and filters client-side, and reports page or record truncation explicitly.",
      inputSchema: USBR_RISE_DISCOVER_ITEMS_INPUT_SCHEMA,
      outputSchema: USBR_RISE_DISCOVER_ITEMS_OUTPUT_SCHEMA,
      execute: executeDiscoverItems,
    },
    {
      operationId: "fetch-results",
      operationVersion: "1.0.0",
      summary: "Fetch bounded RISE result rows for explicit catalog item IDs.",
      description:
        "Retrieves result pages for caller-supplied item IDs, optionally enriches rows with catalog metadata, and isolates later item or page failures without converting them into evidence absence.",
      inputSchema: USBR_RISE_FETCH_RESULTS_INPUT_SCHEMA,
      outputSchema: USBR_RISE_FETCH_RESULTS_OUTPUT_SCHEMA,
      execute: executeFetchResults,
    },
  ],
};

async function executeDiscoverItems(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeDiscoverInput(context.input as DiscoverItemsInput);
  const records: RiseCatalogRecord[] = [];
  const pages: Array<{
    pageNumber: number;
    providerTotalItems: number | null;
    providerMemberCount: number;
    matchedRecordCount: number;
  }> = [];
  const observations: DataSourceObservation[] = [];
  const warnings: string[] = [];
  let stopReason: "completed" | "no-results" | "max-pages" | "max-records" | "partial" =
    "completed";
  let failedPage: number | null = null;
  let failure: unknown;

  if (!hasDiscoveryFilter(query)) {
    warnings.push(
      "No catalog query or filter was supplied; candidates reflect bounded provider scan order only.",
    );
  }

  for (let offset = 0; offset < context.limits.maxPages; offset += 1) {
    const pageNumber = query.startPage + offset;
    try {
      const response = await context.http.request({
        endpointId: "usbr-rise-api",
        method: "GET",
        path: CATALOG_PATH,
        query: { itemsPerPage: query.pageSize, page: pageNumber },
      });
      const parsed = parseProviderPage(response.json(), `catalog page ${pageNumber}`);
      observations.push({ ...response.observation, sourceId: `catalog-page:${pageNumber}` });
      const normalized = parsed.members.map((member) => normalizeCatalogRecord(member, pageNumber));
      const matching = normalized.filter((item) => catalogItemMatches(item, query));
      const remaining = context.limits.maxRecords - records.length;
      const selected = matching.slice(0, remaining);
      records.push(...selected);
      pages.push({
        pageNumber,
        providerTotalItems: parsed.totalItems,
        providerMemberCount: parsed.members.length,
        matchedRecordCount: selected.length,
      });

      if (matching.length > selected.length || records.length >= context.limits.maxRecords) {
        stopReason = "max-records";
        break;
      }
      if (!parsed.hasNext) {
        stopReason = records.length === 0 && offset === 0 ? "no-results" : "completed";
        break;
      }
      if (offset + 1 >= context.limits.maxPages) {
        stopReason = "max-pages";
        break;
      }
    } catch (error) {
      if (observations.length === 0) throw normalizeProviderFailure(error);
      failedPage = pageNumber;
      failure = error;
      stopReason = "partial";
      break;
    }
  }

  if (stopReason === "max-pages") {
    warnings.push(
      "Catalog scanning reached the page limit; zero or sparse candidates do not prove that matching RISE items are absent.",
    );
  }
  const partial = failedPage !== null;
  const errors: DataMachineError[] = partial
    ? [partialError("A later RISE catalog page could not be retrieved or validated.", failure)]
    : [];
  return {
    status: partial ? "partial" : "success",
    data: {
      source: sourceDescriptor(CATALOG_PATH),
      query,
      candidateItemIds: records.map((record) => record.itemId),
      records,
      pages,
      listSemantics: LIST_SEMANTICS,
      stopReason,
    },
    summary: {
      recordCount: records.length,
      pageCount: pages.length,
      chunkCount: 0,
      truncated: stopReason === "max-pages" || stopReason === "max-records",
      completeness: partial ? "partial" : "complete",
      ...(failedPage === null
        ? {}
        : { missing: [{ kind: "page" as const, identifiers: [String(failedPage)] }] }),
    },
    warnings,
    errors,
    observations,
  };
}

async function executeFetchResults(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeFetchInput(context.input as FetchResultsInput);
  const records: RiseResultRecord[] = [];
  const pages: Array<{
    itemId: string;
    pageNumber: number;
    providerTotalItems: number | null;
    recordCount: number;
  }> = [];
  const itemMetadata: Record<string, RiseItemMetadata> = {};
  const observations: DataSourceObservation[] = [];
  const warnings: string[] = [];
  const missing: string[] = [];
  let stopReason: "completed" | "no-results" | "max-pages" | "max-records" | "partial" =
    "completed";
  let partialFailure: unknown;

  for (const itemId of query.itemIds) {
    let metadata = emptyItemMetadata(itemId);
    if (query.includeItemMetadata) {
      try {
        const response = await context.http.request({
          endpointId: "usbr-rise-api",
          method: "GET",
          path: `${CATALOG_PATH}/${encodeURIComponent(itemId)}`,
        });
        metadata = normalizeItemMetadata(requireObject(response.json(), "catalog item"), itemId);
        observations.push({ ...response.observation, sourceId: `item-metadata:${itemId}` });
      } catch (error) {
        warnings.push(
          `Catalog metadata could not be retrieved for item ${itemId}; result rows retain available provider fields.`,
        );
        if (error instanceof DataRuntimeError && error.code === "credential-invalid") throw error;
      }
    }
    itemMetadata[itemId] = metadata;

    for (let offset = 0; offset < context.limits.maxPages; offset += 1) {
      const pageNumber = query.startPage + offset;
      try {
        const response = await context.http.request({
          endpointId: "usbr-rise-api",
          method: "GET",
          path: RESULT_PATH,
          query: buildResultQuery(query, itemId, pageNumber),
        });
        const parsed = parseProviderPage(
          response.json(),
          `result item ${itemId} page ${pageNumber}`,
        );
        observations.push({
          ...response.observation,
          sourceId: `result:${itemId}:page:${pageNumber}`,
        });
        const normalized = parsed.members.map((member) =>
          normalizeResultRecord(member, metadata, pageNumber),
        );
        const remaining = context.limits.maxRecords - records.length;
        const selected = normalized.slice(0, remaining);
        records.push(...selected);
        pages.push({
          itemId,
          pageNumber,
          providerTotalItems: parsed.totalItems,
          recordCount: selected.length,
        });

        if (normalized.length > selected.length || records.length >= context.limits.maxRecords) {
          stopReason = "max-records";
          break;
        }
        if (!parsed.hasNext) break;
        if (offset + 1 >= context.limits.maxPages) {
          stopReason = "max-pages";
          break;
        }
      } catch (error) {
        if (observations.length === 0) throw normalizeProviderFailure(error);
        missing.push(`item:${itemId}`);
        partialFailure = error;
        stopReason = "partial";
        break;
      }
    }
    if (stopReason === "max-records") break;
  }

  if (stopReason === "completed" && records.length === 0) stopReason = "no-results";
  const partial = missing.length > 0;
  const errors: DataMachineError[] = partial
    ? [partialError("One or more RISE item result ranges could not be retrieved.", partialFailure)]
    : [];
  return {
    status: partial ? "partial" : "success",
    data: {
      source: sourceDescriptor(RESULT_PATH),
      query,
      itemMetadata,
      records,
      pages,
      stopReason,
    },
    summary: {
      recordCount: records.length,
      pageCount: pages.length,
      chunkCount: query.itemIds.length,
      truncated: stopReason === "max-pages" || stopReason === "max-records",
      completeness: partial ? "partial" : "complete",
      ...(partial ? { missing: [{ kind: "range" as const, identifiers: missing }] } : {}),
    },
    warnings,
    errors,
    observations,
  };
}

function normalizeDiscoverInput(input: DiscoverItemsInput): NormalizedDiscoverItemsInput {
  const queryTerms = (input.queryTerms ?? [])
    .flatMap((value) =>
      normalizeRequiredText(value, "queryTerms").replaceAll(",", " ").split(/\s+/u),
    )
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  return {
    queryTerms: [...new Set(queryTerms)],
    itemTitleContains: optionalText(input.itemTitleContains, "itemTitleContains"),
    locationNameContains: optionalText(input.locationNameContains, "locationNameContains"),
    parameterNameContains: optionalText(input.parameterNameContains, "parameterNameContains"),
    parameterId: optionalText(input.parameterId, "parameterId"),
    locationId: optionalText(input.locationId, "locationId"),
    sourceCode: optionalText(input.sourceCode, "sourceCode"),
    startPage: input.startPage ?? 1,
    pageSize: input.pageSize ?? DEFAULT_PAGE_SIZE,
  };
}

function normalizeFetchInput(input: FetchResultsInput): NormalizedFetchResultsInput {
  const itemIds = [
    ...new Set((input.itemIds ?? []).map((item) => normalizeRequiredText(item, "itemIds"))),
  ];
  if (itemIds.length === 0) {
    throw new DataRuntimeError(
      "invalid-request",
      "At least one explicit RISE item ID is required.",
    );
  }
  const afterUtc = optionalRfc3339(input.afterUtc, "afterUtc");
  const beforeUtc = optionalRfc3339(input.beforeUtc, "beforeUtc");
  if (afterUtc && beforeUtc && Date.parse(afterUtc) > Date.parse(beforeUtc)) {
    throw new DataRuntimeError("invalid-request", "afterUtc must not follow beforeUtc.");
  }
  return {
    itemIds,
    locationId: optionalText(input.locationId, "locationId"),
    parameterId: optionalText(input.parameterId, "parameterId"),
    afterUtc,
    beforeUtc,
    orderDateTime: input.orderDateTime ?? "desc",
    includeItemMetadata: input.includeItemMetadata ?? false,
    startPage: input.startPage ?? 1,
    pageSize: input.pageSize ?? DEFAULT_PAGE_SIZE,
  };
}

function buildResultQuery(
  query: NormalizedFetchResultsInput,
  itemId: string,
  pageNumber: number,
): Record<string, number | string> {
  return {
    itemId,
    itemsPerPage: query.pageSize,
    page: pageNumber,
    ...(query.locationId === null ? {} : { locationId: query.locationId }),
    ...(query.parameterId === null ? {} : { parameterId: query.parameterId }),
    ...(query.afterUtc === null ? {} : { "dateTime[after]": query.afterUtc }),
    ...(query.beforeUtc === null ? {} : { "dateTime[before]": query.beforeUtc }),
    "order[dateTime]": query.orderDateTime,
  };
}

function parseProviderPage(value: unknown, label: string): ParsedProviderPage {
  const payload = requireObject(value, label);
  if (!Array.isArray(payload.member)) {
    throw providerInvalid(`The RISE ${label} response does not contain a member array.`);
  }
  const members = payload.member.map((member, index) =>
    requireObject(member, `${label} member ${index + 1}`),
  );
  const view = isObject(payload.view) ? payload.view : {};
  return {
    members,
    totalItems: nonNegativeInteger(payload.totalItems),
    hasNext: optionalString(view.next) !== null,
  };
}

function normalizeCatalogRecord(
  payload: Record<string, unknown>,
  sourcePageNumber: number,
): RiseCatalogRecord {
  const metadata = normalizeItemMetadata(payload);
  return {
    itemId: metadata.itemId,
    itemApiPath: optionalString(payload["@id"]),
    itemTitle: metadata.itemTitle,
    itemDescription: metadata.itemDescription,
    locationId: metadata.locationId,
    locationName: metadata.locationName,
    locationSourceCode: metadata.locationSourceCode,
    parameterId: metadata.parameterId,
    parameterName: metadata.parameterName,
    parameterUnit: metadata.parameterUnit,
    parameterGroup: metadata.parameterGroup,
    parameterTimestep: metadata.parameterTimestep,
    parameterTransformation: metadata.parameterTransformation,
    sourceCode: metadata.sourceCode,
    temporalStartDate: metadata.temporalStartDate,
    temporalEndDate: metadata.temporalEndDate,
    landingPage: metadata.landingPage,
    spatial: metadata.spatial,
    sourcePageNumber,
  };
}

function normalizeItemMetadata(
  payload: Record<string, unknown>,
  fallbackItemId = "",
): RiseItemMetadata {
  const itemId = optionalString(payload.id) ?? fallbackItemId;
  if (!itemId) throw providerInvalid("A RISE catalog item is missing its item identifier.");
  return {
    itemId,
    itemTitle: optionalString(payload.itemTitle) ?? optionalString(payload["dcat:title"]),
    itemDescription:
      optionalString(payload.itemDescription) ?? optionalString(payload["dcat:description"]),
    locationId: optionalString(payload.locationId),
    locationName: optionalString(payload.locationName),
    locationSourceCode: optionalString(payload.locationSourceCode),
    parameterId: optionalString(payload.parameterId),
    parameterName: optionalString(payload.parameterName),
    parameterUnit: optionalString(payload.parameterUnit),
    parameterGroup: optionalString(payload.parameterGroup),
    parameterTimestep: optionalString(payload.parameterTimestep),
    parameterTransformation: optionalString(payload.parameterTransformation),
    sourceCode: optionalString(payload.sourceCode),
    temporalStartDate: optionalString(payload.temporalStartDate),
    temporalEndDate: optionalString(payload.temporalEndDate),
    landingPage: optionalString(payload["dcat:landingPage"]),
    providerDisclaimer: optionalString(payload.disclaimer),
    spatial: normalizeSpatial(payload["dcat:spatial"]),
  };
}

function normalizeResultRecord(
  payload: Record<string, unknown>,
  metadata: RiseItemMetadata,
  sourcePageNumber: number,
): RiseResultRecord {
  const itemId = optionalString(payload.itemId) ?? metadata.itemId;
  const locationId = optionalString(payload.locationId) ?? metadata.locationId;
  const parameterId = optionalString(payload.parameterId) ?? metadata.parameterId;
  const observedAtUtc = optionalString(payload.dateTime);
  const value = resultValue(payload.result);
  const coordinates = metadata.spatial?.coordinates ?? null;
  const fallbackRecordId = [itemId, locationId, parameterId, observedAtUtc]
    .filter((item): item is string => item !== null)
    .join(":");
  return {
    recordId:
      (optionalString(payload.id) ?? fallbackRecordId) || `${itemId}:page:${sourcePageNumber}`,
    itemId,
    locationId,
    locationName: metadata.locationName,
    parameterId,
    parameterName: metadata.parameterName,
    parameterUnit: metadata.parameterUnit,
    parameterGroup: metadata.parameterGroup,
    parameterTimestep: metadata.parameterTimestep,
    parameterTransformation: metadata.parameterTransformation,
    sourceCode: optionalString(payload.sourceCode) ?? metadata.sourceCode,
    observedAtUtc,
    value,
    status: optionalString(payload.status),
    lastUpdate: optionalString(payload.lastUpdate),
    createDate: optionalString(payload.createDate),
    updateDate: optionalString(payload.updateDate),
    latitude: coordinates?.[1] ?? null,
    longitude: coordinates?.[0] ?? null,
    itemTitle: metadata.itemTitle,
    itemDescription: metadata.itemDescription,
    landingPage: metadata.landingPage,
    providerDisclaimer: metadata.providerDisclaimer,
    sourcePageNumber,
  };
}

function emptyItemMetadata(itemId: string): RiseItemMetadata {
  return {
    itemId,
    itemTitle: null,
    itemDescription: null,
    locationId: null,
    locationName: null,
    locationSourceCode: null,
    parameterId: null,
    parameterName: null,
    parameterUnit: null,
    parameterGroup: null,
    parameterTimestep: null,
    parameterTransformation: null,
    sourceCode: null,
    temporalStartDate: null,
    temporalEndDate: null,
    landingPage: null,
    providerDisclaimer: null,
    spatial: null,
  };
}

function catalogItemMatches(item: RiseCatalogRecord, query: NormalizedDiscoverItemsInput): boolean {
  const searchable = [
    item.itemId,
    item.itemTitle,
    item.itemDescription,
    item.locationId,
    item.locationName,
    item.locationSourceCode,
    item.parameterId,
    item.parameterName,
    item.parameterUnit,
    item.parameterGroup,
    item.sourceCode,
    item.landingPage,
  ]
    .filter((value): value is string => value !== null)
    .join(" ")
    .toLowerCase();
  return (
    query.queryTerms.every((term) => searchable.includes(term)) &&
    contains(item.itemTitle, query.itemTitleContains) &&
    contains(item.locationName, query.locationNameContains) &&
    contains(item.parameterName, query.parameterNameContains) &&
    equals(item.parameterId, query.parameterId) &&
    equals(item.locationId, query.locationId) &&
    equals(item.sourceCode, query.sourceCode, true)
  );
}

function hasDiscoveryFilter(query: NormalizedDiscoverItemsInput): boolean {
  return (
    query.queryTerms.length > 0 ||
    query.itemTitleContains !== null ||
    query.locationNameContains !== null ||
    query.parameterNameContains !== null ||
    query.parameterId !== null ||
    query.locationId !== null ||
    query.sourceCode !== null
  );
}

function contains(value: string | null, expected: string | null): boolean {
  return expected === null || (value ?? "").toLowerCase().includes(expected.toLowerCase());
}

function equals(value: string | null, expected: string | null, caseInsensitive = false): boolean {
  if (expected === null) return true;
  if (caseInsensitive) return (value ?? "").toLowerCase() === expected.toLowerCase();
  return value === expected;
}

function normalizeSpatial(value: unknown): RiseItemMetadata["spatial"] {
  if (!isObject(value) || value.type !== "Point" || !Array.isArray(value.coordinates)) return null;
  const longitude = finiteNumber(value.coordinates[0]);
  const latitude = finiteNumber(value.coordinates[1]);
  return longitude === null || latitude === null
    ? null
    : { type: "Point", coordinates: [longitude, latitude] };
}

function sourceDescriptor(endpoint: string): Record<string, JsonValue> {
  return {
    providerId: "usbr-rise",
    endpoint,
    interpretationBoundary:
      "RISE catalog and result rows do not determine shortage severity, compliance, attribution, or governance responsibility.",
  };
}

function partialError(message: string, failure: unknown): DataMachineError {
  return {
    code: "partial-result",
    message,
    retryable: failure instanceof DataRuntimeError ? (failure.options.retryable ?? false) : false,
    userActionRequired: false,
    details: {
      causeCode: failure instanceof DataRuntimeError ? failure.code : "provider-response-invalid",
    },
  };
}

function optionalText(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  return normalizeRequiredText(value, field);
}

function normalizeRequiredText(value: string, field: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) throw new DataRuntimeError("invalid-request", `${field} cannot be blank.`);
  return normalized;
}

function optionalRfc3339(value: string | undefined, field: string): string | null {
  const normalized = optionalText(value, field);
  if (normalized === null) return null;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new DataRuntimeError(
      "invalid-request",
      `${field} must be an RFC3339 timestamp with an explicit UTC offset.`,
    );
  }
  return normalized;
}

function optionalString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function nonNegativeInteger(value: unknown): number | null {
  const numberValue =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function resultValue(value: unknown): number | string | null {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw providerInvalid("A RISE result row contains a non-scalar result value.");
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw providerInvalid(`The RISE ${label} response must be an object.`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeProviderFailure(error: unknown): DataRuntimeError {
  if (error instanceof DataRuntimeError) return error;
  return providerInvalid("The RISE response could not be retrieved, parsed, or validated.");
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}
