import type {
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  USGS_WATER_IV_INPUT_SCHEMA,
  USGS_WATER_IV_OUTPUT_SCHEMA,
} from "./usgs-water-instantaneous-values.schemas.js";

const ENDPOINT_PATH = "/nwis/iv/";
const MAX_TIME_SERIES = 500;
const MAX_VALUES_PER_SERIES = 10_000;
const MAX_VALIDATION_ISSUES = 50;
const DEFAULT_PARAMETER_CODES = ["00060", "00065"] as const;
const ISO_DURATION_PATTERN =
  /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

type SiteStatus = "active" | "all" | "inactive";

interface BoundingBox {
  minLongitude: number;
  minLatitude: number;
  maxLongitude: number;
  maxLatitude: number;
}

interface UsgsWaterInput {
  boundingBox?: BoundingBox;
  siteNumbers?: string[];
  period?: string;
  startDateTimeUtc?: string;
  endDateTimeUtc?: string;
  parameterCodes?: string[];
  siteType?: string;
  siteStatus?: SiteStatus;
  agencyCode?: string;
}

interface NormalizedUsgsWaterInput {
  selection:
    | { kind: "bounding-box"; boundingBox: BoundingBox; siteNumbers: null }
    | { kind: "sites"; boundingBox: null; siteNumbers: string[] };
  time:
    | { kind: "period"; period: string; startDateTimeUtc: null; endDateTimeUtc: null }
    | { kind: "window"; period: null; startDateTimeUtc: string; endDateTimeUtc: string };
  parameterCodes: string[];
  siteType: string;
  siteStatus: SiteStatus;
  agencyCode: string | null;
}

interface SeriesIdentity {
  siteNumber: string;
  siteName: string;
  agencyCode: string | null;
  siteType: string | null;
  stateCode: string | null;
  countyCode: string | null;
  hucCode: string | null;
  latitude: number | null;
  longitude: number | null;
  parameterCode: string;
  variableName: string;
  variableDescription: string;
  statisticCode: string | null;
  unit: string | null;
}

interface UsgsWaterRecord extends SeriesIdentity {
  observedAtUtc: string;
  value: number;
  qualifiers: string[];
  provisional: boolean;
}

interface UsgsWaterSeriesSummary extends SeriesIdentity {
  recordCount: number;
  provisionalRecordCount: number;
  firstObservedAtUtc: string | null;
  lastObservedAtUtc: string | null;
}

interface ValidationIssue {
  path: string;
  message: string;
}

interface NormalizedProviderPayload {
  records: UsgsWaterRecord[];
  series: UsgsWaterSeriesSummary[];
  issues: ValidationIssue[];
  issueCount: number;
  truncated: boolean;
}

class IssueCollector {
  count = 0;
  readonly issues: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.count += 1;
    if (this.issues.length < MAX_VALIDATION_ISSUES) this.issues.push({ path, message });
  }
}

export const usgsWaterInstantaneousValuesConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "usgs.water-instantaneous-values",
  capabilityVersion: "1.0.0",
  minimumCliVersion: "0.0.55",
  provider: {
    providerId: "usgs",
    name: "U.S. Geological Survey Water Data for the Nation",
  },
  sourceCategory: "surface-water-observations",
  endpoints: [
    {
      endpointId: "usgs-water-services",
      baseUrl: "https://waterservices.usgs.gov",
      pathPrefixes: [ENDPOINT_PATH],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/json"],
    },
  ],
  license: {
    name: "USGS-authored or produced data and information",
    url: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
    restrictions: [
      "Most recent instantaneous values are provisional and may be revised.",
      "USGS WaterServices is a legacy API scheduled for decommissioning in the first quarter of 2027.",
      "Do not infer flood stage, hazard, or regulatory meaning from a measurement without separately governed context.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 45_000,
    maxRequestBytes: 1_024,
    maxResponseBytes: 25_000_000,
    maxPages: 1,
    maxRecords: 100_000,
    maxRetries: 4,
    maxRetryDelayMs: 120_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "near-real-time-provisional",
    description:
      "Instantaneous time-series values may be recent and provisional; qualifiers and later revisions remain authoritative provider context.",
  },
  limitations: [
    "This connector targets the legacy WaterServices Instantaneous Values endpoint, which USGS plans to decommission in the first quarter of 2027.",
    "USGS warns that decommission preparation may include intentional service degradation or blackouts during the second half of 2026, so availability before final retirement is not guaranteed.",
    "The endpoint exposes USGS-served regular time-series parameters; it is not a station catalog, daily-values service, or statistical service.",
    "Some operational data that are not quality assured, commonly including temperature and precipitation, can be limited by the responsible USGS water science center to 120 days or less.",
    "Bounding-box selection can omit sites whose coordinates are unavailable or not referenced as required by the legacy service.",
    "The connector does not interpret flood thresholds, return periods, hydrologic causes, or policy implications.",
  ],
  discovery: {
    source: {
      maintainedBy: "U.S. Geological Survey",
      summary:
        "USGS WaterServices regular time-series measurements for streamflow, gage height, and other instantaneous parameters.",
      description:
        "The legacy Instantaneous Values service returns recent or historical WaterML time series for selected monitoring sites and parameters. Values commonly include provisional status qualifiers and station metadata.",
      coverage: {
        geographic:
          "USGS Water Data for the Nation monitoring sites available through the selected site identifiers or legacy bounding-box filter, primarily in the United States.",
        temporal:
          "Regular time-series data generally from October 1, 2007 to the present, subject to parameter, site, operational-data, and service availability limits.",
        granularity: "One monitoring-site, parameter, and observation timestamp value.",
      },
    },
    summary:
      "Retrieve bounded USGS instantaneous water observations for explicit sites or one bounding box.",
    description:
      "This capability sends one bounded request to the legacy USGS WaterServices IV endpoint, validates its WaterML JSON envelope, and emits normalized station-parameter observations with qualifier and provisional-state lineage.",
    provides: [
      "Normalized site, location, parameter, unit, timestamp, value, qualifier, and provisional fields.",
      "Selection by at most 100 explicit site identifiers or one bounding box whose span product is at most 25 square degrees.",
      "Selection by one to eight five-digit parameter codes and a positive ISO-8601 period or explicit RFC3339 start/end window.",
      "Explicit partial status when isolated provider rows or series cannot be normalized.",
    ],
    doesNotProvide: [
      "Station discovery by place name, watershed interpretation, geocoding, or cross-source fusion.",
      "Daily values, annual or monthly statistics, discrete field measurements, or a complete site catalog.",
      "Flood-stage classification, forecasts, alerts, hazard advice, or causal interpretation.",
      "Guaranteed operation after the legacy WaterServices decommissioning window.",
    ],
    selectionHints: [
      "Choose this capability when the task already has USGS site identifiers or a small numeric bounding box and needs raw instantaneous observations.",
      "Prefer explicit site identifiers over a bounding box when station identity is already known.",
      "Treat qualifier P as provisional and do not use this capability alone to classify flood risk.",
      "Plan migration to the modern api.waterdata.usgs.gov APIs for workflows that must operate beyond early 2027.",
    ],
    typicalUseCases: [
      "Retrieve recent discharge parameter 00060 for known streamgages.",
      "Verify gage-height parameter 00065 observations within a small regional bounding box.",
    ],
    sourceDocumentation: [
      {
        title: "USGS WaterServices Instantaneous Values service details",
        url: "https://waterservices.usgs.gov/docs/instantaneous-values/instantaneous-values-details/",
      },
      {
        title: "USGS Water Data APIs and WaterServices decommission notice",
        url: "https://www.usgs.gov/tools/usgs-water-data-apis",
      },
      {
        title: "USGS WaterServices decommissioning announcement",
        url: "https://waterdata.usgs.gov/blog/api-waterservices-decom",
      },
    ],
  },
  operations: [
    {
      operationId: "fetch",
      operationVersion: "1.0.0",
      summary:
        "Fetch one bounded USGS WaterServices IV response and normalize station time-series values.",
      description:
        "Builds one deterministic legacy WaterServices query from an exclusive spatial selector and time selector, validates WaterML JSON, and preserves qualifier and provisional metadata under explicit series, value, byte, and record limits.",
      inputSchema: USGS_WATER_IV_INPUT_SCHEMA,
      outputSchema: USGS_WATER_IV_OUTPUT_SCHEMA,
      execute: executeUsgsWaterInstantaneousValues,
    },
  ],
};

async function executeUsgsWaterInstantaneousValues(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const input = normalizeInput(context.input as UsgsWaterInput);
  const response = await context.http.request({
    endpointId: "usgs-water-services",
    method: "GET",
    path: ENDPOINT_PATH,
    query: buildQuery(input),
  });
  const normalized = normalizeProviderPayload(response.json(), input, context.limits.maxRecords);
  const partial = normalized.issueCount > 0;
  const invalidPaths = normalized.issues.map((issue) => issue.path);
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message: "One or more USGS WaterServices series or value rows could not be normalized.",
          retryable: false,
          userActionRequired: false,
          details: {
            issueCount: normalized.issueCount,
            invalidPaths,
          },
        },
      ]
    : [];
  return {
    status: partial ? "partial" : "success",
    data: {
      source: {
        providerId: "usgs",
        service: "WaterServices Instantaneous Values",
        endpoint: ENDPOINT_PATH,
        provisionalPossible: true,
        legacyService: true,
        decommissionExpected: "2027-Q1",
        officialReplacement: "https://api.waterdata.usgs.gov/ogcapi/",
      },
      request: input,
      validation: {
        issueCount: normalized.issueCount,
        issues: normalized.issues,
      },
      series: normalized.series,
      records: normalized.records,
      stopReason: partial ? "partial" : normalized.truncated ? "max-records" : "completed",
    },
    summary: {
      recordCount: normalized.records.length,
      pageCount: 1,
      chunkCount: 1,
      truncated: normalized.truncated,
      completeness: partial ? "partial" : "complete",
      ...(partial ? { missing: [{ kind: "range" as const, identifiers: invalidPaths }] } : {}),
    },
    warnings: [
      "USGS instantaneous values may be provisional; retain and evaluate provider qualifiers.",
      "USGS plans to decommission the legacy WaterServices API in the first quarter of 2027.",
      "USGS has warned that decommission preparation may cause intentional degradation or blackouts during the second half of 2026.",
      ...(normalized.truncated
        ? ["The normalized observation set reached the requested record limit."]
        : []),
    ],
    errors,
    observations: [{ ...response.observation, sourceId: "instantaneous-values" }],
  };
}

function normalizeInput(input: UsgsWaterInput): NormalizedUsgsWaterInput {
  const selection = input.boundingBox
    ? {
        kind: "bounding-box" as const,
        boundingBox: normalizeBoundingBox(input.boundingBox),
        siteNumbers: null,
      }
    : {
        kind: "sites" as const,
        boundingBox: null,
        siteNumbers: [...(input.siteNumbers ?? [])].sort(codePointOrder),
      };
  const time = input.period
    ? {
        kind: "period" as const,
        period: normalizePositivePeriod(input.period),
        startDateTimeUtc: null,
        endDateTimeUtc: null,
      }
    : normalizeWindow(input.startDateTimeUtc ?? "", input.endDateTimeUtc ?? "");
  return {
    selection,
    time,
    parameterCodes: [...(input.parameterCodes ?? DEFAULT_PARAMETER_CODES)].sort(codePointOrder),
    siteType: (input.siteType ?? "ST").toUpperCase(),
    siteStatus: input.siteStatus ?? "active",
    agencyCode: input.agencyCode ? input.agencyCode.toUpperCase() : null,
  };
}

function normalizePositivePeriod(value: string): string {
  const normalized = value.toUpperCase();
  const match = ISO_DURATION_PATTERN.exec(normalized);
  const components = match?.slice(1).map((component) => Number(component ?? 0)) ?? [];
  const week = components[2] ?? 0;
  const hasNonWeekComponent = components.some((component, index) => index !== 2 && component > 0);
  if (
    !match ||
    !components.some((component) => Number.isFinite(component) && component > 0) ||
    (week > 0 && hasNonWeekComponent)
  ) {
    throw new DataRuntimeError(
      "invalid-request",
      "USGS period must be a positive ISO-8601 duration; week notation cannot be mixed with other duration components.",
    );
  }
  return normalized;
}

function normalizeBoundingBox(box: BoundingBox): BoundingBox {
  if (box.minLongitude >= box.maxLongitude || box.minLatitude >= box.maxLatitude) {
    throw new DataRuntimeError(
      "invalid-request",
      "USGS bounding-box minimums must be lower than maximums.",
    );
  }
  const area = (box.maxLongitude - box.minLongitude) * (box.maxLatitude - box.minLatitude);
  if (area > 25) {
    throw new DataRuntimeError(
      "invalid-request",
      "The USGS bounding-box coordinate-span product must not exceed 25 square degrees.",
      { details: { area, maximumArea: 25 } },
    );
  }
  return { ...box };
}

function normalizeWindow(startValue: string, endValue: string): NormalizedUsgsWaterInput["time"] {
  const start = parseInputInstant(startValue, "startDateTimeUtc");
  const end = parseInputInstant(endValue, "endDateTimeUtc");
  if (start.getTime() > end.getTime()) {
    throw new DataRuntimeError(
      "invalid-request",
      "USGS startDateTimeUtc must not follow endDateTimeUtc.",
    );
  }
  return {
    kind: "window",
    period: null,
    startDateTimeUtc: toUtcSecond(start),
    endDateTimeUtc: toUtcSecond(end),
  };
}

function parseInputInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!value || !Number.isFinite(parsed.getTime())) {
    throw new DataRuntimeError("invalid-request", `${field} must be a valid RFC3339 instant.`);
  }
  return parsed;
}

function buildQuery(input: NormalizedUsgsWaterInput): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {
    format: "json",
    parameterCd: input.parameterCodes.join(","),
    siteType: input.siteType,
    siteStatus: input.siteStatus,
  };
  if (input.selection.kind === "bounding-box") {
    query.bBox = boundingBoxText(input.selection.boundingBox);
  } else {
    query.sites = input.selection.siteNumbers.join(",");
  }
  if (input.time.kind === "period") {
    query.period = input.time.period;
  } else {
    query.startDT = input.time.startDateTimeUtc;
    query.endDT = input.time.endDateTimeUtc;
  }
  if (input.agencyCode) query.agencyCd = input.agencyCode;
  return query;
}

function boundingBoxText(box: BoundingBox): string {
  return [box.minLongitude, box.minLatitude, box.maxLongitude, box.maxLatitude]
    .map((value) => value.toFixed(6))
    .join(",");
}

function normalizeProviderPayload(
  payload: unknown,
  input: NormalizedUsgsWaterInput,
  maxRecords: number,
): NormalizedProviderPayload {
  const top = recordValue(payload);
  const value = recordValue(top?.value);
  const timeSeries = value?.timeSeries;
  if (!top || !value || !Array.isArray(timeSeries)) {
    throw new DataRuntimeError(
      "provider-response-invalid",
      "USGS WaterServices JSON must contain an array at $.value.timeSeries.",
    );
  }
  if (timeSeries.length > MAX_TIME_SERIES) {
    throw new DataRuntimeError(
      "response-too-large",
      "The USGS WaterServices response exceeds the connector time-series limit.",
      { details: { timeSeriesCount: timeSeries.length, maximumTimeSeries: MAX_TIME_SERIES } },
    );
  }

  const records: UsgsWaterRecord[] = [];
  const series: UsgsWaterSeriesSummary[] = [];
  const issues = new IssueCollector();
  let truncated = false;
  for (let seriesIndex = 0; seriesIndex < timeSeries.length; seriesIndex += 1) {
    const path = `$.value.timeSeries[${seriesIndex}]`;
    const parsed = normalizeSeries(
      timeSeries[seriesIndex],
      path,
      input,
      maxRecords - records.length,
      issues,
    );
    if (!parsed) continue;
    records.push(...parsed.records);
    series.push(parsed.summary);
    truncated ||= parsed.truncated;
  }
  return {
    records,
    series,
    issues: issues.issues,
    issueCount: issues.count,
    truncated,
  };
}

function normalizeSeries(
  rawSeries: unknown,
  path: string,
  input: NormalizedUsgsWaterInput,
  remainingRecords: number,
  issues: IssueCollector,
): { records: UsgsWaterRecord[]; summary: UsgsWaterSeriesSummary; truncated: boolean } | null {
  const series = recordValue(rawSeries);
  if (!series) {
    issues.add(path, "The timeSeries item is not an object.");
    return null;
  }
  const sourceInfo = recordValue(series.sourceInfo);
  const variable = recordValue(series.variable);
  const siteCode = firstRecord(sourceInfo?.siteCode);
  const variableCode = firstRecord(variable?.variableCode);
  const siteNumber = textValue(siteCode?.value);
  const parameterCode = textValue(variableCode?.value);
  if (!siteNumber || !parameterCode || !/^\d{5}$/.test(parameterCode)) {
    issues.add(path, "The timeSeries item lacks a valid site or five-digit parameter code.");
    return null;
  }
  if (!Array.isArray(series.values)) {
    issues.add(`${path}.values`, "The timeSeries values field is not an array.");
    return null;
  }

  const properties = siteProperties(sourceInfo);
  const geography = recordValue(recordValue(sourceInfo?.geoLocation)?.geogLocation);
  const identity: SeriesIdentity = {
    siteNumber,
    siteName: textValue(sourceInfo?.siteName) ?? "",
    agencyCode: textValue(siteCode?.agencyCode),
    siteType: properties.get("siteTypeCd") ?? null,
    stateCode: properties.get("stateCd") ?? null,
    countyCode: properties.get("countyCd") ?? null,
    hucCode: properties.get("hucCd") ?? null,
    latitude: coordinateValue(geography?.latitude, -90, 90),
    longitude: coordinateValue(geography?.longitude, -180, 180),
    parameterCode,
    variableName: textValue(variable?.variableName) ?? "",
    variableDescription: textValue(variable?.variableDescription) ?? "",
    statisticCode: statisticCode(variable),
    unit: textValue(recordValue(variable?.unit)?.unitCode),
  };
  const noDataValue = numberValue(variable?.noDataValue);
  const records: UsgsWaterRecord[] = [];
  let provisionalRecordCount = 0;
  let firstObservedAtUtc: string | null = null;
  let lastObservedAtUtc: string | null = null;
  let truncated = false;

  for (let sectionIndex = 0; sectionIndex < series.values.length; sectionIndex += 1) {
    const sectionPath = `${path}.values[${sectionIndex}]`;
    const section = recordValue(series.values[sectionIndex]);
    if (!section || !Array.isArray(section.value)) {
      issues.add(sectionPath, "The values section does not contain a value array.");
      continue;
    }
    if (section.value.length > MAX_VALUES_PER_SERIES) {
      throw new DataRuntimeError(
        "response-too-large",
        "A USGS WaterServices time series exceeds the per-series value limit.",
        {
          details: {
            siteNumber,
            parameterCode,
            valueCount: section.value.length,
            maximumValuesPerSeries: MAX_VALUES_PER_SERIES,
          },
        },
      );
    }
    for (let valueIndex = 0; valueIndex < section.value.length; valueIndex += 1) {
      const rowPath = `${sectionPath}.value[${valueIndex}]`;
      if (records.length >= remainingRecords) {
        truncated = true;
        continue;
      }
      const row = recordValue(section.value[valueIndex]);
      const value = numberValue(row?.value);
      const observedAtUtc = providerInstant(row?.dateTime);
      if (!row || value === null || observedAtUtc === null) {
        issues.add(rowPath, "The value row lacks a finite numeric value or valid timestamp.");
        continue;
      }
      if (noDataValue !== null && value === noDataValue) continue;
      if (!instantInsideWindow(observedAtUtc, input.time)) continue;
      const qualifiers = Array.isArray(row.qualifiers)
        ? row.qualifiers.map(textValue).filter((item): item is string => item !== null)
        : [];
      const provisional = qualifiers.some((item) => item.toUpperCase() === "P");
      records.push({
        ...identity,
        observedAtUtc,
        value,
        qualifiers,
        provisional,
      });
      if (provisional) provisionalRecordCount += 1;
      firstObservedAtUtc = earlierInstant(firstObservedAtUtc, observedAtUtc);
      lastObservedAtUtc = laterInstant(lastObservedAtUtc, observedAtUtc);
    }
  }

  return {
    records,
    summary: {
      ...identity,
      recordCount: records.length,
      provisionalRecordCount,
      firstObservedAtUtc,
      lastObservedAtUtc,
    },
    truncated,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const record = recordValue(item);
    if (record) return record;
  }
  return null;
}

function textValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/\s+/g, " ");
  return text || null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  const text = typeof value === "number" ? null : textValue(value);
  if (typeof value !== "number" && text === null) return null;
  const number = typeof value === "number" ? value : Number(text);
  return Number.isFinite(number) ? number : null;
}

function coordinateValue(value: unknown, minimum: number, maximum: number): number | null {
  const number = numberValue(value);
  return number !== null && number >= minimum && number <= maximum ? number : null;
}

function siteProperties(sourceInfo: Record<string, unknown> | null): Map<string, string> {
  const properties = new Map<string, string>();
  if (!Array.isArray(sourceInfo?.siteProperty)) return properties;
  for (const item of sourceInfo.siteProperty) {
    const property = recordValue(item);
    const name = textValue(property?.name);
    const value = textValue(property?.value);
    if (name && value) properties.set(name, value);
  }
  return properties;
}

function statisticCode(variable: Record<string, unknown> | null): string | null {
  const options = recordValue(variable?.options);
  if (!Array.isArray(options?.option)) return null;
  for (const item of options.option) {
    const option = recordValue(item);
    if (textValue(option?.name) === "Statistic") return textValue(option?.optionCode);
  }
  return null;
}

function providerInstant(value: unknown): string | null {
  const text = textValue(value);
  if (!text || !/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? toUtcSecond(parsed) : null;
}

function toUtcSecond(value: Date): string {
  const copy = new Date(value.getTime());
  copy.setUTCMilliseconds(0);
  return copy.toISOString().replace(".000Z", "Z");
}

function instantInsideWindow(
  observedAtUtc: string,
  time: NormalizedUsgsWaterInput["time"],
): boolean {
  return (
    time.kind === "period" ||
    (observedAtUtc >= time.startDateTimeUtc && observedAtUtc <= time.endDateTimeUtc)
  );
}

function earlierInstant(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function laterInstant(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

function codePointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
