import type { ProjectEvidenceRequirements, ResearchBudget, WorkspaceConfig } from "./types.js";

export interface DiscoveryBatchPlan {
  kind: "required-first-pass" | "supplemental-first-pass" | "gap-fill";
  capabilityIds: string[];
  maxCalls: number;
}

export interface DiscoveryPlan {
  targetUniqueSources: number;
  targetFullTextSources: number;
  targetDatedSources: number;
  hardCallLimit: number;
  maxCalls: number;
  expectedUniqueSourcesPerCall: number;
  maxItemsPerCall: number;
  recommendedOutputTokens: number;
  outputTokenLimit: number;
  reservedDiscoverTokens: number;
  requiredFirstPassCapabilityIds: string[];
  plannedBatches: DiscoveryBatchPlan[];
  constraintGaps: string[];
}

export function deriveDiscoveryPlan(
  requirements: ProjectEvidenceRequirements,
  config: Pick<WorkspaceConfig, "budget">,
  availableCapabilityIds: string[],
): DiscoveryPlan {
  const budget = config.budget;
  const requiredCapabilityIds = [...new Set(requirements.requiredCapabilityIds ?? [])].sort();
  const available = [...new Set(availableCapabilityIds)].sort();
  const supplemental = available.filter((id) => !requiredCapabilityIds.includes(id));
  const callsForSources = Math.ceil(requirements.minSources / 5);
  const callsForDimensions = Math.ceil(requirements.dimensions.length / 2);
  const callsForSourceTypes = Math.ceil(Math.max(1, requirements.sourceTypes.length) / 2);
  const firstPassCalls = Math.max(
    1,
    requiredCapabilityIds.length,
    callsForSources,
    callsForDimensions,
    callsForSourceTypes,
  );
  const gapFillCalls = Math.max(2, Math.ceil(requirements.minSources / 15));
  // Even a small/smoke requirement needs enough room to exercise multiple
  // channels and one focused gap-fill pass. The workspace value remains the
  // reviewed hard ceiling; this is a derived target, not an unconditional
  // entitlement to spend every call.
  const desiredCalls = Math.max(6, firstPassCalls + gapFillCalls);
  const maxCalls = Math.min(budget.maxBrokerCalls, desiredCalls);
  const constraintGaps: string[] = [];
  const unavailableRequired = requiredCapabilityIds.filter((id) => !available.includes(id));
  if (unavailableRequired.length) {
    constraintGaps.push(
      `required discovery capabilities unavailable: ${unavailableRequired.join(", ")}`,
    );
  }
  if (budget.maxBrokerCalls < requiredCapabilityIds.length) {
    constraintGaps.push(
      `broker view ceiling ${budget.maxBrokerCalls} is below ${requiredCapabilityIds.length} required first-pass capabilities`,
    );
  }
  if (maxCalls < callsForSources) {
    constraintGaps.push(
      `broker view ceiling cannot support the ${requirements.minSources}-source discovery target`,
    );
  }
  const expectedUniqueSourcesPerCall = Math.max(
    3,
    Math.ceil(requirements.minSources / Math.max(1, firstPassCalls)),
  );
  const maxItemsPerCall = Math.min(
    budget.maxBrokerItems,
    Math.max(10, expectedUniqueSourcesPerCall * 3),
  );
  const recommendedOutputTokens = roundUp(
    Math.max(
      1_024,
      768 +
        requirements.minSources * 110 +
        requirements.dimensions.length * 35 +
        requirements.sourceTypes.length * 25,
    ),
    128,
  );
  const outputTokenLimit = Math.min(budget.maxOutputTokens, recommendedOutputTokens);
  if (budget.maxOutputTokens < recommendedOutputTokens) {
    constraintGaps.push(
      `discover output ceiling ${budget.maxOutputTokens} is below the compact schema recommendation ${recommendedOutputTokens}`,
    );
  }
  const reservedDiscoverTokens = Math.min(
    budget.packageMaxTokens.discover,
    outputTokenLimit +
      budget.maxRepairTokens +
      maxCalls * budget.maxBrokerContextTokens +
      12_000 +
      requirements.minSources * 200,
  );
  const requiredFirstPassCalls = Math.min(requiredCapabilityIds.length, maxCalls);
  const remainingAfterRequired = Math.max(0, maxCalls - requiredFirstPassCalls);
  const supplementalCalls = Math.min(supplemental.length, remainingAfterRequired);
  const remainingGapCalls = Math.max(0, remainingAfterRequired - supplementalCalls);
  const plannedBatches: DiscoveryBatchPlan[] = [];
  if (requiredFirstPassCalls) {
    plannedBatches.push({
      kind: "required-first-pass",
      capabilityIds: requiredCapabilityIds.slice(0, requiredFirstPassCalls),
      maxCalls: requiredFirstPassCalls,
    });
  }
  if (supplementalCalls) {
    plannedBatches.push({
      kind: "supplemental-first-pass",
      capabilityIds: supplemental.slice(0, supplementalCalls),
      maxCalls: supplementalCalls,
    });
  }
  if (remainingGapCalls || plannedBatches.length === 0) {
    plannedBatches.push({
      kind: "gap-fill",
      capabilityIds: available,
      maxCalls: Math.max(remainingGapCalls, plannedBatches.length === 0 ? maxCalls : 0),
    });
  }
  return {
    targetUniqueSources: requirements.minSources,
    targetFullTextSources: requirements.minFullTextSources,
    targetDatedSources: requirements.minDatedSources,
    hardCallLimit: budget.maxBrokerCalls,
    maxCalls,
    expectedUniqueSourcesPerCall,
    maxItemsPerCall,
    recommendedOutputTokens,
    outputTokenLimit,
    reservedDiscoverTokens,
    requiredFirstPassCapabilityIds: requiredCapabilityIds,
    plannedBatches,
    constraintGaps,
  };
}

export function discoveryOutputTokenLimit(
  requirements: ProjectEvidenceRequirements,
  budget: ResearchBudget,
): number {
  return deriveDiscoveryPlan(requirements, { budget }, []).recommendedOutputTokens;
}

function roundUp(value: number, step: number): number {
  return Math.min(Math.ceil(value / step) * step, Number.MAX_SAFE_INTEGER);
}
