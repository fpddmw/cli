import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readAndVerifyScientificDesign } from "../../src/research/workspace/scientific-design.js";
import { loadProject } from "../../src/research/workspace/projects.js";
import {
  prepareScientificReview,
  submitScientificReview,
  type ScientificReviewPacket,
} from "../../src/research/workspace/scientific-review.js";
import {
  resolveContained,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "../../src/research/workspace/storage.js";
import type { AgentKind } from "../../src/research/workspace/types.js";

const fixturePath = resolve("test/fixtures/scientific-design/ev-r9-narrowed-valid.json");

export async function scientificDesignInput(
  root: string,
  projectId: string,
  options: {
    targetJournal?: string | null;
    approvalStatus?: "candidate-only" | "policy-approved";
    policyRules?: string[];
    pendingUncertainty?: boolean;
    pendingModels?: boolean;
    producerAgent?: AgentKind;
    producerSessionId?: string;
  } = {},
) {
  const target = join(root, `${projectId}-scientific-design.json`);
  const value = JSON.parse(await readFile(fixturePath, "utf8")) as {
    projectId: string;
    identity: {
      targetJournals: {
        primary: string;
        approvalStatus: "candidate-only" | "policy-approved";
      };
      modelStructures: Array<{
        id: string;
        implementationArtifactLocator: string;
        environmentLockLocator: string;
        implementationStatus?: "executable-frozen" | "pending-source-acquisition";
        implementationFreezeBeforeGate?: "research-design" | "evidence-construct" | "pilot-methods";
        environmentLockStatus?: "exact-frozen" | "pending-runtime-lock";
        environmentLockFreezeBeforeGate?:
          | "research-design"
          | "evidence-construct"
          | "pilot-methods";
      }>;
    };
    policyRuleDispositions: Array<{
      ruleId: string;
      status: "planned";
      dueGate: "research-design" | "evidence-construct" | "pilot-methods" | "publication-freeze";
      rationale: string;
      claimIds: string[];
      evidenceRoleIds: string[];
      validationPlanIds: string[];
      knownGapIds: string[];
      uncertaintyParameterIds: string[];
      modelStructureIds: string[];
    }>;
    uncertaintyParameters: Array<{
      id: string;
      stateValueStatus: "frozen" | "pending-source-acquisition";
      freezeBeforeGate: "research-design" | "evidence-construct" | "pilot-methods";
      states: Array<{ value: string }>;
    }>;
    knownGaps: Array<{
      id: string;
      sourceProjectId: string | null;
      sourceArtifacts: Array<{ objectLocator: string; kind: string }>;
    }>;
  };
  value.projectId = projectId;
  if (options.targetJournal) value.identity.targetJournals.primary = options.targetJournal;
  if (options.approvalStatus) {
    value.identity.targetJournals.approvalStatus = options.approvalStatus;
  }
  value.policyRuleDispositions = (options.policyRules ?? []).map((ruleId) => ({
    ruleId,
    status: "planned",
    dueGate: "publication-freeze",
    rationale:
      "The synthetic workflow fixture binds this policy rule for adjudication in the frozen-manuscript publication assessment and independent reviewer packet.",
    claimIds: ["claim-discrepancy"],
    evidenceRoleIds: ["role-central-model"],
    validationPlanIds: ["validation-cross-model"],
    knownGapIds: [],
    uncertaintyParameterIds: [],
    modelStructureIds: [],
  }));
  if (options.pendingUncertainty) {
    const parameter = value.uncertaintyParameters.find(
      (candidate) => candidate.id === "uncertainty-vehicle-load-factor",
    );
    if (!parameter) throw new Error("Missing fixture uncertainty parameter.");
    parameter.stateValueStatus = "pending-source-acquisition";
    parameter.freezeBeforeGate = "evidence-construct";
    parameter.states[0]!.value = "source lower state";
    const disposition = value.policyRuleDispositions.find(
      (candidate) => candidate.ruleId === "uncertainty-propagated",
    );
    if (!disposition) throw new Error("Missing fixture uncertainty policy disposition.");
    disposition.dueGate = "evidence-construct";
    disposition.uncertaintyParameterIds = [parameter.id];
  }
  if (options.pendingModels) {
    for (const model of value.identity.modelStructures) {
      model.implementationStatus = "pending-source-acquisition";
      model.implementationFreezeBeforeGate = "pilot-methods";
      model.environmentLockStatus = "pending-runtime-lock";
      model.environmentLockFreezeBeforeGate = "pilot-methods";
    }
    const disposition = value.policyRuleDispositions.find(
      (candidate) => candidate.ruleId === "model-calibrated-or-justified",
    );
    if (!disposition) throw new Error("Missing fixture model policy disposition.");
    disposition.dueGate = "pilot-methods";
    disposition.modelStructureIds = value.identity.modelStructures.map((model) => model.id);
  }
  await stageFixtureModelSources(root, value.identity.modelStructures);
  await stageFixtureGapSources(root, value.knownGaps);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  return {
    design: await readAndVerifyScientificDesign(target, projectId),
    producerAgent: options.producerAgent ?? ("codex" as const),
    producerSessionId: options.producerSessionId ?? `native-${projectId}-design-session`,
  };
}

async function stageFixtureModelSources(
  root: string,
  models: Array<{
    id: string;
    implementationArtifactLocator: string;
    environmentLockLocator: string;
  }>,
): Promise<void> {
  const sourceFiles: Record<string, { implementation: string; environment: string }> = {
    "mechanistic-fatigue-model": {
      implementation: "mechanistic-fatigue-model.json",
      environment: "mechanistic-environment-lock.json",
    },
    "reference-fatigue-model": {
      implementation: "reference-fatigue-model.json",
      environment: "reference-environment-lock.json",
    },
  };
  for (const model of models) {
    const source = sourceFiles[model.id];
    if (!source) throw new Error(`Missing fixture model objects for ${model.id}`);
    for (const [locator, filename] of [
      [model.implementationArtifactLocator, source.implementation],
      [model.environmentLockLocator, source.environment],
    ] as const) {
      await writeTextAtomic(
        resolveContained(workspacePaths(root).control, locator),
        await readFile(resolve("test/fixtures/scientific-design/objects", filename), "utf8"),
      );
    }
  }
}

async function stageFixtureGapSources(
  root: string,
  gaps: Array<{
    id: string;
    sourceProjectId: string | null;
    sourceArtifacts: Array<{ objectLocator: string; kind: string }>;
  }>,
): Promise<void> {
  const attestations: Record<string, string> = {
    "gap-powertrain-wim":
      "The prior reviewed generation found no powertrain-labelled WIM exposure and narrowed all claims to cross-model outputs.",
    "gap-event-material-tickets":
      "The prior reviewed generation found no same-project RAP, yield, removal, or ticket records and narrowed material claims to gross installed HMA.",
  };
  for (const gap of gaps) {
    for (const artifact of gap.sourceArtifacts) {
      if (artifact.kind !== "owner-attestation" || !gap.sourceProjectId) continue;
      const attestation = attestations[gap.id];
      if (!attestation) throw new Error(`Missing fixture attestation for ${gap.id}`);
      await writeJsonAtomic(
        resolveContained(workspacePaths(root).control, artifact.objectLocator),
        {
          schemaVersion: 1,
          kind: "owner-attestation",
          sourceProjectId: gap.sourceProjectId,
          gapId: gap.id,
          attestation,
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      );
    }
  }
}

export async function passResearchDesignGate(root: string, projectId: string): Promise<void> {
  const { scientificDesign } = await loadProject(root, projectId);
  if (!scientificDesign) throw new Error("Test project has no scientific design binding.");
  const sessionId = `independent-${projectId}-research-design-review`;
  const assessmentPath = join(root, `${projectId}-research-design-assessment.json`);
  await writeJsonAtomic(assessmentPath, {
    schemaVersion: 1,
    role: "research-design",
    designSha256: scientificDesign.designSha256,
    recommendation: "pass",
    checks: {
      identityCoherent: true,
      estimandObservable: true,
      claimGraphComplete: true,
      endpointTruthRolesCorrect: true,
      quantityOntologyComplete: true,
      validationSemanticsCorrect: true,
      knownGapDispositionComplete: true,
      lifecycleFeasible: true,
    },
    findings: [],
  });
  const packet = await prepareScientificReview({
    root,
    projectId,
    role: "research-design",
    assessmentPath,
    reviewerAgent: "claude",
    reviewerSessionId: sessionId,
  });
  await submitPassingReview(root, projectId, packet);
}

export async function passEvidenceConstructGate(root: string, projectId: string): Promise<void> {
  const { scientificDesign } = await loadProject(root, projectId);
  if (!scientificDesign) throw new Error("Test project has no scientific design binding.");
  const design = JSON.parse(
    await readFile(join(root, ".tiangong-research", scientificDesign.objectLocator), "utf8"),
  ) as {
    edges: Array<{ id: string; role: string }>;
    evidenceRoles: Array<{
      id: string;
      minimumFullText: number;
      minimumIndependentSources: number;
      minimumDatedSources: number;
      peerReviewedRequired: boolean;
      coverageDimensionIds: string[];
      sourceTypeRequirements: string[];
    }>;
  };
  const assessmentPath = join(root, `${projectId}-evidence-construct-assessment.json`);
  await writeJsonAtomic(assessmentPath, {
    schemaVersion: 1,
    role: "evidence-construct",
    designSha256: scientificDesign.designSha256,
    recommendation: "pass",
    constructCanary: {
      usesRealRecords: true,
      outcomeBlind: true,
      resultValuesInspected: false,
      rowCount: 10,
      constructedEdgeIds: design.edges
        .filter((edge) => edge.role === "central")
        .map((edge) => edge.id),
      failedEdgeIds: [],
      artifactSha256s: ["c".repeat(64)],
    },
    evidenceRoleCoverage: design.evidenceRoles.map((role, roleIndex) => ({
      roleId: role.id,
      fullTextSourceIds: Array.from(
        { length: role.minimumFullText },
        (_, index) => `source-${roleIndex}-${index}`,
      ),
      independentSourceIds: Array.from(
        { length: role.minimumIndependentSources },
        (_, index) => `source-${roleIndex}-${index}`,
      ),
      datedSourceIds: Array.from(
        { length: role.minimumDatedSources },
        (_, index) => `source-${roleIndex}-${index}`,
      ),
      peerReviewedSourceIds: role.peerReviewedRequired
        ? Array.from({ length: role.minimumFullText }, (_, index) => `source-${roleIndex}-${index}`)
        : [],
      dimensionIds: role.coverageDimensionIds,
      sourceTypes: role.sourceTypeRequirements,
    })),
    closestWorkDispositionComplete: true,
    centralEvidenceFitsContext: true,
    findings: [],
  });
  const packet = await prepareScientificReview({
    root,
    projectId,
    role: "evidence-construct",
    assessmentPath,
    reviewerAgent: "claude",
    reviewerSessionId: `independent-${projectId}-evidence-construct-review`,
  });
  await submitPassingReview(root, projectId, packet);
}

export async function passPilotMethodsGate(root: string, projectId: string): Promise<void> {
  const { scientificDesign } = await loadProject(root, projectId);
  if (!scientificDesign) throw new Error("Test project has no scientific design binding.");
  const design = JSON.parse(
    await readFile(join(root, ".tiangong-research", scientificDesign.objectLocator), "utf8"),
  ) as {
    validationPlans: Array<{
      id: string;
      outcomeBlind: boolean;
      originalUnitCount: number;
      independentClusterCount: number;
      effectiveIndependentUnits: number;
      clusterKeyIds: string[];
      independenceJustification: string;
      resamplingUnit: string;
      resamplingIterations: number;
      resamplingMethod: "exact-enumeration" | "cluster-bootstrap" | "none";
      resamplingStateSpaceSize: number;
      reportingPrecision: string;
      minimumDetectableDifference: string | null;
      independentValidation: {
        status: "available" | "planned" | "unavailable-scope-bounded" | "not-required";
        gapId: string | null;
      };
    }>;
    baselinePlan: { decisionLossMetrics: Array<{ id: string }> };
  };
  const assessmentPath = join(root, `${projectId}-pilot-methods-assessment.json`);
  await writeJsonAtomic(assessmentPath, {
    schemaVersion: 1,
    role: "pilot-methods",
    designSha256: scientificDesign.designSha256,
    recommendation: "pass",
    checks: {
      noDataLeakage: true,
      noCircularValidation: true,
      endpointComparisonsCompatible: true,
      baselineFair: true,
      unitsAndDenominatorsVerified: true,
      thresholdsTyped: true,
      decisionLossMetricsComputed: true,
    },
    validationAudits: design.validationPlans.map((plan) => ({
      validationPlanId: plan.id,
      outcomeBlind: plan.outcomeBlind,
      originalUnitCount: plan.originalUnitCount,
      independentClusterCount: plan.independentClusterCount,
      effectiveIndependentUnits: plan.effectiveIndependentUnits,
      clusterKeyIds: plan.clusterKeyIds,
      independenceJustification: plan.independenceJustification,
      resamplingUnit: plan.resamplingUnit,
      resamplingIterations: plan.resamplingIterations,
      resamplingMethod: plan.resamplingMethod,
      resamplingStateSpaceSize: plan.resamplingStateSpaceSize,
      reportingPrecision: plan.reportingPrecision,
      minimumDetectableDifference: plan.minimumDetectableDifference,
      independentValidationStatus: plan.independentValidation.status,
      independentValidationGapId: plan.independentValidation.gapId,
    })),
    decisionLossMetricIds: design.baselinePlan.decisionLossMetrics.map((metric) => metric.id),
    findings: [],
  });
  const packet = await prepareScientificReview({
    root,
    projectId,
    role: "pilot-methods",
    assessmentPath,
    reviewerAgent: "claude",
    reviewerSessionId: `independent-${projectId}-pilot-methods-review`,
  });
  await submitPassingReview(root, projectId, packet);
}

async function submitPassingReview(
  root: string,
  projectId: string,
  packet: ScientificReviewPacket,
): Promise<void> {
  const reviewPath = join(root, `${projectId}-${packet.role}-review.json`);
  await writeJsonAtomic(reviewPath, {
    schemaVersion: 1,
    role: packet.role,
    packetSha256: packet.packetSha256,
    reviewerSessionSha256: packet.reviewer.sessionSha256,
    decision: "pass",
    findings: [],
    boundedRecommendation: `The exact ${packet.role} packet passes independent review.`,
  });
  await submitScientificReview({ root, projectId, role: packet.role, reviewPath });
}
