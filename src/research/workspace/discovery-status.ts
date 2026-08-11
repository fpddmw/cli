import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadCapabilityDeclarations } from "./capabilities.js";
import { deriveDiscoveryPlan, type DiscoveryPlan } from "./discovery-planning.js";
import { evidenceLedgerPath, listEvidenceCandidates } from "./evidence-ledger.js";
import { readJournal } from "./journal.js";
import { isObject, pathExists, workspacePaths } from "./storage.js";
import type { ProjectState, WorkspaceConfig } from "./types.js";
import { loadWorkspaceConfig } from "./workspace.js";

export interface DiscoveryProviderProgress {
  capabilityId: string;
  requests: number;
  networkCalls: number;
  completedReceipts: number;
  reuseHits: number;
  failures: number;
  uniqueCandidates: number;
}

export interface DiscoveryProgress {
  plan: DiscoveryPlan;
  calls: {
    used: number;
    networkUsed: number;
    reused: number;
    max: number;
    remaining: number;
    hardLimit: number;
  };
  candidates: {
    unique: number;
    duplicateOccurrences: number;
    admitted: number;
    rejected: number;
    unassessed: number;
  };
  providers: DiscoveryProviderProgress[];
  gaps: string[];
  nextBatch: { kind: string; capabilityIds: string[]; maxCalls: number } | null;
  recommendedAction:
    | "exercise-required-first-pass"
    | "assess-unassessed-candidates"
    | "run-gap-fill-batch"
    | "submit-admission-judgments"
    | "review-call-ceiling-or-stop"
    | "continue-pipeline";
}

export async function inspectDiscoveryProgress(
  root: string,
  project: ProjectState,
  suppliedConfig?: WorkspaceConfig,
): Promise<DiscoveryProgress> {
  const [config, declarations, mainEvents, ledgerEvents, candidates] = await Promise.all([
    suppliedConfig ? Promise.resolve(suppliedConfig) : loadWorkspaceConfig(root),
    loadCapabilityDeclarations(root),
    readJournal(workspacePaths(root).journal),
    readJournal(evidenceLedgerPath(root, project.id)),
    listEvidenceCandidates(root, project.id),
  ]);
  const networkCapabilityIds = declarations.capabilities
    .filter((capability) => capability.permissions.includes("brokered-network"))
    .map((capability) => capability.id)
    .sort();
  const plan = deriveDiscoveryPlan(project.evidenceRequirements, config, networkCapabilityIds);
  const projectEvents = mainEvents.filter((event) => event.scope === project.id);
  const requested = projectEvents.filter((event) => event.type === "capability.fetch.requested");
  const attempted = projectEvents.filter((event) => event.type === "capability.fetch.attempted");
  const completed = projectEvents.filter((event) => event.type === "capability.fetch.completed");
  const reused = projectEvents.filter((event) => event.type === "capability.fetch.reused");
  const failed = projectEvents.filter((event) => event.type === "capability.fetch.failed");
  const latestDecisions = new Map<string, "admitted" | "rejected">();
  for (const event of ledgerEvents) {
    if (event.type === "candidate.admitted") {
      latestDecisions.set(String(event.payload.candidateId), "admitted");
    } else if (event.type === "candidate.rejected") {
      latestDecisions.set(String(event.payload.candidateId), "rejected");
    }
  }
  const admitted = new Set(
    [...latestDecisions].filter(([, decision]) => decision === "admitted").map(([id]) => id),
  );
  const rejected = new Set(
    [...latestDecisions].filter(([, decision]) => decision === "rejected").map(([id]) => id),
  );
  const duplicateOccurrences = ledgerEvents.filter(
    (event) => event.type === "candidate.duplicate",
  ).length;
  const providers = networkCapabilityIds.map((capabilityId) => {
    const uniqueCandidates = candidates.filter((candidate) =>
      candidate.occurrences.some((origin) => origin.capabilityId === capabilityId),
    ).length;
    return {
      capabilityId,
      requests: requested.filter((event) => event.payload.capabilityId === capabilityId).length,
      networkCalls: attempted.filter((event) => event.payload.capabilityId === capabilityId).length,
      completedReceipts: completed.filter((event) => event.payload.capabilityId === capabilityId)
        .length,
      reuseHits: reused.filter((event) => event.payload.capabilityId === capabilityId).length,
      failures: failed.filter((event) => event.payload.capabilityId === capabilityId).length,
      uniqueCandidates,
    };
  });
  const exercised = new Set(
    providers
      .filter((provider) => provider.networkCalls > 0 || provider.completedReceipts > 0)
      .map((provider) => provider.capabilityId),
  );
  const missingRequired = plan.requiredFirstPassCapabilityIds.filter(
    (capabilityId) => !exercised.has(capabilityId),
  );
  const callsRemaining = Math.max(0, plan.maxCalls - requested.length);
  const gaps = [...plan.constraintGaps];
  if (missingRequired.length) {
    gaps.push(`required first-pass capabilities not exercised: ${missingRequired.join(", ")}`);
  }
  if (candidates.length < plan.targetUniqueSources) {
    gaps.push(`unique candidate target not met: ${candidates.length}/${plan.targetUniqueSources}`);
  }
  const persistedCoverageGaps = await readPersistedCoverageGaps(root, project.id);
  gaps.push(...persistedCoverageGaps);

  const terminalDiscover =
    project.packages.find((workPackage) => workPackage.stage === "discover")?.status === "complete";
  let recommendedAction: DiscoveryProgress["recommendedAction"];
  if (terminalDiscover) recommendedAction = "continue-pipeline";
  else if (missingRequired.length && callsRemaining > 0) {
    recommendedAction = "exercise-required-first-pass";
  } else if (candidates.length - admitted.size - rejected.size > 0) {
    recommendedAction = "assess-unassessed-candidates";
  } else if (candidates.length < plan.targetUniqueSources && callsRemaining > 0) {
    recommendedAction = "run-gap-fill-batch";
  } else if (callsRemaining === 0 && gaps.length > 0) {
    recommendedAction = "review-call-ceiling-or-stop";
  } else {
    recommendedAction = "submit-admission-judgments";
  }
  const nextBatch = nextDiscoveryBatch(
    plan,
    missingRequired,
    exercised,
    callsRemaining,
    recommendedAction,
  );
  return {
    plan,
    calls: {
      used: requested.length,
      networkUsed: attempted.length,
      reused: reused.length,
      max: plan.maxCalls,
      remaining: callsRemaining,
      hardLimit: plan.hardCallLimit,
    },
    candidates: {
      unique: candidates.length,
      duplicateOccurrences,
      admitted: admitted.size,
      rejected: rejected.size,
      unassessed: Math.max(0, candidates.length - admitted.size - rejected.size),
    },
    providers,
    gaps: [...new Set(gaps)],
    nextBatch,
    recommendedAction,
  };
}

function nextDiscoveryBatch(
  plan: DiscoveryPlan,
  missingRequired: string[],
  exercised: Set<string>,
  callsRemaining: number,
  action: DiscoveryProgress["recommendedAction"],
): DiscoveryProgress["nextBatch"] {
  if (callsRemaining < 1 || action === "continue-pipeline") return null;
  if (missingRequired.length) {
    return {
      kind: "required-first-pass",
      capabilityIds: missingRequired,
      maxCalls: Math.min(callsRemaining, missingRequired.length),
    };
  }
  const supplemental = plan.plannedBatches
    .flatMap((batch) => batch.capabilityIds)
    .filter((id) => !exercised.has(id));
  if (supplemental.length) {
    return {
      kind: "supplemental-first-pass",
      capabilityIds: [...new Set(supplemental)],
      maxCalls: Math.min(callsRemaining, supplemental.length),
    };
  }
  const available = [...new Set(plan.plannedBatches.flatMap((batch) => batch.capabilityIds))];
  return {
    kind: "gap-fill",
    capabilityIds: available,
    maxCalls: callsRemaining,
  };
}

async function readPersistedCoverageGaps(root: string, projectId: string): Promise<string[]> {
  const path = join(workspacePaths(root).projects, projectId, "outputs", "evidence.json");
  if (!(await pathExists(path))) return [];
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isObject(value) || !isObject(value.coverage)) return [];
    const mechanical = value.coverage.mechanicalGaps;
    const declared = value.coverage.gaps;
    return [
      ...(Array.isArray(mechanical) ? mechanical : []),
      ...(Array.isArray(declared) ? declared : []),
    ].filter((item): item is string => typeof item === "string");
  } catch {
    return ["persisted evidence coverage cannot be read"];
  }
}
