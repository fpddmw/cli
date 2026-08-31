import { basename, join } from "node:path";

import { CliError } from "../../errors.js";
import { activeDiscoveryRecovery } from "./discovery-recovery.js";
import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  listEvidenceCandidates,
} from "./evidence-ledger.js";
import { loadProjectEvidenceReceipts } from "./evidence.js";
import { readJournal } from "./journal.js";
import { loadProject } from "./projects.js";
import { parseDiscoveryAssessmentBatch, StructuredOutputError } from "./schemas.js";
import { canonicalJson, isObject, readJsonFile, sha256Text, workspacePaths } from "./storage.js";
import type { ProjectState } from "./types.js";

interface DiscoveryAdmission {
  decision: "admit";
  candidateId: string;
  sourceId: string;
  sourceType: string;
  relevance: string;
  quality: { level: "primary" | "secondary" | "tertiary" | "unknown"; rationale: string };
  applicability: string;
  coverageDimensions: string[];
  evidenceRoleIds?: string[];
  limitations: string[];
}

interface DiscoveryRejection {
  decision: "reject";
  candidateId: string;
  reasonCode: string;
  rationale: string;
}

interface DimensionJudgment {
  id: string;
  status: "covered" | "partial" | "missing";
}

export interface DiscoveryCloseoutValue {
  schemaVersion: 2;
  limitations: string[];
  dimensionJudgments: DimensionJudgment[];
  gaps: string[];
  recoveryDisposition?: "minimum-satisfied" | "novelty-defeating-prior-found" | null;
  noveltyDefeatingCandidateIds?: string[];
}

export async function materializeDiscoveryEvidence(
  root: string,
  project: ProjectState,
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const closeout = parseCloseoutValue(value);
  const assessments = await latestDiscoveryAssessments(root, project.id);
  const admissions = assessments.filter(isAdmission);
  const rejections = assessments.filter(isRejection);
  const candidates = new Map(
    (await listEvidenceCandidates(root, project.id)).map((candidate) => [candidate.id, candidate]),
  );
  await assertDiscoveryRecoveryCloseout(root, project, closeout, assessments, candidates);
  const receipts = new Map(
    (await loadProjectEvidenceReceipts(root, project.id)).map((receipt) => [
      receipt.attemptId,
      receipt,
    ]),
  );
  const inputs = new Map(project.inputs.map((input) => [input.id, input]));
  const admittedCandidateIds = new Set(admissions.map((item) => item.candidateId));
  const rejectedCandidateIds = new Set(rejections.map((item) => item.candidateId));
  for (const candidateId of [...admittedCandidateIds, ...rejectedCandidateIds]) {
    if (!candidates.has(candidateId)) {
      throw discoveryError(`Discovery decision refers to unknown candidate ${candidateId}.`);
    }
  }
  for (const candidateId of admittedCandidateIds) {
    if (rejectedCandidateIds.has(candidateId)) {
      throw discoveryError(`Candidate ${candidateId} cannot be both admitted and rejected.`);
    }
  }
  const requiredDimensions = new Set(project.evidenceRequirements.dimensions);
  const judgmentIds = new Set(closeout.dimensionJudgments.map((item) => item.id));
  if (
    judgmentIds.size !== requiredDimensions.size ||
    [...requiredDimensions].some((dimension) => !judgmentIds.has(dimension))
  ) {
    throw discoveryError(
      "Dimension judgments must cover every reviewed evidence dimension exactly once.",
    );
  }
  const sources = admissions.map((admission) => {
    if (admission.coverageDimensions.some((dimension) => !requiredDimensions.has(dimension))) {
      throw discoveryError(
        `Admission ${admission.sourceId} declares an unreviewed evidence dimension.`,
      );
    }
    const candidate = candidates.get(admission.candidateId)!;
    const admissibleOrigin = candidate.occurrences.find(
      (origin) => origin.kind === "input" || origin.kind === "broker",
    );
    if (!admissibleOrigin) {
      throw new StructuredOutputError(
        "Native Web or Browser discovery must first be formalized through an immutable broker receipt for the same canonical URL or DOI.",
        {
          validation: ["native candidates require immutable broker provenance"],
          candidateId: candidate.id,
        },
      );
    }
    const provenance =
      admissibleOrigin.kind === "broker"
        ? brokerProvenance(admissibleOrigin.receiptId, admissibleOrigin.locator, receipts)
        : inputProvenance(admissibleOrigin.inputId, admissibleOrigin.locator, inputs);
    const input = provenance.kind === "input" ? inputs.get(provenance.id) : undefined;
    return {
      id: admission.sourceId,
      title: candidate.title,
      locator: provenance.locator,
      relevance: admission.relevance,
      provenance: { kind: provenance.kind, id: provenance.id },
      sourceType: admission.sourceType,
      retrievedAt: admissibleOrigin.retrievedAt,
      fullTextAvailable: provenance.kind === "input" ? input?.fullText !== false : false,
      url: candidate.url,
      doi: candidate.doi,
      publicationDate: candidate.publicationDate ?? input?.publicationDate ?? null,
      excerpt: candidate.excerpt,
      jsonPointer: admissibleOrigin.jsonPointer,
      quality: admission.quality,
      applicability: admission.applicability,
      coverageDimensions: admission.coverageDimensions,
      evidenceRoleIds: admission.evidenceRoleIds ?? [],
    };
  });
  const sourceLimitations = admissions.flatMap((admission) =>
    admission.limitations.map((limitation) => `${admission.sourceId}: ${limitation}`),
  );
  return {
    schemaVersion: 1,
    sources,
    limitations: [...new Set([...closeout.limitations, ...sourceLimitations])],
    coverage: {
      dimensions: closeout.dimensionJudgments.map((item) => ({
        id: item.id,
        status: item.status,
        sourceIds: [],
      })),
      sourceTypes: [],
      fullTextSources: 0,
      datedSources: 0,
      publicationDateRange: { earliest: null, latest: null },
      decision: "pass",
      gaps: closeout.gaps,
    },
  };
}

export async function commitDiscoveryDecisions(
  root: string,
  projectId: string,
  value: Record<string, unknown>,
): Promise<void> {
  parseCloseoutValue(value);
  await commitCurrentDiscoveryAssessments(root, projectId);
}

export async function commitCurrentDiscoveryAssessments(
  root: string,
  projectId: string,
): Promise<void> {
  const assessments = await latestDiscoveryAssessments(root, projectId);
  const events = await readJournal(evidenceLedgerPath(root, projectId));
  const committed = new Set(
    events
      .filter((event) => event.type === "candidate.admitted" || event.type === "candidate.rejected")
      .map((event) => `${event.type}:${String(event.payload.judgmentSha256)}`),
  );
  for (const admission of assessments.filter(isAdmission)) {
    const judgmentSha256 = sha256Text(canonicalJson(admission));
    const key = `candidate.admitted:${judgmentSha256}`;
    if (committed.has(key)) continue;
    await appendEvidenceLedgerEvent(root, projectId, "candidate.admitted", {
      candidateId: admission.candidateId,
      sourceId: admission.sourceId,
      sourceType: admission.sourceType,
      judgmentSha256,
      coverageDimensions: admission.coverageDimensions,
      evidenceRoleIds: admission.evidenceRoleIds ?? [],
    });
  }
  for (const rejection of assessments.filter(isRejection)) {
    const judgmentSha256 = sha256Text(canonicalJson(rejection));
    const key = `candidate.rejected:${judgmentSha256}`;
    if (committed.has(key)) continue;
    await appendEvidenceLedgerEvent(root, projectId, "candidate.rejected", {
      candidateId: rejection.candidateId,
      reasonCode: rejection.reasonCode,
      rationale: rejection.rationale,
      judgmentSha256,
    });
  }
}

export async function recordDiscoveryAssessmentBatch(input: {
  root: string;
  projectId: string;
  value: Record<string, unknown>;
}): Promise<{
  recorded: number;
  unchanged: number;
  assessedCandidates: number;
  admittedCandidates: number;
  rejectedCandidates: number;
}> {
  const parsed = parseDiscoveryAssessmentBatch(input.value);
  const assessments = parsed.assessments as Array<DiscoveryAdmission | DiscoveryRejection>;
  const project = await loadProject(input.root, input.projectId);
  const packages = project.packages;
  const discover = packages.find((workPackage) => workPackage.stage === "discover");
  const acquire = packages.find((workPackage) => workPackage.stage === "acquire");
  const evidenceIntakeOpen = discover?.status === "running" || acquire?.status === "running";
  if (!evidenceIntakeOpen) {
    throw discoveryError(
      "Discovery assessments may be recorded only during an active discover or acquire stage.",
    );
  }
  const requiredDimensions = new Set(project.evidenceRequirements.dimensions);
  const recovery = activeDiscoveryRecovery(project);
  const candidates = new Map(
    (await listEvidenceCandidates(input.root, input.projectId)).map((candidate) => [
      candidate.id,
      candidate,
    ]),
  );
  for (const assessment of assessments) {
    const candidate = candidates.get(assessment.candidateId);
    if (!candidate) {
      throw discoveryError(
        `Discovery assessment refers to unknown candidate ${assessment.candidateId}.`,
      );
    }
    if (assessment.decision === "admit") {
      if (assessment.coverageDimensions.some((dimension) => !requiredDimensions.has(dimension))) {
        throw discoveryError(
          `Admission ${assessment.sourceId} declares an unreviewed evidence dimension.`,
        );
      }
      if (
        !candidate.occurrences.some((origin) => origin.kind === "input" || origin.kind === "broker")
      ) {
        throw discoveryError(
          `Native candidate ${candidate.id} must be formalized by a broker receipt before admission.`,
        );
      }
      if (recovery) {
        if (
          assessment.evidenceRoleIds?.length !== 1 ||
          assessment.evidenceRoleIds[0] !== recovery.evidenceRoleId
        ) {
          throw recoveryError(
            `Recovery admission ${assessment.sourceId} must bind only ${recovery.evidenceRoleId}.`,
          );
        }
        if (
          !recovery.inheritedEligibleCandidateIds.includes(candidate.id) &&
          !(await isQualifyingRecoveryCandidate(input.root, project, candidate.id))
        ) {
          throw recoveryError(
            `Recovery candidate ${candidate.id} lacks a completed legal-seed citation chase and matching broker formalization.`,
          );
        }
      } else if (assessment.evidenceRoleIds?.length) {
        throw recoveryError(
          "evidenceRoleIds on a discovery admission are reserved for an active bounded recovery.",
        );
      }
    }
  }

  const existing = await latestDiscoveryAssessments(input.root, input.projectId);
  if (recovery) {
    const projected = new Map(existing.map((assessment) => [assessment.candidateId, assessment]));
    for (const assessment of assessments) projected.set(assessment.candidateId, assessment);
    const projectedEligible = [...projected.values()].filter(
      (assessment) =>
        isAdmission(assessment) &&
        (recovery.inheritedEligibleCandidateIds.includes(assessment.candidateId) ||
          assessment.evidenceRoleIds?.includes(recovery.evidenceRoleId)),
    );
    if (projectedEligible.length > recovery.minimumDistinctCandidates) {
      throw recoveryError(
        "Recovery admission would exceed the frozen closest-work floor; no candidate after the floor may be admitted.",
      );
    }
  }
  const replacementIds = new Set(assessments.map((assessment) => assessment.candidateId));
  const sourceOwners = new Map(
    existing
      .filter(isAdmission)
      .filter((assessment) => !replacementIds.has(assessment.candidateId))
      .map((assessment) => [assessment.sourceId, assessment.candidateId]),
  );
  for (const assessment of assessments.filter(isAdmission)) {
    const owner = sourceOwners.get(assessment.sourceId);
    if (owner && owner !== assessment.candidateId) {
      throw discoveryError(`Source ID ${assessment.sourceId} is already assigned to ${owner}.`);
    }
    sourceOwners.set(assessment.sourceId, assessment.candidateId);
  }

  const priorHashes = new Set(
    (await readJournal(evidenceLedgerPath(input.root, input.projectId)))
      .filter((event) => event.type === "candidate.assessed")
      .map((event) => String(event.payload.assessmentSha256)),
  );
  let recorded = 0;
  let unchanged = 0;
  for (const assessment of assessments) {
    const assessmentSha256 = sha256Text(canonicalJson(assessment));
    if (priorHashes.has(assessmentSha256)) {
      unchanged += 1;
      continue;
    }
    await appendEvidenceLedgerEvent(input.root, input.projectId, "candidate.assessed", {
      candidateId: assessment.candidateId,
      decision: assessment.decision,
      assessment,
      assessmentSha256,
    });
    priorHashes.add(assessmentSha256);
    recorded += 1;
  }
  const latest = await latestDiscoveryAssessments(input.root, input.projectId);
  return {
    recorded,
    unchanged,
    assessedCandidates: latest.length,
    admittedCandidates: latest.filter(isAdmission).length,
    rejectedCandidates: latest.filter(isRejection).length,
  };
}

function brokerProvenance(
  receiptId: string | null,
  locator: string | null,
  receipts: Map<string, Awaited<ReturnType<typeof loadProjectEvidenceReceipts>>[number]>,
): { kind: "broker"; id: string; locator: string } {
  const receipt = receiptId ? receipts.get(receiptId) : undefined;
  if (!receipt || !locator || receipt.locator !== locator) {
    throw discoveryError("Broker candidate provenance does not match an immutable receipt.");
  }
  return { kind: "broker", id: receipt.attemptId, locator: receipt.locator };
}

function inputProvenance(
  inputId: string | null,
  locator: string | null,
  inputs: Map<string, ProjectState["inputs"][number]>,
): { kind: "input"; id: string; locator: string } {
  const input = inputId ? inputs.get(inputId) : undefined;
  const expectedLocator = input
    ? join("inputs", input.id, basename(input.path)).replaceAll("\\", "/")
    : null;
  if (!input || !locator || locator !== expectedLocator) {
    throw discoveryError("Input candidate provenance does not match a registered immutable input.");
  }
  return { kind: "input", id: input.id, locator: expectedLocator };
}

async function latestDiscoveryAssessments(
  root: string,
  projectId: string,
): Promise<Array<DiscoveryAdmission | DiscoveryRejection>> {
  const events = await readJournal(evidenceLedgerPath(root, projectId));
  const latest = new Map<string, DiscoveryAdmission | DiscoveryRejection>();
  for (const event of events) {
    if (event.type !== "candidate.assessed" || !isObject(event.payload.assessment)) continue;
    const assessment = event.payload.assessment;
    if (!isAdmission(assessment) && !isRejection(assessment)) {
      throw discoveryError("Persisted discovery assessment is malformed.");
    }
    latest.set(assessment.candidateId, assessment);
  }
  return [...latest.values()];
}

function parseCloseoutValue(value: Record<string, unknown>): DiscoveryCloseoutValue {
  if (
    value.schemaVersion !== 2 ||
    !Array.isArray(value.limitations) ||
    !Array.isArray(value.dimensionJudgments) ||
    !Array.isArray(value.gaps) ||
    value.dimensionJudgments.some((item) => !isDimensionJudgment(item)) ||
    (value.recoveryDisposition !== undefined &&
      value.recoveryDisposition !== null &&
      !["minimum-satisfied", "novelty-defeating-prior-found"].includes(
        String(value.recoveryDisposition),
      )) ||
    (value.noveltyDefeatingCandidateIds !== undefined &&
      (!Array.isArray(value.noveltyDefeatingCandidateIds) ||
        value.noveltyDefeatingCandidateIds.some((item) => typeof item !== "string") ||
        new Set(value.noveltyDefeatingCandidateIds).size !==
          value.noveltyDefeatingCandidateIds.length))
  ) {
    throw discoveryError("Discovery closeout value is malformed.");
  }
  return value as unknown as DiscoveryCloseoutValue;
}

function isAdmission(value: unknown): value is DiscoveryAdmission {
  return (
    isObject(value) &&
    value.decision === "admit" &&
    typeof value.candidateId === "string" &&
    typeof value.sourceId === "string" &&
    typeof value.sourceType === "string" &&
    typeof value.relevance === "string" &&
    isObject(value.quality) &&
    typeof value.quality.level === "string" &&
    typeof value.quality.rationale === "string" &&
    typeof value.applicability === "string" &&
    Array.isArray(value.coverageDimensions) &&
    value.coverageDimensions.every((item) => typeof item === "string") &&
    (value.evidenceRoleIds === undefined ||
      (Array.isArray(value.evidenceRoleIds) &&
        value.evidenceRoleIds.every((item) => typeof item === "string") &&
        new Set(value.evidenceRoleIds).size === value.evidenceRoleIds.length)) &&
    Array.isArray(value.limitations) &&
    value.limitations.every((item) => typeof item === "string")
  );
}

function isRejection(value: unknown): value is DiscoveryRejection {
  return (
    isObject(value) &&
    value.decision === "reject" &&
    typeof value.candidateId === "string" &&
    typeof value.reasonCode === "string" &&
    typeof value.rationale === "string"
  );
}

function isDimensionJudgment(value: unknown): value is DimensionJudgment {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    ["covered", "partial", "missing"].includes(String(value.status))
  );
}

function discoveryError(message: string): StructuredOutputError {
  return new StructuredOutputError(message, { validation: [message] });
}

async function assertDiscoveryRecoveryCloseout(
  root: string,
  project: ProjectState,
  closeout: DiscoveryCloseoutValue,
  assessments: Array<DiscoveryAdmission | DiscoveryRejection>,
  candidates: Map<string, Awaited<ReturnType<typeof listEvidenceCandidates>>[number]>,
): Promise<void> {
  const recovery = activeDiscoveryRecovery(project);
  if (!recovery) {
    if (closeout.recoveryDisposition || closeout.noveltyDefeatingCandidateIds?.length) {
      throw recoveryError("Recovery closeout fields require an active bounded recovery.");
    }
    return;
  }
  const noveltyIds = closeout.noveltyDefeatingCandidateIds ?? [];
  if (noveltyIds.some((candidateId) => !candidates.has(candidateId))) {
    throw recoveryError("Recovery closeout names an unknown novelty-defeating candidate.");
  }
  if (closeout.recoveryDisposition === "novelty-defeating-prior-found") {
    if (!noveltyIds.length) {
      throw recoveryError(
        "A novelty-defeating disposition must identify the responsible candidate.",
      );
    }
    throw new CliError(
      "The bounded citation chase found prior work that may defeat the frozen novelty claim.",
      {
        code: "RESEARCH_DISCOVERY_RECOVERY_NOVELTY_DEFEAT",
        exitCode: 3,
        details: {
          candidateIds: noveltyIds,
          requiredAction: recovery.noveltyDefeatingPriorAction,
        },
      },
    );
  }
  if (closeout.recoveryDisposition !== "minimum-satisfied" || noveltyIds.length) {
    throw recoveryError(
      "Recovery closeout must explicitly report minimum-satisfied with no novelty-defeating candidates.",
    );
  }
  const events = await readJournal(evidenceLedgerPath(root, project.id));
  const completedActivities = events.filter(
    (event) =>
      event.type === "activity.recorded" &&
      event.payload.recoveryContractSha256 === recovery.contractSha256 &&
      event.payload.status === "completed",
  );
  if (!completedActivities.length) {
    throw recoveryError("Recovery closeout requires a completed legal-seed citation chase.");
  }
  const admitted = new Set(
    assessments
      .filter(isAdmission)
      .filter(
        (assessment) =>
          recovery.inheritedEligibleCandidateIds.includes(assessment.candidateId) ||
          assessment.evidenceRoleIds?.includes(recovery.evidenceRoleId),
      )
      .map((assessment) => assessment.candidateId),
  );
  if (admitted.size < recovery.minimumDistinctCandidates) {
    throw new CliError(
      "The bounded Discover recovery has not reached its frozen closest-work floor.",
      {
        code: "RESEARCH_DISCOVERY_RECOVERY_INCOMPLETE",
        exitCode: 3,
        details: {
          evidenceRoleId: recovery.evidenceRoleId,
          eligibleCandidates: admitted.size,
          minimumDistinctCandidates: recovery.minimumDistinctCandidates,
        },
      },
    );
  }
}

async function isQualifyingRecoveryCandidate(
  root: string,
  project: ProjectState,
  candidateId: string,
): Promise<boolean> {
  const recovery = activeDiscoveryRecovery(project);
  if (!recovery) return false;
  const [ledgerEvents, mainEvents, candidates] = await Promise.all([
    readJournal(evidenceLedgerPath(root, project.id)),
    readJournal(workspacePaths(root).journal),
    listEvidenceCandidates(root, project.id),
  ]);
  const chased = ledgerEvents.some(
    (event) =>
      event.type === "activity.recorded" &&
      event.payload.recoveryContractSha256 === recovery.contractSha256 &&
      event.payload.status === "completed" &&
      Array.isArray(event.payload.candidateIds) &&
      event.payload.candidateIds.includes(candidateId),
  );
  if (!chased) return false;
  const formalizationAttemptIds = new Set(
    mainEvents
      .filter(
        (event) =>
          event.scope === project.id &&
          event.type === "capability.fetch.completed" &&
          event.payload.recoveryContractSha256 === recovery.contractSha256 &&
          event.payload.formalizeCandidateId === candidateId,
      )
      .map((event) => String(event.payload.attemptId)),
  );
  const candidate = candidates.find((item) => item.id === candidateId);
  return Boolean(
    candidate?.occurrences.some(
      (origin) => origin.kind === "broker" && formalizationAttemptIds.has(origin.receiptId ?? ""),
    ),
  );
}

function recoveryError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_DISCOVERY_RECOVERY_SCOPE_VIOLATION",
    exitCode: 3,
  });
}
