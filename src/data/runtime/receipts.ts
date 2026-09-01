import type {
  CoreDataReceipt,
  DataCapabilityManifest,
  DataExecutionSummary,
  DataOperationManifest,
  DataRunRequest,
  DataSourceObservation,
} from "../contracts.js";
import { DATA_RECEIPT_SCHEMA_VERSION } from "../contracts.js";
import { sha256CanonicalJson } from "./canonical-json.js";

export function semanticRequest(request: DataRunRequest): Omit<DataRunRequest, "requestId"> {
  const { requestId: _requestId, ...semantic } = request;
  return semantic;
}

export function buildCoreDataReceipt(input: {
  cliVersion: string;
  request: DataRunRequest;
  manifest: DataCapabilityManifest | null;
  operation: DataOperationManifest | null;
  observations: DataSourceObservation[];
  data: unknown | null;
  completionStatus: "success" | "partial" | "blocked";
  summary: DataExecutionSummary;
  generatedAt: string;
}): CoreDataReceipt {
  const requestDigest = sha256CanonicalJson(semanticRequest(input.request));
  const inputDigest = sha256CanonicalJson(input.request.input);
  const aggregateResponseDigest = input.observations.length
    ? sha256CanonicalJson(input.observations)
    : null;
  const normalizedDataDigest = input.data === null ? null : sha256CanonicalJson(input.data);
  const stable = {
    schemaVersion: DATA_RECEIPT_SCHEMA_VERSION,
    cliVersion: input.cliVersion,
    capabilityId: input.request.capabilityId,
    capabilityVersion: input.request.capabilityVersion,
    operationId: input.request.operationId,
    operationVersion: input.request.operationVersion,
    requestDigest,
    manifestDigest: input.manifest?.manifestDigest ?? null,
    inputSchemaDigest: input.operation?.inputSchema.digest ?? null,
    outputSchemaDigest: input.operation?.outputSchema.digest ?? null,
    inputDigest,
    aggregateResponseDigest,
    normalizedDataDigest,
    observations: input.observations,
    completionStatus: input.completionStatus,
    summary: input.summary,
  };
  return {
    ...stable,
    generatedAt: input.generatedAt,
    receiptDigest: sha256CanonicalJson(stable),
  };
}
