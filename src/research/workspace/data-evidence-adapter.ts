import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtInDataRegistry } from "../../data/builtins.js";
import type { DataRegistry } from "../../data/catalog.js";
import type {
  DataArtifactRecord,
  DataCatalogCapability,
  DataRunRequest,
  DataRunResult,
} from "../../data/contracts.js";
import { executeDataRun } from "../../data/runtime/execute.js";
import { validateDataPublicContract } from "../../data/schemas.js";
import { CliError } from "../../errors.js";
import { loadCapabilityDeclarations, verifyCapabilities } from "./capabilities.js";
import {
  loadCapabilityCredentialMapForIds,
  researchDataCredentialId,
  researchDataCredentialIds,
} from "./credentials.js";
import {
  loadProjectEvidenceReceipts,
  persistDataEvidence,
  type BrokerEvidenceReceipt,
  type DataEvidenceArtifactInput,
} from "./evidence.js";
import { registerDataResultCandidate, type EvidenceCandidate } from "./evidence-ledger.js";
import { appendJournalEvent, readJournal } from "./journal.js";
import { loadProject } from "./projects.js";
import { canonicalJson, sha256Bytes, sha256Text, workspacePaths } from "./storage.js";
import { loadWorkspaceConfig } from "./workspace.js";
import {
  boundedResearchDataContext,
  buildResearchDataCommunication,
  inferResearchDataResultShape,
  type ResearchDataCommunication,
  type ResearchDataResultShape,
} from "./data-evidence-view.js";

const DATA_CONTEXT_BYTES_PER_TOKEN = 4;

export interface ResearchDataCapability {
  id: string;
  capabilityId: string;
  capabilityVersion: string;
  operationId: string;
  operationVersion: string;
  providerId: string;
  sourceCategory: string;
  summary: string;
  provides: string[];
  doesNotProvide: string[];
  manifestDigest: string;
  discoveryDigest: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  artifactOutput: boolean;
  resultShape: ResearchDataResultShape;
  credentials: Array<{
    id: string;
    credentialId: string;
    environmentVariable: string;
    required: boolean;
  }>;
}

export interface ResearchDataCapabilityCatalog {
  schemaVersion: 1;
  kind: "tiangong-research-data-capabilities";
  dataCatalogDigest: string;
  capabilities: ResearchDataCapability[];
  catalogDigest: string;
}

export interface ResearchDataExecutionResult {
  coreResult: DataRunResult;
  evidenceReceipt: BrokerEvidenceReceipt | null;
  candidate: EvidenceCandidate | null;
  boundedContext: {
    encoding: "utf8";
    text: string;
    truncated: boolean;
  } | null;
  communication: ResearchDataCommunication | null;
  dataBudget: {
    maxCalls: number;
    startedCalls: number;
    remainingCalls: number;
  };
}

export interface ExecuteResearchDataCapabilityInput {
  root: string;
  projectId: string;
  request: unknown;
  registry?: DataRegistry;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export interface ReadResearchDataEvidenceInput {
  root: string;
  projectId: string;
  receiptId: string;
  cursor: string;
}

export interface ResearchDataEvidenceViewResult {
  schemaVersion: 1;
  kind: "tiangong-research-data-evidence-view";
  projectId: string;
  receiptId: string;
  evidenceSha256: string;
  boundedContext: {
    encoding: "utf8";
    text: string;
    truncated: boolean;
  };
  communication: ResearchDataCommunication;
}

export function researchDataCapabilityId(capabilityId: string, operationId: string): string {
  return `data:${capabilityId}:${operationId}`;
}

export function projectResearchDataCapabilities(
  registry: DataRegistry = builtInDataRegistry,
): ResearchDataCapabilityCatalog {
  const dataCatalog = registry.catalog();
  const capabilities = dataCatalog.capabilities.flatMap((capability) =>
    projectCapability(registry, capability),
  );
  const stable = {
    schemaVersion: 1 as const,
    kind: "tiangong-research-data-capabilities" as const,
    dataCatalogDigest: dataCatalog.catalogDigest,
    capabilities,
  };
  return { ...stable, catalogDigest: sha256Text(canonicalJson(stable)) };
}

export async function executeResearchDataCapability(
  input: ExecuteResearchDataCapabilityInput,
): Promise<ResearchDataExecutionResult> {
  try {
    validateDataPublicContract("runRequest", input.request);
  } catch {
    throw researchDataError(
      "The Research data request does not satisfy the published DataRunRequest contract.",
      "RESEARCH_DATA_REQUEST_INVALID",
      2,
    );
  }
  const request = input.request as DataRunRequest;
  const registry = input.registry ?? builtInDataRegistry;
  const project = await loadProject(input.root, input.projectId);
  const discover = project.packages.find((workPackage) => workPackage.stage === "discover");
  if (discover?.status !== "running" || discover.executor !== "producer") {
    throw researchDataError(
      "Research data execution is allowed only during an active native discover stage.",
      "RESEARCH_NATIVE_STAGE_REQUIRED",
    );
  }
  const verification = await verifyCapabilities(input.root);
  if (verification.status !== "verified") {
    throw new CliError("Research data execution requires verified capability locks.", {
      code: "RESEARCH_CAPABILITY_DRIFT",
      exitCode: 3,
      details: verification,
    });
  }
  const connector = registry.registered(request.capabilityId);
  const operation = connector?.operations.get(request.operationId);
  if (!connector || !operation) {
    throw researchDataError(
      "The requested data capability operation is not registered.",
      "RESEARCH_DATA_CAPABILITY_INVALID",
    );
  }
  const config = await loadWorkspaceConfig(input.root);
  const journal = await readJournal(workspacePaths(input.root).journal);
  const startedCalls = journal.filter(
    (event) =>
      event.scope === input.projectId &&
      (event.type === "capability.fetch.requested" || event.type === "data.capability.requested"),
  ).length;
  if (startedCalls >= config.budget.maxBrokerCalls) {
    throw researchDataError(
      `Research evidence call ceiling reached: ${startedCalls}/${config.budget.maxBrokerCalls}.`,
      "RESEARCH_DATA_CALL_LIMIT_EXCEEDED",
    );
  }

  const effectiveRequest = structuredClone(request);
  validateDataPublicContract("runRequest", effectiveRequest);
  const researchCapabilityId = researchDataCapabilityId(request.capabilityId, request.operationId);
  const attemptId = randomUUID();
  await appendJournalEvent(
    workspacePaths(input.root).journal,
    "data.capability.requested",
    input.projectId,
    {
      attemptId,
      projectId: input.projectId,
      capabilityId: researchCapabilityId,
      dataCapabilityId: request.capabilityId,
      operationId: request.operationId,
      manifestDigest: connector.manifest.manifestDigest,
      requestEnvelopeSha256: sha256Text(canonicalJson(effectiveRequest)),
    },
  );

  const artifactDirectory = operation.manifest.artifactOutput
    ? await mkdtemp(join(tmpdir(), "tiangong-research-data-artifacts-"))
    : undefined;
  try {
    const declarations = await loadCapabilityDeclarations(input.root);
    const declaredCredentialIds = [
      ...new Set([
        ...declarations.capabilities.flatMap((capability) =>
          capability.credentials.map((credential) => credential.id),
        ),
        ...researchDataCredentialIds(registry),
      ]),
    ];
    const credentialMap = await loadCapabilityCredentialMapForIds(
      input.root,
      declaredCredentialIds,
    );
    const environment: NodeJS.ProcessEnv = {};
    for (const credential of connector.manifest.credentials) {
      const value = credentialMap.get(
        researchDataCredentialId(connector.manifest.capabilityId, credential.credentialId),
      );
      if (value !== undefined) environment[credential.environmentVariable] = value;
    }
    const coreResult = await executeDataRun(effectiveRequest, {
      registry,
      environment,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
      ...(input.clock === undefined ? {} : { clock: input.clock }),
      ...(artifactDirectory === undefined ? {} : { artifactOutputDirectory: artifactDirectory }),
    });
    if (coreResult.status === "blocked") {
      await appendJournalEvent(
        workspacePaths(input.root).journal,
        "data.capability.failed",
        input.projectId,
        {
          attemptId,
          capabilityId: researchCapabilityId,
          coreReceiptDigest: coreResult.receipt.receiptDigest,
          errorCodes: coreResult.errors.map((error) => error.code),
        },
      );
      return {
        coreResult,
        evidenceReceipt: null,
        candidate: null,
        boundedContext: null,
        communication: null,
        dataBudget: budget(config.budget.maxBrokerCalls, startedCalls + 1),
      };
    }

    const serialized = Buffer.from(`${canonicalJson(coreResult)}\n`, "utf8");
    const artifacts = artifactDirectory
      ? await loadDataEvidenceArtifacts(artifactDirectory, coreResult.data)
      : [];
    assertEvidencePackageBudget(serialized, artifacts, config.budget);
    const maxContextBytes = config.budget.maxBrokerContextTokens * DATA_CONTEXT_BYTES_PER_TOKEN;
    let context;
    try {
      context = boundedResearchDataContext(
        coreResult,
        maxContextBytes,
        config.budget.maxBrokerItems,
      );
    } catch {
      throw researchDataError(
        "Data evidence metadata exceeds the Research bounded-context ceiling.",
        "RESEARCH_DATA_CONTEXT_TOO_LARGE",
      );
    }
    const evidenceSha256 = sha256Bytes(serialized);
    const communication = buildResearchDataCommunication(
      coreResult,
      context,
      {
        maxBytes: maxContextBytes,
        maxItems: config.budget.maxBrokerItems,
      },
      (offset) => encodeDataEvidenceCursor(evidenceSha256, offset),
    );
    const receipt = await persistDataEvidence(
      input.root,
      {
        attemptId,
        projectId: input.projectId,
        capabilityId: researchCapabilityId,
        credentialId: null,
        status: coreResult.status === "success" ? 200 : 206,
        contentType: "application/json",
        sourceSha256:
          coreResult.receipt.aggregateResponseDigest ??
          coreResult.receipt.normalizedDataDigest ??
          coreResult.receipt.receiptDigest,
        contextItems: context.itemCount,
        contextOffset: 0,
        contextTotalItems: coreResult.summary.recordCount,
        contextNextOffset: context.nextOffset,
        contextTruncated: context.projected,
        redactions: 0,
        retrievedAt: coreResult.receipt.generatedAt,
        cacheHit: false,
        data: {
          coreReceiptDigest: coreResult.receipt.receiptDigest,
          capabilityId: coreResult.contract.capabilityId,
          capabilityVersion: coreResult.contract.capabilityVersion,
          operationId: coreResult.contract.operationId,
          operationVersion: coreResult.contract.operationVersion,
          requestDigest: coreResult.receipt.requestDigest,
          manifestDigest: coreResult.contract.manifestDigest!,
          inputSchemaDigest: coreResult.contract.inputSchema!.digest,
          outputSchemaDigest: coreResult.contract.outputSchema!.digest,
          resultStatus: coreResult.status,
          coverage: communication.requestCoverage,
          providerCoverage: communication.providerCoverage,
          limitCoverage: communication.limitCoverage,
          contextView: communication.contextView,
        },
      },
      serialized,
      context.bytes,
      artifacts,
    );
    const discovery = connector.discovery;
    const operationDiscovery = discovery.operations.find(
      (item) => item.operationId === request.operationId,
    )!;
    const candidate = await registerDataResultCandidate({
      root: input.root,
      projectId: input.projectId,
      receipt,
      title: `${discovery.source.name}: ${operationDiscovery.summary}`,
      excerpt: candidateExcerpt(discovery.summary, communication),
    });
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "data.capability.completed",
      input.projectId,
      {
        attemptId,
        capabilityId: researchCapabilityId,
        coreReceiptDigest: coreResult.receipt.receiptDigest,
        evidenceSha256: receipt.sha256,
        evidenceLocator: receipt.locator,
        candidateId: candidate.id,
        status: coreResult.status,
        recordCount: coreResult.summary.recordCount,
        coverageStatus: communication.requestCoverage.status,
        coverageTruncated: communication.requestCoverage.truncated,
        contextStatus: communication.contextView.status,
        contextItems: communication.contextView.itemCount,
        artifactCount: receipt.data?.artifacts.length ?? 0,
      },
    );
    return {
      coreResult,
      evidenceReceipt: receipt,
      candidate,
      boundedContext: {
        encoding: "utf8",
        text: Buffer.from(context.bytes).toString("utf8"),
        truncated: context.projected,
      },
      communication,
      dataBudget: budget(config.budget.maxBrokerCalls, startedCalls + 1),
    };
  } catch (error) {
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "data.capability.failed",
      input.projectId,
      {
        attemptId,
        capabilityId: researchCapabilityId,
        failureKind: error instanceof CliError ? error.code : "RESEARCH_DATA_EXECUTION_FAILED",
      },
    );
    throw error;
  } finally {
    if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
  }
}

export async function readResearchDataEvidence(
  input: ReadResearchDataEvidenceInput,
): Promise<ResearchDataEvidenceViewResult> {
  const project = await loadProject(input.root, input.projectId);
  const discover = project.packages.find((workPackage) => workPackage.stage === "discover");
  if (discover?.status !== "running" || discover.executor !== "producer") {
    throw researchDataError(
      "Research data evidence can be read only during an active native discover stage.",
      "RESEARCH_NATIVE_STAGE_REQUIRED",
    );
  }
  const receipts = await loadProjectEvidenceReceipts(input.root, input.projectId);
  const receipt = receipts.find((candidate) => candidate.attemptId === input.receiptId);
  if (!receipt || receipt.evidenceKind !== "data") {
    throw researchDataError(
      "The requested Research data evidence receipt does not exist.",
      "RESEARCH_DATA_EVIDENCE_NOT_FOUND",
      2,
    );
  }
  const offset = decodeDataEvidenceCursor(input.cursor, receipt.sha256);
  const serialized = await readFile(join(workspacePaths(input.root).control, receipt.locator));
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(serialized)) as unknown;
    validateDataPublicContract("runResult", parsed);
  } catch {
    throw researchDataError(
      "The persisted Research data evidence object is not a valid core result.",
      "RESEARCH_EVIDENCE_STORE_INVALID",
    );
  }
  const coreResult = parsed as DataRunResult;
  if (offset < 0 || offset >= coreResult.summary.recordCount) {
    throw researchDataError(
      "The Research data evidence cursor is outside the persisted result.",
      "RESEARCH_DATA_EVIDENCE_CURSOR_INVALID",
      2,
    );
  }
  const config = await loadWorkspaceConfig(input.root);
  const maxContextBytes = config.budget.maxBrokerContextTokens * DATA_CONTEXT_BYTES_PER_TOKEN;
  const context = boundedResearchDataContext(
    coreResult,
    maxContextBytes,
    config.budget.maxBrokerItems,
    offset,
  );
  const communication = buildResearchDataCommunication(
    coreResult,
    context,
    {
      maxBytes: maxContextBytes,
      maxItems: config.budget.maxBrokerItems,
    },
    (nextOffset) => encodeDataEvidenceCursor(receipt.sha256, nextOffset),
  );
  await appendJournalEvent(
    workspacePaths(input.root).journal,
    "data.evidence.viewed",
    input.projectId,
    {
      receiptId: receipt.attemptId,
      evidenceSha256: receipt.sha256,
      offset: context.offset,
      itemCount: context.itemCount,
      totalItems: context.totalItems,
      remainingItems: context.remainingItems,
    },
  );
  return {
    schemaVersion: 1,
    kind: "tiangong-research-data-evidence-view",
    projectId: input.projectId,
    receiptId: receipt.attemptId,
    evidenceSha256: receipt.sha256,
    boundedContext: {
      encoding: "utf8",
      text: Buffer.from(context.bytes).toString("utf8"),
      truncated: context.remainingItems > 0,
    },
    communication,
  };
}

function projectCapability(
  registry: DataRegistry,
  capability: DataCatalogCapability,
): ResearchDataCapability[] {
  const registered = registry.registered(capability.capabilityId)!;
  return capability.operations.map((operation) => ({
    id: researchDataCapabilityId(capability.capabilityId, operation.operationId),
    capabilityId: capability.capabilityId,
    capabilityVersion: capability.capabilityVersion,
    operationId: operation.operationId,
    operationVersion: operation.operationVersion,
    providerId: capability.providerId,
    sourceCategory: capability.sourceCategory,
    summary: operation.summary,
    provides: [...capability.provides],
    doesNotProvide: [...capability.doesNotProvide],
    manifestDigest: capability.manifestDigest,
    discoveryDigest: capability.discoveryDigest,
    inputSchemaDigest: operation.inputSchemaDigest,
    outputSchemaDigest: operation.outputSchemaDigest,
    artifactOutput: Boolean(
      registered.operations.get(operation.operationId)?.manifest.artifactOutput,
    ),
    resultShape: inferResearchDataResultShape(
      registered.operations.get(operation.operationId)!.definition.outputSchema,
      Boolean(registered.operations.get(operation.operationId)?.manifest.artifactOutput),
    ),
    credentials: registered.manifest.credentials.map((credential) => ({
      id: researchDataCredentialId(capability.capabilityId, credential.credentialId),
      credentialId: credential.credentialId,
      environmentVariable: credential.environmentVariable,
      required: credential.required,
    })),
  }));
}

async function loadDataEvidenceArtifacts(
  directory: string,
  data: unknown,
): Promise<DataEvidenceArtifactInput[]> {
  const records = collectArtifactRecords(data);
  return Promise.all(
    records.map(async (record) => {
      const bytes = await readFile(join(directory, record.relativePath));
      if (bytes.byteLength !== record.byteSize || sha256Bytes(bytes) !== record.sha256) {
        throw researchDataError(
          "A data runtime artifact no longer matches its validated output binding.",
          "RESEARCH_DATA_ARTIFACT_DRIFT",
        );
      }
      return { ...record, bytes };
    }),
  );
}

function assertEvidencePackageBudget(
  resultBytes: Uint8Array,
  artifacts: DataEvidenceArtifactInput[],
  limits: { maxBytesPerPackage: number; maxFilesPerPackage: number },
): void {
  // Artifact-producing connectors may bind one machine-readable manifest in
  // addition to the bounded source files.
  if (artifacts.length > limits.maxFilesPerPackage + 1) {
    throw researchDataError(
      `The validated data result has ${artifacts.length} artifacts; the Research evidence package allows ${limits.maxFilesPerPackage} source files plus one manifest.`,
      "RESEARCH_DATA_RESULT_TOO_LARGE",
    );
  }
  const totalBytes = artifacts.reduce(
    (total, artifact) => total + artifact.bytes.byteLength,
    resultBytes.byteLength,
  );
  if (totalBytes > limits.maxBytesPerPackage) {
    throw researchDataError(
      `The validated data result and artifacts require ${totalBytes} bytes; the Research evidence package allows ${limits.maxBytesPerPackage}.`,
      "RESEARCH_DATA_RESULT_TOO_LARGE",
    );
  }
}

function candidateExcerpt(sourceSummary: string, communication: ResearchDataCommunication): string {
  const coverage = communication.requestCoverage;
  const stopReason = coverage.stopReason ? ` (stop reason: ${coverage.stopReason})` : "";
  const coverageText =
    coverage.status === "complete"
      ? "Request coverage is complete."
      : coverage.status === "bounded"
        ? `Request coverage is bounded${stopReason}; the persisted evidence contains every returned record.`
        : `Request coverage is partial${stopReason}; inspect missing ranges and validation issues.`;
  const context = communication.contextView;
  const limitText =
    communication.limitCoverage.status === "bounded"
      ? ` Explicit limits were also reached: ${communication.limitCoverage.limitsHit.join(", ")}.`
      : "";
  const contextText =
    context.status === "full"
      ? "The Agent context contains the full result."
      : context.nextCursor
        ? `The Agent context is a ${context.strategy} view of ${context.itemCount}/${context.totalItems} returned records; ${context.remainingItems} remain in evidence. Continue reading with the returned cursor before claiming full row-level review, or disclose the presented fraction as a limitation.`
        : `The Agent context is a ${context.strategy} view of ${context.itemCount}/${context.totalItems} returned records; ${context.remainingItems} remain in evidence, but no further item view fits the configured context ceiling. Use a narrower request or disclose this limitation.`;
  return `${sourceSummary} Returned ${coverage.recordCount} record(s). ${coverageText}${limitText} ${contextText}`;
}

function encodeDataEvidenceCursor(evidenceSha256: string, offset: number): string {
  const core = { schemaVersion: 1, evidenceSha256, offset };
  return Buffer.from(
    canonicalJson({ ...core, bindingSha256: sha256Text(canonicalJson(core)) }),
    "utf8",
  ).toString("base64url");
}

function decodeDataEvidenceCursor(cursor: string, evidenceSha256: string): number {
  try {
    if (!/^[A-Za-z0-9_-]{16,2048}$/.test(cursor)) throw new Error("invalid cursor encoding");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      schemaVersion?: unknown;
      evidenceSha256?: unknown;
      offset?: unknown;
      bindingSha256?: unknown;
    };
    const core = {
      schemaVersion: value.schemaVersion,
      evidenceSha256: value.evidenceSha256,
      offset: value.offset,
    };
    if (
      value.schemaVersion !== 1 ||
      value.evidenceSha256 !== evidenceSha256 ||
      !Number.isInteger(value.offset) ||
      Number(value.offset) < 0 ||
      value.bindingSha256 !== sha256Text(canonicalJson(core))
    ) {
      throw new Error("invalid cursor binding");
    }
    return Number(value.offset);
  } catch {
    throw researchDataError(
      "The Research data evidence cursor is invalid or belongs to another evidence object.",
      "RESEARCH_DATA_EVIDENCE_CURSOR_INVALID",
      2,
    );
  }
}

function collectArtifactRecords(value: unknown): DataArtifactRecord[] {
  const records = new Map<string, DataArtifactRecord>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const object = candidate as Record<string, unknown>;
    if (
      typeof object.relativePath === "string" &&
      typeof object.sha256 === "string" &&
      typeof object.byteSize === "number"
    ) {
      const record = object as unknown as DataArtifactRecord;
      records.set(record.relativePath, record);
    }
    for (const nested of Object.values(object)) visit(nested);
  };
  visit(value);
  return [...records.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function budget(maxCalls: number, startedCalls: number) {
  return {
    maxCalls,
    startedCalls,
    remainingCalls: Math.max(0, maxCalls - startedCalls),
  };
}

function researchDataError(message: string, code: string, exitCode = 3): CliError {
  return new CliError(message, { code, exitCode });
}
