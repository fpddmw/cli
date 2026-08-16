import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  evaluateScientificDesign,
  parseScientificDesign,
  scientificDesignSchema,
} from "../src/research/workspace/scientific-design.js";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "scientific-design",
);

describe("top-journal scientific design contract", () => {
  it("rejects the EV R9 route before discovery for the actual scientific reasons", async () => {
    const design = await fixture("ev-r9-invalid.json");
    const result = evaluateScientificDesign(design);

    assert.equal(result.readyForDesignReview, false);
    assert.deepEqual(
      new Set(result.issueCodes),
      new Set([
        "ENDPOINT_TRUTH_ROLE_INVALID",
        "ENDPOINT_COMPARISON_INCOMPATIBLE",
        "TARGET_EXPOSURE_UNIDENTIFIABLE",
        "VALIDATION_DGP_NOT_INDEPENDENT",
        "EFFECTIVE_SAMPLE_SIZE_INFLATED",
        "RESAMPLING_UNIT_INVALID",
        "ACCOUNTING_UNCERTAINTY_BRIDGE_INCOMPLETE",
        "QUANTITY_TERM_OVERCLAIM",
        "THRESHOLD_TYPE_MISMATCH",
        "THRESHOLD_SENSITIVITY_MISSING",
        "CLOSEST_WORK_FULLTEXT_UNPLANNED",
        "KNOWN_BLOCKING_GAP_UNRESOLVED",
        "BASELINE_FAIRNESS_UNRESOLVED",
        "CONTEXT_PLAN_OVER_LIMIT",
        "CLAIM_CRITICAL_CONTEXT_MISSING",
      ]),
    );
  });

  it("accepts the explicitly narrowed cross-model and gross-HMA design", async () => {
    const design = await fixture("ev-r9-narrowed-valid.json");
    const result = evaluateScientificDesign(design);

    assert.equal(result.readyForDesignReview, true);
    assert.deepEqual(result.issueCodes, []);
    assert.equal(result.centralStudyKind, "cross-model-comparison");
    assert.equal(result.effectiveIndependentUnits, 4);
    assert.equal(result.requiredEvidenceRoles, 5);
  });

  it("rejects the reviewer-discovered cross-model, quantity, and false-precision blind spots", async () => {
    const design = await fixture("ev-r9-narrowed-valid.json");
    const serviceEndpoint = design.endpoints.find(
      (endpoint) => endpoint.id === "endpoint-reference-fatigue",
    );
    assert.ok(serviceEndpoint);
    serviceEndpoint.physicalConstruct = "multi-mechanism service equivalence";
    serviceEndpoint.scale = "vehicle-service";
    serviceEndpoint.timeBasis = "modeled freight service";
    const centralClaim = design.claims.find((claim) => claim.id === "claim-discrepancy");
    assert.ok(centralClaim);
    centralClaim.quantityIds = [];
    const serviceShare = design.quantities.find(
      (quantity) => quantity.id === "quantity-service-share",
    );
    assert.ok(serviceShare);
    serviceShare.denominatorType = "freight_service_share";
    const crossModelPlan = design.validationPlans.find(
      (plan) => plan.id === "validation-cross-model",
    );
    assert.ok(crossModelPlan);
    crossModelPlan.resamplingIterations = 200000;
    const result = evaluateScientificDesign(design);

    for (const code of [
      "CROSS_MODEL_COMPARISON_INVALID",
      "CENTRAL_CLAIM_QUANTITY_UNBOUND",
      "QUANTITY_DENOMINATOR_SELF_REFERENCE",
      "RESAMPLING_PRECISION_UNJUSTIFIED",
    ]) {
      assert.ok(result.issueCodes.includes(code), `missing reviewer regression ${code}`);
    }
    assert.equal(result.readyForDesignReview, false);
  });

  it("rejects material uncertainty that is declared on a quantity but dropped by its accounting bridge", async () => {
    const design = await fixture("ev-r9-narrowed-valid.json");
    const accountingEdge = design.edges.find((edge) => edge.id === "edge-overlay-to-hma");
    assert.ok(accountingEdge);
    accountingEdge.uncertaintyParameterIds = [];

    const result = evaluateScientificDesign(design);
    assert.ok(result.issueCodes.includes("ACCOUNTING_UNCERTAINTY_BRIDGE_INCOMPLETE"));
    assert.equal(result.readyForDesignReview, false);
  });

  it("rejects the second independent review's decision, unit, bridge, sensitivity, and provenance blind spots", async () => {
    const design = await fixture("ev-r9-narrowed-valid.json");
    for (const comparison of design.comparisons) {
      const mutable = comparison as unknown as Record<string, unknown>;
      mutable.decisionRule = "";
      mutable.thresholdIds = [];
      mutable.reportingLevel = "";
    }
    const centralPlan = design.validationPlans.find((plan) => plan.id === "validation-cross-model");
    assert.ok(centralPlan);
    const mutablePlan = centralPlan as unknown as Record<string, unknown>;
    mutablePlan.originalUnitDefinition = "";
    mutablePlan.independentClusterDefinition = "";
    mutablePlan.nestingRule = "";
    mutablePlan.reportingUnitDefinition = "";
    const centralQuantity = design.quantities.find(
      (quantity) => quantity.id === "quantity-model-discrepancy",
    );
    assert.ok(centralQuantity);
    centralQuantity.uncertaintyParameterIds = [];
    const mutableQuantity = centralQuantity as unknown as Record<string, unknown>;
    mutableQuantity.normalizationMode = "directional-convention";
    mutableQuantity.normalizationJustification = "";
    for (const edge of design.edges) {
      const mutable = edge as unknown as Record<string, unknown>;
      mutable.quantityIds = [];
      if (edge.id === "edge-model-to-overlay") edge.uncertaintyParameterIds = [];
    }
    design.knownGaps[0]!.sourceArtifacts[0]!.sha256 = "a".repeat(64);

    const result = evaluateScientificDesign(design);
    for (const code of [
      "CENTRAL_DECISION_RULE_UNDECLARED",
      "CONFIGURATION_INVENTORY_UNDECLARED",
      "CENTRAL_UNCERTAINTY_PLAN_MISSING",
      "CLAIM_QUANTITY_BRIDGE_MISSING",
      "CENTRAL_NORMALIZATION_UNJUSTIFIED",
      "GAP_LINEAGE_PLACEHOLDER_DIGEST",
    ]) {
      assert.ok(result.issueCodes.includes(code), `missing second-review regression ${code}`);
    }
    assert.equal(result.readyForDesignReview, false);
  });

  it("rejects the real R11 executable-graph, factor, dataset, and uncertainty blind spots", async () => {
    const design = await fixture("ev-r9-narrowed-valid.json");
    for (const model of design.identity.modelStructures) {
      const mutable = model as unknown as Record<string, unknown>;
      mutable.equationSet = "";
      mutable.coefficientSet = "";
      mutable.implementationArtifactSha256 = "";
      mutable.environmentLockSha256 = "";
      mutable.baselineSelectionJustification = "";
    }
    const centralEdge = design.edges.find((edge) => edge.id === "edge-model-to-overlay");
    assert.ok(centralEdge);
    const mutableEdge = centralEdge as unknown as Record<string, unknown>;
    mutableEdge.fromEndpointIds = [];
    mutableEdge.toEndpointIds = [];
    mutableEdge.operatorId = "";
    mutableEdge.operatorDefinition = "";
    const discrepancy = design.quantities.find(
      (quantity) => quantity.id === "quantity-model-discrepancy",
    );
    assert.ok(discrepancy);
    (discrepancy as unknown as Record<string, unknown>).valueMode = "absolute";
    for (const threshold of design.thresholds) {
      const mutable = threshold as unknown as Record<string, unknown>;
      mutable.criterionQuantityIds = [threshold.quantityId];
      mutable.basisJustification = "";
      mutable.stabilityMode = "sign";
      mutable.stabilityQuantityId = threshold.quantityId;
      mutable.stabilityRule = "";
      mutable.sensitivityReportingRule = "";
    }
    design.thresholds[0]!.unit = "event";
    for (const parameter of design.uncertaintyParameters) {
      (parameter as unknown as Record<string, unknown>).states = [];
    }
    (design as unknown as Record<string, unknown>).uncertaintyGroups = [];
    (design as unknown as Record<string, unknown>).factors = [];
    for (const plan of design.validationPlans) {
      const mutable = plan as unknown as Record<string, unknown>;
      mutable.datasetRoles = [];
      mutable.factorIds = [];
    }
    const centralDataRole = design.evidenceRoles.find((role) => role.id === "role-central-data");
    assert.ok(centralDataRole);
    centralDataRole.claimIds = ["claim-hma"];
    const centralClaim = design.claims.find((claim) => claim.id === "claim-discrepancy");
    assert.ok(centralClaim);
    centralClaim.evidenceRoleIds = centralClaim.evidenceRoleIds.filter(
      (roleId) => roleId !== "role-central-data",
    );
    design.baselinePlan.decisionLossMetrics = [];
    design.contextPlan.claimCriticalCapsuleIds = ["unmapped-capsule"];

    const result = evaluateScientificDesign(design);
    for (const code of [
      "MODEL_IMPLEMENTATION_BINDING_MISSING",
      "CROSS_SCALE_OPERATOR_UNDECLARED",
      "THRESHOLD_QUANTITY_UNIT_MISMATCH",
      "SIGNED_STABILITY_QUANTITY_MISSING",
      "THRESHOLD_SENSITIVITY_RULE_UNDECLARED",
      "UNCERTAINTY_STATE_SPACE_UNDECLARED",
      "CONFIGURATION_FACTOR_UNDECLARED",
      "VALIDATION_DATASET_ROLE_UNDECLARED",
      "EVIDENCE_ROLE_CLAIM_BINDING_INCONSISTENT",
      "DECISION_LOSS_METRIC_UNBOUND",
      "CLAIM_CRITICAL_CAPSULE_UNMAPPED",
    ]) {
      assert.ok(result.issueCodes.includes(code), `missing real R11 regression ${code}`);
    }
    assert.equal(result.readyForDesignReview, false);
  });

  it("rejects the real R13 byte-binding, consequence-graph, and factor-composition blind spots", async () => {
    const design = await fixture("ev-r9-narrowed-valid.json");
    for (const model of design.identity.modelStructures) {
      const mutable = model as unknown as Record<string, unknown>;
      mutable.implementationArtifactLocator = "";
      mutable.environmentLockLocator = "";
    }
    const scenarioComponent = design.identity.components.find(
      (component) => component.kind === "scenario-analysis",
    );
    assert.ok(scenarioComponent);
    scenarioComponent.bridgeEdgeIds = scenarioComponent.bridgeEdgeIds.filter(
      (edgeId) => edgeId !== "edge-model-overlay-to-scenario",
    );
    design.edges = design.edges.filter((edge) => edge.id !== "edge-model-overlay-to-scenario");
    const loadFactor = design.uncertaintyParameters.find(
      (parameter) => parameter.id === "uncertainty-vehicle-load-factor",
    );
    assert.ok(loadFactor);
    const mutableLoadFactor = loadFactor as unknown as Record<string, unknown>;
    mutableLoadFactor.factorIds = ["factor-load-configuration"];
    mutableLoadFactor.applicationPoint = "";
    mutableLoadFactor.compositionRule = "";
    mutableLoadFactor.preservesFactorLevelIdentity = false;

    const result = evaluateScientificDesign(design);
    for (const code of [
      "MODEL_ARTIFACT_OBJECT_UNBOUND",
      "COMPONENT_BRIDGE_GRAPH_DISCONNECTED",
      "FACTOR_UNCERTAINTY_COMPOSITION_UNDECLARED",
    ]) {
      assert.ok(result.issueCodes.includes(code), `missing real R13 regression ${code}`);
    }
    assert.equal(result.readyForDesignReview, false);
  });

  it("requires every declared joint sensitivity state to map exactly one state from every grouped parameter", async () => {
    const raw = JSON.parse(
      await readFile(join(fixtureRoot, "ev-r9-narrowed-valid.json"), "utf8"),
    ) as Record<string, any>;
    addJointStateBindings(raw);
    const valid = parseScientificDesign(raw);
    assert.ok(
      !evaluateScientificDesign(valid).issueCodes.includes(
        "UNCERTAINTY_JOINT_STATE_BINDING_INVALID",
      ),
    );

    const invalidRaw = structuredClone(raw);
    invalidRaw.uncertaintyGroups[1].jointStateBindings[3].parameterStateIds = [
      "baseline-interval-central",
      "horizon-untraceable",
      "overlay-trigger-central",
      "load-factor-central",
    ];
    const invalid = parseScientificDesign(invalidRaw);
    assert.ok(
      evaluateScientificDesign(invalid).issueCodes.includes(
        "UNCERTAINTY_JOINT_STATE_BINDING_INVALID",
      ),
    );
  });

  it("binds each pending source-derived uncertainty freeze to a policy rule due at the same gate", async () => {
    const raw = JSON.parse(
      await readFile(join(fixtureRoot, "ev-r9-narrowed-valid.json"), "utf8"),
    ) as Record<string, any>;
    addJointStateBindings(raw);
    const parameter = raw.uncertaintyParameters.find(
      (candidate: { id: string }) => candidate.id === "uncertainty-vehicle-load-factor",
    );
    parameter.stateValueStatus = "pending-source-acquisition";
    parameter.freezeBeforeGate = "evidence-construct";
    parameter.states[0].value = "source lower state";
    raw.policyRuleDispositions = [
      {
        ruleId: "uncertainty-propagated",
        status: "planned",
        dueGate: "evidence-construct",
        rationale:
          "Discovery must supply exact source-derived states before the evidence-construct gate.",
        claimIds: ["claim-discrepancy"],
        evidenceRoleIds: ["role-central-model"],
        validationPlanIds: ["validation-cross-model"],
        knownGapIds: [],
        uncertaintyParameterIds: ["uncertainty-vehicle-load-factor"],
        modelStructureIds: [],
      },
    ];
    const bound = parseScientificDesign(raw);
    assert.ok(
      !evaluateScientificDesign(bound).issueCodes.includes(
        "UNCERTAINTY_FREEZE_POLICY_BINDING_MISSING",
      ),
    );

    const unboundRaw = structuredClone(raw);
    unboundRaw.policyRuleDispositions[0].uncertaintyParameterIds = [];
    const unbound = parseScientificDesign(unboundRaw);
    assert.ok(
      evaluateScientificDesign(unbound).issueCodes.includes(
        "UNCERTAINTY_FREEZE_POLICY_BINDING_MISSING",
      ),
    );
  });

  it("binds every pending model implementation and environment lock to a policy rule due at the same gate", async () => {
    const raw = JSON.parse(
      await readFile(join(fixtureRoot, "ev-r9-narrowed-valid.json"), "utf8"),
    ) as Record<string, any>;
    for (const model of raw.identity.modelStructures) {
      model.implementationStatus = "pending-source-acquisition";
      model.implementationFreezeBeforeGate = "pilot-methods";
      model.environmentLockStatus = "pending-runtime-lock";
      model.environmentLockFreezeBeforeGate = "pilot-methods";
    }
    raw.policyRuleDispositions = [
      {
        ruleId: "model-calibrated-or-justified",
        status: "planned",
        dueGate: "pilot-methods",
        rationale:
          "Exact model implementations and environment locks must replace design-stage objects before pilot-methods.",
        claimIds: ["claim-discrepancy"],
        evidenceRoleIds: ["role-central-model"],
        validationPlanIds: ["validation-cross-model"],
        knownGapIds: [],
        uncertaintyParameterIds: [],
        modelStructureIds: raw.identity.modelStructures.map((model: { id: string }) => model.id),
      },
    ];
    const bound = parseScientificDesign(raw);
    assert.ok(
      !evaluateScientificDesign(bound).issueCodes.includes("MODEL_FREEZE_POLICY_BINDING_MISSING"),
    );

    const unboundRaw = structuredClone(raw);
    unboundRaw.policyRuleDispositions[0].modelStructureIds = [];
    const unbound = parseScientificDesign(unboundRaw);
    assert.ok(
      evaluateScientificDesign(unbound).issueCodes.includes("MODEL_FREEZE_POLICY_BINDING_MISSING"),
    );
  });

  it("accepts only explicit cross-model identities, estimands, and null-outcome claim bindings", async () => {
    const design = await fixture("ev-r9-narrowed-valid.json");
    assert.equal(design.identity.modelStructures.length, 2);
    assert.equal(design.estimands.filter((estimand) => estimand.role === "central").length, 1);
    assert.equal(design.claims[0]?.hypothesisMode, "two-sided");
    assert.ok(design.claims[0]?.nullOutcomeStatement);
    assert.equal(evaluateScientificDesign(design).readyForDesignReview, true);
  });

  it("requires a closed acquisition plan that maps every required evidence role to lawful routes", async () => {
    const raw = JSON.parse(
      await readFile(join(fixtureRoot, "ev-r9-narrowed-valid.json"), "utf8"),
    ) as Record<string, any>;
    raw.acquisitionPlan = acquisitionPlanFor(
      raw.evidenceRoles.map((role: { id: string }) => role.id),
    );
    const planned = parseScientificDesign(raw);
    assert.equal(evaluateScientificDesign(planned).readyForDesignReview, true);

    const unmappedRaw = structuredClone(raw);
    unmappedRaw.acquisitionPlan.routes[0].evidenceRoleIds = ["role-central-model"];
    unmappedRaw.acquisitionPlan.routes[1].evidenceRoleIds = ["role-central-model"];
    const unmapped = parseScientificDesign(unmappedRaw);
    assert.ok(
      evaluateScientificDesign(unmapped).issueCodes.includes("EVIDENCE_ACQUISITION_ROUTE_UNMAPPED"),
    );

    const optionalAgentRaw = structuredClone(raw);
    optionalAgentRaw.acquisitionPlan.routes[0].required = false;
    const optionalAgent = parseScientificDesign(optionalAgentRaw);
    assert.ok(
      evaluateScientificDesign(optionalAgent).issueCodes.includes(
        "EVIDENCE_ACQUISITION_AGENT_ROUTE_OPTIONAL",
      ),
    );

    const bypassRaw = structuredClone(raw);
    bypassRaw.acquisitionPlan.stopPolicy.allAgentRoutesExhaustedBeforeHandoff = false;
    const bypass = parseScientificDesign(bypassRaw);
    assert.ok(
      evaluateScientificDesign(bypass).issueCodes.includes("EVIDENCE_EXHAUSTION_POLICY_INVALID"),
    );
  });

  it("requires executable bridge, uncertainty, cluster, validation, evidence, and gap provenance plans", async () => {
    const raw = JSON.parse(
      await readFile(join(fixtureRoot, "ev-r9-narrowed-valid.json"), "utf8"),
    ) as Record<string, any>;
    const design = parseScientificDesign(raw);
    assert.ok(design.edges.every((edge) => edge.quantityIds.length > 0));
    assert.ok(
      design.comparisons.every(
        (comparison) => comparison.decisionRule && comparison.reportingLevel,
      ),
    );
    assert.ok(
      design.validationPlans.every(
        (plan) =>
          plan.originalUnitDefinition &&
          plan.independentClusterDefinition &&
          plan.nestingRule &&
          plan.reportingUnitDefinition,
      ),
    );
    assert.ok(
      design.knownGaps.every((gap) =>
        gap.sourceArtifacts.every((artifact) => !/^([a-f0-9])\1{63}$/iu.test(artifact.sha256)),
      ),
    );
    assert.equal(evaluateScientificDesign(design).readyForDesignReview, true);
  });

  it("publishes a closed authoritative JSON Schema and rejects undeclared fields", async () => {
    const schema = scientificDesignSchema();
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");

    const raw = JSON.parse(
      await readFile(join(fixtureRoot, "ev-r9-narrowed-valid.json"), "utf8"),
    ) as Record<string, unknown>;
    raw.secretUnreviewedOverride = true;
    assert.throws(
      () => parseScientificDesign(raw),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "RESEARCH_SCIENTIFIC_DESIGN_INVALID");
        return true;
      },
    );
  });
});

async function fixture(name: string) {
  return parseScientificDesign(
    JSON.parse(await readFile(join(fixtureRoot, name), "utf8")) as unknown,
  );
}

function addJointStateBindings(raw: Record<string, any>) {
  const bindings: Record<string, Array<[string, string[]]>> = {
    "uncertainty-group-central-models": [
      ["central-all", ["modulus-central", "layer-thickness-central", "load-factor-central"]],
      ["modulus-low-only", ["modulus-low", "layer-thickness-central", "load-factor-central"]],
      ["modulus-high-only", ["modulus-high", "layer-thickness-central", "load-factor-central"]],
      [
        "layer-thickness-low-only",
        ["modulus-central", "layer-thickness-low", "load-factor-central"],
      ],
      [
        "layer-thickness-high-only",
        ["modulus-central", "layer-thickness-high", "load-factor-central"],
      ],
      ["load-factor-low-only", ["modulus-central", "layer-thickness-central", "load-factor-low"]],
      ["load-factor-high-only", ["modulus-central", "layer-thickness-central", "load-factor-high"]],
    ],
    "uncertainty-group-overlay-scenario": [
      [
        "scenario-central-all",
        [
          "baseline-interval-central",
          "horizon-50",
          "overlay-trigger-central",
          "load-factor-central",
        ],
      ],
      [
        "baseline-interval-low-only",
        ["baseline-interval-low", "horizon-50", "overlay-trigger-central", "load-factor-central"],
      ],
      [
        "baseline-interval-high-only",
        ["baseline-interval-high", "horizon-50", "overlay-trigger-central", "load-factor-central"],
      ],
      [
        "horizon-low-only",
        [
          "baseline-interval-central",
          "horizon-49",
          "overlay-trigger-central",
          "load-factor-central",
        ],
      ],
      [
        "horizon-high-only",
        [
          "baseline-interval-central",
          "horizon-51",
          "overlay-trigger-central",
          "load-factor-central",
        ],
      ],
      [
        "overlay-trigger-low-only",
        ["baseline-interval-central", "horizon-50", "overlay-trigger-low", "load-factor-central"],
      ],
      [
        "overlay-trigger-high-only",
        ["baseline-interval-central", "horizon-50", "overlay-trigger-high", "load-factor-central"],
      ],
      [
        "scenario-load-factor-low-only",
        ["baseline-interval-central", "horizon-50", "overlay-trigger-central", "load-factor-low"],
      ],
      [
        "scenario-load-factor-high-only",
        ["baseline-interval-central", "horizon-50", "overlay-trigger-central", "load-factor-high"],
      ],
    ],
    "uncertainty-group-hma-accounting": [
      ["hma-90-225", ["overlay-thickness-90", "density-225"]],
      ["hma-90-235", ["overlay-thickness-90", "density-235"]],
      ["hma-90-245", ["overlay-thickness-90", "density-245"]],
      ["hma-120-225", ["overlay-thickness-120", "density-225"]],
      ["hma-120-235", ["overlay-thickness-120", "density-235"]],
      ["hma-120-245", ["overlay-thickness-120", "density-245"]],
      ["hma-150-225", ["overlay-thickness-150", "density-225"]],
      ["hma-150-235", ["overlay-thickness-150", "density-235"]],
      ["hma-150-245", ["overlay-thickness-150", "density-245"]],
    ],
  };
  for (const group of raw.uncertaintyGroups) {
    const groupBindings = bindings[group.id];
    assert.ok(groupBindings);
    group.jointStateBindings = groupBindings.map(([jointStateId, parameterStateIds]) => ({
      jointStateId,
      parameterStateIds,
    }));
  }
}

function acquisitionPlanFor(evidenceRoleIds: string[]) {
  return {
    routes: [
      {
        id: "route-native-public-search",
        evidenceRoleIds,
        routeClass: "native-discovery",
        executor: "agent",
        required: true,
        capabilityId: null,
        activityKind: "web-search",
        activityChannel: "codex.web",
        downloadBackends: [],
        accessMode: "open-public",
        rationale: "Use the current native host public-web search before requesting paid access.",
      },
      {
        id: "route-licensed-literature",
        evidenceRoleIds,
        routeClass: "licensed-resource",
        executor: "user",
        required: true,
        capabilityId: null,
        activityKind: null,
        activityChannel: null,
        downloadBackends: [],
        accessMode: "purchase-or-subscription",
        rationale: "Acquire indispensable licensed full text only after lawful public routes fail.",
      },
    ],
    stopPolicy: {
      allAgentRoutesExhaustedBeforeHandoff: true,
      unresolvedRequiredEvidenceRoleBlocksDownstream: true,
      prohibitUnreviewedSubstitution: true,
    },
  };
}
