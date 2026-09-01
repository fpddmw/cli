import type { DataMissingRange, DataRunResult } from "../../data/contracts.js";
import { canonicalJson } from "./storage.js";

export type ResearchDataResultShape = "artifact" | "record-list" | "structured" | "timeseries";

export type ResearchDataContextStrategy =
  | "artifact-manifest"
  | "full"
  | "metadata-only"
  | "record-groups"
  | "record-prefix"
  | "structured-prefix"
  | "timeseries-chunks";

export interface ResearchDataCoverage {
  status: "bounded" | "complete" | "partial";
  truncated: boolean;
  stopReason: string | null;
  recordCount: number;
  missing: DataMissingRange[];
}

export interface ResearchDataContextView {
  status: "full" | "metadata-only" | "projected";
  strategy: ResearchDataContextStrategy;
  itemCount: number;
  totalItems: number;
  maxItems: number;
  maxBytes: number;
}

export interface ResearchDataCommunication {
  validation: {
    status: "issues" | "valid";
    issueCodes: string[];
  };
  requestCoverage: ResearchDataCoverage;
  contextView: ResearchDataContextView;
}

export interface BoundedResearchDataContext {
  bytes: Uint8Array;
  projected: boolean;
  itemCount: number;
  totalItems: number;
  strategy: ResearchDataContextStrategy;
  status: ResearchDataContextView["status"];
}

interface DataProjection {
  value: unknown;
  itemCount: number;
  strategy: Exclude<ResearchDataContextStrategy, "full" | "metadata-only">;
}

export function inferResearchDataResultShape(
  outputSchema: Record<string, unknown>,
  artifactOutput: boolean,
): ResearchDataResultShape {
  if (artifactOutput) return "artifact";
  const properties = objectValue(outputSchema.properties);
  if (properties && "locations" in properties) return "timeseries";
  if (properties && "records" in properties) return "record-list";
  return "structured";
}

export function boundedResearchDataContext(
  result: DataRunResult,
  maxBytes: number,
  maxItems: number,
): BoundedResearchDataContext {
  const totalItems = result.summary.recordCount;
  const availableItems = Math.max(totalItems, inferAvailableItems(result.data));
  const full = encode(result);
  if (full.byteLength <= maxBytes && availableItems <= maxItems) {
    return {
      bytes: full,
      projected: false,
      itemCount: totalItems,
      totalItems,
      strategy: "full",
      status: "full",
    };
  }

  let lower = 0;
  let upper = Math.min(maxItems, availableItems);
  let best:
    | { bytes: Uint8Array; itemCount: number; strategy: DataProjection["strategy"] }
    | undefined;
  while (lower <= upper) {
    const candidate = Math.floor((lower + upper) / 2);
    const projection = projectData(result.data, candidate);
    if (!projection) break;
    const bytes = encode(projectedResult(result, projection, totalItems));
    if (bytes.byteLength <= maxBytes) {
      best = { bytes, itemCount: projection.itemCount, strategy: projection.strategy };
      lower = candidate + 1;
    } else {
      upper = candidate - 1;
    }
  }
  if (best && best.itemCount > 0) {
    return {
      ...best,
      projected: true,
      totalItems,
      status: "projected",
    };
  }

  const metadata = encode(metadataOnlyResult(result, totalItems));
  if (metadata.byteLength > maxBytes) {
    throw new Error("Data evidence metadata exceeds the Research bounded-context ceiling.");
  }
  return {
    bytes: metadata,
    projected: true,
    itemCount: 0,
    totalItems,
    strategy: "metadata-only",
    status: "metadata-only",
  };
}

export function buildResearchDataCommunication(
  result: DataRunResult,
  context: BoundedResearchDataContext,
  limits: { maxBytes: number; maxItems: number },
): ResearchDataCommunication {
  const issueCodes = collectIssueCodes(result);
  const coverageStatus =
    result.summary.completeness === "partial"
      ? "partial"
      : result.summary.truncated
        ? "bounded"
        : "complete";
  return {
    validation: {
      status: issueCodes.length === 0 && result.status === "success" ? "valid" : "issues",
      issueCodes,
    },
    requestCoverage: {
      status: coverageStatus,
      truncated: result.summary.truncated,
      stopReason: stopReason(result.data),
      recordCount: result.summary.recordCount,
      missing: structuredClone(result.summary.missing ?? []),
    },
    contextView: {
      status: context.status,
      strategy: context.strategy,
      itemCount: context.itemCount,
      totalItems: context.totalItems,
      maxItems: limits.maxItems,
      maxBytes: limits.maxBytes,
    },
  };
}

function projectedResult(
  result: DataRunResult,
  projection: DataProjection,
  totalItems: number,
): Record<string, unknown> {
  return {
    schemaVersion: result.schemaVersion,
    status: result.status,
    requestId: result.requestId,
    contract: result.contract,
    summary: result.summary,
    warnings: result.warnings,
    errors: result.errors,
    receipt: result.receipt,
    data: {
      contextView: {
        projected: true,
        strategy: projection.strategy,
        itemCount: projection.itemCount,
        totalItems,
        normalizedDataDigest: result.receipt.normalizedDataDigest,
        fullEvidenceLocatorAvailableInReceipt: true,
      },
      value: projection.value,
    },
  };
}

function metadataOnlyResult(result: DataRunResult, totalItems: number): Record<string, unknown> {
  return {
    schemaVersion: result.schemaVersion,
    status: result.status,
    requestId: result.requestId,
    contract: result.contract,
    summary: result.summary,
    warnings: result.warnings,
    errors: result.errors,
    receipt: result.receipt,
    data: {
      contextView: {
        projected: true,
        strategy: "metadata-only",
        itemCount: 0,
        totalItems,
        normalizedDataDigest: result.receipt.normalizedDataDigest,
        fullEvidenceLocatorAvailableInReceipt: true,
      },
    },
  };
}

function projectData(data: unknown, maxItems: number): DataProjection | null {
  const value = objectValue(data);
  if (!value) return null;
  if (Array.isArray(value.records)) {
    const grouped = projectRecords(value.records, maxItems);
    return {
      value: { ...value, records: grouped.records },
      itemCount: grouped.records.length,
      strategy: grouped.grouped ? "record-groups" : "record-prefix",
    };
  }
  if (Array.isArray(value.locations) && value.locations.some(hasTimeAxis)) {
    const projected = projectLocations(value.locations, maxItems);
    return {
      value: { ...value, locations: projected.locations },
      itemCount: projected.itemCount,
      strategy: "timeseries-chunks",
    };
  }
  if (Array.isArray(value.files)) {
    return {
      value: projectTopLevelCollections(value, maxItems, "files"),
      itemCount: Math.min(maxItems, value.files.length),
      strategy: "artifact-manifest",
    };
  }
  const collection = largestTopLevelArray(value);
  if (collection) {
    return {
      value: { ...value, [collection.key]: collection.values.slice(0, maxItems) },
      itemCount: Math.min(maxItems, collection.values.length),
      strategy: "structured-prefix",
    };
  }
  return null;
}

function projectRecords(
  records: unknown[],
  maxItems: number,
): { records: unknown[]; grouped: boolean } {
  const rows = records.map(objectValue);
  if (!rows.every((row) => row && typeof row.threadId === "string")) {
    return { records: records.slice(0, maxItems), grouped: false };
  }
  const groups = new Map<string, unknown[]>();
  for (let index = 0; index < records.length; index += 1) {
    const key = String(rows[index]!.threadId);
    const group = groups.get(key) ?? [];
    group.push(records[index]);
    groups.set(key, group);
  }
  const selected: unknown[] = [];
  for (const group of groups.values()) {
    const remaining = maxItems - selected.length;
    if (remaining <= 0) break;
    if (group.length <= remaining) selected.push(...group);
    else {
      const root = group.find((record) => objectValue(record)?.parentId === null);
      if (root !== undefined) selected.push(root);
      for (const record of group) {
        if (selected.length >= maxItems) break;
        if (record !== root) selected.push(record);
      }
    }
  }
  return { records: selected, grouped: true };
}

function projectLocations(
  locations: unknown[],
  maxItems: number,
): { locations: unknown[]; itemCount: number } {
  const capacities = locations.map(locationRecordCount);
  const allocations = new Array<number>(locations.length).fill(0);
  let remaining = maxItems;
  while (remaining > 0) {
    let allocated = false;
    for (let index = 0; index < capacities.length && remaining > 0; index += 1) {
      if (allocations[index]! >= capacities[index]!) continue;
      allocations[index]! += 1;
      remaining -= 1;
      allocated = true;
    }
    if (!allocated) break;
  }
  return {
    locations: locations.map((location, index) =>
      projectLocation(location, allocations[index] ?? 0),
    ),
    itemCount: allocations.reduce((total, count) => total + count, 0),
  };
}

function projectLocation(location: unknown, maxItems: number): unknown {
  const value = objectValue(location);
  if (!value) return location;
  const directAxis = timeAxis(value);
  if (directAxis) return sliceAlignedSeries(value, directAxis, maxItems);
  const sectionKeys = Object.keys(value).filter((key) => {
    const section = objectValue(value[key]);
    return section !== null && timeAxis(section) !== null;
  });
  if (sectionKeys.length === 0) return structuredClone(value);
  const capacities = sectionKeys.map((key) => {
    const section = objectValue(value[key])!;
    return timeAxis(section)!.values.length;
  });
  const allocations = new Array<number>(sectionKeys.length).fill(0);
  let remaining = maxItems;
  while (remaining > 0) {
    let allocated = false;
    for (let index = 0; index < sectionKeys.length && remaining > 0; index += 1) {
      if (allocations[index]! >= capacities[index]!) continue;
      allocations[index]! += 1;
      remaining -= 1;
      allocated = true;
    }
    if (!allocated) break;
  }
  const projected: Record<string, unknown> = { ...value };
  for (let index = 0; index < sectionKeys.length; index += 1) {
    const key = sectionKeys[index]!;
    const section = objectValue(value[key])!;
    projected[key] = sliceAlignedSeries(section, timeAxis(section)!, allocations[index] ?? 0);
  }
  return projected;
}

function sliceAlignedSeries(
  value: Record<string, unknown>,
  axis: { key: string; values: unknown[] },
  maxItems: number,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    ...value,
    [axis.key]: axis.values.slice(0, maxItems),
  };
  for (const [key, candidate] of Object.entries(value)) {
    if (key === axis.key) continue;
    if (Array.isArray(candidate) && candidate.length === axis.values.length) {
      projected[key] = candidate.slice(0, maxItems);
      continue;
    }
    if (
      Array.isArray(candidate) &&
      candidate.every((item) => Array.isArray(objectValue(item)?.values))
    ) {
      projected[key] = candidate.map((item) => {
        const record = objectValue(item)!;
        return { ...record, values: (record.values as unknown[]).slice(0, maxItems) };
      });
    }
  }
  return projected;
}

function projectTopLevelCollections(
  value: Record<string, unknown>,
  maxItems: number,
  primaryKey: string,
): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...value };
  for (const [key, candidate] of Object.entries(value)) {
    if (!Array.isArray(candidate)) continue;
    projected[key] = candidate.slice(0, key === primaryKey ? maxItems : Math.min(maxItems, 20));
  }
  return projected;
}

function locationRecordCount(location: unknown): number {
  const value = objectValue(location);
  if (!value) return 0;
  const direct = timeAxis(value);
  if (direct) return direct.values.length;
  return Object.values(value).reduce<number>((total, section) => {
    const sectionValue = objectValue(section);
    return total + (sectionValue ? (timeAxis(sectionValue)?.values.length ?? 0) : 0);
  }, 0);
}

function hasTimeAxis(location: unknown): boolean {
  return locationRecordCount(location) > 0;
}

function timeAxis(value: Record<string, unknown>): { key: string; values: unknown[] } | null {
  for (const key of ["timesUtc", "dates", "time"]) {
    if (Array.isArray(value[key])) return { key, values: value[key] };
  }
  return null;
}

function largestTopLevelArray(
  value: Record<string, unknown>,
): { key: string; values: unknown[] } | null {
  let selected: { key: string; values: unknown[] } | null = null;
  for (const [key, candidate] of Object.entries(value)) {
    if (!Array.isArray(candidate)) continue;
    if (!selected || candidate.length > selected.values.length)
      selected = { key, values: candidate };
  }
  return selected;
}

function inferAvailableItems(data: unknown): number {
  const value = objectValue(data);
  if (!value) return 0;
  if (Array.isArray(value.records)) return value.records.length;
  if (Array.isArray(value.locations)) {
    return value.locations.reduce((total, location) => total + locationRecordCount(location), 0);
  }
  return largestTopLevelArray(value)?.values.length ?? 0;
}

function collectIssueCodes(result: DataRunResult): string[] {
  const codes = new Set<string>(result.errors.map((error) => error.code));
  const data = objectValue(result.data);
  const validation = data ? objectValue(data.validation) : null;
  if (validation && Array.isArray(validation.issues)) {
    for (const issue of validation.issues) {
      const code = objectValue(issue)?.code;
      if (typeof code === "string" && code.length > 0) codes.add(code);
    }
  }
  return [...codes].sort();
}

function stopReason(data: unknown): string | null {
  const value = objectValue(data)?.stopReason;
  return typeof value === "string" ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}
