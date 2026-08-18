import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CliError } from "../../errors.js";
import { loadEvidenceArtifactRecords, type EvidenceArtifactRecord } from "./artifacts.js";
import { loadProjectEvidenceReceipts } from "./evidence.js";
import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  verifyEvidenceLedger,
} from "./evidence-ledger.js";
import { readJournal } from "./journal.js";
import { parseEvidenceRecord, StructuredOutputError } from "./schemas.js";
import {
  canonicalJson,
  ensureDirectory,
  isObject,
  pathExists,
  resolveContained,
  sha256File,
  sha256Text,
  workspacePaths,
  writeTextAtomic,
} from "./storage.js";
import type { ProjectState } from "./types.js";

interface AcquisitionDecisionInput {
  sourceId: string;
  candidateId: string;
  artifactIds: string[];
  status: "accepted" | "limited" | "rejected";
  rationale: string;
  limitations: string[];
}

export interface MaterializedAcquisitionAudit {
  schemaVersion: 1;
  decisions: Array<
    AcquisitionDecisionInput & {
      artifacts: EvidenceArtifactRecord[];
    }
  >;
  limitations: string[];
  gaps: string[];
}

export interface EvidenceSnapshot {
  schemaVersion: 1;
  kind: "tiangong-evidence-snapshot";
  snapshotId: string;
  snapshotSha256: string;
  parentSnapshotId: string | null;
  parentSnapshotSha256: string | null;
  projectId: string;
  questionSha256: string;
  createdAt: string;
  ledgerHead: string;
  evidenceRecord: { path: string; sha256: string };
  acquisitionRecord: { path: string; sha256: string };
  receipts: Array<{
    attemptId: string;
    capabilityId: string;
    sha256: string;
    contextSha256: string;
    locator: string;
    contextLocator: string;
  }>;
  artifacts: EvidenceArtifactRecord[];
  sources: Array<Record<string, unknown>>;
  activitySummary: {
    total: number;
    byKind: Record<string, number>;
    blockedChallenges: number;
    linkedCandidateIds: string[];
  };
  coverage: Record<string, unknown>;
  gaps: string[];
  inferenceGate: {
    decision: "pass" | "stop";
    coverageDecision: "pass" | "insufficient";
    reasons: string[];
  };
  limitations: string[];
  delta: {
    addedSourceIds: string[];
    changedSourceIds: string[];
    removedSourceIds: string[];
    unchangedSourceIds: string[];
    addedArtifactIds: string[];
    removedArtifactIds: string[];
  };
}

export async function materializeAcquisitionAudit(
  root: string,
  project: ProjectState,
  value: Record<string, unknown>,
): Promise<MaterializedAcquisitionAudit> {
  const parsed = parseAcquisitionValue(value);
  const evidencePath = join(workspacePaths(root).projects, project.id, "outputs", "evidence.json");
  const evidence = parseEvidenceRecord(await readFile(evidencePath, "utf8"));
  const sources = evidence.sources as Array<Record<string, unknown>>;
  const sourceIds = new Set(sources.map((source) => String(source.id)));
  const sourceById = new Map(sources.map((source) => [String(source.id), source]));
  const sourceCandidates = await admittedSourceCandidateMap(root, project.id);
  if (
    parsed.decisions.length !== sourceIds.size ||
    parsed.decisions.some((decision) => !sourceIds.has(decision.sourceId)) ||
    [...sourceIds].some(
      (sourceId) => !parsed.decisions.some((decision) => decision.sourceId === sourceId),
    )
  ) {
    throw acquisitionOutputError(
      "Acquisition decisions must assess every provisionally admitted source exactly once.",
    );
  }
  const artifacts = new Map(
    (await loadEvidenceArtifactRecords(root, project.id)).map((record) => [
      record.artifactId,
      record,
    ]),
  );
  const decisions = parsed.decisions.map((decision) => {
    const expectedCandidateId = sourceCandidates.get(decision.sourceId);
    if (!expectedCandidateId || expectedCandidateId !== decision.candidateId) {
      throw acquisitionOutputError(
        `Acquisition decision ${decision.sourceId} is not bound to its ledger candidate.`,
      );
    }
    const boundArtifacts = decision.artifactIds.map((artifactId) => {
      const artifact = artifacts.get(artifactId);
      if (!artifact || artifact.candidateId !== decision.candidateId) {
        throw acquisitionOutputError(
          `Acquisition decision ${decision.sourceId} refers to an unknown or differently bound artifact.`,
        );
      }
      return artifact;
    });
    const source = sourceById.get(decision.sourceId);
    const provenance = source && isObject(source.provenance) ? source.provenance : {};
    if (
      provenance.kind === "broker" &&
      boundArtifacts.some((artifact) => !artifactHasDownloadProvenance(artifact, artifacts))
    ) {
      throw acquisitionOutputError(
        `Network source ${decision.sourceId} includes an artifact without an exact download or derived-file binding.`,
      );
    }
    return { ...decision, artifacts: boundArtifacts };
  });
  return {
    schemaVersion: 1,
    decisions,
    limitations: parsed.limitations,
    gaps: parsed.gaps,
  };
}

function artifactHasDownloadProvenance(
  artifact: EvidenceArtifactRecord,
  artifacts: Map<string, EvidenceArtifactRecord>,
  visited: Set<string> = new Set(),
): boolean {
  if (artifact.downloadBinding) return true;
  if (!artifact.derivedFromArtifactId || visited.has(artifact.artifactId)) return false;
  visited.add(artifact.artifactId);
  const parent = artifacts.get(artifact.derivedFromArtifactId);
  return parent ? artifactHasDownloadProvenance(parent, artifacts, visited) : false;
}

export async function commitAcquisitionAssessments(
  root: string,
  projectId: string,
  audit: MaterializedAcquisitionAudit,
): Promise<void> {
  const events = await readJournal(evidenceLedgerPath(root, projectId));
  const committed = new Set(
    events
      .filter((event) => event.type === "artifact.assessed")
      .map((event) => String(event.payload.assessmentSha256)),
  );
  for (const decision of audit.decisions) {
    const assessment = {
      sourceId: decision.sourceId,
      candidateId: decision.candidateId,
      artifactIds: decision.artifactIds,
      status: decision.status,
      rationale: decision.rationale,
      limitations: decision.limitations,
    };
    const assessmentSha256 = sha256Text(canonicalJson(assessment));
    if (committed.has(assessmentSha256)) continue;
    await appendEvidenceLedgerEvent(root, projectId, "artifact.assessed", {
      ...assessment,
      assessmentSha256,
    });
  }
}

export async function freezeEvidenceSnapshot(
  root: string,
  project: ProjectState,
): Promise<EvidenceSnapshot> {
  const projectRoot = join(workspacePaths(root).projects, project.id);
  const evidencePath = join(projectRoot, "outputs", "evidence.json");
  const acquisitionPath = join(projectRoot, "outputs", "acquisition.json");
  const evidence = parseEvidenceRecord(await readFile(evidencePath, "utf8"));
  const audit = parseMaterializedAcquisitionAudit(
    JSON.parse(await readFile(acquisitionPath, "utf8")),
  );
  const decisions = new Map(audit.decisions.map((decision) => [decision.sourceId, decision]));
  const includedSources = (evidence.sources as Array<Record<string, unknown>>).flatMap((source) => {
    const sourceId = String(source.id);
    const decision = decisions.get(sourceId);
    if (!decision || decision.status === "rejected") return [];
    const artifactIds = decision.artifacts.map((artifact) => artifact.artifactId);
    const producerVisibleArtifactIds = decision.artifacts
      .filter((artifact) => producerVisibleMediaType(artifact.mediaType))
      .map((artifact) => artifact.artifactId);
    const registeredInputFullText = source.fullTextAvailable === true;
    const producerContextLevel = registeredInputFullText
      ? "full-input"
      : producerVisibleArtifactIds.length
        ? "bounded-text-artifact"
        : "metadata-only";
    return [
      {
        ...source,
        fullTextAvailable: producerContextLevel !== "metadata-only",
        registeredFullFile: registeredInputFullText || artifactIds.length > 0,
        producerContextLevel,
        producerVisibleArtifactIds,
        reviewerBoundFullFile: registeredInputFullText || artifactIds.length > 0,
        locallyAcquired: artifactIds.length > 0,
        visuallyVerified: false,
        acquisitionStatus: decision.status,
        acquisitionRationale: decision.rationale,
        acquisitionLimitations: decision.limitations,
        artifactIds,
      },
    ];
  });
  const coverage = computeSnapshotCoverage(
    project,
    includedSources,
    isObject(evidence.coverage) ? evidence.coverage : {},
  );
  const inferenceReasons = [...new Set([...audit.gaps, ...coverage.gaps])];
  const inferenceGate = {
    decision: (inferenceReasons.length ? "stop" : "pass") as "pass" | "stop",
    coverageDecision: coverage.decision,
    reasons: inferenceReasons,
  };
  const selectedArtifactIds = new Set(
    audit.decisions
      .filter((decision) => decision.status !== "rejected")
      .flatMap((decision) => decision.artifactIds),
  );
  const [ledger, receipts, registeredArtifacts, ledgerEvents] = await Promise.all([
    verifyEvidenceLedger(root, project.id),
    loadProjectEvidenceReceipts(root, project.id),
    loadEvidenceArtifactRecords(root, project.id),
    readJournal(evidenceLedgerPath(root, project.id)),
  ]);
  const artifacts = registeredArtifacts.filter((artifact) =>
    selectedArtifactIds.has(artifact.artifactId),
  );
  const priorSnapshot = [...ledgerEvents]
    .reverse()
    .find((event) => event.type === "snapshot.frozen");
  const parentSnapshotId =
    typeof priorSnapshot?.payload.snapshotId === "string" ? priorSnapshot.payload.snapshotId : null;
  const parentSnapshotSha256 =
    typeof priorSnapshot?.payload.snapshotSha256 === "string"
      ? priorSnapshot.payload.snapshotSha256
      : project.lineage.baseSnapshotSha256;
  const effectiveParentSnapshotId = parentSnapshotId ?? project.lineage.baseSnapshotId;
  const parentSnapshot = parentSnapshotSha256
    ? await loadImmutableEvidenceSnapshot(root, project.id, parentSnapshotSha256)
    : null;
  const delta = snapshotDelta(parentSnapshot, includedSources, artifacts);
  const activityEvents = ledgerEvents.filter((event) => event.type === "activity.recorded");
  const activityByKind: Record<string, number> = {};
  for (const event of activityEvents) {
    const kind = String(event.payload.kind);
    activityByKind[kind] = (activityByKind[kind] ?? 0) + 1;
  }
  const core = {
    schemaVersion: 1 as const,
    kind: "tiangong-evidence-snapshot" as const,
    parentSnapshotId: effectiveParentSnapshotId,
    parentSnapshotSha256,
    projectId: project.id,
    questionSha256: sha256Text(project.question),
    createdAt: new Date().toISOString(),
    ledgerHead: ledger.head,
    evidenceRecord: {
      path: "outputs/evidence.json",
      sha256: await sha256File(evidencePath),
    },
    acquisitionRecord: {
      path: "outputs/acquisition.json",
      sha256: await sha256File(acquisitionPath),
    },
    receipts: receipts.map((receipt) => ({
      attemptId: receipt.attemptId,
      capabilityId: receipt.capabilityId,
      sha256: receipt.sha256,
      contextSha256: receipt.contextSha256,
      locator: receipt.locator,
      contextLocator: receipt.contextLocator,
    })),
    artifacts,
    sources: includedSources,
    activitySummary: {
      total: activityEvents.length,
      byKind: activityByKind,
      blockedChallenges: activityEvents.filter(
        (event) => event.payload.status === "blocked" && event.payload.challenge !== "none",
      ).length,
      linkedCandidateIds: [
        ...new Set(
          activityEvents.flatMap((event) =>
            Array.isArray(event.payload.candidateIds)
              ? event.payload.candidateIds.filter(
                  (candidateId): candidateId is string => typeof candidateId === "string",
                )
              : [],
          ),
        ),
      ].sort(),
    },
    coverage,
    gaps: audit.gaps,
    inferenceGate,
    limitations: [
      ...(evidence.limitations as string[]),
      ...audit.limitations,
      ...audit.decisions.flatMap((decision) => decision.limitations),
    ].filter((value, index, values) => values.indexOf(value) === index),
    delta,
  };
  const snapshotId = `snapshot-${sha256Text(canonicalJson(core)).slice(0, 24)}`;
  const withoutHash = { ...core, snapshotId };
  const snapshot: EvidenceSnapshot = {
    ...withoutHash,
    snapshotSha256: sha256Text(canonicalJson(withoutHash)),
  };
  const logicalPath = `evidence/snapshots/${snapshot.snapshotSha256}.json`;
  const immutablePath = resolveContained(projectRoot, logicalPath);
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (await pathExists(immutablePath)) {
    if ((await sha256File(immutablePath)) !== sha256Text(content)) {
      throw snapshotError("Content-addressed evidence snapshot drift detected.");
    }
  } else {
    await ensureDirectory(dirname(immutablePath));
    await writeTextAtomic(immutablePath, content, 0o444);
    await chmod(immutablePath, 0o444).catch(() => undefined);
  }
  await writeTextAtomic(join(projectRoot, "outputs", "evidence-snapshot.json"), content);
  await appendEvidenceLedgerEvent(root, project.id, "snapshot.frozen", {
    snapshotId,
    snapshotSha256: snapshot.snapshotSha256,
    parentSnapshotId: effectiveParentSnapshotId,
    parentSnapshotSha256,
    path: logicalPath,
    sourceCount: includedSources.length,
    artifactCount: artifacts.length,
    coverage,
    gaps: audit.gaps,
    inferenceGate,
  });
  project.evidenceState.currentSnapshotId = snapshot.snapshotId;
  project.evidenceState.currentSnapshotSha256 = snapshot.snapshotSha256;
  return snapshot;
}

function producerVisibleMediaType(mediaType: string): boolean {
  // HTML is frequently a login, paywall, challenge, or error page returned in
  // place of the requested file. Keep it auditable as an artifact, but never
  // let it mechanically satisfy producer-visible/full-text coverage.
  return ["application/json", "text/plain", "text/markdown", "text/csv"].includes(mediaType);
}

export async function loadCurrentEvidenceSnapshot(
  root: string,
  projectId: string,
): Promise<EvidenceSnapshot> {
  const projectRoot = join(workspacePaths(root).projects, projectId);
  const path = join(projectRoot, "outputs", "evidence-snapshot.json");
  if (!(await pathExists(path))) {
    throw snapshotError("Formal analysis requires a frozen evidence snapshot.");
  }
  const snapshot = parseEvidenceSnapshot(JSON.parse(await readFile(path, "utf8")));
  if (snapshot.projectId !== projectId) {
    throw snapshotError("Current evidence snapshot belongs to a different project.");
  }
  const { snapshotSha256, ...withoutHash } = snapshot;
  if (sha256Text(canonicalJson(withoutHash)) !== snapshotSha256) {
    throw snapshotError("Evidence snapshot hash binding is invalid.");
  }
  const immutablePath = resolveContained(projectRoot, `evidence/snapshots/${snapshotSha256}.json`);
  if (
    !(await pathExists(immutablePath)) ||
    (await sha256File(immutablePath)) !== (await sha256File(path))
  ) {
    throw snapshotError("Current evidence snapshot is not bound to its immutable copy.");
  }
  const chain = await loadImmutableEvidenceSnapshotChain(root, projectId, snapshotSha256);
  if (canonicalJson(chain[0]) !== canonicalJson(snapshot)) {
    throw snapshotError("Current evidence snapshot does not match the immutable chain leaf.");
  }
  for (const record of [snapshot.evidenceRecord, snapshot.acquisitionRecord]) {
    if ((await sha256File(resolveContained(projectRoot, record.path))) !== record.sha256) {
      throw snapshotError(`Snapshot-bound output drifted: ${record.path}.`);
    }
  }
  const receipts = await loadProjectEvidenceReceipts(root, projectId);
  const receiptById = new Map(receipts.map((receipt) => [receipt.attemptId, receipt]));
  if (
    receipts.length !== snapshot.receipts.length ||
    snapshot.receipts.some((record) => {
      const receipt = receiptById.get(record.attemptId);
      return (
        !receipt ||
        canonicalJson(record) !==
          canonicalJson({
            attemptId: receipt.attemptId,
            capabilityId: receipt.capabilityId,
            sha256: receipt.sha256,
            contextSha256: receipt.contextSha256,
            locator: receipt.locator,
            contextLocator: receipt.contextLocator,
          })
      );
    })
  ) {
    throw snapshotError("Snapshot broker-receipt binding drifted.");
  }
  await verifyEvidenceLedger(root, projectId);
  const snapshotEvents = (await readJournal(evidenceLedgerPath(root, projectId))).filter(
    (event) =>
      event.type === "snapshot.frozen" &&
      event.payload.snapshotId === snapshot.snapshotId &&
      event.payload.snapshotSha256 === snapshot.snapshotSha256,
  );
  const snapshotEvent = snapshotEvents[0];
  if (
    snapshotEvents.length !== 1 ||
    !snapshotEvent ||
    snapshotEvent.previousHash !== snapshot.ledgerHead ||
    snapshotEvent.payload.path !== `evidence/snapshots/${snapshot.snapshotSha256}.json` ||
    snapshotEvent.payload.parentSnapshotId !== snapshot.parentSnapshotId ||
    snapshotEvent.payload.parentSnapshotSha256 !== snapshot.parentSnapshotSha256
  ) {
    throw snapshotError("Evidence snapshot is not bound to its ledger freeze event.");
  }
  const currentArtifacts = new Map(
    (await loadEvidenceArtifactRecords(root, projectId)).map((record) => [
      record.artifactId,
      record,
    ]),
  );
  for (const artifact of snapshot.artifacts) {
    const current = currentArtifacts.get(artifact.artifactId);
    if (!current || canonicalJson(current) !== canonicalJson(artifact)) {
      throw snapshotError(`Snapshot artifact binding drifted: ${artifact.artifactId}.`);
    }
  }
  return snapshot;
}

export async function loadInferenceReadyEvidenceSnapshot(
  root: string,
  projectId: string,
): Promise<EvidenceSnapshot> {
  const snapshot = await loadCurrentEvidenceSnapshot(root, projectId);
  if (snapshot.inferenceGate.decision !== "pass") {
    throw new CliError("Formal inference is blocked by the frozen evidence gate.", {
      code: "RESEARCH_INFERENCE_GATE_BLOCKED",
      exitCode: 3,
      details: {
        snapshotId: snapshot.snapshotId,
        snapshotSha256: snapshot.snapshotSha256,
        coverageDecision: snapshot.inferenceGate.coverageDecision,
        reasons: snapshot.inferenceGate.reasons,
      },
    });
  }
  return snapshot;
}

export async function loadImmutableEvidenceSnapshotChain(
  root: string,
  projectId: string,
  leafSnapshotSha256: string,
): Promise<EvidenceSnapshot[]> {
  if (!/^[0-9a-f]{64}$/.test(leafSnapshotSha256)) {
    throw snapshotError("Evidence snapshot chain leaf hash is invalid.");
  }
  const chain: EvidenceSnapshot[] = [];
  const visited = new Set<string>();
  let nextSha256: string | null = leafSnapshotSha256;
  let child: EvidenceSnapshot | null = null;
  while (nextSha256) {
    if (visited.has(nextSha256) || chain.length >= 1_000) {
      throw snapshotError("Evidence snapshot chain contains a cycle or exceeds its bound.");
    }
    visited.add(nextSha256);
    const snapshot = await loadImmutableEvidenceSnapshot(root, projectId, nextSha256);
    if (
      child &&
      (child.parentSnapshotSha256 !== snapshot.snapshotSha256 ||
        child.parentSnapshotId !== snapshot.snapshotId)
    ) {
      throw snapshotError("Evidence snapshot parent linkage is invalid.");
    }
    if ((snapshot.parentSnapshotId === null) !== (snapshot.parentSnapshotSha256 === null)) {
      throw snapshotError("Evidence snapshot parent identity is incomplete.");
    }
    chain.push(snapshot);
    child = snapshot;
    nextSha256 = snapshot.parentSnapshotSha256;
  }
  return chain;
}

async function loadImmutableEvidenceSnapshot(
  root: string,
  projectId: string,
  snapshotSha256: string,
): Promise<EvidenceSnapshot> {
  const path = resolveContained(
    join(workspacePaths(root).projects, projectId),
    `evidence/snapshots/${snapshotSha256}.json`,
  );
  if (!(await pathExists(path))) {
    throw snapshotError("Parent evidence snapshot is missing from the immutable chain.");
  }
  const snapshot = parseEvidenceSnapshot(JSON.parse(await readFile(path, "utf8")));
  const { snapshotSha256: recordedSha256, ...withoutHash } = snapshot;
  if (
    recordedSha256 !== snapshotSha256 ||
    sha256Text(canonicalJson(withoutHash)) !== snapshotSha256
  ) {
    throw snapshotError("Parent evidence snapshot failed its hash binding.");
  }
  return snapshot;
}

function snapshotDelta(
  parent: EvidenceSnapshot | null,
  sources: Array<Record<string, unknown>>,
  artifacts: EvidenceArtifactRecord[],
): EvidenceSnapshot["delta"] {
  const currentSources = new Map(
    sources.map((source) => [String(source.id), sha256Text(canonicalJson(source))]),
  );
  const parentSources = new Map(
    (parent?.sources ?? []).map((source) => [String(source.id), sha256Text(canonicalJson(source))]),
  );
  const currentArtifactIds = new Set(artifacts.map((artifact) => artifact.artifactId));
  const parentArtifactIds = new Set(
    (parent?.artifacts ?? []).map((artifact) => artifact.artifactId),
  );
  return {
    addedSourceIds: [...currentSources.keys()]
      .filter((sourceId) => !parentSources.has(sourceId))
      .sort(),
    changedSourceIds: [...currentSources.keys()]
      .filter(
        (sourceId) =>
          parentSources.has(sourceId) &&
          parentSources.get(sourceId) !== currentSources.get(sourceId),
      )
      .sort(),
    removedSourceIds: [...parentSources.keys()]
      .filter((sourceId) => !currentSources.has(sourceId))
      .sort(),
    unchangedSourceIds: [...currentSources.keys()]
      .filter(
        (sourceId) =>
          parentSources.has(sourceId) &&
          parentSources.get(sourceId) === currentSources.get(sourceId),
      )
      .sort(),
    addedArtifactIds: [...currentArtifactIds]
      .filter((artifactId) => !parentArtifactIds.has(artifactId))
      .sort(),
    removedArtifactIds: [...parentArtifactIds]
      .filter((artifactId) => !currentArtifactIds.has(artifactId))
      .sort(),
  };
}

function parseAcquisitionValue(value: Record<string, unknown>): {
  decisions: AcquisitionDecisionInput[];
  limitations: string[];
  gaps: string[];
} {
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.decisions) ||
    !Array.isArray(value.limitations) ||
    !Array.isArray(value.gaps) ||
    value.decisions.some((decision) => !isAcquisitionDecision(decision)) ||
    value.limitations.some((item) => typeof item !== "string") ||
    value.gaps.some((item) => typeof item !== "string")
  ) {
    throw acquisitionOutputError("Acquisition audit output is malformed.");
  }
  return value as unknown as {
    decisions: AcquisitionDecisionInput[];
    limitations: string[];
    gaps: string[];
  };
}

export function parseMaterializedAcquisitionAudit(value: unknown): MaterializedAcquisitionAudit {
  if (!isObject(value)) throw snapshotError("Materialized acquisition audit is invalid.");
  const parsed = parseAcquisitionValue(value);
  if (
    parsed.decisions.some(
      (decision) =>
        !Array.isArray((decision as unknown as { artifacts?: unknown }).artifacts) ||
        (decision as unknown as { artifacts: unknown[] }).artifacts.some(
          (artifact) => !isObject(artifact),
        ),
    )
  ) {
    throw snapshotError("Materialized acquisition artifact bindings are invalid.");
  }
  return value as unknown as MaterializedAcquisitionAudit;
}

function parseEvidenceSnapshot(value: unknown): EvidenceSnapshot {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-evidence-snapshot" ||
    typeof value.snapshotId !== "string" ||
    typeof value.snapshotSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.snapshotSha256) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.questionSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.questionSha256) ||
    typeof value.ledgerHead !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.ledgerHead) ||
    typeof value.projectId !== "string" ||
    (value.parentSnapshotId !== null && typeof value.parentSnapshotId !== "string") ||
    (value.parentSnapshotSha256 !== null &&
      (typeof value.parentSnapshotSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.parentSnapshotSha256))) ||
    !isSnapshotOutputRecord(value.evidenceRecord, "outputs/evidence.json") ||
    !isSnapshotOutputRecord(value.acquisitionRecord, "outputs/acquisition.json") ||
    !Array.isArray(value.receipts) ||
    value.receipts.some((receipt) => !isSnapshotReceipt(receipt)) ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.artifacts) ||
    !isActivitySummary(value.activitySummary) ||
    !isObject(value.coverage) ||
    !Array.isArray(value.gaps) ||
    value.gaps.some((gap) => typeof gap !== "string") ||
    !isInferenceGate(value.inferenceGate) ||
    !Array.isArray(value.limitations) ||
    value.limitations.some((limitation) => typeof limitation !== "string") ||
    !isObject(value.delta) ||
    Object.values(value.delta).some(
      (items) => !Array.isArray(items) || items.some((item) => typeof item !== "string"),
    )
  ) {
    throw snapshotError("Evidence snapshot is malformed.");
  }
  return value as unknown as EvidenceSnapshot;
}

function isInferenceGate(value: unknown): boolean {
  return (
    isObject(value) &&
    ["pass", "stop"].includes(String(value.decision)) &&
    ["pass", "insufficient"].includes(String(value.coverageDecision)) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === "string") &&
    (value.decision === "pass" ? value.reasons.length === 0 : value.reasons.length > 0)
  );
}

function isActivitySummary(value: unknown): boolean {
  return (
    isObject(value) &&
    Number.isInteger(value.total) &&
    Number(value.total) >= 0 &&
    isObject(value.byKind) &&
    Object.values(value.byKind).every((count) => Number.isInteger(count) && Number(count) >= 0) &&
    Number.isInteger(value.blockedChallenges) &&
    Number(value.blockedChallenges) >= 0 &&
    Array.isArray(value.linkedCandidateIds) &&
    value.linkedCandidateIds.every((candidateId) => typeof candidateId === "string")
  );
}

function isSnapshotOutputRecord(value: unknown, path: string): boolean {
  return (
    isObject(value) &&
    value.path === path &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  );
}

function isSnapshotReceipt(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.attemptId === "string" &&
    typeof value.capabilityId === "string" &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    typeof value.contextSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.contextSha256) &&
    value.locator === `evidence/objects/${value.sha256.slice(0, 2)}/${value.sha256}` &&
    value.contextLocator ===
      `evidence/objects/${value.contextSha256.slice(0, 2)}/${value.contextSha256}`
  );
}

function isAcquisitionDecision(value: unknown): value is AcquisitionDecisionInput {
  return (
    isObject(value) &&
    typeof value.sourceId === "string" &&
    typeof value.candidateId === "string" &&
    Array.isArray(value.artifactIds) &&
    value.artifactIds.every((item) => typeof item === "string") &&
    ["accepted", "limited", "rejected"].includes(String(value.status)) &&
    typeof value.rationale === "string" &&
    Array.isArray(value.limitations) &&
    value.limitations.every((item) => typeof item === "string")
  );
}

async function admittedSourceCandidateMap(
  root: string,
  projectId: string,
): Promise<Map<string, string>> {
  const events = await readJournal(evidenceLedgerPath(root, projectId));
  const result = new Map<string, string>();
  for (const event of events) {
    if (
      event.type === "candidate.admitted" &&
      typeof event.payload.sourceId === "string" &&
      typeof event.payload.candidateId === "string"
    ) {
      result.set(event.payload.sourceId, event.payload.candidateId);
    }
  }
  return result;
}

function computeSnapshotCoverage(
  project: ProjectState,
  sources: Array<Record<string, unknown>>,
  priorCoverage: Record<string, unknown>,
): Record<string, unknown> & { decision: "pass" | "insufficient"; gaps: string[] } {
  const gaps: string[] = [];
  if (sources.length < project.evidenceRequirements.minSources) {
    gaps.push(
      `requires ${project.evidenceRequirements.minSources} source(s), found ${sources.length}`,
    );
  }
  const fullTextSources = sources.filter((source) => source.fullTextAvailable === true).length;
  if (fullTextSources < project.evidenceRequirements.minFullTextSources) {
    gaps.push(
      `requires ${project.evidenceRequirements.minFullTextSources} full-text source(s), found ${fullTextSources}`,
    );
  }
  const intervals = sources.flatMap((source) => {
    const interval = publicationInterval(source.publicationDate);
    return interval ? [interval] : [];
  });
  const inRange = intervals.filter(
    (interval) =>
      (project.evidenceRequirements.publicationDateFrom === null ||
        interval.latest >= project.evidenceRequirements.publicationDateFrom) &&
      (project.evidenceRequirements.publicationDateTo === null ||
        interval.earliest <= project.evidenceRequirements.publicationDateTo),
  ).length;
  if (inRange < project.evidenceRequirements.minDatedSources) {
    gaps.push(
      `requires ${project.evidenceRequirements.minDatedSources} dated source(s) within the publication boundary, found ${inRange}`,
    );
  }
  const sourceTypes = [...new Set(sources.map((source) => String(source.sourceType)))].sort();
  for (const sourceType of project.evidenceRequirements.sourceTypes) {
    if (!sourceTypes.includes(sourceType)) gaps.push(`missing required source type: ${sourceType}`);
  }
  const priorDimensions = Array.isArray(priorCoverage.dimensions)
    ? priorCoverage.dimensions.filter(isObject)
    : [];
  const dimensions = project.evidenceRequirements.dimensions.map((dimension) => {
    const sourceIds = sources
      .filter(
        (source) =>
          Array.isArray(source.coverageDimensions) && source.coverageDimensions.includes(dimension),
      )
      .map((source) => String(source.id))
      .sort();
    if (!sourceIds.length) gaps.push(`missing evidence dimension: ${dimension}`);
    const prior = priorDimensions.find((entry) => entry.id === dimension);
    const priorSourceIds = Array.isArray(prior?.sourceIds)
      ? prior.sourceIds.filter((value): value is string => typeof value === "string")
      : [];
    const retainedAllPriorSources = priorSourceIds.every((sourceId) =>
      sourceIds.includes(sourceId),
    );
    const status: "covered" | "partial" | "missing" = sourceIds.length
      ? prior?.status === "covered" && retainedAllPriorSources
        ? "covered"
        : "partial"
      : "missing";
    return { id: dimension, status, sourceIds };
  });
  return {
    dimensions,
    sourceTypes,
    fullTextSources,
    datedSources: intervals.length,
    publicationDateRange: {
      earliest: intervals.length ? intervals.map((interval) => interval.earliest).sort()[0]! : null,
      latest: intervals.length
        ? intervals
            .map((interval) => interval.latest)
            .sort()
            .at(-1)!
        : null,
    },
    decision: gaps.length ? "insufficient" : "pass",
    gaps,
  };
}

function publicationInterval(value: unknown): { earliest: string; latest: string } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return null;
  if (match[3]) return { earliest: value, latest: value };
  if (match[2]) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      earliest: `${match[1]}-${match[2]}-01`,
      latest: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`,
    };
  }
  return { earliest: `${match[1]}-01-01`, latest: `${match[1]}-12-31` };
}

function acquisitionOutputError(message: string): StructuredOutputError {
  return new StructuredOutputError(message, { validation: [message] });
}

function snapshotError(message: string, details?: Record<string, unknown>): CliError {
  return new CliError(message, {
    code: "RESEARCH_EVIDENCE_SNAPSHOT_INVALID",
    exitCode: 3,
    details,
  });
}
