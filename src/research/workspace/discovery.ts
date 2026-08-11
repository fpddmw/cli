import { basename, join } from "node:path";

import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  listEvidenceCandidates,
} from "./evidence-ledger.js";
import { loadProjectEvidenceReceipts } from "./evidence.js";
import { readJournal } from "./journal.js";
import { StructuredOutputError } from "./schemas.js";
import { canonicalJson, isObject, sha256Text } from "./storage.js";
import type { ProjectState } from "./types.js";

interface DiscoveryAdmission {
  candidateId: string;
  sourceId: string;
  sourceType: string;
  relevance: string;
  quality: { level: "primary" | "secondary" | "tertiary" | "unknown"; rationale: string };
  applicability: string;
  coverageDimensions: string[];
  limitations: string[];
}

interface DiscoveryRejection {
  candidateId: string;
  reasonCode: string;
  rationale: string;
}

interface DimensionJudgment {
  id: string;
  status: "covered" | "partial" | "missing";
}

export interface DiscoveryAdmissionValue {
  schemaVersion: 1;
  admissions: DiscoveryAdmission[];
  rejections: DiscoveryRejection[];
  limitations: string[];
  dimensionJudgments: DimensionJudgment[];
  gaps: string[];
}

export async function materializeDiscoveryEvidence(
  root: string,
  project: ProjectState,
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const admissionValue = parseAdmissionValue(value);
  const candidates = new Map(
    (await listEvidenceCandidates(root, project.id)).map((candidate) => [candidate.id, candidate]),
  );
  const receipts = new Map(
    (await loadProjectEvidenceReceipts(root, project.id)).map((receipt) => [
      receipt.attemptId,
      receipt,
    ]),
  );
  const inputs = new Map(project.inputs.map((input) => [input.id, input]));
  const admittedCandidateIds = new Set(admissionValue.admissions.map((item) => item.candidateId));
  const rejectedCandidateIds = new Set(admissionValue.rejections.map((item) => item.candidateId));
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
  const judgmentIds = new Set(admissionValue.dimensionJudgments.map((item) => item.id));
  if (
    judgmentIds.size !== requiredDimensions.size ||
    [...requiredDimensions].some((dimension) => !judgmentIds.has(dimension))
  ) {
    throw discoveryError(
      "Dimension judgments must cover every reviewed evidence dimension exactly once.",
    );
  }
  const sources = admissionValue.admissions.map((admission) => {
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
    };
  });
  const sourceLimitations = admissionValue.admissions.flatMap((admission) =>
    admission.limitations.map((limitation) => `${admission.sourceId}: ${limitation}`),
  );
  return {
    schemaVersion: 1,
    sources,
    limitations: [...new Set([...admissionValue.limitations, ...sourceLimitations])],
    coverage: {
      dimensions: admissionValue.dimensionJudgments.map((item) => ({
        id: item.id,
        status: item.status,
        sourceIds: [],
      })),
      sourceTypes: [],
      fullTextSources: 0,
      datedSources: 0,
      publicationDateRange: { earliest: null, latest: null },
      decision: "pass",
      gaps: admissionValue.gaps,
    },
  };
}

export async function commitDiscoveryDecisions(
  root: string,
  projectId: string,
  value: Record<string, unknown>,
): Promise<void> {
  const admissionValue = parseAdmissionValue(value);
  const events = await readJournal(evidenceLedgerPath(root, projectId));
  const committed = new Set(
    events
      .filter((event) => event.type === "candidate.admitted" || event.type === "candidate.rejected")
      .map((event) => `${event.type}:${String(event.payload.judgmentSha256)}`),
  );
  for (const admission of admissionValue.admissions) {
    const judgmentSha256 = sha256Text(canonicalJson(admission));
    const key = `candidate.admitted:${judgmentSha256}`;
    if (committed.has(key)) continue;
    await appendEvidenceLedgerEvent(root, projectId, "candidate.admitted", {
      candidateId: admission.candidateId,
      sourceId: admission.sourceId,
      sourceType: admission.sourceType,
      judgmentSha256,
      coverageDimensions: admission.coverageDimensions,
    });
  }
  for (const rejection of admissionValue.rejections) {
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

function parseAdmissionValue(value: Record<string, unknown>): DiscoveryAdmissionValue {
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.admissions) ||
    !Array.isArray(value.rejections) ||
    !Array.isArray(value.limitations) ||
    !Array.isArray(value.dimensionJudgments) ||
    !Array.isArray(value.gaps) ||
    value.admissions.some((item) => !isAdmission(item)) ||
    value.rejections.some((item) => !isRejection(item)) ||
    value.dimensionJudgments.some((item) => !isDimensionJudgment(item))
  ) {
    throw discoveryError("Discovery admission value is malformed.");
  }
  return value as unknown as DiscoveryAdmissionValue;
}

function isAdmission(value: unknown): value is DiscoveryAdmission {
  return (
    isObject(value) &&
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
    Array.isArray(value.limitations) &&
    value.limitations.every((item) => typeof item === "string")
  );
}

function isRejection(value: unknown): value is DiscoveryRejection {
  return (
    isObject(value) &&
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
