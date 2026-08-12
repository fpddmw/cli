import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateTopJournalAssessment,
  type PublicationAssessment,
} from "../src/research/workspace/publication.js";
import type { ResearchPolicyBinding } from "../src/research/workspace/types.js";

describe("top-journal publication assessment", () => {
  it("blocks an original paper when a central dimension is only partial", () => {
    const result = evaluateTopJournalAssessment({
      policy: policy("original-empirical"),
      evidenceSnapshot: evidence({ dimensionStatus: "partial" }),
      inputs: [],
      assessment: assessment(),
    });
    assert.ok(result.issueCodes.includes("CENTRAL_DIMENSION_INCOMPLETE"));
    assert.equal(result.canClaimSubmissionReady, false);
    assert.equal(result.evidenceReportAllowed, true);
  });

  it("computes evidence composition instead of treating eight full texts as interchangeable", () => {
    const sources = [
      ...Array.from({ length: 2 }, (_, index) =>
        source(`peer-${index}`, true, "direct", "peer-reviewed-empirical"),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        source(`admin-${index}`, true, "direct", "administrative-record"),
      ),
      source("owner-model", true, "direct", "internal-model"),
      source("owner-synthesis", true, "adjacent", "owner-provided-input"),
    ];
    const result = evaluateTopJournalAssessment({
      policy: policy("systematic-review-meta-analysis", {
        minDirectPeerReviewedFullText: 8,
      }),
      evidenceSnapshot: evidence({ sources }),
      inputs: [],
      assessment: assessment({
        sourceClassifications: sources.map(({ id, relationship, evidenceKind }) => ({
          sourceId: id,
          relationship,
          evidenceKind,
        })),
      }),
    });
    assert.equal(result.evidenceComposition.totalFullText, 8);
    assert.equal(result.evidenceComposition.directPeerReviewedFullText, 2);
    assert.equal(result.evidenceComposition.administrativeRecords, 4);
    assert.ok(result.issueCodes.includes("DIRECT_PEER_REVIEWED_FULL_TEXT_INSUFFICIENT"));
  });

  it("keeps uncertain owner input reference-only until independently reproduced", () => {
    const result = evaluateTopJournalAssessment({
      policy: policy("original-empirical"),
      evidenceSnapshot: evidence({
        sources: [source("owner-source", true, "direct", "owner-provided-input")],
      }),
      inputs: [
        {
          id: "owner-source",
          trustStatus: "reference-only",
          independentlyReproduced: false,
        },
      ],
      assessment: assessment({
        claims: [
          {
            id: "claim-central",
            role: "central",
            statement: "The owner model establishes the central effect.",
            evidenceSourceIds: ["owner-source"],
            dimensionIds: ["central-outcome"],
            resultIds: ["result-central"],
          },
        ],
        sourceClassifications: [
          {
            sourceId: "owner-source",
            relationship: "direct",
            evidenceKind: "owner-provided-input",
          },
        ],
      }),
    });
    assert.ok(result.issueCodes.includes("OWNER_INPUT_UNVERIFIED"));
    assert.equal(result.canClaimSubmissionReady, false);
  });

  it("resolves owner-input trust through source provenance instead of source display IDs", () => {
    const ownerSource = {
      ...source("source-owner-model", true, "direct", "owner-provided-input"),
      provenance: { kind: "input", id: "owner-input-record" },
    };
    const result = evaluateTopJournalAssessment({
      policy: policy("original-empirical"),
      evidenceSnapshot: evidence({ sources: [ownerSource] }),
      inputs: [
        {
          id: "owner-input-record",
          trustStatus: "reference-only",
          independentlyReproduced: false,
        },
      ],
      assessment: assessment({
        claims: [
          {
            id: "claim-central",
            role: "central",
            statement: "The owner model uniquely supports the central result.",
            evidenceSourceIds: ["source-owner-model"],
            dimensionIds: ["central-outcome"],
            resultIds: ["result-central"],
          },
        ],
        sourceClassifications: [
          {
            sourceId: "source-owner-model",
            relationship: "direct",
            evidenceKind: "owner-provided-input",
          },
        ],
      }),
    });
    assert.ok(result.issueCodes.includes("OWNER_INPUT_UNVERIFIED"));
  });

  it("classifies identities and illustrative sensitivities as insufficient original results", () => {
    const result = evaluateTopJournalAssessment({
      policy: policy("original-empirical"),
      evidenceSnapshot: evidence(),
      inputs: [],
      assessment: assessment({
        results: [
          {
            id: "result-central",
            role: "central",
            resultClass: "accounting-identity",
            statement: "Material equals volume multiplied by density.",
            evidenceSourceIds: ["peer-1"],
            independentlyReproduced: true,
          },
        ],
      }),
    });
    assert.ok(result.issueCodes.includes("ORIGINAL_QUANTITATIVE_CONTRIBUTION_INSUFFICIENT"));
    assert.equal(result.supportedArticleType, "perspective-theory");
    assert.ok(result.pivotOptions.includes("perspective-theory"));
  });

  it("detects a promised title outcome that is not observed, estimated, calibrated, or validated", () => {
    const result = evaluateTopJournalAssessment({
      policy: policy("original-empirical"),
      evidenceSnapshot: evidence(),
      inputs: [],
      assessment: assessment({
        titleOutcomeIds: ["maintenance-materials"],
        outcomes: [
          {
            id: "maintenance-materials",
            role: "central",
            label: "Maintenance material demand",
            supportStatus: "unobserved",
            claimIds: ["claim-central"],
            resultIds: ["result-central"],
          },
        ],
      }),
    });
    assert.ok(result.issueCodes.includes("CENTRAL_OUTCOME_UNOBSERVED"));
    assert.ok(result.issueCodes.includes("TITLE_OUTCOME_MISMATCH"));
  });

  it("fails novelty and recall when a direct core work is missing", () => {
    const result = evaluateTopJournalAssessment({
      policy: policy("systematic-review-meta-analysis"),
      evidenceSnapshot: evidence(),
      inputs: [],
      assessment: assessment({
        recallAudit: {
          status: "fail",
          candidateDispositionComplete: false,
          databaseCoverageComplete: true,
          backwardCitationChasing: true,
          forwardCitationChasing: true,
          adversarialSearch: true,
          closestPriorWorkCompared: false,
          missingCoreWorkIds: ["known-core-paper"],
        },
      }),
    });
    assert.ok(result.issueCodes.includes("LITERATURE_RECALL_FAILURE"));
    assert.ok(result.issueCodes.includes("NOVELTY_NOT_ESTABLISHED"));
    assert.ok(result.issueCodes.includes("CANDIDATE_DISPOSITION_INCOMPLETE"));
  });
});

function policy(
  articleType: string,
  constraints: ResearchPolicyBinding["resolvedConstraints"] = {},
): ResearchPolicyBinding {
  return {
    goal: "top-journal",
    projectId: "publication-test",
    articleType,
    field: "engineering-computing",
    journalClass: "discipline-flagship",
    targetJournal: "Example Journal",
    resolvedPolicySha256: "a".repeat(64),
    approvalSha256: "b".repeat(64),
    verdictCeiling: "target-journal-submission-ready",
    documents: [],
    resolvedRules: [],
    resolvedConstraints: constraints,
    requiredReviewers: ["evidence", "methods-reproducibility", "domain-novelty", "journal-editor"],
    approvedAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2027-08-12T00:00:00.000Z",
  };
}

function evidence(
  override: {
    dimensionStatus?: "covered" | "partial" | "missing";
    sources?: Array<ReturnType<typeof source> & { provenance?: Record<string, string> }>;
  } = {},
) {
  const sources = override.sources ?? [source("peer-1", true, "direct", "peer-reviewed-empirical")];
  return {
    snapshotId: "snapshot-1",
    snapshotSha256: "c".repeat(64),
    sources: sources.map(({ relationship: _relationship, evidenceKind: _kind, ...item }) => item),
    coverage: {
      dimensions: [
        {
          id: "central-outcome",
          status: override.dimensionStatus ?? "covered",
          sourceIds: sources.map((item) => item.id),
        },
      ],
    },
  };
}

function source(
  id: string,
  fullTextAvailable: boolean,
  relationship: PublicationAssessment["sourceClassifications"][number]["relationship"],
  evidenceKind: PublicationAssessment["sourceClassifications"][number]["evidenceKind"],
) {
  return { id, fullTextAvailable, relationship, evidenceKind };
}

function assessment(override: Partial<PublicationAssessment> = {}): PublicationAssessment {
  return {
    schemaVersion: 1,
    title: "Observed central outcome in a validated study",
    claims: [
      {
        id: "claim-central",
        role: "central",
        statement: "The central outcome changes under the studied condition.",
        evidenceSourceIds: ["peer-1"],
        dimensionIds: ["central-outcome"],
        resultIds: ["result-central"],
      },
    ],
    outcomes: [
      {
        id: "central-outcome",
        role: "central",
        label: "Central outcome",
        supportStatus: "field-observation",
        claimIds: ["claim-central"],
        resultIds: ["result-central"],
      },
    ],
    titleOutcomeIds: ["central-outcome"],
    results: [
      {
        id: "result-central",
        role: "central",
        resultClass: "field-observation",
        statement: "The central outcome was directly observed.",
        evidenceSourceIds: ["peer-1"],
        independentlyReproduced: true,
      },
    ],
    sourceClassifications: [
      {
        sourceId: "peer-1",
        relationship: "direct",
        evidenceKind: "peer-reviewed-empirical",
      },
    ],
    recallAudit: {
      status: "pass",
      candidateDispositionComplete: true,
      databaseCoverageComplete: true,
      backwardCitationChasing: true,
      forwardCitationChasing: true,
      adversarialSearch: true,
      closestPriorWorkCompared: true,
      missingCoreWorkIds: [],
    },
    ...override,
  };
}
