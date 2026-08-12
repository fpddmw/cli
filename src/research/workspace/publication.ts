import type { ResearchPolicyBinding, ResearchVerdictCeiling } from "./types.js";

export type PublicationClaimRole = "central" | "supporting" | "contextual" | "future-research";
export type PublicationResultClass =
  | "definition"
  | "accounting-identity"
  | "illustrative-sensitivity"
  | "calibrated-model"
  | "causal-estimate"
  | "field-observation"
  | "validated-forecast"
  | "systematic-synthesis"
  | "conceptual-proposition";
export type PublicationOutcomeSupport =
  | "unobserved"
  | "future-work"
  | "conceptual-proposition"
  | "calibrated-model"
  | "causal-estimate"
  | "field-observation"
  | "validated-forecast"
  | "systematic-synthesis";
export type PublicationEvidenceKind =
  | "peer-reviewed-empirical"
  | "peer-reviewed-model"
  | "peer-reviewed-review"
  | "official-data"
  | "administrative-record"
  | "patent"
  | "news"
  | "owner-provided-input"
  | "internal-model"
  | "other";

export interface PublicationAssessment {
  schemaVersion: 1;
  title: string;
  claims: Array<{
    id: string;
    role: PublicationClaimRole;
    statement: string;
    evidenceSourceIds: string[];
    dimensionIds: string[];
    resultIds: string[];
  }>;
  outcomes: Array<{
    id: string;
    role: "central" | "supporting" | "contextual";
    label: string;
    supportStatus: PublicationOutcomeSupport;
    claimIds: string[];
    resultIds: string[];
  }>;
  titleOutcomeIds: string[];
  results: Array<{
    id: string;
    role: "central" | "supporting" | "contextual";
    resultClass: PublicationResultClass;
    statement: string;
    evidenceSourceIds: string[];
    independentlyReproduced: boolean;
  }>;
  sourceClassifications: Array<{
    sourceId: string;
    relationship: "direct" | "adjacent" | "contextual";
    evidenceKind: PublicationEvidenceKind;
  }>;
  recallAudit: {
    status: "pass" | "fail" | "incomplete";
    candidateDispositionComplete: boolean;
    databaseCoverageComplete: boolean;
    backwardCitationChasing: boolean;
    forwardCitationChasing: boolean;
    adversarialSearch: boolean;
    closestPriorWorkCompared: boolean;
    missingCoreWorkIds: string[];
  };
}

export interface PublicationAssessmentIssue {
  code: string;
  severity: "blocking" | "major" | "minor";
  message: string;
}

export interface PublicationEvidenceComposition {
  totalSources: number;
  totalFullText: number;
  directPeerReviewedFullText: number;
  directEmpiricalFullText: number;
  directModelFullText: number;
  adjacentPeerReviewedFullText: number;
  administrativeRecords: number;
  patents: number;
  news: number;
  ownerProvidedInputs: number;
  internalModels: number;
  metadataOnly: number;
}

export interface TopJournalAssessmentResult {
  schemaVersion: 1;
  policySha256: string;
  evidenceSnapshotSha256: string;
  requestedArticleType: string;
  supportedArticleType: string;
  evidenceComposition: PublicationEvidenceComposition;
  issues: PublicationAssessmentIssue[];
  issueCodes: string[];
  evidenceReportAllowed: boolean;
  canClaimSubmissionReady: boolean;
  verdictCeiling: ResearchVerdictCeiling;
  pivotOptions: string[];
}

interface AssessmentEvidenceSnapshot {
  snapshotId: string;
  snapshotSha256: string;
  sources: Array<{ id?: unknown; fullTextAvailable?: unknown; provenance?: unknown }>;
  coverage: {
    dimensions?: Array<{ id?: unknown; status?: unknown; sourceIds?: unknown }>;
  };
}

interface AssessmentInput {
  id: string;
  trustStatus?:
    | "verified-owner-input"
    | "unverified-owner-input"
    | "reference-only"
    | "replication-candidate";
  independentlyReproduced?: boolean;
}

export function evaluateTopJournalAssessment(input: {
  policy: ResearchPolicyBinding;
  evidenceSnapshot: AssessmentEvidenceSnapshot;
  inputs: AssessmentInput[];
  assessment: PublicationAssessment;
}): TopJournalAssessmentResult {
  const issues = new Map<string, PublicationAssessmentIssue>();
  const addIssue = (
    code: string,
    message: string,
    severity: PublicationAssessmentIssue["severity"] = "blocking",
  ) => {
    if (!issues.has(code)) issues.set(code, { code, severity, message });
  };
  const assessment = input.assessment;
  const sourceById = new Map(
    input.evidenceSnapshot.sources.flatMap((source) =>
      typeof source.id === "string" ? [[source.id, source] as const] : [],
    ),
  );
  const classificationById = new Map(
    assessment.sourceClassifications.map((classification) => [
      classification.sourceId,
      classification,
    ]),
  );
  const evidenceComposition = computeEvidenceComposition(
    input.evidenceSnapshot.sources,
    classificationById,
  );
  const claimById = new Map(assessment.claims.map((claim) => [claim.id, claim]));
  const resultById = new Map(assessment.results.map((result) => [result.id, result]));
  const outcomeById = new Map(assessment.outcomes.map((outcome) => [outcome.id, outcome]));
  const dimensionStatus = new Map(
    (input.evidenceSnapshot.coverage.dimensions ?? []).flatMap((dimension) =>
      typeof dimension.id === "string" &&
      ["covered", "partial", "missing"].includes(String(dimension.status))
        ? [[dimension.id, String(dimension.status)] as const]
        : [],
    ),
  );
  const centralClaims = assessment.claims.filter((claim) => claim.role === "central");
  const centralOutcomes = assessment.outcomes.filter((outcome) => outcome.role === "central");
  const centralResults = assessment.results.filter((result) => result.role === "central");
  if (!centralClaims.length) {
    addIssue("CENTRAL_CLAIM_MISSING", "The publication assessment defines no central claim.");
  }
  if (!centralOutcomes.length) {
    addIssue(
      "CENTRAL_OUTCOME_UNOBSERVED",
      "The publication assessment defines no central outcome.",
    );
  }
  for (const claim of centralClaims) {
    if (!claim.evidenceSourceIds.length) {
      addIssue("CENTRAL_CLAIM_UNSUPPORTED", "A central claim has no bound evidence source.");
    }
    for (const sourceId of claim.evidenceSourceIds) {
      if (!sourceById.has(sourceId)) {
        addIssue(
          "CENTRAL_CLAIM_UNSUPPORTED",
          "A central claim cites a source outside the snapshot.",
        );
      }
    }
    for (const dimensionId of claim.dimensionIds) {
      if (dimensionStatus.get(dimensionId) !== "covered") {
        addIssue(
          "CENTRAL_DIMENSION_INCOMPLETE",
          "A central claim depends on a partial, missing, or undeclared evidence dimension.",
        );
      }
    }
    if (claim.resultIds.some((resultId) => !resultById.has(resultId))) {
      addIssue("CENTRAL_CLAIM_UNSUPPORTED", "A central claim cites an unknown result.");
    }
  }

  const empiricalOutcomeStatuses = new Set<PublicationOutcomeSupport>([
    "field-observation",
    "causal-estimate",
    "calibrated-model",
    "validated-forecast",
    "systematic-synthesis",
  ]);
  for (const outcome of centralOutcomes) {
    const supported =
      empiricalOutcomeStatuses.has(outcome.supportStatus) ||
      (input.policy.articleType === "perspective-theory" &&
        outcome.supportStatus === "conceptual-proposition");
    if (!supported) {
      addIssue(
        "CENTRAL_OUTCOME_UNOBSERVED",
        "A central outcome was not observed, estimated, calibrated, validated, or systematically synthesized.",
      );
    }
  }
  for (const outcomeId of assessment.titleOutcomeIds) {
    const outcome = outcomeById.get(outcomeId);
    if (!outcome || !empiricalOutcomeStatuses.has(outcome.supportStatus)) {
      addIssue(
        "TITLE_OUTCOME_MISMATCH",
        "The title promises an outcome that the frozen results do not support.",
      );
    }
  }

  const illustrativeClasses = new Set<PublicationResultClass>([
    "definition",
    "accounting-identity",
    "illustrative-sensitivity",
    "conceptual-proposition",
  ]);
  const illustrativeOnly =
    centralResults.length === 0 ||
    centralResults.every((result) => illustrativeClasses.has(result.resultClass));
  let supportedArticleType = input.policy.articleType;
  if (
    illustrativeOnly &&
    ["original-empirical", "computational-modeling", "methods-data-resource"].includes(
      input.policy.articleType,
    )
  ) {
    supportedArticleType = "perspective-theory";
    addIssue(
      "ORIGINAL_QUANTITATIVE_CONTRIBUTION_INSUFFICIENT",
      "Central results are definitions, identities, illustrative sensitivities, or conceptual propositions rather than an original quantitative contribution.",
    );
  }
  if (
    input.policy.articleType === "original-empirical" &&
    centralResults.some(
      (result) =>
        !["field-observation", "causal-estimate", "validated-forecast"].includes(
          result.resultClass,
        ),
    )
  ) {
    addIssue(
      "ORIGINAL_QUANTITATIVE_CONTRIBUTION_INSUFFICIENT",
      "The original empirical article type requires observed, estimated, or independently validated central results.",
    );
  }
  if (
    input.policy.articleType === "computational-modeling" &&
    centralResults.some(
      (result) => !["calibrated-model", "validated-forecast"].includes(result.resultClass),
    )
  ) {
    addIssue(
      "MODEL_NOT_CALIBRATED_OR_VALIDATED",
      "The modeling article type requires calibrated or independently validated central results.",
    );
  }
  for (const result of centralResults) {
    if (!result.independentlyReproduced) {
      addIssue(
        "MATERIAL_RESULT_NOT_REPRODUCED",
        "A central result has not been independently reproduced from frozen inputs.",
      );
    }
  }

  const inputById = new Map(input.inputs.map((ownerInput) => [ownerInput.id, ownerInput]));
  for (const claim of centralClaims) {
    for (const sourceId of claim.evidenceSourceIds) {
      const source = sourceById.get(sourceId);
      const provenance =
        source?.provenance &&
        typeof source.provenance === "object" &&
        !Array.isArray(source.provenance)
          ? (source.provenance as Record<string, unknown>)
          : null;
      const ownerInputId =
        provenance?.kind === "input" && typeof provenance.id === "string"
          ? provenance.id
          : sourceId;
      const ownerInput = inputById.get(ownerInputId);
      if (
        ownerInput &&
        (ownerInput.trustStatus !== "verified-owner-input" ||
          ownerInput.independentlyReproduced !== true)
      ) {
        addIssue(
          "OWNER_INPUT_UNVERIFIED",
          "Reference-only or unverified owner input cannot uniquely support a central result.",
        );
      }
    }
  }

  const constraints = input.policy.resolvedConstraints ?? {};
  const minDirectPeerReviewed = numericConstraint(constraints.minDirectPeerReviewedFullText);
  if (
    minDirectPeerReviewed > 0 &&
    evidenceComposition.directPeerReviewedFullText < minDirectPeerReviewed
  ) {
    addIssue(
      "DIRECT_PEER_REVIEWED_FULL_TEXT_INSUFFICIENT",
      `The policy requires ${minDirectPeerReviewed} direct peer-reviewed full texts; the snapshot contains ${evidenceComposition.directPeerReviewedFullText}.`,
    );
  }
  const minDirectEmpirical = numericConstraint(constraints.minDirectEmpiricalFullText);
  if (minDirectEmpirical > 0 && evidenceComposition.directEmpiricalFullText < minDirectEmpirical) {
    addIssue(
      "DIRECT_EMPIRICAL_FULL_TEXT_INSUFFICIENT",
      `The policy requires ${minDirectEmpirical} direct empirical full texts; the snapshot contains ${evidenceComposition.directEmpiricalFullText}.`,
    );
  }
  const minDirectModel = numericConstraint(constraints.minDirectModelFullText);
  if (minDirectModel > 0 && evidenceComposition.directModelFullText < minDirectModel) {
    addIssue(
      "DIRECT_MODEL_FULL_TEXT_INSUFFICIENT",
      `The policy requires ${minDirectModel} direct model full texts; the snapshot contains ${evidenceComposition.directModelFullText}.`,
    );
  }

  const recall = assessment.recallAudit;
  if (
    recall.status !== "pass" ||
    !recall.databaseCoverageComplete ||
    !recall.backwardCitationChasing ||
    !recall.forwardCitationChasing ||
    !recall.adversarialSearch ||
    recall.missingCoreWorkIds.length > 0
  ) {
    addIssue(
      "LITERATURE_RECALL_FAILURE",
      "The novelty and recall audit is incomplete or identified missing direct core work.",
    );
  }
  if (!recall.closestPriorWorkCompared || recall.missingCoreWorkIds.length > 0) {
    addIssue(
      "NOVELTY_NOT_ESTABLISHED",
      "The contribution is not compared against all identified closest prior work.",
    );
  }
  if (!recall.candidateDispositionComplete) {
    addIssue(
      "CANDIDATE_DISPOSITION_INCOMPLETE",
      "Not every discovered candidate has an explicit screening disposition.",
    );
  }

  const orderedIssues = [...issues.values()].sort((left, right) =>
    left.code.localeCompare(right.code),
  );
  const blocking = orderedIssues.some((issue) => issue.severity === "blocking");
  const canClaimSubmissionReady =
    !blocking &&
    input.policy.targetJournal !== null &&
    input.policy.verdictCeiling === "target-journal-submission-ready";
  return {
    schemaVersion: 1,
    policySha256: input.policy.resolvedPolicySha256,
    evidenceSnapshotSha256: input.evidenceSnapshot.snapshotSha256,
    requestedArticleType: input.policy.articleType,
    supportedArticleType,
    evidenceComposition,
    issues: orderedIssues,
    issueCodes: orderedIssues.map((issue) => issue.code),
    evidenceReportAllowed: true,
    canClaimSubmissionReady,
    verdictCeiling: canClaimSubmissionReady
      ? input.policy.verdictCeiling
      : minimumVerdictCeiling(input.policy.verdictCeiling),
    pivotOptions: publicationPivots(input.policy.articleType, supportedArticleType, blocking),
  };
}

function computeEvidenceComposition(
  sources: AssessmentEvidenceSnapshot["sources"],
  classifications: Map<string, PublicationAssessment["sourceClassifications"][number]>,
): PublicationEvidenceComposition {
  const result: PublicationEvidenceComposition = {
    totalSources: sources.length,
    totalFullText: 0,
    directPeerReviewedFullText: 0,
    directEmpiricalFullText: 0,
    directModelFullText: 0,
    adjacentPeerReviewedFullText: 0,
    administrativeRecords: 0,
    patents: 0,
    news: 0,
    ownerProvidedInputs: 0,
    internalModels: 0,
    metadataOnly: 0,
  };
  for (const source of sources) {
    if (typeof source.id !== "string") continue;
    const fullText = source.fullTextAvailable === true;
    if (fullText) result.totalFullText += 1;
    else result.metadataOnly += 1;
    const classification = classifications.get(source.id);
    if (!classification) continue;
    const peerReviewed = classification.evidenceKind.startsWith("peer-reviewed-");
    if (fullText && classification.relationship === "direct" && peerReviewed) {
      result.directPeerReviewedFullText += 1;
    }
    if (
      fullText &&
      classification.relationship === "direct" &&
      ["peer-reviewed-empirical", "official-data"].includes(classification.evidenceKind)
    ) {
      result.directEmpiricalFullText += 1;
    }
    if (
      fullText &&
      classification.relationship === "direct" &&
      classification.evidenceKind === "peer-reviewed-model"
    ) {
      result.directModelFullText += 1;
    }
    if (fullText && classification.relationship === "adjacent" && peerReviewed) {
      result.adjacentPeerReviewedFullText += 1;
    }
    if (classification.evidenceKind === "administrative-record") {
      result.administrativeRecords += 1;
    } else if (classification.evidenceKind === "patent") {
      result.patents += 1;
    } else if (classification.evidenceKind === "news") {
      result.news += 1;
    } else if (classification.evidenceKind === "owner-provided-input") {
      result.ownerProvidedInputs += 1;
    } else if (classification.evidenceKind === "internal-model") {
      result.internalModels += 1;
    }
  }
  return result;
}

function numericConstraint(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function minimumVerdictCeiling(ceiling: ResearchVerdictCeiling): ResearchVerdictCeiling {
  return ceiling === "top-journal-feasibility-complete" ? ceiling : "top-journal-candidate";
}

function publicationPivots(
  requestedArticleType: string,
  supportedArticleType: string,
  blocking: boolean,
): string[] {
  const pivots = new Set<string>();
  if (requestedArticleType !== supportedArticleType) pivots.add(supportedArticleType);
  if (blocking) {
    pivots.add("additional-research-or-data");
    pivots.add("systematic-review-addendum");
  }
  if (requestedArticleType !== "perspective-theory") pivots.add("perspective-theory");
  return [...pivots];
}
