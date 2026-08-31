import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { CliError } from "../../errors.js";
import { evidenceLedgerPath } from "./evidence-ledger.js";
import { readJournal } from "./journal.js";
import { canonicalJson, isObject, sha256Text, workspacePaths } from "./storage.js";
import type { DiscoveryRecoveryBinding, ProjectState } from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const MAX_RECOVERY_BYTES = 64 * 1024;

export interface DiscoveryRecoveryContract {
  schemaVersion: 1;
  projectId: string;
  sourceProjectId: string;
  evidenceRoleId: string;
  activeRouteIds: string[];
  formalizationRouteIds: string[];
  seedCandidateIds: string[];
  inheritedEligibleCandidateIds: string[];
  minimumDistinctCandidates: number;
  maxNativeCitationChaseActivities: number;
  maxBrokerFormalizationCalls: number;
  noveltyDefeatingPriorAction: "stop-and-return-to-design-review";
}

export interface VerifiedDiscoveryRecovery {
  schemaVersion: 1;
  contract: DiscoveryRecoveryContract;
  sha256: string;
  bytes: number;
}

export async function readAndVerifyDiscoveryRecovery(
  path: string,
  expectedProjectId?: string,
): Promise<VerifiedDiscoveryRecovery> {
  if (!isAbsolute(path)) throw recoveryPathError("Discover recovery path must be absolute.");
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw recoveryPathError(
      "Discover recovery path must be an existing regular file and cannot be a symbolic link.",
    );
  }
  if (info.size > MAX_RECOVERY_BYTES) {
    throw recoveryPathError(`Discover recovery exceeds the ${MAX_RECOVERY_BYTES}-byte limit.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw recoveryError("Discover recovery is not valid JSON.");
  }
  const contract = parseDiscoveryRecovery(value);
  if (expectedProjectId && contract.projectId !== expectedProjectId) {
    throw new CliError("Discover recovery projectId does not match the target project.", {
      code: "RESEARCH_DISCOVERY_RECOVERY_PROJECT_MISMATCH",
      exitCode: 2,
      details: { expectedProjectId, actualProjectId: contract.projectId },
    });
  }
  const normalized = `${JSON.stringify(contract, null, 2)}\n`;
  return {
    schemaVersion: 1,
    contract,
    sha256: sha256Text(normalized),
    bytes: Buffer.byteLength(normalized, "utf8"),
  };
}

export function parseDiscoveryRecovery(value: unknown): DiscoveryRecoveryContract {
  const keys = [
    "schemaVersion",
    "projectId",
    "sourceProjectId",
    "evidenceRoleId",
    "activeRouteIds",
    "formalizationRouteIds",
    "seedCandidateIds",
    "inheritedEligibleCandidateIds",
    "minimumDistinctCandidates",
    "maxNativeCitationChaseActivities",
    "maxBrokerFormalizationCalls",
    "noveltyDefeatingPriorAction",
  ];
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    Object.keys(value).length !== keys.length ||
    value.schemaVersion !== 1 ||
    typeof value.projectId !== "string" ||
    !PROJECT_ID.test(value.projectId) ||
    typeof value.sourceProjectId !== "string" ||
    !PROJECT_ID.test(value.sourceProjectId) ||
    typeof value.evidenceRoleId !== "string" ||
    !IDENTIFIER.test(value.evidenceRoleId) ||
    !identifierSet(value.activeRouteIds, 1, 20) ||
    !identifierSet(value.formalizationRouteIds, 1, 20) ||
    !identifierSet(value.seedCandidateIds, 1, 100) ||
    !identifierSet(value.inheritedEligibleCandidateIds, 1, 200) ||
    !boundedInteger(value.minimumDistinctCandidates, 2, 200) ||
    !boundedInteger(value.maxNativeCitationChaseActivities, 1, 100) ||
    !boundedInteger(value.maxBrokerFormalizationCalls, 1, 100) ||
    value.noveltyDefeatingPriorAction !== "stop-and-return-to-design-review"
  ) {
    throw recoveryError("Discover recovery failed closed-schema validation.");
  }
  const activeRouteIds = value.activeRouteIds as string[];
  const formalizationRouteIds = value.formalizationRouteIds as string[];
  const seedCandidateIds = value.seedCandidateIds as string[];
  const inheritedEligibleCandidateIds = value.inheritedEligibleCandidateIds as string[];
  if (activeRouteIds.some((routeId) => formalizationRouteIds.includes(routeId))) {
    throw recoveryError("Citation-chase and formalization route sets must be disjoint.");
  }
  if (
    seedCandidateIds.some((candidateId) => !inheritedEligibleCandidateIds.includes(candidateId))
  ) {
    throw recoveryError("Every citation-chase seed must be inherited as eligible closest work.");
  }
  if (Number(value.minimumDistinctCandidates) <= inheritedEligibleCandidateIds.length) {
    throw recoveryError("The recovery floor must exceed the inherited eligible candidate count.");
  }
  if (
    Number(value.maxBrokerFormalizationCalls) <
    Number(value.minimumDistinctCandidates) - inheritedEligibleCandidateIds.length
  ) {
    throw recoveryError(
      "The broker formalization allowance cannot close the declared recovery gap.",
    );
  }
  return value as unknown as DiscoveryRecoveryContract;
}

export function activeDiscoveryRecovery(project: ProjectState): DiscoveryRecoveryBinding | null {
  const discover = project.packages.find((workPackage) => workPackage.stage === "discover");
  return project.discoveryRecovery && discover?.status !== "complete"
    ? project.discoveryRecovery
    : null;
}

export async function assertDiscoveryRecoveryObjectBinding(
  root: string,
  project: ProjectState,
): Promise<void> {
  const binding = project.discoveryRecovery;
  if (!binding) return;
  let verified: VerifiedDiscoveryRecovery;
  try {
    verified = await readAndVerifyDiscoveryRecovery(
      join(workspacePaths(root).control, binding.objectLocator),
      project.id,
    );
  } catch (error) {
    throw recoveryBindingError(
      "The bounded Discover recovery object is missing, invalid, or no longer matches its target generation.",
      error,
    );
  }
  const contract = verified.contract;
  const expected = {
    contractSha256: verified.sha256,
    sourceProjectId: contract.sourceProjectId,
    evidenceRoleId: contract.evidenceRoleId,
    activeRouteIds: contract.activeRouteIds,
    formalizationRouteIds: contract.formalizationRouteIds,
    seedCandidateIds: contract.seedCandidateIds,
    inheritedEligibleCandidateIds: contract.inheritedEligibleCandidateIds,
    minimumDistinctCandidates: contract.minimumDistinctCandidates,
    maxNativeCitationChaseActivities: contract.maxNativeCitationChaseActivities,
    maxBrokerFormalizationCalls: contract.maxBrokerFormalizationCalls,
    noveltyDefeatingPriorAction: contract.noveltyDefeatingPriorAction,
  };
  const actual = {
    contractSha256: binding.contractSha256,
    sourceProjectId: binding.sourceProjectId,
    evidenceRoleId: binding.evidenceRoleId,
    activeRouteIds: binding.activeRouteIds,
    formalizationRouteIds: binding.formalizationRouteIds,
    seedCandidateIds: binding.seedCandidateIds,
    inheritedEligibleCandidateIds: binding.inheritedEligibleCandidateIds,
    minimumDistinctCandidates: binding.minimumDistinctCandidates,
    maxNativeCitationChaseActivities: binding.maxNativeCitationChaseActivities,
    maxBrokerFormalizationCalls: binding.maxBrokerFormalizationCalls,
    noveltyDefeatingPriorAction: binding.noveltyDefeatingPriorAction,
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw recoveryBindingError(
      "The bounded Discover recovery binding drifted from its immutable contract object.",
    );
  }
}

export async function inspectDiscoveryRecoveryFloor(
  root: string,
  project: ProjectState,
): Promise<{ eligibleCandidateIds: string[]; minimumSatisfied: boolean }> {
  const recovery = activeDiscoveryRecovery(project);
  if (!recovery) return { eligibleCandidateIds: [], minimumSatisfied: false };
  const latest = new Map<string, { decision: "admit" | "reject"; evidenceRoleIds: string[] }>();
  for (const event of await readJournal(evidenceLedgerPath(root, project.id))) {
    if (
      event.type === "candidate.assessed" &&
      (event.payload.decision === "admit" || event.payload.decision === "reject")
    ) {
      const assessment = isObject(event.payload.assessment) ? event.payload.assessment : {};
      latest.set(String(event.payload.candidateId), {
        decision: event.payload.decision,
        evidenceRoleIds: Array.isArray(assessment.evidenceRoleIds)
          ? assessment.evidenceRoleIds.filter((item): item is string => typeof item === "string")
          : [],
      });
    } else if (event.type === "candidate.admitted") {
      const candidateId = String(event.payload.candidateId);
      latest.set(candidateId, {
        decision: "admit",
        evidenceRoleIds: latest.get(candidateId)?.evidenceRoleIds ?? [],
      });
    } else if (event.type === "candidate.rejected") {
      latest.set(String(event.payload.candidateId), {
        decision: "reject",
        evidenceRoleIds: [],
      });
    }
  }
  const eligibleCandidateIds = [...latest]
    .filter(
      ([candidateId, assessment]) =>
        assessment.decision === "admit" &&
        (recovery.inheritedEligibleCandidateIds.includes(candidateId) ||
          assessment.evidenceRoleIds.includes(recovery.evidenceRoleId)),
    )
    .map(([candidateId]) => candidateId)
    .sort();
  return {
    eligibleCandidateIds,
    minimumSatisfied: eligibleCandidateIds.length >= recovery.minimumDistinctCandidates,
  };
}

function identifierSet(value: unknown, minimum: number, maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every((item) => typeof item === "string" && IDENTIFIER.test(item)) &&
    new Set(value).size === value.length
  );
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function recoveryPathError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_DISCOVERY_RECOVERY_PATH_INVALID",
    exitCode: 2,
  });
}

function recoveryError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_DISCOVERY_RECOVERY_INVALID",
    exitCode: 2,
  });
}

function recoveryBindingError(message: string, cause?: unknown): CliError {
  return new CliError(message, {
    code: "RESEARCH_DISCOVERY_RECOVERY_BINDING_INVALID",
    exitCode: 3,
    details: {
      causeCode:
        cause instanceof CliError && typeof cause.code === "string" ? cause.code : "unavailable",
    },
  });
}
