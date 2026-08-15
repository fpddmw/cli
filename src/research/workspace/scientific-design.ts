import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { CliError } from "../../errors.js";
import { sanitizeResearchValue } from "./sanitization.js";
import { sha256Text } from "./storage.js";

export type ScientificStudyKind =
  | "causal-empirical"
  | "observational-empirical"
  | "predictive-model"
  | "mechanism-model"
  | "cross-model-comparison"
  | "scenario-analysis"
  | "material-flow-accounting"
  | "systematic-synthesis"
  | "methods-data-resource";

export type ScientificResultClass =
  | "causal-estimate"
  | "observational-estimate"
  | "validated-forecast"
  | "model-output"
  | "scenario-output"
  | "accounting-output"
  | "systematic-synthesis"
  | "method-performance";

export interface ScientificDesignContract {
  schemaVersion: 1;
  projectId: string;
  workingTitle: string;
  identity: {
    centralStudyKind: ScientificStudyKind;
    contributionStatement: string;
    components: Array<{
      kind: ScientificStudyKind;
      role: "central" | "supporting" | "contextual";
      purpose: string;
      bridgeEdgeIds: string[];
    }>;
    modelStructures: Array<{
      id: string;
      label: string;
      family: string;
      version: string;
      equationSet: string;
      coefficientSet: string;
      implementationArtifactSha256: string;
      implementationArtifactLocator: string;
      implementationEntrypoint: string;
      implementationStatus: "executable-frozen" | "pending-source-acquisition";
      implementationFreezeBeforeGate: "research-design" | "evidence-construct" | "pilot-methods";
      environmentLockSha256: string;
      environmentLockLocator: string;
      environmentLockStatus: "exact-frozen" | "pending-runtime-lock";
      environmentLockFreezeBeforeGate: "research-design" | "evidence-construct" | "pilot-methods";
      artifactHashBasis: "raw-file-bytes";
      baselineRole: "candidate" | "reference" | "strongest-available";
      baselineSelectionJustification: string;
      sourceEvidenceRoleIds: string[];
    }>;
    allowedClaimVerbs: string[];
    targetJournals: {
      primary: string;
      alternate: string;
      fallback: string;
      approvalStatus: "candidate-only" | "policy-approved";
    };
  };
  policyRuleDispositions: Array<{
    ruleId: string;
    status: "satisfied-by-design" | "planned" | "scope-limited" | "incompatible";
    dueGate: "research-design" | "evidence-construct" | "pilot-methods" | "publication-freeze";
    rationale: string;
    claimIds: string[];
    evidenceRoleIds: string[];
    validationPlanIds: string[];
    knownGapIds: string[];
    uncertaintyParameterIds: string[];
    modelStructureIds: string[];
  }>;
  estimands: Array<{
    id: string;
    role: "central" | "supporting" | "contextual";
    population: string;
    analysisUnit: string;
    exposure: string;
    comparator: string;
    outcome: string;
    spatialScale: string;
    timeHorizon: string;
    resultClass: ScientificResultClass;
  }>;
  claims: Array<{
    id: string;
    role: "central" | "supporting" | "contextual";
    statement: string;
    resultClass: ScientificResultClass;
    edgeIds: string[];
    endpointIds: string[];
    comparisonIds: string[];
    estimandIds: string[];
    quantityIds: string[];
    evidenceRoleIds: string[];
    hypothesisMode: "two-sided" | "directional" | "descriptive" | "not-applicable";
    nullOutcomeStatement: string | null;
  }>;
  edges: Array<{
    id: string;
    role: "central" | "supporting" | "contextual";
    fromConstruct: string;
    toConstruct: string;
    evidenceMode: "direct-observation" | "model-bridge" | "accounting-bridge" | "assumption-only";
    requiredJoinKeys: string[];
    temporalAlignment: string;
    spatialAlignment: string;
    fromModelStructureIds: string[];
    toModelStructureIds: string[];
    fromEndpointIds: string[];
    toEndpointIds: string[];
    operatorId: string;
    operatorDefinition: string;
    aggregationRule: string;
    scaleReconciliation: string;
    quantityIds: string[];
    uncertaintyParameterIds: string[];
    sameSectionRequired: boolean;
    sameEventRequired: boolean;
    status: "planned" | "constructible" | "blocked";
    blockingReason: string | null;
  }>;
  endpoints: Array<{
    id: string;
    label: string;
    physicalConstruct: string;
    scale: string;
    unit: string;
    timeBasis: string;
    modelStructureId: string | null;
    truthRole:
      | "field-observation"
      | "experimental-reference"
      | "engineering-model"
      | "proxy"
      | "scenario-output"
      | "accounting-output";
  }>;
  comparisons: Array<{
    id: string;
    leftEndpointId: string;
    rightEndpointId: string;
    operation:
      | "error"
      | "accuracy"
      | "validation"
      | "agreement"
      | "discrepancy"
      | "ranking"
      | "qualitative-boundary";
    axis:
      | "same-endpoint-cross-model"
      | "model-to-observation"
      | "decision-consequence"
      | "qualitative-boundary";
    quantityIds: string[];
    thresholdIds: string[];
    decisionRule: string;
    reportingLevel: string;
    truthEndpointId: string | null;
  }>;
  quantities: Array<{
    id: string;
    label: string;
    quantityType: "share" | "material" | "rate" | "count" | "index" | "other";
    unit: string;
    numeratorType: string;
    denominatorType: string;
    denominatorDescription: string;
    normalizationMode: "symmetric" | "directional-convention" | "not-applicable";
    normalizationJustification: string;
    valueMode: "signed" | "absolute" | "nonnegative" | "categorical";
    uncertaintyParameterIds: string[];
    spatialScope: string;
    temporalScope: string;
    allowedTerms: string[];
    prohibitedTerms: string[];
  }>;
  validationPlans: Array<{
    id: string;
    claimIds: string[];
    role:
      | "internal-holdout"
      | "temporal-holdout"
      | "section-holdout"
      | "external-dgp"
      | "cross-model-reference"
      | "background-constraint"
      | "not-applicable";
    parameterDatasetIds: string[];
    comparisonDatasetIds: string[];
    datasetRoles: Array<{
      datasetId: string;
      role:
        | "parameter-source"
        | "endpoint-definition-source"
        | "non-independent-cross-check"
        | "independent-validation"
        | "background-context";
      sharedUpstreamIds: string[];
      justification: string;
    }>;
    factorIds: string[];
    exposureIdentifierAvailable: boolean;
    independentDataGeneratingProcess: boolean;
    outcomeBlind: boolean;
    originalUnitCount: number;
    independentClusterCount: number;
    effectiveIndependentUnits: number;
    originalUnitDefinition: string;
    independentClusterDefinition: string;
    nestingRule: string;
    reportingUnitDefinition: string;
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
      justification: string;
    };
    status: "planned" | "feasible" | "impossible";
    blockingReason: string | null;
  }>;
  thresholds: Array<{
    id: string;
    claimId: string;
    quantityId: string;
    type: "analytic" | "scenario" | "estimated" | "policy-trigger";
    reportedAs:
      | "analytic-threshold"
      | "scenario-threshold"
      | "estimated-threshold"
      | "policy-trigger";
    criterion: string;
    criterionQuantityIds: string[];
    numericValue: number | null;
    unit: string;
    direction: "above" | "below" | "outside" | "equal" | "categorical";
    basis: "reporting-convention" | "domain-standard" | "decision-consequence" | "policy";
    basisJustification: string;
    stabilityMode: "sign" | "classification" | "range" | "none";
    stabilityQuantityId: string | null;
    stabilityRule: string;
    sensitivityReportingRule: string;
    assumptionIds: string[];
    sensitivityParameterIds: string[];
  }>;
  evidenceRoles: Array<{
    id: string;
    role:
      | "central-model-source"
      | "central-data-documentation"
      | "closest-prior-work"
      | "counterevidence"
      | "method-identification"
      | "material-conversion"
      | "overlay-rule"
      | "cross-model-validation"
      | "pavement-context"
      | "limitation-boundary"
      | "target-journal-recent-work"
      | "background";
    claimIds: string[];
    coverageDimensionIds: string[];
    sourceTypeRequirements: string[];
    peerReviewedRequired: boolean;
    required: boolean;
    minimumFullText: number;
    minimumIndependentSources: number;
    minimumDatedSources: number;
  }>;
  knownGaps: Array<{
    id: string;
    description: string;
    sourceProjectId: string | null;
    sourceArtifacts: Array<{
      sha256: string;
      objectLocator: string;
      hashBasis: "raw-file-bytes";
      kind:
        | "scientific-review-packet"
        | "scientific-review"
        | "evidence-snapshot"
        | "publication-assessment"
        | "owner-attestation";
    }>;
    lineageStatus: "verified" | "owner-attested" | "unverified";
    disposition: "unresolved" | "closed" | "scope-narrowed" | "user-handoff" | "external-handoff";
    evidenceRefs: Array<{
      kind: "claim" | "quantity" | "validation-plan" | "edge" | "evidence-role";
      id: string;
    }>;
  }>;
  uncertaintyParameters: Array<{
    id: string;
    label: string;
    distributionOrRange: string;
    states: Array<{
      id: string;
      label: string;
      value: string;
      unit: string;
    }>;
    stateValueType: "numeric" | "categorical";
    stateValueStatus: "frozen" | "pending-source-acquisition";
    freezeBeforeGate: "research-design" | "evidence-construct" | "pilot-methods";
    factorIds: string[];
    applicationPoint: string;
    compositionRule: string;
    preservesFactorLevelIdentity: boolean;
    sourceEvidenceRoleIds: string[];
    quantityIds: string[];
  }>;
  uncertaintyGroups: Array<{
    id: string;
    parameterIds: string[];
    combinationMode: "one-at-a-time" | "full-factorial" | "explicit-joint-states";
    jointStateIds: string[];
    jointStateBindings: Array<{
      jointStateId: string;
      parameterStateIds: string[];
    }>;
    applicationRule: string;
    sharedAcrossModelStructureIds: string[];
  }>;
  factors: Array<{
    id: string;
    label: string;
    role: "exposure" | "blocking" | "scenario";
    observationalStatus: "observed" | "modeled-only" | "externally-defined";
    applicabilityBoundary: string;
    evidenceRoleIds: string[];
    levels: Array<{
      id: string;
      label: string;
      definition: string;
      attributes: Array<{
        id: string;
        label: string;
        value: string;
        unit: string;
      }>;
    }>;
  }>;
  baselinePlan: {
    sameInputInformation: boolean;
    comparableCalibrationBudget: boolean;
    sameEndpoint: boolean;
    frozenBeforeAnalysis: boolean;
    decisionLossMetrics: Array<{
      id: string;
      label: string;
      comparisonIds: string[];
      quantityIds: string[];
      decisionRule: string;
      reportingLevel: string;
    }>;
  };
  contextPlan: {
    maxEstimatedTokens: number;
    estimatedTokens: number;
    claimCriticalCapsuleIds: string[];
    backgroundIndexOnly: boolean;
    centralEvidenceFits: boolean;
  };
}

export interface ScientificDesignIssue {
  code: string;
  severity: "blocking" | "major" | "minor";
  message: string;
  objectIds: string[];
}

export interface ScientificDesignEvaluation {
  schemaVersion: 1;
  projectId: string;
  centralStudyKind: ScientificStudyKind;
  readyForDesignReview: boolean;
  issues: ScientificDesignIssue[];
  issueCodes: string[];
  effectiveIndependentUnits: number;
  requiredEvidenceRoles: number;
}

export interface VerifiedScientificDesign {
  schemaVersion: 1;
  contract: ScientificDesignContract;
  sha256: string;
  bytes: number;
}

const MAX_SCIENTIFIC_DESIGN_BYTES = 2 * 1024 * 1024;

const IDENTIFIER = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const nonEmptyString = { type: "string", minLength: 1 } as const;
const stringArray = {
  type: "array",
  items: nonEmptyString,
  uniqueItems: true,
} as const;
const identifierArray = {
  type: "array",
  items: { type: "string", pattern: IDENTIFIER },
  uniqueItems: true,
} as const;
const studyKinds: ScientificStudyKind[] = [
  "causal-empirical",
  "observational-empirical",
  "predictive-model",
  "mechanism-model",
  "cross-model-comparison",
  "scenario-analysis",
  "material-flow-accounting",
  "systematic-synthesis",
  "methods-data-resource",
];
const resultClasses: ScientificResultClass[] = [
  "causal-estimate",
  "observational-estimate",
  "validated-forecast",
  "model-output",
  "scenario-output",
  "accounting-output",
  "systematic-synthesis",
  "method-performance",
];

export function scientificDesignSchema(): Record<string, unknown> {
  const endpointSchema = {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "label",
      "physicalConstruct",
      "scale",
      "unit",
      "timeBasis",
      "modelStructureId",
      "truthRole",
    ],
    properties: {
      id: { type: "string", pattern: IDENTIFIER },
      label: nonEmptyString,
      physicalConstruct: nonEmptyString,
      scale: nonEmptyString,
      unit: nonEmptyString,
      timeBasis: nonEmptyString,
      modelStructureId: { type: ["string", "null"], pattern: IDENTIFIER },
      truthRole: {
        type: "string",
        enum: [
          "field-observation",
          "experimental-reference",
          "engineering-model",
          "proxy",
          "scenario-output",
          "accounting-output",
        ],
      },
    },
  } as const;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.tiangong.ai/research/scientific-design-v1.json",
    title: "Tiangong top-journal scientific design contract",
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "projectId",
      "workingTitle",
      "identity",
      "policyRuleDispositions",
      "estimands",
      "claims",
      "edges",
      "endpoints",
      "comparisons",
      "quantities",
      "validationPlans",
      "thresholds",
      "evidenceRoles",
      "knownGaps",
      "uncertaintyParameters",
      "uncertaintyGroups",
      "factors",
      "baselinePlan",
      "contextPlan",
    ],
    properties: {
      schemaVersion: { type: "integer", const: 1 },
      projectId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{2,63}$" },
      workingTitle: { type: "string", minLength: 8 },
      identity: {
        type: "object",
        additionalProperties: false,
        required: [
          "centralStudyKind",
          "contributionStatement",
          "components",
          "modelStructures",
          "allowedClaimVerbs",
          "targetJournals",
        ],
        properties: {
          centralStudyKind: { type: "string", enum: studyKinds },
          contributionStatement: nonEmptyString,
          components: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "role", "purpose", "bridgeEdgeIds"],
              properties: {
                kind: { type: "string", enum: studyKinds },
                role: { type: "string", enum: ["central", "supporting", "contextual"] },
                purpose: nonEmptyString,
                bridgeEdgeIds: identifierArray,
              },
            },
          },
          modelStructures: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "id",
                "label",
                "family",
                "version",
                "equationSet",
                "coefficientSet",
                "implementationArtifactSha256",
                "implementationArtifactLocator",
                "implementationEntrypoint",
                "implementationStatus",
                "implementationFreezeBeforeGate",
                "environmentLockSha256",
                "environmentLockLocator",
                "environmentLockStatus",
                "environmentLockFreezeBeforeGate",
                "artifactHashBasis",
                "baselineRole",
                "baselineSelectionJustification",
                "sourceEvidenceRoleIds",
              ],
              properties: {
                id: { type: "string", pattern: IDENTIFIER },
                label: nonEmptyString,
                family: nonEmptyString,
                version: nonEmptyString,
                equationSet: nonEmptyString,
                coefficientSet: nonEmptyString,
                implementationArtifactSha256: {
                  type: "string",
                  pattern: "^[a-f0-9]{64}$",
                },
                implementationArtifactLocator: {
                  type: "string",
                  pattern:
                    "^(?:projects/[a-z0-9][a-z0-9-]{2,63}|lineage/objects)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
                },
                implementationEntrypoint: nonEmptyString,
                implementationStatus: {
                  type: "string",
                  enum: ["executable-frozen", "pending-source-acquisition"],
                },
                implementationFreezeBeforeGate: {
                  type: "string",
                  enum: ["research-design", "evidence-construct", "pilot-methods"],
                },
                environmentLockSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
                environmentLockLocator: {
                  type: "string",
                  pattern:
                    "^(?:projects/[a-z0-9][a-z0-9-]{2,63}|lineage/objects)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
                },
                environmentLockStatus: {
                  type: "string",
                  enum: ["exact-frozen", "pending-runtime-lock"],
                },
                environmentLockFreezeBeforeGate: {
                  type: "string",
                  enum: ["research-design", "evidence-construct", "pilot-methods"],
                },
                artifactHashBasis: { const: "raw-file-bytes" },
                baselineRole: {
                  type: "string",
                  enum: ["candidate", "reference", "strongest-available"],
                },
                baselineSelectionJustification: nonEmptyString,
                sourceEvidenceRoleIds: identifierArray,
              },
            },
          },
          allowedClaimVerbs: stringArray,
          targetJournals: {
            type: "object",
            additionalProperties: false,
            required: ["primary", "alternate", "fallback", "approvalStatus"],
            properties: {
              primary: nonEmptyString,
              alternate: nonEmptyString,
              fallback: nonEmptyString,
              approvalStatus: { type: "string", enum: ["candidate-only", "policy-approved"] },
            },
          },
        },
      },
      policyRuleDispositions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "ruleId",
            "status",
            "dueGate",
            "rationale",
            "claimIds",
            "evidenceRoleIds",
            "validationPlanIds",
            "knownGapIds",
            "uncertaintyParameterIds",
            "modelStructureIds",
          ],
          properties: {
            ruleId: { type: "string", pattern: IDENTIFIER },
            status: {
              type: "string",
              enum: ["satisfied-by-design", "planned", "scope-limited", "incompatible"],
            },
            dueGate: {
              type: "string",
              enum: [
                "research-design",
                "evidence-construct",
                "pilot-methods",
                "publication-freeze",
              ],
            },
            rationale: nonEmptyString,
            claimIds: identifierArray,
            evidenceRoleIds: identifierArray,
            validationPlanIds: identifierArray,
            knownGapIds: identifierArray,
            uncertaintyParameterIds: identifierArray,
            modelStructureIds: identifierArray,
          },
        },
      },
      estimands: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "role",
            "population",
            "analysisUnit",
            "exposure",
            "comparator",
            "outcome",
            "spatialScale",
            "timeHorizon",
            "resultClass",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            role: { type: "string", enum: ["central", "supporting", "contextual"] },
            population: nonEmptyString,
            analysisUnit: nonEmptyString,
            exposure: nonEmptyString,
            comparator: nonEmptyString,
            outcome: nonEmptyString,
            spatialScale: nonEmptyString,
            timeHorizon: nonEmptyString,
            resultClass: { type: "string", enum: resultClasses },
          },
        },
      },
      claims: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "role",
            "statement",
            "resultClass",
            "edgeIds",
            "endpointIds",
            "comparisonIds",
            "estimandIds",
            "quantityIds",
            "evidenceRoleIds",
            "hypothesisMode",
            "nullOutcomeStatement",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            role: { type: "string", enum: ["central", "supporting", "contextual"] },
            statement: nonEmptyString,
            resultClass: { type: "string", enum: resultClasses },
            edgeIds: identifierArray,
            endpointIds: identifierArray,
            comparisonIds: identifierArray,
            estimandIds: identifierArray,
            quantityIds: identifierArray,
            evidenceRoleIds: identifierArray,
            hypothesisMode: {
              type: "string",
              enum: ["two-sided", "directional", "descriptive", "not-applicable"],
            },
            nullOutcomeStatement: { type: ["string", "null"] },
          },
        },
      },
      edges: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "role",
            "fromConstruct",
            "toConstruct",
            "evidenceMode",
            "requiredJoinKeys",
            "temporalAlignment",
            "spatialAlignment",
            "fromModelStructureIds",
            "toModelStructureIds",
            "fromEndpointIds",
            "toEndpointIds",
            "operatorId",
            "operatorDefinition",
            "aggregationRule",
            "scaleReconciliation",
            "quantityIds",
            "uncertaintyParameterIds",
            "sameSectionRequired",
            "sameEventRequired",
            "status",
            "blockingReason",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            role: { type: "string", enum: ["central", "supporting", "contextual"] },
            fromConstruct: nonEmptyString,
            toConstruct: nonEmptyString,
            evidenceMode: {
              type: "string",
              enum: ["direct-observation", "model-bridge", "accounting-bridge", "assumption-only"],
            },
            requiredJoinKeys: identifierArray,
            temporalAlignment: nonEmptyString,
            spatialAlignment: nonEmptyString,
            fromModelStructureIds: identifierArray,
            toModelStructureIds: identifierArray,
            fromEndpointIds: identifierArray,
            toEndpointIds: identifierArray,
            operatorId: { type: "string", pattern: IDENTIFIER },
            operatorDefinition: nonEmptyString,
            aggregationRule: nonEmptyString,
            scaleReconciliation: nonEmptyString,
            quantityIds: identifierArray,
            uncertaintyParameterIds: identifierArray,
            sameSectionRequired: { type: "boolean" },
            sameEventRequired: { type: "boolean" },
            status: { type: "string", enum: ["planned", "constructible", "blocked"] },
            blockingReason: { type: ["string", "null"] },
          },
        },
      },
      endpoints: { type: "array", minItems: 1, items: endpointSchema },
      comparisons: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "leftEndpointId",
            "rightEndpointId",
            "operation",
            "axis",
            "quantityIds",
            "thresholdIds",
            "decisionRule",
            "reportingLevel",
            "truthEndpointId",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            leftEndpointId: { type: "string", pattern: IDENTIFIER },
            rightEndpointId: { type: "string", pattern: IDENTIFIER },
            operation: {
              type: "string",
              enum: [
                "error",
                "accuracy",
                "validation",
                "agreement",
                "discrepancy",
                "ranking",
                "qualitative-boundary",
              ],
            },
            axis: {
              type: "string",
              enum: [
                "same-endpoint-cross-model",
                "model-to-observation",
                "decision-consequence",
                "qualitative-boundary",
              ],
            },
            quantityIds: identifierArray,
            thresholdIds: identifierArray,
            decisionRule: nonEmptyString,
            reportingLevel: nonEmptyString,
            truthEndpointId: { type: ["string", "null"], pattern: IDENTIFIER },
          },
        },
      },
      quantities: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "label",
            "quantityType",
            "unit",
            "numeratorType",
            "denominatorType",
            "denominatorDescription",
            "normalizationMode",
            "normalizationJustification",
            "valueMode",
            "uncertaintyParameterIds",
            "spatialScope",
            "temporalScope",
            "allowedTerms",
            "prohibitedTerms",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            label: nonEmptyString,
            quantityType: {
              type: "string",
              enum: ["share", "material", "rate", "count", "index", "other"],
            },
            unit: nonEmptyString,
            numeratorType: nonEmptyString,
            denominatorType: { type: "string", pattern: IDENTIFIER },
            denominatorDescription: nonEmptyString,
            normalizationMode: {
              type: "string",
              enum: ["symmetric", "directional-convention", "not-applicable"],
            },
            normalizationJustification: nonEmptyString,
            valueMode: {
              type: "string",
              enum: ["signed", "absolute", "nonnegative", "categorical"],
            },
            uncertaintyParameterIds: identifierArray,
            spatialScope: nonEmptyString,
            temporalScope: nonEmptyString,
            allowedTerms: stringArray,
            prohibitedTerms: stringArray,
          },
        },
      },
      validationPlans: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "claimIds",
            "role",
            "parameterDatasetIds",
            "comparisonDatasetIds",
            "datasetRoles",
            "factorIds",
            "exposureIdentifierAvailable",
            "independentDataGeneratingProcess",
            "outcomeBlind",
            "originalUnitCount",
            "independentClusterCount",
            "effectiveIndependentUnits",
            "originalUnitDefinition",
            "independentClusterDefinition",
            "nestingRule",
            "reportingUnitDefinition",
            "clusterKeyIds",
            "independenceJustification",
            "resamplingUnit",
            "resamplingIterations",
            "resamplingMethod",
            "resamplingStateSpaceSize",
            "reportingPrecision",
            "minimumDetectableDifference",
            "independentValidation",
            "status",
            "blockingReason",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            claimIds: identifierArray,
            role: {
              type: "string",
              enum: [
                "internal-holdout",
                "temporal-holdout",
                "section-holdout",
                "external-dgp",
                "cross-model-reference",
                "background-constraint",
                "not-applicable",
              ],
            },
            parameterDatasetIds: identifierArray,
            comparisonDatasetIds: identifierArray,
            datasetRoles: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["datasetId", "role", "sharedUpstreamIds", "justification"],
                properties: {
                  datasetId: { type: "string", pattern: IDENTIFIER },
                  role: {
                    type: "string",
                    enum: [
                      "parameter-source",
                      "endpoint-definition-source",
                      "non-independent-cross-check",
                      "independent-validation",
                      "background-context",
                    ],
                  },
                  sharedUpstreamIds: identifierArray,
                  justification: nonEmptyString,
                },
              },
            },
            factorIds: identifierArray,
            exposureIdentifierAvailable: { type: "boolean" },
            independentDataGeneratingProcess: { type: "boolean" },
            outcomeBlind: { type: "boolean" },
            originalUnitCount: { type: "integer", minimum: 0 },
            independentClusterCount: { type: "integer", minimum: 0 },
            effectiveIndependentUnits: { type: "number", minimum: 0 },
            originalUnitDefinition: nonEmptyString,
            independentClusterDefinition: nonEmptyString,
            nestingRule: nonEmptyString,
            reportingUnitDefinition: nonEmptyString,
            clusterKeyIds: identifierArray,
            independenceJustification: nonEmptyString,
            resamplingUnit: nonEmptyString,
            resamplingIterations: { type: "integer", minimum: 0 },
            resamplingMethod: {
              type: "string",
              enum: ["exact-enumeration", "cluster-bootstrap", "none"],
            },
            resamplingStateSpaceSize: { type: "integer", minimum: 0 },
            reportingPrecision: nonEmptyString,
            minimumDetectableDifference: { type: ["string", "null"] },
            independentValidation: {
              type: "object",
              additionalProperties: false,
              required: ["status", "gapId", "justification"],
              properties: {
                status: {
                  type: "string",
                  enum: ["available", "planned", "unavailable-scope-bounded", "not-required"],
                },
                gapId: { type: ["string", "null"], pattern: IDENTIFIER },
                justification: nonEmptyString,
              },
            },
            status: { type: "string", enum: ["planned", "feasible", "impossible"] },
            blockingReason: { type: ["string", "null"] },
          },
        },
      },
      thresholds: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "claimId",
            "quantityId",
            "type",
            "reportedAs",
            "criterion",
            "criterionQuantityIds",
            "numericValue",
            "unit",
            "direction",
            "basis",
            "basisJustification",
            "stabilityMode",
            "stabilityQuantityId",
            "stabilityRule",
            "sensitivityReportingRule",
            "assumptionIds",
            "sensitivityParameterIds",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            claimId: { type: "string", pattern: IDENTIFIER },
            quantityId: { type: "string", pattern: IDENTIFIER },
            type: { type: "string", enum: ["analytic", "scenario", "estimated", "policy-trigger"] },
            reportedAs: {
              type: "string",
              enum: [
                "analytic-threshold",
                "scenario-threshold",
                "estimated-threshold",
                "policy-trigger",
              ],
            },
            criterion: nonEmptyString,
            criterionQuantityIds: identifierArray,
            numericValue: { type: ["number", "null"] },
            unit: nonEmptyString,
            direction: {
              type: "string",
              enum: ["above", "below", "outside", "equal", "categorical"],
            },
            basis: {
              type: "string",
              enum: ["reporting-convention", "domain-standard", "decision-consequence", "policy"],
            },
            basisJustification: nonEmptyString,
            stabilityMode: {
              type: "string",
              enum: ["sign", "classification", "range", "none"],
            },
            stabilityQuantityId: { type: ["string", "null"], pattern: IDENTIFIER },
            stabilityRule: nonEmptyString,
            sensitivityReportingRule: nonEmptyString,
            assumptionIds: identifierArray,
            sensitivityParameterIds: identifierArray,
          },
        },
      },
      evidenceRoles: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "role",
            "claimIds",
            "coverageDimensionIds",
            "sourceTypeRequirements",
            "peerReviewedRequired",
            "required",
            "minimumFullText",
            "minimumIndependentSources",
            "minimumDatedSources",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            role: {
              type: "string",
              enum: [
                "central-model-source",
                "central-data-documentation",
                "closest-prior-work",
                "counterevidence",
                "method-identification",
                "material-conversion",
                "overlay-rule",
                "cross-model-validation",
                "pavement-context",
                "limitation-boundary",
                "target-journal-recent-work",
                "background",
              ],
            },
            claimIds: identifierArray,
            coverageDimensionIds: identifierArray,
            sourceTypeRequirements: identifierArray,
            peerReviewedRequired: { type: "boolean" },
            required: { type: "boolean" },
            minimumFullText: { type: "integer", minimum: 0 },
            minimumIndependentSources: { type: "integer", minimum: 0 },
            minimumDatedSources: { type: "integer", minimum: 0 },
          },
        },
      },
      knownGaps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "description",
            "sourceProjectId",
            "sourceArtifacts",
            "lineageStatus",
            "disposition",
            "evidenceRefs",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            description: nonEmptyString,
            sourceProjectId: { type: ["string", "null"], pattern: "^[a-z0-9][a-z0-9-]{2,63}$" },
            sourceArtifacts: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["sha256", "objectLocator", "hashBasis", "kind"],
                properties: {
                  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
                  objectLocator: {
                    type: "string",
                    pattern:
                      "^(?:projects/[a-z0-9][a-z0-9-]{2,63}|lineage/objects)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
                  },
                  hashBasis: { const: "raw-file-bytes" },
                  kind: {
                    type: "string",
                    enum: [
                      "scientific-review-packet",
                      "scientific-review",
                      "evidence-snapshot",
                      "publication-assessment",
                      "owner-attestation",
                    ],
                  },
                },
              },
            },
            lineageStatus: {
              type: "string",
              enum: ["verified", "owner-attested", "unverified"],
            },
            disposition: {
              type: "string",
              enum: ["unresolved", "closed", "scope-narrowed", "user-handoff", "external-handoff"],
            },
            evidenceRefs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "id"],
                properties: {
                  kind: {
                    type: "string",
                    enum: ["claim", "quantity", "validation-plan", "edge", "evidence-role"],
                  },
                  id: { type: "string", pattern: IDENTIFIER },
                },
              },
            },
          },
        },
      },
      uncertaintyParameters: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "label",
            "distributionOrRange",
            "states",
            "stateValueType",
            "stateValueStatus",
            "freezeBeforeGate",
            "factorIds",
            "applicationPoint",
            "compositionRule",
            "preservesFactorLevelIdentity",
            "sourceEvidenceRoleIds",
            "quantityIds",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            label: nonEmptyString,
            distributionOrRange: nonEmptyString,
            states: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "label", "value", "unit"],
                properties: {
                  id: { type: "string", pattern: IDENTIFIER },
                  label: nonEmptyString,
                  value: nonEmptyString,
                  unit: nonEmptyString,
                },
              },
            },
            stateValueType: { type: "string", enum: ["numeric", "categorical"] },
            stateValueStatus: {
              type: "string",
              enum: ["frozen", "pending-source-acquisition"],
            },
            freezeBeforeGate: {
              type: "string",
              enum: ["research-design", "evidence-construct", "pilot-methods"],
            },
            factorIds: identifierArray,
            applicationPoint: nonEmptyString,
            compositionRule: nonEmptyString,
            preservesFactorLevelIdentity: { type: "boolean" },
            sourceEvidenceRoleIds: identifierArray,
            quantityIds: identifierArray,
          },
        },
      },
      uncertaintyGroups: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "parameterIds",
            "combinationMode",
            "jointStateIds",
            "jointStateBindings",
            "applicationRule",
            "sharedAcrossModelStructureIds",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            parameterIds: identifierArray,
            combinationMode: {
              type: "string",
              enum: ["one-at-a-time", "full-factorial", "explicit-joint-states"],
            },
            jointStateIds: identifierArray,
            jointStateBindings: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["jointStateId", "parameterStateIds"],
                properties: {
                  jointStateId: { type: "string", pattern: IDENTIFIER },
                  parameterStateIds: identifierArray,
                },
              },
            },
            applicationRule: nonEmptyString,
            sharedAcrossModelStructureIds: identifierArray,
          },
        },
      },
      factors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "label",
            "role",
            "observationalStatus",
            "applicabilityBoundary",
            "evidenceRoleIds",
            "levels",
          ],
          properties: {
            id: { type: "string", pattern: IDENTIFIER },
            label: nonEmptyString,
            role: { type: "string", enum: ["exposure", "blocking", "scenario"] },
            observationalStatus: {
              type: "string",
              enum: ["observed", "modeled-only", "externally-defined"],
            },
            applicabilityBoundary: nonEmptyString,
            evidenceRoleIds: identifierArray,
            levels: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "label", "definition", "attributes"],
                properties: {
                  id: { type: "string", pattern: IDENTIFIER },
                  label: nonEmptyString,
                  definition: nonEmptyString,
                  attributes: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["id", "label", "value", "unit"],
                      properties: {
                        id: { type: "string", pattern: IDENTIFIER },
                        label: nonEmptyString,
                        value: nonEmptyString,
                        unit: nonEmptyString,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      baselinePlan: {
        type: "object",
        additionalProperties: false,
        required: [
          "sameInputInformation",
          "comparableCalibrationBudget",
          "sameEndpoint",
          "frozenBeforeAnalysis",
          "decisionLossMetrics",
        ],
        properties: {
          sameInputInformation: { type: "boolean" },
          comparableCalibrationBudget: { type: "boolean" },
          sameEndpoint: { type: "boolean" },
          frozenBeforeAnalysis: { type: "boolean" },
          decisionLossMetrics: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "id",
                "label",
                "comparisonIds",
                "quantityIds",
                "decisionRule",
                "reportingLevel",
              ],
              properties: {
                id: { type: "string", pattern: IDENTIFIER },
                label: nonEmptyString,
                comparisonIds: identifierArray,
                quantityIds: identifierArray,
                decisionRule: nonEmptyString,
                reportingLevel: nonEmptyString,
              },
            },
          },
        },
      },
      contextPlan: {
        type: "object",
        additionalProperties: false,
        required: [
          "maxEstimatedTokens",
          "estimatedTokens",
          "claimCriticalCapsuleIds",
          "backgroundIndexOnly",
          "centralEvidenceFits",
        ],
        properties: {
          maxEstimatedTokens: { type: "integer", minimum: 1 },
          estimatedTokens: { type: "integer", minimum: 0 },
          claimCriticalCapsuleIds: identifierArray,
          backgroundIndexOnly: { type: "boolean" },
          centralEvidenceFits: { type: "boolean" },
        },
      },
    },
  };
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
let designValidator: ValidateFunction | null = null;

export function parseScientificDesign(value: unknown): ScientificDesignContract {
  const validate = designValidator ?? (designValidator = ajv.compile(scientificDesignSchema()));
  if (!validate(value)) {
    throw new CliError("Scientific design does not match the authoritative schema.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_INVALID",
      exitCode: 2,
      details: sanitizeResearchValue({ validation: formatValidationErrors(validate.errors) }),
    });
  }
  const design = value as ScientificDesignContract;
  assertUniqueIds(design);
  assertReferences(design);
  return design;
}

export async function readAndVerifyScientificDesign(
  path: string,
  expectedProjectId?: string,
): Promise<VerifiedScientificDesign> {
  if (!isAbsolute(path)) {
    throw scientificDesignPathError("Scientific design path must be absolute.");
  }
  const info = await lstat(path).catch(() => undefined);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw scientificDesignPathError(
      "Scientific design path must be an existing regular file and cannot be a symbolic link.",
    );
  }
  if (info.size > MAX_SCIENTIFIC_DESIGN_BYTES) {
    throw scientificDesignPathError(
      `Scientific design exceeds the ${MAX_SCIENTIFIC_DESIGN_BYTES}-byte limit.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new CliError("Scientific design is not valid JSON.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_INVALID",
      exitCode: 2,
    });
  }
  const contract = parseScientificDesign(raw);
  if (expectedProjectId && contract.projectId !== expectedProjectId) {
    throw new CliError("Scientific design projectId does not match the target project.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_PROJECT_MISMATCH",
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

export function evaluateScientificDesign(
  design: ScientificDesignContract,
): ScientificDesignEvaluation {
  const issues = new Map<string, ScientificDesignIssue>();
  const add = (code: string, message: string, objectIds: string[] = []) => {
    if (!issues.has(code)) {
      issues.set(code, { code, severity: "blocking", message, objectIds });
    }
  };
  const endpointById = new Map(design.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const quantityById = new Map(design.quantities.map((quantity) => [quantity.id, quantity]));
  const edgeById = new Map(design.edges.map((edge) => [edge.id, edge]));
  const uncertaintyParameterById = new Map(
    design.uncertaintyParameters.map((parameter) => [parameter.id, parameter]),
  );
  const evidenceRoleById = new Map(design.evidenceRoles.map((role) => [role.id, role]));
  const factorById = new Map(design.factors.map((factor) => [factor.id, factor]));
  const centralClaimIds = new Set(
    design.claims.filter((claim) => claim.role === "central").map((claim) => claim.id),
  );
  const centralComparisonIds = new Set(
    design.claims
      .filter((claim) => claim.role === "central")
      .flatMap((claim) => claim.comparisonIds),
  );
  const modelStructureById = new Map(
    design.identity.modelStructures.map((model) => [model.id, model]),
  );
  if (
    design.identity.centralStudyKind === "cross-model-comparison" &&
    modelStructureById.size < 2
  ) {
    add(
      "CROSS_MODEL_STRUCTURES_INSUFFICIENT",
      "A central cross-model study must freeze at least two explicitly identified model structures.",
      [...modelStructureById.keys()],
    );
  }
  const incompletelyBoundModels = design.identity.modelStructures.filter(
    (model) =>
      !model.equationSet.trim() ||
      !model.coefficientSet.trim() ||
      !isReviewableDigest(model.implementationArtifactSha256) ||
      !model.implementationArtifactLocator.trim() ||
      !model.implementationEntrypoint.trim() ||
      !isReviewableDigest(model.environmentLockSha256) ||
      !model.environmentLockLocator.trim() ||
      model.artifactHashBasis !== "raw-file-bytes" ||
      !model.baselineSelectionJustification.trim(),
  );
  const hasReviewableReference = design.identity.modelStructures.some((model) =>
    ["reference", "strongest-available"].includes(model.baselineRole),
  );
  if (
    incompletelyBoundModels.length ||
    (design.identity.centralStudyKind === "cross-model-comparison" && !hasReviewableReference)
  ) {
    add(
      "MODEL_IMPLEMENTATION_BINDING_MISSING",
      "Every model must freeze its equations, coefficients, implementation artifact, environment lock, and baseline-selection rationale; a cross-model design must identify a reviewable reference or strongest available baseline.",
      incompletelyBoundModels.length
        ? incompletelyBoundModels.map((model) => model.id)
        : [...modelStructureById.keys()],
    );
  }
  const modelsWithoutRetrievableObjects = design.identity.modelStructures.filter(
    (model) =>
      !model.implementationArtifactLocator.trim() ||
      !model.environmentLockLocator.trim() ||
      model.artifactHashBasis !== "raw-file-bytes",
  );
  if (modelsWithoutRetrievableObjects.length) {
    add(
      "MODEL_ARTIFACT_OBJECT_UNBOUND",
      "Every frozen model implementation and environment lock must bind a safe retrievable object locator whose digest is explicitly defined over raw file bytes.",
      modelsWithoutRetrievableObjects.map((model) => model.id),
    );
  }
  const invalidModelFreezePlans = design.identity.modelStructures.filter(
    (model) =>
      (model.implementationStatus === "executable-frozen" &&
        model.implementationFreezeBeforeGate !== "research-design") ||
      (model.implementationStatus === "pending-source-acquisition" &&
        model.implementationFreezeBeforeGate === "research-design") ||
      (model.environmentLockStatus === "exact-frozen" &&
        model.environmentLockFreezeBeforeGate !== "research-design") ||
      (model.environmentLockStatus === "pending-runtime-lock" &&
        model.environmentLockFreezeBeforeGate === "research-design"),
  );
  if (invalidModelFreezePlans.length) {
    add(
      "MODEL_FREEZE_PLAN_INVALID",
      "Frozen model implementations and environment locks must be frozen at research design; pending model objects must declare a later early-review gate before which a new authoritative generation will freeze them.",
      invalidModelFreezePlans.map((model) => model.id),
    );
  }
  const modelFreezePolicyBindingsMissing = design.identity.modelStructures.filter((model) => {
    const pendingGates = [
      ...(model.implementationStatus === "pending-source-acquisition"
        ? [model.implementationFreezeBeforeGate]
        : []),
      ...(model.environmentLockStatus === "pending-runtime-lock"
        ? [model.environmentLockFreezeBeforeGate]
        : []),
    ];
    return pendingGates.some(
      (dueGate) =>
        !design.policyRuleDispositions.some(
          (disposition) =>
            disposition.status === "planned" &&
            disposition.dueGate === dueGate &&
            disposition.modelStructureIds.includes(model.id),
        ),
    );
  });
  if (modelFreezePolicyBindingsMissing.length) {
    add(
      "MODEL_FREEZE_POLICY_BINDING_MISSING",
      "Every pending model implementation or environment lock must bind to a planned Research Policy disposition due at the same early-review gate.",
      modelFreezePolicyBindingsMissing.map((model) => model.id),
    );
  }
  const disconnectedComponents = design.identity.components.filter(
    (component) =>
      component.bridgeEdgeIds.length > 1 &&
      !bridgeEdgesConnected(component.bridgeEdgeIds, edgeById),
  );
  if (disconnectedComponents.length) {
    add(
      "COMPONENT_BRIDGE_GRAPH_DISCONNECTED",
      "Every multi-edge study component must declare one endpoint-connected executable bridge graph from its inputs to its claimed consequences.",
      disconnectedComponents.flatMap((component) => component.bridgeEdgeIds),
    );
  }
  const unidentifiedModelEndpoints = design.endpoints.filter(
    (endpoint) => endpoint.truthRole === "engineering-model" && !endpoint.modelStructureId,
  );
  if (unidentifiedModelEndpoints.length) {
    add(
      "MODEL_ENDPOINT_IDENTITY_MISSING",
      "Every engineering-model endpoint must bind one frozen model structure.",
      unidentifiedModelEndpoints.map((endpoint) => endpoint.id),
    );
  }
  const observationalTruthRoles = new Set(["field-observation", "experimental-reference"]);
  const truthOperations = new Set(["error", "accuracy", "validation"]);
  const crossModelOperations = new Set(["agreement", "discrepancy", "ranking"]);
  for (const comparison of design.comparisons) {
    const left = endpointById.get(comparison.leftEndpointId)!;
    const right = endpointById.get(comparison.rightEndpointId)!;
    if (
      comparison.axis === "same-endpoint-cross-model" &&
      (!left.modelStructureId ||
        !right.modelStructureId ||
        left.modelStructureId === right.modelStructureId ||
        !endpointSignaturesMatch(left, right))
    ) {
      add(
        "CROSS_MODEL_COMPARISON_INVALID",
        "A same-endpoint cross-model comparison requires compatible endpoint signatures bound to two different frozen model structures.",
        [comparison.id, left.id, right.id],
      );
    } else if (
      crossModelOperations.has(comparison.operation) &&
      !endpointSignaturesMatch(left, right)
    ) {
      add(
        "CROSS_MODEL_COMPARISON_INVALID",
        "Cross-model agreement, discrepancy, and ranking require the same physical construct, scale, unit, and time basis.",
        [comparison.id, left.id, right.id],
      );
    }
    if (!truthOperations.has(comparison.operation)) continue;
    const truth = comparison.truthEndpointId
      ? endpointById.get(comparison.truthEndpointId)
      : undefined;
    if (!truth || !observationalTruthRoles.has(truth.truthRole)) {
      add(
        "ENDPOINT_TRUTH_ROLE_INVALID",
        "Error, accuracy, and validation claims require an observational or experimental truth endpoint.",
        [comparison.id],
      );
    }
    if (!endpointSignaturesMatch(left, right)) {
      add(
        "ENDPOINT_COMPARISON_INCOMPATIBLE",
        "Error, accuracy, and validation operations require compatible physical endpoints, scales, units, and time bases.",
        [comparison.id, left.id, right.id],
      );
    }
  }
  const undeclaredCentralDecisionRules = design.comparisons.filter(
    (comparison) =>
      centralComparisonIds.has(comparison.id) &&
      (!comparison.decisionRule.trim() ||
        !comparison.reportingLevel.trim() ||
        (["agreement", "discrepancy"].includes(comparison.operation) &&
          comparison.thresholdIds.length === 0)),
  );
  if (undeclaredCentralDecisionRules.length) {
    add(
      "CENTRAL_DECISION_RULE_UNDECLARED",
      "Every central comparison must freeze an executable decision rule and reporting level; agreement or discrepancy decisions must also bind a declared threshold.",
      undeclaredCentralDecisionRules.map((comparison) => comparison.id),
    );
  }

  const unexecutableCentralEdges = design.edges.filter((edge) => {
    if (edge.role !== "central") return false;
    if (
      edge.fromEndpointIds.length === 0 ||
      edge.toEndpointIds.length === 0 ||
      !edge.operatorId.trim() ||
      !edge.operatorDefinition.trim()
    ) {
      return true;
    }
    const sourceModels = new Set(
      edge.fromEndpointIds
        .map((endpointId) => endpointById.get(endpointId)?.modelStructureId)
        .filter((modelId): modelId is string => Boolean(modelId)),
    );
    return edge.fromModelStructureIds.some((modelId) => !sourceModels.has(modelId));
  });
  if (unexecutableCentralEdges.length) {
    add(
      "CROSS_SCALE_OPERATOR_UNDECLARED",
      "Every central cross-scale edge must bind source and destination endpoints plus a frozen, executable accumulation or reconciliation operator.",
      unexecutableCentralEdges.map((edge) => edge.id),
    );
  }

  for (const plan of design.validationPlans) {
    const declaredDatasets = [...plan.parameterDatasetIds, ...plan.comparisonDatasetIds];
    const roleCount = new Map<string, number>();
    for (const role of plan.datasetRoles) {
      roleCount.set(role.datasetId, (roleCount.get(role.datasetId) ?? 0) + 1);
    }
    const datasetRolesInvalid =
      declaredDatasets.some((datasetId) => roleCount.get(datasetId) !== 1) ||
      plan.datasetRoles.some((role) => !declaredDatasets.includes(role.datasetId)) ||
      (plan.independentValidation.status === "unavailable-scope-bounded" &&
        plan.datasetRoles.some((role) => role.role === "independent-validation"));
    if (datasetRolesInvalid) {
      add(
        "VALIDATION_DATASET_ROLE_UNDECLARED",
        "Every parameter and comparison dataset must have exactly one declared role, shared-upstream disclosure, and justification consistent with the independent-validation disposition.",
        [plan.id, ...declaredDatasets],
      );
    }
    if (
      design.identity.centralStudyKind === "cross-model-comparison" &&
      plan.claimIds.some((claimId) => centralClaimIds.has(claimId)) &&
      plan.originalUnitCount > plan.independentClusterCount
    ) {
      const factors = plan.factorIds.map((factorId) => factorById.get(factorId));
      const levelProduct = factors.reduce(
        (product, factor) => product * (factor?.levels.length ?? 0),
        1,
      );
      const repeatedLevels =
        plan.independentClusterCount > 0
          ? plan.originalUnitCount / plan.independentClusterCount
          : Number.NaN;
      if (
        factors.length === 0 ||
        factors.some((factor) => !factor) ||
        !Number.isInteger(repeatedLevels) ||
        levelProduct !== repeatedLevels
      ) {
        add(
          "CONFIGURATION_FACTOR_UNDECLARED",
          "A repeated cross-model design must bind a structured factor inventory whose frozen level product exactly explains the modeled configurations within each independent cluster.",
          [plan.id, ...plan.factorIds],
        );
      }
    }
    if (
      plan.claimIds.some((claimId) => centralClaimIds.has(claimId)) &&
      plan.originalUnitCount > plan.independentClusterCount &&
      (!plan.originalUnitDefinition.trim() ||
        !plan.independentClusterDefinition.trim() ||
        !plan.nestingRule.trim() ||
        !plan.reportingUnitDefinition.trim())
    ) {
      add(
        "CONFIGURATION_INVENTORY_UNDECLARED",
        "A repeated-measures central design must define original units, independent clusters, their nesting rule, and the level at which results are reported.",
        [plan.id],
      );
    }
    if (plan.independentClusterCount > 0 && plan.clusterKeyIds.length === 0) {
      add(
        "INDEPENDENT_CLUSTER_KEY_MISSING",
        "Every nonzero independent-cluster count must declare the stable keys used to deduplicate repeated records.",
        [plan.id],
      );
    }
    if (
      ["external-dgp", "internal-holdout", "temporal-holdout", "section-holdout"].includes(
        plan.role,
      ) &&
      !plan.exposureIdentifierAvailable
    ) {
      add(
        "TARGET_EXPOSURE_UNIDENTIFIABLE",
        "A validation plan cannot test the target exposure because the validation data do not identify it.",
        [plan.id],
      );
    }
    if (plan.role === "external-dgp" && !plan.independentDataGeneratingProcess) {
      add(
        "VALIDATION_DGP_NOT_INDEPENDENT",
        "An external validation plan shares a data-generating process or upstream information with calibration.",
        [plan.id],
      );
    }
    if (
      plan.effectiveIndependentUnits > plan.independentClusterCount ||
      plan.independentClusterCount > plan.originalUnitCount
    ) {
      add(
        "EFFECTIVE_SAMPLE_SIZE_INFLATED",
        "Effective independent units cannot exceed independent clusters or original units.",
        [plan.id],
      );
    }
    if (
      plan.resamplingIterations > 0 &&
      plan.originalUnitCount > plan.independentClusterCount &&
      (plan.effectiveIndependentUnits > plan.independentClusterCount ||
        /^(cell|row|observation)$/i.test(plan.resamplingUnit))
    ) {
      add(
        "RESAMPLING_UNIT_INVALID",
        "Resampling must operate at the independent data-generating cluster, not a repeated cell or row.",
        [plan.id],
      );
    }
    const resamplingStateCount = bootstrapMultisetCount(plan.effectiveIndependentUnits);
    if (
      plan.resamplingIterations > 0 &&
      resamplingStateCount !== null &&
      plan.resamplingIterations > resamplingStateCount
    ) {
      add(
        "RESAMPLING_PRECISION_UNJUSTIFIED",
        "Requested resampling iterations exceed the distinct cluster-level bootstrap multisets available from the effective independent units.",
        [plan.id],
      );
    }
    if (
      plan.resamplingMethod === "exact-enumeration" &&
      (resamplingStateCount === null ||
        plan.resamplingStateSpaceSize !== resamplingStateCount ||
        plan.resamplingIterations !== resamplingStateCount)
    ) {
      add(
        "RESAMPLING_STATE_SPACE_INVALID",
        "Exact cluster-level resampling must report and enumerate the complete distinct multiset state space.",
        [plan.id],
      );
    }
    if (
      plan.independentValidation.status === "unavailable-scope-bounded" &&
      !plan.independentValidation.gapId
    ) {
      add(
        "INDEPENDENT_VALIDATION_DISPOSITION_MISSING",
        "Unavailable independent validation must bind an explicit scope-limiting known gap.",
        [plan.id],
      );
    }
  }

  const unboundCentralClaims = design.claims.filter(
    (claim) =>
      claim.role === "central" &&
      ["model-output", "scenario-output", "accounting-output"].includes(claim.resultClass) &&
      claim.quantityIds.length === 0,
  );
  if (unboundCentralClaims.length) {
    add(
      "CENTRAL_CLAIM_QUANTITY_UNBOUND",
      "Every central model, scenario, or accounting claim must bind at least one declared quantity.",
      unboundCentralClaims.map((claim) => claim.id),
    );
  }
  const missingQuantityBridges = design.claims.flatMap((claim) => {
    const boundEdgeQuantityIds = new Set(
      claim.edgeIds.flatMap((edgeId) => edgeById.get(edgeId)?.quantityIds ?? []),
    );
    return claim.quantityIds
      .filter((quantityId) => !boundEdgeQuantityIds.has(quantityId))
      .map((quantityId) => `${claim.id}:${quantityId}`);
  });
  if (missingQuantityBridges.length) {
    add(
      "CLAIM_QUANTITY_BRIDGE_MISSING",
      "Every quantity bound to a claim must be carried by at least one executable edge used by that claim.",
      missingQuantityBridges,
    );
  }
  const centralUncertaintyFailures = design.claims
    .filter((claim) => claim.role === "central" && claim.resultClass === "model-output")
    .flatMap((claim) =>
      claim.quantityIds.flatMap((quantityId) => {
        const quantity = quantityById.get(quantityId);
        if (!quantity) return [];
        const quantityEdges = claim.edgeIds
          .map((edgeId) => edgeById.get(edgeId))
          .filter((edge): edge is ScientificDesignContract["edges"][number] =>
            Boolean(edge?.quantityIds.includes(quantityId)),
          );
        const propagated = new Set(quantityEdges.flatMap((edge) => edge.uncertaintyParameterIds));
        return quantity.uncertaintyParameterIds.length === 0 ||
          quantityEdges.length === 0 ||
          quantity.uncertaintyParameterIds.some((parameterId) => !propagated.has(parameterId))
          ? [`${claim.id}:${quantity.id}`, ...quantityEdges.map((edge) => edge.id)]
          : [];
      }),
    );
  if (centralUncertaintyFailures.length) {
    add(
      "CENTRAL_UNCERTAINTY_PLAN_MISSING",
      "Every central model quantity must bind shared-input uncertainty and propagate it through a claim edge before comparison.",
      [...new Set(centralUncertaintyFailures)],
    );
  }
  const unjustifiedCentralNormalizations = design.claims
    .filter((claim) => claim.role === "central" && claim.resultClass === "model-output")
    .flatMap((claim) => claim.quantityIds)
    .map((quantityId) => quantityById.get(quantityId))
    .filter(
      (quantity): quantity is ScientificDesignContract["quantities"][number] =>
        quantity?.normalizationMode === "directional-convention" &&
        !quantity.normalizationJustification.trim(),
    );
  if (unjustifiedCentralNormalizations.length) {
    add(
      "CENTRAL_NORMALIZATION_UNJUSTIFIED",
      "A directional cross-model normalization must explain why one model is the denominator and how directionality affects interpretation.",
      unjustifiedCentralNormalizations.map((quantity) => quantity.id),
    );
  }
  const unboundCentralEstimands = design.claims.filter(
    (claim) => claim.role === "central" && claim.estimandIds.length === 0,
  );
  if (unboundCentralEstimands.length) {
    add(
      "CENTRAL_CLAIM_ESTIMAND_UNBOUND",
      "Every central claim must bind an explicit central estimand.",
      unboundCentralEstimands.map((claim) => claim.id),
    );
  }
  const crossModelClaims = design.claims.filter(
    (claim) => claim.role === "central" && claim.resultClass === "model-output",
  );
  const outcomePresuppositions = crossModelClaims.filter(
    (claim) =>
      claim.comparisonIds.length === 0 ||
      claim.hypothesisMode !== "two-sided" ||
      !claim.nullOutcomeStatement?.trim(),
  );
  if (
    design.identity.centralStudyKind === "cross-model-comparison" &&
    outcomePresuppositions.length
  ) {
    add(
      "CLAIM_NULL_OUTCOME_UNPLANNED",
      "Central cross-model claims must bind explicit comparisons and a two-sided null or agreement outcome before results are inspected.",
      outcomePresuppositions.map((claim) => claim.id),
    );
  }
  const centralEstimands = design.estimands.filter((estimand) => estimand.role === "central");
  if (centralEstimands.length !== 1) {
    add(
      "CENTRAL_ESTIMAND_IDENTITY_INVALID",
      "A scientific design must declare exactly one central estimand; supporting scenario and accounting estimands remain separate.",
      centralEstimands.map((estimand) => estimand.id),
    );
  }

  const claimText = [design.workingTitle, ...design.claims.map((claim) => claim.statement)].join(
    "\n",
  );
  for (const quantity of design.quantities) {
    const denominator = normalizeIdentifierTerm(quantity.denominatorType);
    if (
      denominator === normalizeIdentifierTerm(quantity.id) ||
      denominator === normalizeIdentifierTerm(quantity.label)
    ) {
      add(
        "QUANTITY_DENOMINATOR_SELF_REFERENCE",
        "A quantity denominator must identify the population or exposure base and cannot restate the quantity itself.",
        [quantity.id],
      );
    }
    if (quantity.quantityType === "material" && quantity.uncertaintyParameterIds.length === 0) {
      add(
        "MATERIAL_UNCERTAINTY_UNPROPAGATED",
        "Material quantities must bind the declared uncertainty parameters propagated through their accounting bridge.",
        [quantity.id],
      );
    }
    if (quantity.quantityType === "material" && quantity.uncertaintyParameterIds.length > 0) {
      const claimEdgeIds = new Set(
        design.claims
          .filter((claim) => claim.quantityIds.includes(quantity.id))
          .flatMap((claim) => claim.edgeIds),
      );
      const accountingEdges = design.edges.filter(
        (edge) => claimEdgeIds.has(edge.id) && edge.evidenceMode === "accounting-bridge",
      );
      const propagatedParameters = new Set(
        accountingEdges.flatMap((edge) => edge.uncertaintyParameterIds),
      );
      if (
        accountingEdges.length === 0 ||
        quantity.uncertaintyParameterIds.some(
          (parameterId) => !propagatedParameters.has(parameterId),
        )
      ) {
        add(
          "ACCOUNTING_UNCERTAINTY_BRIDGE_INCOMPLETE",
          "Every material-quantity uncertainty parameter must propagate through an accounting bridge used by the bound claim.",
          [quantity.id, ...accountingEdges.map((edge) => edge.id)],
        );
      }
    }
    const prohibited = quantity.prohibitedTerms.filter((term) => includesTerm(claimText, term));
    if (prohibited.length) {
      add(
        "QUANTITY_TERM_OVERCLAIM",
        "The working title or a claim uses a term explicitly prohibited by the declared quantity and denominator.",
        [quantity.id],
      );
    }
  }

  const thresholdLabels = {
    analytic: "analytic-threshold",
    scenario: "scenario-threshold",
    estimated: "estimated-threshold",
    "policy-trigger": "policy-trigger",
  } as const;
  for (const threshold of design.thresholds) {
    const boundQuantity = quantityById.get(threshold.quantityId);
    if (threshold.reportedAs !== thresholdLabels[threshold.type]) {
      add(
        "THRESHOLD_TYPE_MISMATCH",
        "A threshold must be reported using the same analytic, scenario, estimated, or policy type declared by its design.",
        [threshold.id],
      );
    }
    if (
      ["analytic", "scenario"].includes(threshold.type) &&
      threshold.sensitivityParameterIds.length === 0
    ) {
      add(
        "THRESHOLD_SENSITIVITY_MISSING",
        "Analytic and scenario thresholds require predeclared sensitivity parameters.",
        [threshold.id],
      );
    }
    if (!boundQuantity || normalizeTerm(threshold.unit) !== normalizeTerm(boundQuantity.unit)) {
      add(
        "THRESHOLD_QUANTITY_UNIT_MISMATCH",
        "A threshold numeric value and unit must bind the quantity it actually classifies; a scenario input fraction cannot carry an event-count threshold.",
        [threshold.id, threshold.quantityId],
      );
    }
    if (
      threshold.sensitivityParameterIds.length > 0 &&
      (!threshold.basisJustification.trim() ||
        !threshold.stabilityRule.trim() ||
        !threshold.sensitivityReportingRule.trim() ||
        threshold.criterionQuantityIds.length === 0 ||
        threshold.stabilityMode === "none")
    ) {
      add(
        "THRESHOLD_SENSITIVITY_RULE_UNDECLARED",
        "A sensitivity-dependent threshold must freeze its basis, criterion quantities, stability test, and the rule used to report all sensitivity states.",
        [threshold.id],
      );
    }
    if (threshold.stabilityMode === "sign") {
      const stabilityQuantity = threshold.stabilityQuantityId
        ? quantityById.get(threshold.stabilityQuantityId)
        : undefined;
      if (!stabilityQuantity || stabilityQuantity.valueMode !== "signed") {
        add(
          "SIGNED_STABILITY_QUANTITY_MISSING",
          "A sign-stability decision must bind a signed quantity; an absolute discrepancy cannot determine direction.",
          [threshold.id, ...(threshold.stabilityQuantityId ? [threshold.stabilityQuantityId] : [])],
        );
      }
    }
  }

  const incompleteFactorCompositions = design.uncertaintyParameters.filter(
    (parameter) =>
      parameter.factorIds.length > 0 &&
      (!parameter.applicationPoint.trim() ||
        !parameter.compositionRule.trim() ||
        !parameter.preservesFactorLevelIdentity),
  );
  if (incompleteFactorCompositions.length) {
    add(
      "FACTOR_UNCERTAINTY_COMPOSITION_UNDECLARED",
      "An uncertainty parameter that acts on a frozen factor must declare where and how it composes with factor levels and must preserve each level's identity.",
      incompleteFactorCompositions.map((parameter) => parameter.id),
    );
  }
  const invalidStateFreezePlans = design.uncertaintyParameters.filter(
    (parameter) =>
      (parameter.stateValueStatus === "frozen" &&
        parameter.freezeBeforeGate !== "research-design") ||
      (parameter.stateValueStatus === "pending-source-acquisition" &&
        parameter.freezeBeforeGate === "research-design"),
  );
  if (invalidStateFreezePlans.length) {
    add(
      "UNCERTAINTY_STATE_FREEZE_PLAN_INVALID",
      "Frozen uncertainty states must be frozen at research design; pending source-derived states must name a later early-review gate before which their exact values will be frozen in a new generation.",
      invalidStateFreezePlans.map((parameter) => parameter.id),
    );
  }
  const nonNumericFrozenStates = design.uncertaintyParameters.filter(
    (parameter) =>
      parameter.stateValueStatus === "frozen" &&
      parameter.stateValueType === "numeric" &&
      parameter.states.some((state) => !Number.isFinite(Number(state.value))),
  );
  if (nonNumericFrozenStates.length) {
    add(
      "UNCERTAINTY_STATE_VALUES_NOT_FROZEN",
      "A frozen numeric uncertainty state must contain finite numeric values; source placeholders require a declared pending-source freeze plan and a new generation before the due gate.",
      nonNumericFrozenStates.map((parameter) => parameter.id),
    );
  }
  const pendingFreezePolicyBindingsMissing = design.uncertaintyParameters.filter(
    (parameter) =>
      parameter.stateValueStatus === "pending-source-acquisition" &&
      !design.policyRuleDispositions.some(
        (disposition) =>
          disposition.status === "planned" &&
          disposition.dueGate === parameter.freezeBeforeGate &&
          disposition.uncertaintyParameterIds.includes(parameter.id),
      ),
  );
  if (pendingFreezePolicyBindingsMissing.length) {
    add(
      "UNCERTAINTY_FREEZE_POLICY_BINDING_MISSING",
      "Every pending source-derived uncertainty state must bind to a planned Research Policy disposition due at the same early-review gate, so the future freeze is independently visible and mechanically enforceable.",
      pendingFreezePolicyBindingsMissing.map((parameter) => parameter.id),
    );
  }

  const stateSpaceFailures: string[] = [];
  const jointStateBindingFailures: string[] = [];
  const coveredParameters = new Set<string>();
  for (const group of design.uncertaintyGroups) {
    const parameters = group.parameterIds.map((parameterId) =>
      uncertaintyParameterById.get(parameterId),
    );
    parameters.forEach((parameter) => {
      if (parameter) coveredParameters.add(parameter.id);
    });
    const stateCounts = parameters.map((parameter) => parameter?.states.length ?? 0);
    const expectedJointStates =
      group.combinationMode === "one-at-a-time"
        ? 1 + stateCounts.reduce((sum, count) => sum + Math.max(0, count - 1), 0)
        : group.combinationMode === "full-factorial"
          ? stateCounts.reduce((product, count) => product * count, 1)
          : group.jointStateIds.length;
    if (
      parameters.length === 0 ||
      parameters.some((parameter) => !parameter || parameter.states.length === 0) ||
      !group.applicationRule.trim() ||
      group.jointStateIds.length === 0 ||
      group.jointStateIds.length !== expectedJointStates
    ) {
      stateSpaceFailures.push(group.id);
    }
    const jointStateIds = new Set(group.jointStateIds);
    const bindingIds = group.jointStateBindings.map((binding) => binding.jointStateId);
    const bindingIdSet = new Set(bindingIds);
    const bindingsTraceable = group.jointStateBindings.every((binding) => {
      if (binding.parameterStateIds.length !== group.parameterIds.length) return false;
      const stateOwners = binding.parameterStateIds.map((stateId) =>
        parameters.filter((parameter) => parameter?.states.some((state) => state.id === stateId)),
      );
      return (
        stateOwners.every((owners) => owners.length === 1) &&
        parameters.every(
          (parameter) =>
            parameter &&
            binding.parameterStateIds.filter((stateId) =>
              parameter.states.some((state) => state.id === stateId),
            ).length === 1,
        )
      );
    });
    if (
      bindingIds.length !== group.jointStateIds.length ||
      bindingIdSet.size !== bindingIds.length ||
      jointStateIds.size !== group.jointStateIds.length ||
      [...jointStateIds].some((stateId) => !bindingIdSet.has(stateId)) ||
      !bindingsTraceable
    ) {
      jointStateBindingFailures.push(group.id);
    }
  }
  const usedUncertaintyParameters = new Set(
    design.quantities.flatMap((quantity) => quantity.uncertaintyParameterIds),
  );
  for (const parameterId of usedUncertaintyParameters) {
    const parameter = uncertaintyParameterById.get(parameterId);
    if (!parameter || parameter.states.length === 0 || !coveredParameters.has(parameterId)) {
      stateSpaceFailures.push(parameterId);
    }
  }
  const centralModelIds = new Set(
    design.edges
      .filter((edge) => edge.role === "central")
      .flatMap((edge) => edge.fromModelStructureIds),
  );
  if (
    design.identity.centralStudyKind === "cross-model-comparison" &&
    centralModelIds.size > 1 &&
    !design.uncertaintyGroups.some((group) =>
      [...centralModelIds].every((modelId) =>
        group.sharedAcrossModelStructureIds.includes(modelId),
      ),
    )
  ) {
    stateSpaceFailures.push(...centralModelIds);
  }
  if (stateSpaceFailures.length) {
    add(
      "UNCERTAINTY_STATE_SPACE_UNDECLARED",
      "Every used uncertainty parameter must declare finite states and belong to a group with an exact combination rule, joint-state inventory, and shared-model application where required.",
      [...new Set(stateSpaceFailures)],
    );
  }
  if (jointStateBindingFailures.length) {
    add(
      "UNCERTAINTY_JOINT_STATE_BINDING_INVALID",
      "Every joint sensitivity state must map exactly one declared parameter state from every parameter in its group, and the binding IDs must exactly match the reviewed joint-state inventory.",
      [...new Set(jointStateBindingFailures)],
    );
  }

  const closestWorkRoles = design.evidenceRoles.filter(
    (role) => role.required && role.role === "closest-prior-work",
  );
  if (
    closestWorkRoles.length === 0 ||
    closestWorkRoles.some((role) => role.minimumFullText < 1 || role.minimumIndependentSources < 1)
  ) {
    add(
      "CLOSEST_WORK_FULLTEXT_UNPLANNED",
      "A top-journal design must require full-text comparison with independent closest prior work.",
      closestWorkRoles.map((role) => role.id),
    );
  }
  const incompleteEvidenceRoles = design.evidenceRoles.filter(
    (role) =>
      role.required &&
      (role.coverageDimensionIds.length === 0 || role.sourceTypeRequirements.length === 0),
  );
  if (incompleteEvidenceRoles.length) {
    add(
      "EVIDENCE_ROLE_COVERAGE_UNMAPPED",
      "Every required evidence role must map explicit research dimensions and source types.",
      incompleteEvidenceRoles.map((role) => role.id),
    );
  }
  const inconsistentEvidenceBindings = design.claims.flatMap((claim) => {
    const requiredRoleIds = new Set(
      claim.quantityIds.flatMap(
        (quantityId) =>
          quantityById
            .get(quantityId)
            ?.uncertaintyParameterIds.flatMap(
              (parameterId) =>
                uncertaintyParameterById.get(parameterId)?.sourceEvidenceRoleIds ?? [],
            ) ?? [],
      ),
    );
    return [...requiredRoleIds]
      .filter((roleId) => {
        const role = evidenceRoleById.get(roleId);
        return !claim.evidenceRoleIds.includes(roleId) || !role?.claimIds.includes(claim.id);
      })
      .map((roleId) => `${claim.id}:${roleId}`);
  });
  if (inconsistentEvidenceBindings.length) {
    add(
      "EVIDENCE_ROLE_CLAIM_BINDING_INCONSISTENT",
      "Every evidence role supplying uncertainty for a claim quantity must be bound in both directions: from the claim to the role and from the role to the claim.",
      inconsistentEvidenceBindings,
    );
  }

  const unresolvedGaps = design.knownGaps.filter((gap) => gap.disposition === "unresolved");
  if (unresolvedGaps.length) {
    add(
      "KNOWN_BLOCKING_GAP_UNRESOLVED",
      "Inherited central gaps must be closed, scope-narrowed, or placed in an explicit handoff before research starts.",
      unresolvedGaps.map((gap) => gap.id),
    );
  }
  const unverifiableInheritedGaps = design.knownGaps.filter(
    (gap) =>
      gap.sourceProjectId &&
      gap.disposition !== "unresolved" &&
      (gap.lineageStatus === "unverified" ||
        gap.sourceArtifacts.length === 0 ||
        gap.sourceArtifacts.some(
          (artifact) =>
            (!artifact.objectLocator.startsWith(`projects/${gap.sourceProjectId}/`) &&
              !artifact.objectLocator.startsWith("lineage/objects/")) ||
            (gap.lineageStatus === "verified" && artifact.kind === "owner-attestation"),
        ) ||
        (gap.lineageStatus === "owner-attested" &&
          !gap.sourceArtifacts.some((artifact) => artifact.kind === "owner-attestation"))),
  );
  if (unverifiableInheritedGaps.length) {
    add(
      "GAP_LINEAGE_UNVERIFIABLE",
      "A disposed inherited gap must retain a verified or owner-attested content-hash lineage.",
      unverifiableInheritedGaps.map((gap) => gap.id),
    );
  }
  const placeholderGapDigests = design.knownGaps.filter((gap) =>
    gap.sourceArtifacts.some((artifact) => /^([a-f0-9])\1{63}$/iu.test(artifact.sha256)),
  );
  if (placeholderGapDigests.length) {
    add(
      "GAP_LINEAGE_PLACEHOLDER_DIGEST",
      "Inherited-gap lineage must use a real content digest; repeated-character placeholder hashes are not reviewable provenance.",
      placeholderGapDigests.map((gap) => gap.id),
    );
  }

  const baseline = design.baselinePlan;
  if (
    !baseline.sameInputInformation ||
    !baseline.comparableCalibrationBudget ||
    !baseline.sameEndpoint ||
    !baseline.frozenBeforeAnalysis ||
    baseline.decisionLossMetrics.length === 0
  ) {
    add(
      "BASELINE_FAIRNESS_UNRESOLVED",
      "The comparison baseline must use fair information, calibration, endpoint, freeze, and decision-loss rules.",
    );
  }
  const unboundDecisionLossMetrics = baseline.decisionLossMetrics.filter(
    (metric) =>
      metric.comparisonIds.length === 0 ||
      metric.quantityIds.length === 0 ||
      !metric.decisionRule.trim() ||
      !metric.reportingLevel.trim(),
  );
  if (
    design.identity.centralStudyKind === "cross-model-comparison" &&
    (baseline.decisionLossMetrics.length === 0 || unboundDecisionLossMetrics.length > 0)
  ) {
    add(
      "DECISION_LOSS_METRIC_UNBOUND",
      "A cross-model design must freeze executable decision-loss metrics bound to concrete comparisons, quantities, rules, and reporting levels.",
      unboundDecisionLossMetrics.map((metric) => metric.id),
    );
  }
  if (
    design.contextPlan.estimatedTokens > design.contextPlan.maxEstimatedTokens ||
    !design.contextPlan.centralEvidenceFits
  ) {
    add(
      "CONTEXT_PLAN_OVER_LIMIT",
      "The planned claim-critical context does not fit its reviewed token boundary.",
    );
  }
  if (design.contextPlan.claimCriticalCapsuleIds.length === 0) {
    add(
      "CLAIM_CRITICAL_CONTEXT_MISSING",
      "At least one claim-critical evidence capsule must be planned before high-cost stages.",
    );
  }
  const coverageDimensionIds = new Set(
    design.evidenceRoles.flatMap((role) => role.coverageDimensionIds),
  );
  const unmappedCapsules = design.contextPlan.claimCriticalCapsuleIds.filter(
    (capsuleId) => !coverageDimensionIds.has(capsuleId),
  );
  if (unmappedCapsules.length) {
    add(
      "CLAIM_CRITICAL_CAPSULE_UNMAPPED",
      "Every claim-critical context capsule must map to a reviewed evidence-role coverage dimension.",
      unmappedCapsules,
    );
  }

  const blockingEdges = design.edges.filter(
    (edge) => edge.role === "central" && edge.status === "blocked",
  );
  if (blockingEdges.length) {
    add(
      "CENTRAL_CLAIM_EDGE_BLOCKED",
      "A central claim edge is explicitly blocked and must be closed or removed through approved scope narrowing.",
      blockingEdges.map((edge) => edge.id),
    );
  }

  const issueList = [...issues.values()];
  const centralValidationPlans = design.validationPlans.filter((plan) =>
    plan.claimIds.some(
      (claimId) => design.claims.find((claim) => claim.id === claimId)?.role === "central",
    ),
  );
  return {
    schemaVersion: 1,
    projectId: design.projectId,
    centralStudyKind: design.identity.centralStudyKind,
    readyForDesignReview: issueList.every((issue) => issue.severity !== "blocking"),
    issues: issueList,
    issueCodes: issueList.map((issue) => issue.code),
    effectiveIndependentUnits: centralValidationPlans.reduce(
      (minimum, plan) => Math.min(minimum, plan.effectiveIndependentUnits),
      centralValidationPlans.length ? Number.POSITIVE_INFINITY : 0,
    ),
    requiredEvidenceRoles: design.evidenceRoles.filter((role) => role.required).length,
  };
}

export function scientificDesignPolicyGaps(
  design: ScientificDesignContract,
  policy: { resolvedRules: string[]; targetJournal: string | null },
): string[] {
  const gaps: string[] = [];
  const policyRules = [...new Set(policy.resolvedRules)];
  const dispositionCounts = new Map<string, number>();
  for (const disposition of design.policyRuleDispositions) {
    dispositionCounts.set(disposition.ruleId, (dispositionCounts.get(disposition.ruleId) ?? 0) + 1);
  }
  for (const ruleId of policyRules) {
    const matches = design.policyRuleDispositions.filter(
      (disposition) => disposition.ruleId === ruleId,
    );
    if (matches.length === 0) {
      gaps.push(`policy-rule-disposition-missing:${ruleId}`);
      continue;
    }
    if (matches.length > 1) {
      gaps.push(`policy-rule-disposition-duplicate:${ruleId}`);
      continue;
    }
    const disposition = matches[0]!;
    if (disposition.status === "incompatible") {
      gaps.push(`policy-rule-incompatible:${ruleId}`);
    }
    if (disposition.status === "planned" && disposition.dueGate === "research-design") {
      gaps.push(`policy-rule-due-unresolved:${ruleId}`);
    }
    if (disposition.status === "scope-limited" && policy.targetJournal) {
      gaps.push(`policy-rule-scope-conflict:${ruleId}`);
    }
    if (
      disposition.status === "satisfied-by-design" &&
      disposition.claimIds.length === 0 &&
      disposition.evidenceRoleIds.length === 0 &&
      disposition.validationPlanIds.length === 0 &&
      disposition.uncertaintyParameterIds.length === 0 &&
      disposition.modelStructureIds.length === 0
    ) {
      gaps.push(`policy-rule-binding-empty:${ruleId}`);
    }
  }
  for (const ruleId of dispositionCounts.keys()) {
    if (!policyRules.includes(ruleId)) gaps.push(`policy-rule-disposition-unbound:${ruleId}`);
  }
  if (policyRules.includes("independent-validation-required")) {
    const disposition = design.policyRuleDispositions.find(
      (candidate) => candidate.ruleId === "independent-validation-required",
    );
    const centralClaimIds = new Set(
      design.claims.filter((claim) => claim.role === "central").map((claim) => claim.id),
    );
    const centralPlans = design.validationPlans.filter((plan) =>
      plan.claimIds.some((claimId) => centralClaimIds.has(claimId)),
    );
    if (
      disposition?.status === "satisfied-by-design" &&
      centralPlans.some(
        (plan) =>
          plan.independentValidation.status !== "available" ||
          !plan.independentDataGeneratingProcess,
      )
    ) {
      gaps.push("policy-rule-status-mismatch:independent-validation-required");
    }
  }
  return gaps;
}

function bridgeEdgesConnected(
  edgeIds: string[],
  edgeById: Map<string, ScientificDesignContract["edges"][number]>,
): boolean {
  const endpointSets = edgeIds.map((edgeId) => {
    const edge = edgeById.get(edgeId);
    return new Set([...(edge?.fromEndpointIds ?? []), ...(edge?.toEndpointIds ?? [])]);
  });
  if (endpointSets.some((endpoints) => endpoints.size === 0)) return false;
  const reachedEdges = new Set<number>([0]);
  const reachedEndpoints = new Set(endpointSets[0]);
  let changed = true;
  while (changed) {
    changed = false;
    endpointSets.forEach((endpoints, index) => {
      if (reachedEdges.has(index)) return;
      if ([...endpoints].some((endpointId) => reachedEndpoints.has(endpointId))) {
        reachedEdges.add(index);
        endpoints.forEach((endpointId) => reachedEndpoints.add(endpointId));
        changed = true;
      }
    });
  }
  return reachedEdges.size === endpointSets.length;
}

function endpointSignaturesMatch(
  left: ScientificDesignContract["endpoints"][number],
  right: ScientificDesignContract["endpoints"][number],
): boolean {
  return (
    normalizeTerm(left.physicalConstruct) === normalizeTerm(right.physicalConstruct) &&
    normalizeTerm(left.scale) === normalizeTerm(right.scale) &&
    normalizeTerm(left.unit) === normalizeTerm(right.unit) &&
    normalizeTerm(left.timeBasis) === normalizeTerm(right.timeBasis)
  );
}

function includesTerm(value: string, term: string): boolean {
  return normalizeTerm(value).includes(normalizeTerm(term));
}

function normalizeTerm(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function normalizeIdentifierTerm(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/^quantity[-_:\s]+/u, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function isReviewableDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value) && !/^([a-f0-9])\1{63}$/u.test(value);
}

function bootstrapMultisetCount(effectiveIndependentUnits: number): number | null {
  if (!Number.isInteger(effectiveIndependentUnits) || effectiveIndependentUnits < 1) return null;
  if (effectiveIndependentUnits > 20) return null;
  const n = effectiveIndependentUnits;
  let result = 1;
  for (let index = 1; index <= n; index += 1) {
    result = (result * (n - 1 + index)) / index;
  }
  return Math.round(result);
}

function assertUniqueIds(design: ScientificDesignContract): void {
  const collections: Array<[string, string[]]> = [
    ["policyRuleDispositions", design.policyRuleDispositions.map((item) => item.ruleId)],
    ["modelStructures", design.identity.modelStructures.map((item) => item.id)],
    ["estimands", design.estimands.map((item) => item.id)],
    ["claims", design.claims.map((item) => item.id)],
    ["edges", design.edges.map((item) => item.id)],
    ["endpoints", design.endpoints.map((item) => item.id)],
    ["comparisons", design.comparisons.map((item) => item.id)],
    ["quantities", design.quantities.map((item) => item.id)],
    ["validationPlans", design.validationPlans.map((item) => item.id)],
    ["thresholds", design.thresholds.map((item) => item.id)],
    ["evidenceRoles", design.evidenceRoles.map((item) => item.id)],
    ["knownGaps", design.knownGaps.map((item) => item.id)],
    ["uncertaintyParameters", design.uncertaintyParameters.map((item) => item.id)],
    ["uncertaintyGroups", design.uncertaintyGroups.map((item) => item.id)],
    ["factors", design.factors.map((item) => item.id)],
    ["decisionLossMetrics", design.baselinePlan.decisionLossMetrics.map((item) => item.id)],
  ];
  const duplicateCollections = collections
    .filter(([, ids]) => new Set(ids).size !== ids.length)
    .map(([name]) => name);
  if (duplicateCollections.length) {
    throw scientificDesignSemanticError(
      duplicateCollections.map((name) => `${name} contains duplicate identifiers`),
    );
  }
}

function assertReferences(design: ScientificDesignContract): void {
  const claims = new Set(design.claims.map((item) => item.id));
  const modelStructures = new Set(design.identity.modelStructures.map((item) => item.id));
  const estimands = new Set(design.estimands.map((item) => item.id));
  const edges = new Set(design.edges.map((item) => item.id));
  const endpoints = new Set(design.endpoints.map((item) => item.id));
  const comparisons = new Set(design.comparisons.map((item) => item.id));
  const quantities = new Set(design.quantities.map((item) => item.id));
  const validationPlans = new Set(design.validationPlans.map((item) => item.id));
  const thresholds = new Set(design.thresholds.map((item) => item.id));
  const evidenceRoles = new Set(design.evidenceRoles.map((item) => item.id));
  const knownGaps = new Set(design.knownGaps.map((item) => item.id));
  const uncertaintyParameters = new Set(design.uncertaintyParameters.map((item) => item.id));
  const factors = new Set(design.factors.map((item) => item.id));
  const failures: string[] = [];
  const requireIds = (path: string, ids: string[], known: Set<string>) => {
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) failures.push(`${path} references unknown ids: ${missing.join(", ")}`);
  };
  for (const disposition of design.policyRuleDispositions) {
    requireIds(
      `policyRuleDispositions.${disposition.ruleId}.claimIds`,
      disposition.claimIds,
      claims,
    );
    requireIds(
      `policyRuleDispositions.${disposition.ruleId}.evidenceRoleIds`,
      disposition.evidenceRoleIds,
      evidenceRoles,
    );
    requireIds(
      `policyRuleDispositions.${disposition.ruleId}.validationPlanIds`,
      disposition.validationPlanIds,
      validationPlans,
    );
    requireIds(
      `policyRuleDispositions.${disposition.ruleId}.knownGapIds`,
      disposition.knownGapIds,
      knownGaps,
    );
    requireIds(
      `policyRuleDispositions.${disposition.ruleId}.uncertaintyParameterIds`,
      disposition.uncertaintyParameterIds,
      uncertaintyParameters,
    );
    requireIds(
      `policyRuleDispositions.${disposition.ruleId}.modelStructureIds`,
      disposition.modelStructureIds,
      modelStructures,
    );
  }
  for (const component of design.identity.components) {
    requireIds(
      `identity.components.${component.kind}.bridgeEdgeIds`,
      component.bridgeEdgeIds,
      edges,
    );
  }
  for (const model of design.identity.modelStructures) {
    requireIds(
      `identity.modelStructures.${model.id}.sourceEvidenceRoleIds`,
      model.sourceEvidenceRoleIds,
      evidenceRoles,
    );
  }
  const centralComponents = design.identity.components.filter(
    (component) => component.role === "central",
  );
  if (
    centralComponents.length !== 1 ||
    centralComponents[0]?.kind !== design.identity.centralStudyKind
  ) {
    failures.push("identity must contain exactly one central component matching centralStudyKind");
  }
  for (const claim of design.claims) {
    requireIds(`claims.${claim.id}.edgeIds`, claim.edgeIds, edges);
    requireIds(`claims.${claim.id}.endpointIds`, claim.endpointIds, endpoints);
    requireIds(`claims.${claim.id}.comparisonIds`, claim.comparisonIds, comparisons);
    requireIds(`claims.${claim.id}.estimandIds`, claim.estimandIds, estimands);
    requireIds(`claims.${claim.id}.quantityIds`, claim.quantityIds, quantities);
    requireIds(`claims.${claim.id}.evidenceRoleIds`, claim.evidenceRoleIds, evidenceRoles);
  }
  for (const edge of design.edges) {
    requireIds(
      `edges.${edge.id}.fromModelStructureIds`,
      edge.fromModelStructureIds,
      modelStructures,
    );
    requireIds(`edges.${edge.id}.toModelStructureIds`, edge.toModelStructureIds, modelStructures);
    requireIds(
      `edges.${edge.id}.uncertaintyParameterIds`,
      edge.uncertaintyParameterIds,
      uncertaintyParameters,
    );
    requireIds(`edges.${edge.id}.quantityIds`, edge.quantityIds, quantities);
    requireIds(`edges.${edge.id}.fromEndpointIds`, edge.fromEndpointIds, endpoints);
    requireIds(`edges.${edge.id}.toEndpointIds`, edge.toEndpointIds, endpoints);
  }
  for (const endpoint of design.endpoints) {
    if (endpoint.modelStructureId) {
      requireIds(
        `endpoints.${endpoint.id}.modelStructureId`,
        [endpoint.modelStructureId],
        modelStructures,
      );
    }
  }
  for (const comparison of design.comparisons) {
    requireIds(
      `comparisons.${comparison.id}.leftEndpointId`,
      [comparison.leftEndpointId],
      endpoints,
    );
    requireIds(
      `comparisons.${comparison.id}.rightEndpointId`,
      [comparison.rightEndpointId],
      endpoints,
    );
    if (comparison.truthEndpointId) {
      requireIds(
        `comparisons.${comparison.id}.truthEndpointId`,
        [comparison.truthEndpointId],
        endpoints,
      );
    }
    requireIds(`comparisons.${comparison.id}.quantityIds`, comparison.quantityIds, quantities);
    requireIds(`comparisons.${comparison.id}.thresholdIds`, comparison.thresholdIds, thresholds);
  }
  for (const plan of design.validationPlans) {
    requireIds(`validationPlans.${plan.id}.claimIds`, plan.claimIds, claims);
    requireIds(`validationPlans.${plan.id}.factorIds`, plan.factorIds, factors);
    if (plan.independentValidation.gapId) {
      requireIds(
        `validationPlans.${plan.id}.independentValidation.gapId`,
        [plan.independentValidation.gapId],
        knownGaps,
      );
    }
  }
  for (const threshold of design.thresholds) {
    requireIds(`thresholds.${threshold.id}.claimId`, [threshold.claimId], claims);
    requireIds(`thresholds.${threshold.id}.quantityId`, [threshold.quantityId], quantities);
    requireIds(
      `thresholds.${threshold.id}.criterionQuantityIds`,
      threshold.criterionQuantityIds,
      quantities,
    );
    if (threshold.stabilityQuantityId) {
      requireIds(
        `thresholds.${threshold.id}.stabilityQuantityId`,
        [threshold.stabilityQuantityId],
        quantities,
      );
    }
    requireIds(
      `thresholds.${threshold.id}.sensitivityParameterIds`,
      threshold.sensitivityParameterIds,
      uncertaintyParameters,
    );
  }
  for (const role of design.evidenceRoles) {
    requireIds(`evidenceRoles.${role.id}.claimIds`, role.claimIds, claims);
  }
  for (const gap of design.knownGaps) {
    for (const evidenceRef of gap.evidenceRefs) {
      const known =
        evidenceRef.kind === "claim"
          ? claims
          : evidenceRef.kind === "quantity"
            ? quantities
            : evidenceRef.kind === "validation-plan"
              ? validationPlans
              : evidenceRef.kind === "edge"
                ? edges
                : evidenceRoles;
      requireIds(`knownGaps.${gap.id}.evidenceRefs.${evidenceRef.kind}`, [evidenceRef.id], known);
    }
  }
  for (const quantity of design.quantities) {
    requireIds(
      `quantities.${quantity.id}.uncertaintyParameterIds`,
      quantity.uncertaintyParameterIds,
      uncertaintyParameters,
    );
  }
  for (const parameter of design.uncertaintyParameters) {
    requireIds(
      `uncertaintyParameters.${parameter.id}.sourceEvidenceRoleIds`,
      parameter.sourceEvidenceRoleIds,
      evidenceRoles,
    );
    requireIds(
      `uncertaintyParameters.${parameter.id}.quantityIds`,
      parameter.quantityIds,
      quantities,
    );
    requireIds(`uncertaintyParameters.${parameter.id}.factorIds`, parameter.factorIds, factors);
  }
  for (const group of design.uncertaintyGroups) {
    requireIds(
      `uncertaintyGroups.${group.id}.parameterIds`,
      group.parameterIds,
      uncertaintyParameters,
    );
    requireIds(
      `uncertaintyGroups.${group.id}.sharedAcrossModelStructureIds`,
      group.sharedAcrossModelStructureIds,
      modelStructures,
    );
  }
  for (const factor of design.factors) {
    requireIds(`factors.${factor.id}.evidenceRoleIds`, factor.evidenceRoleIds, evidenceRoles);
  }
  for (const metric of design.baselinePlan.decisionLossMetrics) {
    requireIds(
      `baselinePlan.decisionLossMetrics.${metric.id}.comparisonIds`,
      metric.comparisonIds,
      comparisons,
    );
    requireIds(
      `baselinePlan.decisionLossMetrics.${metric.id}.quantityIds`,
      metric.quantityIds,
      quantities,
    );
  }
  if (failures.length) throw scientificDesignSemanticError(failures);
}

function scientificDesignSemanticError(validation: string[]): CliError {
  return new CliError("Scientific design failed semantic validation.", {
    code: "RESEARCH_SCIENTIFIC_DESIGN_INVALID",
    exitCode: 2,
    details: sanitizeResearchValue({ validation }),
  });
}

function scientificDesignPathError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_SCIENTIFIC_DESIGN_PATH_INVALID",
    exitCode: 2,
  });
}

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 20).map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message ?? "is invalid"}`;
  });
}
