import { loadCapabilityDeclarations, verifyCapabilities } from "./capabilities.js";
import { hasPublicInternetCapability } from "./external-skills.js";
import { schemaForStage } from "./schemas.js";
import { canonicalJson, sha256Text } from "./storage.js";
import type {
  AgentPackageStage,
  AgentRoute,
  ProjectEvidenceRequirements,
  VerifiedProjectInputPlan,
  WorkspaceConfig,
} from "./types.js";
import { loadWorkspaceConfig, verifyDoctorAttestation } from "./workspace.js";

export const RESEARCH_AGENT_PROTOCOL_OVERHEAD_TOKENS: Record<AgentRoute["agent"], number> = {
  codex: 5_000,
  claude: 12_000,
};
export const RESEARCH_ESTIMATED_BYTES_PER_TOKEN = 3;
export const RESEARCH_MAX_REPAIR_SOURCE_BYTES = 32_000;
export const RESEARCH_CODEX_STRUCTURED_OUTPUT_MAX_TURNS = 2;
export const RESEARCH_CLAUDE_STRUCTURED_OUTPUT_MAX_TURNS = 3;
export const RESEARCH_BROKER_MAX_TURNS = 6;
export const RESEARCH_REPAIR_MAX_TURNS = 1;
const RESEARCH_PREFLIGHT_PROMPT_ALLOWANCE_TOKENS = 3_000;

export async function evaluateProjectPreflight(
  root: string,
  question: string,
  requirements: ProjectEvidenceRequirements | null,
  inputPlan: VerifiedProjectInputPlan | null,
) {
  const config = await loadWorkspaceConfig(root);
  const capabilities = await loadCapabilityDeclarations(root);
  const capabilityVerification = await verifyCapabilities(root);
  const doctorAttestation =
    config.mode === "production-research" ? await verifyDoctorAttestation(root) : null;
  const networkCapabilities = capabilities.capabilities
    .filter((capability) => capability.permissions.includes("brokered-network"))
    .map((capability) => ({
      id: capability.id,
      allowedHosts: capability.allowedHosts,
      endpoint: capability.http?.endpoint ?? null,
      accept: capability.http?.accept ?? null,
      maxResponseBytes: capability.http?.maxResponseBytes ?? null,
      maxItems: capability.http?.maxItems ?? null,
      requiredForDiscovery: capability.requiredForDiscovery,
      coverage: capability.coverage,
    }));
  const packageTokens = config.budget.packageMaxTokens;
  const tokenReservation = Object.values(packageTokens).reduce((sum, value) => sum + value, 0);
  const wallReservation = Object.values(config.budget.packageMaxWallSeconds).reduce(
    (sum, value) => sum + value,
    0,
  );
  const estimatedMaxCostUsd =
    config.producer.pricing && config.reviewer.pricing
      ? roundMoney(
          reservedAgentPackageCost(config.producer, packageTokens.discover, config) +
            reservedAgentPackageCost(config.producer, packageTokens.analyze, config) +
            reservedAgentPackageCost(config.producer, packageTokens.synthesize, config) +
            reservedAgentPackageCost(config.reviewer, packageTokens.review, config),
        )
      : null;
  const gaps: string[] = [];
  if (config.mode === "production-research" && !requirements) {
    gaps.push("explicit-evidence-requirements-missing");
  }
  if (config.mode === "production-research" && (!config.producer.model || !config.reviewer.model)) {
    gaps.push("explicit-agent-models-missing");
  }
  if (
    config.mode === "production-research" &&
    (!config.producer.effort || !config.reviewer.effort)
  ) {
    gaps.push("explicit-agent-effort-missing");
  }
  if (config.mode === "production-research" && !config.producer.verbosity) {
    gaps.push("explicit-codex-verbosity-missing");
  }
  if (
    config.mode === "production-research" &&
    (!config.producer.pricing || !config.reviewer.pricing)
  ) {
    gaps.push("explicit-agent-pricing-missing");
  }
  if (config.producer.agent === config.reviewer.agent) {
    gaps.push("independent-review-route-missing");
  }
  if (!networkCapabilities.length && !inputPlan) gaps.push("no-evidence-acquisition-plan");
  if (config.mode === "production-research" && !hasPublicInternetCapability(capabilities)) {
    gaps.push("production-public-internet-capability-missing");
  }
  if (capabilityVerification.status !== "verified") {
    gaps.push("capability-lock-missing-or-drifted");
  }
  if (doctorAttestation && doctorAttestation.status !== "verified") {
    gaps.push(`doctor-attestation-${doctorAttestation.status}`);
  }
  if (tokenReservation > config.budget.maxTokens) {
    gaps.push(
      `package-token-reservations-exceed-total:${tokenReservation}/${config.budget.maxTokens}`,
    );
  }
  if (wallReservation > config.budget.maxWallSeconds) {
    gaps.push(
      `package-wall-reservations-exceed-total:${wallReservation}/${config.budget.maxWallSeconds}`,
    );
  }
  if (estimatedMaxCostUsd !== null && estimatedMaxCostUsd > config.budget.maxCostUsd) {
    gaps.push(
      `package-cost-reservations-exceed-total:${estimatedMaxCostUsd}/${config.budget.maxCostUsd}`,
    );
  }
  const outputAndRepairReservation = config.budget.maxOutputTokens + config.budget.maxRepairTokens;
  for (const [stage, tokens] of Object.entries(packageTokens)) {
    if (tokens < outputAndRepairReservation) {
      gaps.push(
        `package-output-repair-reservation-exceeds-${stage}:${outputAndRepairReservation}/${tokens}`,
      );
    }
  }
  const stageContextTokenReservations = {
    analyze: config.budget.maxOutputTokens,
    synthesize: config.budget.maxOutputTokens * 2,
    review: config.budget.maxInputContextTokens + config.budget.maxOutputTokens * 3,
  };
  const producerStructuredOutputMaxTurns = researchStructuredOutputMaxTurns(config.producer);
  const reviewerStructuredOutputMaxTurns = researchStructuredOutputMaxTurns(config.reviewer);
  const embeddedStageContextReservation = stageContextTokenReservations.synthesize;
  if (embeddedStageContextReservation > config.budget.maxInputContextTokens) {
    gaps.push(
      `embedded-stage-context-reservation-exceeds-total:${embeddedStageContextReservation}/${config.budget.maxInputContextTokens}`,
    );
  }
  const recommendedDiscoverOutputTokens = requirements ? 768 + requirements.minSources * 320 : null;
  if (
    config.mode === "production-research" &&
    recommendedDiscoverOutputTokens !== null &&
    config.budget.maxOutputTokens < recommendedDiscoverOutputTokens
  ) {
    gaps.push(
      `discover-output-reservation-below-schema-recommendation:${config.budget.maxOutputTokens}/${recommendedDiscoverOutputTokens}`,
    );
  }
  const estimatedInputContextTokens =
    inputPlan?.inputs.reduce(
      (sum, input) => sum + Math.ceil((input.contextBytes ?? input.bytes) / 4),
      0,
    ) ?? 0;
  if (estimatedInputContextTokens > config.budget.maxInputContextTokens) {
    gaps.push(
      `input-context-reservation-exceeds-total:${estimatedInputContextTokens}/${config.budget.maxInputContextTokens}`,
    );
  }
  const maxTurns = {
    discover: networkCapabilities.length
      ? RESEARCH_BROKER_MAX_TURNS
      : producerStructuredOutputMaxTurns,
    analyze: producerStructuredOutputMaxTurns,
    synthesize: producerStructuredOutputMaxTurns,
    review: reviewerStructuredOutputMaxTurns,
    repair: RESEARCH_REPAIR_MAX_TURNS,
  };
  const schemaTokens = Object.fromEntries(
    (["discover", "analyze", "synthesize", "review"] as const).map((stage) => [
      stage,
      Math.ceil(
        Buffer.byteLength(
          JSON.stringify(
            schemaForStage(
              stage,
              null,
              stage === "discover" && networkCapabilities.length === 0
                ? { inputOnlyProvenanceIds: inputPlan?.inputs.map((input) => input.id) ?? [] }
                : {},
            ),
          ),
          "utf8",
        ) / RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
      ),
    ]),
  ) as Record<AgentPackageStage, number>;
  const capabilityDocumentationReservation = networkCapabilities.length
    ? config.budget.maxInputContextTokens
    : 0;
  const preCallTokenReservations = {
    discover: estimatedStageTokenReservation(
      config.producer,
      estimatedInputContextTokens + capabilityDocumentationReservation,
      schemaTokens.discover,
      maxTurns.discover,
      config,
      config.budget.maxBrokerContextTokens * config.budget.maxBrokerCalls,
    ),
    analyze: estimatedStageTokenReservation(
      config.producer,
      config.budget.maxOutputTokens,
      schemaTokens.analyze,
      producerStructuredOutputMaxTurns,
      config,
    ),
    synthesize: estimatedStageTokenReservation(
      config.producer,
      config.budget.maxOutputTokens * 2,
      schemaTokens.synthesize,
      producerStructuredOutputMaxTurns,
      config,
    ),
    review: estimatedStageTokenReservation(
      config.reviewer,
      stageContextTokenReservations.review,
      schemaTokens.review,
      reviewerStructuredOutputMaxTurns,
      config,
    ),
  };
  for (const [stage, reservation] of Object.entries(preCallTokenReservations)) {
    const configured = packageTokens[stage as AgentPackageStage];
    if (reservation > configured) {
      gaps.push(`package-precall-reservation-exceeds-${stage}:${reservation}/${configured}`);
    }
  }
  if (requirements) {
    appendEvidencePlanGaps(gaps, requirements, inputPlan, networkCapabilities);
  }
  const result = {
    schemaVersion: 1 as const,
    mode: config.mode,
    questionSha256: sha256Text(question),
    evidenceRequirements: requirements,
    capabilities: networkCapabilities,
    inputPlan:
      inputPlan === null
        ? null
        : {
            sha256: inputPlan.sha256,
            inputs: inputPlan.inputs.map((input) => ({
              id: input.id,
              role: input.role,
              sha256: input.sha256,
              bytes: input.bytes,
              contextSha256: input.contextSha256,
              contextBytes: input.contextBytes,
              contextRanges: input.contextRanges ?? null,
              dimensions: input.dimensions,
              sourceType: input.sourceType,
              fullText: input.fullText,
              publicationDate: input.publicationDate,
            })),
          },
    capabilityVerification,
    doctorAttestation:
      doctorAttestation === null
        ? null
        : {
            status: doctorAttestation.status,
            errors: doctorAttestation.errors,
            attestationSha256: doctorAttestation.attestation?.attestationSha256 ?? null,
            checkedAt: doctorAttestation.attestation?.checkedAt ?? null,
            expiresAt: doctorAttestation.attestation?.expiresAt ?? null,
          },
    gaps,
    budget: {
      tokenReservation,
      wallReservation,
      maxTokens: config.budget.maxTokens,
      maxCostUsd: config.budget.maxCostUsd,
      maxWallSeconds: config.budget.maxWallSeconds,
      packageMaxTokens: config.budget.packageMaxTokens,
      confirmationCostUsd: config.budget.confirmationCostUsd,
      confirmationRequired: config.budget.maxCostUsd > config.budget.confirmationCostUsd,
      estimatedMaxCostUsd,
      maxBrokerContextTokens: config.budget.maxBrokerContextTokens,
      maxBrokerCalls: config.budget.maxBrokerCalls,
      maxOutputTokens: config.budget.maxOutputTokens,
      maxRepairTokens: config.budget.maxRepairTokens,
      estimatedInputContextTokens,
      maxInputContextTokens: config.budget.maxInputContextTokens,
      embeddedStageContextReservation,
      stageContextTokenReservations,
      recommendedDiscoverOutputTokens,
      outputTokenLimitEnforcement: {
        producer: "post-execution",
        reviewer: "post-execution",
      },
      preCallTokenReservations,
      maxTurns,
    },
    executionPolicy: {
      producer: {
        agent: config.producer.agent,
        model: config.producer.model,
        effort: config.producer.effort ?? null,
        verbosity: config.producer.verbosity ?? null,
        wrapperTargetPinned: Boolean(config.producer.wrapperTargetBinary),
        turnLimitEnforcement:
          config.producer.agent === "claude" ? "provider" : "reservation-and-post-execution",
      },
      reviewer: {
        agent: config.reviewer.agent,
        model: config.reviewer.model,
        effort: config.reviewer.effort ?? null,
        verbosity: config.reviewer.verbosity ?? null,
        wrapperTargetPinned: Boolean(config.reviewer.wrapperTargetBinary),
        turnLimitEnforcement:
          config.reviewer.agent === "claude" ? "provider" : "reservation-and-post-execution",
      },
    },
    readyToInitialize:
      capabilityVerification.status === "verified" &&
      (config.mode === "smoke-test" || Boolean(requirements)) &&
      gaps.length === 0,
  };
  return { ...result, preflightSha256: sha256Text(canonicalJson(result)) };
}

export function researchStructuredOutputMaxTurns(route: Pick<AgentRoute, "agent">): number {
  return route.agent === "claude"
    ? RESEARCH_CLAUDE_STRUCTURED_OUTPUT_MAX_TURNS
    : RESEARCH_CODEX_STRUCTURED_OUTPUT_MAX_TURNS;
}

function estimatedStageTokenReservation(
  route: AgentRoute,
  embeddedContextTokens: number,
  schemaTokens: number,
  primaryMaxTurns: number,
  config: WorkspaceConfig,
  potentialToolContextTokens = 0,
): number {
  return calculateAgentCallTokenReservation({
    route,
    primaryPayloadTokens:
      embeddedContextTokens + schemaTokens + RESEARCH_PREFLIGHT_PROMPT_ALLOWANCE_TOKENS,
    repairPayloadTokens:
      schemaTokens +
      Math.ceil((RESEARCH_MAX_REPAIR_SOURCE_BYTES + 2_048) / RESEARCH_ESTIMATED_BYTES_PER_TOKEN),
    maxTurns: primaryMaxTurns,
    maxOutputTokens: config.budget.maxOutputTokens,
    maxToolContextTokens: potentialToolContextTokens,
    maxRepairTokens: config.budget.maxRepairTokens,
    reserveRepair: true,
  }).totalTokens;
}

export function calculateAgentCallTokenReservation(input: {
  route: Pick<AgentRoute, "agent">;
  primaryPayloadTokens: number;
  repairPayloadTokens: number;
  maxTurns: number;
  maxOutputTokens: number;
  maxToolContextTokens: number;
  maxRepairTokens: number;
  reserveRepair: boolean;
  alreadyUsedTokens?: number;
}) {
  const protocolOverhead = RESEARCH_AGENT_PROTOCOL_OVERHEAD_TOKENS[input.route.agent];
  const alreadyUsedTokens = input.alreadyUsedTokens ?? 0;
  const estimatedCallInputTokensPerTurn = protocolOverhead + input.primaryPayloadTokens;
  const estimatedCallInputTokens = estimatedCallInputTokensPerTurn * input.maxTurns;
  const potentialRepairTokens = input.reserveRepair
    ? (protocolOverhead + input.repairPayloadTokens) * RESEARCH_REPAIR_MAX_TURNS +
      input.maxRepairTokens
    : 0;
  return {
    alreadyUsedTokens,
    maxTurns: input.maxTurns,
    estimatedCallInputTokensPerTurn,
    estimatedCallInputTokens,
    outputTokens: input.maxOutputTokens,
    potentialToolContextTokens: input.maxToolContextTokens,
    potentialRepairTokens,
    totalTokens:
      alreadyUsedTokens +
      estimatedCallInputTokens +
      input.maxToolContextTokens +
      input.maxOutputTokens +
      potentialRepairTokens,
  };
}

export function reservedAgentPackageCost(
  route: AgentRoute,
  tokens: number,
  config: Pick<WorkspaceConfig, "budget">,
): number {
  if (!route.pricing) return 0;
  const maximumOutputTokens = Math.min(
    tokens,
    config.budget.maxOutputTokens + config.budget.maxRepairTokens,
  );
  const maximumInputTokens = Math.max(0, tokens - maximumOutputTokens);
  const inputRate = Math.max(
    route.pricing.inputUsdPerMillionTokens,
    route.pricing.cachedInputUsdPerMillionTokens,
  );
  return (
    (maximumInputTokens * inputRate +
      maximumOutputTokens * route.pricing.outputUsdPerMillionTokens) /
    1_000_000
  );
}

function appendEvidencePlanGaps(
  gaps: string[],
  requirements: ProjectEvidenceRequirements,
  inputPlan: VerifiedProjectInputPlan | null,
  networkCapabilities: Array<{
    coverage: {
      dimensions: string[];
      sourceTypes: string[];
      fullText: boolean;
      publicationDates: boolean;
    } | null;
  }>,
): void {
  const declaredCoverage = networkCapabilities.flatMap((capability) =>
    capability.coverage ? [capability.coverage] : [],
  );
  const dimensions = new Set([
    ...declaredCoverage.flatMap((coverage) => coverage.dimensions),
    ...(inputPlan?.inputs.flatMap((input) => input.dimensions) ?? []),
  ]);
  const sourceTypes = new Set([
    ...declaredCoverage.flatMap((coverage) => coverage.sourceTypes),
    ...(inputPlan?.inputs.map((input) => input.sourceType) ?? []),
  ]);
  for (const dimension of requirements.dimensions) {
    if (!dimensions.has("*") && !dimensions.has(dimension)) {
      gaps.push(`evidence-plan-dimension-uncovered:${dimension}`);
    }
  }
  for (const sourceType of requirements.sourceTypes) {
    if (!sourceTypes.has("*") && !sourceTypes.has(sourceType)) {
      gaps.push(`evidence-plan-source-type-uncovered:${sourceType}`);
    }
  }
  const canDiscoverFullText = declaredCoverage.some((coverage) => coverage.fullText);
  const canDiscoverDates = declaredCoverage.some((coverage) => coverage.publicationDates);
  const plannedInputCount = inputPlan?.inputs.length ?? 0;
  const plannedFullTextCount = inputPlan?.inputs.filter((input) => input.fullText).length ?? 0;
  const plannedDatedCount =
    inputPlan?.inputs.filter(
      (input) =>
        input.publicationDate !== null &&
        (requirements.publicationDateFrom === null ||
          input.publicationDate >= requirements.publicationDateFrom) &&
        (requirements.publicationDateTo === null ||
          input.publicationDate <= requirements.publicationDateTo),
    ).length ?? 0;
  if (!networkCapabilities.length && plannedInputCount < requirements.minSources) {
    gaps.push(
      `evidence-plan-min-sources-insufficient:${plannedInputCount}/${requirements.minSources}`,
    );
  }
  if (requirements.minFullTextSources > plannedFullTextCount && !canDiscoverFullText) {
    gaps.push(
      `evidence-plan-full-text-insufficient:${plannedFullTextCount}/${requirements.minFullTextSources}`,
    );
  }
  if (requirements.minDatedSources > plannedDatedCount && !canDiscoverDates) {
    gaps.push(
      `evidence-plan-dated-sources-insufficient:${plannedDatedCount}/${requirements.minDatedSources}`,
    );
  }
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
