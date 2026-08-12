import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import {
  closePublication,
  freezePublicationManuscript,
  inspectPublicationStatus,
  preparePublicationReview,
  submitPublicationReview,
  type PublicationReviewRole,
} from "../src/research/workspace/publication-workflow.js";
import type { PublicationAssessment } from "../src/research/workspace/publication.js";
import { initializeProject, loadProject, saveProject } from "../src/research/workspace/projects.js";
import {
  canonicalJson,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "../src/research/workspace/storage.js";
import type { ResearchPolicyBinding } from "../src/research/workspace/types.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

const REVIEW_ROLES: PublicationReviewRole[] = [
  "evidence",
  "methods-reproducibility",
  "domain-novelty",
  "journal-editor",
];

describe("top-journal publication workflow", () => {
  it("exposes publication freeze/status and authoritative assessment/review schemas", async () => {
    const fixture = await publicationFixture("publication-cli");
    try {
      const frozen = await invokeCli([
        "research",
        "publication",
        "freeze",
        fixture.projectId,
        "--manuscript",
        fixture.manuscript,
        "--assessment",
        fixture.assessment,
        "--producer-agent",
        "codex",
        "--producer-session",
        "native-cli-session",
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(frozen.exitCode, 0);
      assert.equal(JSON.parse(frozen.stdout).status, "manuscript-frozen");

      const status = await invokeCli([
        "research",
        "publication",
        "status",
        fixture.projectId,
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(status.exitCode, 0);
      assert.equal(JSON.parse(status.stdout).reviewState, "not-started");

      for (const schemaName of [
        "publication-assessment",
        "publication-review-evidence",
        "publication-review-journal-editor",
      ]) {
        const schema = await invokeCli(["research", "schema", "show", schemaName, "--json"]);
        assert.equal(schema.exitCode, 0);
        assert.equal(JSON.parse(schema.stdout).additionalProperties, false);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("freezes the final manuscript and requires four fresh hash-bound reviews", async () => {
    const fixture = await publicationFixture("review-complete");
    try {
      const frozen = await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [fixture.supplement],
        producerAgent: "codex",
        producerSessionId: "native-codex-session-1",
      });
      assert.match(frozen.generationSha256, /^[a-f0-9]{64}$/);
      assert.equal(frozen.status, "manuscript-frozen");

      for (const role of REVIEW_ROLES) {
        const reviewerSessionId = `independent-${role}-session`;
        const packet = await preparePublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role,
          reviewerAgent: role === "journal-editor" ? "claude" : "codex",
          reviewerSessionId,
        });
        assert.equal(packet.manuscript.sha256, frozen.manuscript.sha256);
        assert.equal(packet.policy.resolvedPolicySha256, fixture.policy.resolvedPolicySha256);
        assert.equal(packet.evidenceSnapshot.sha256, fixture.snapshotSha256);
        assert.match(packet.packetSha256, /^[a-f0-9]{64}$/);
        const reviewPath = join(fixture.root, `${role}-review.json`);
        await writeJsonAtomic(
          reviewPath,
          reviewRecord(role, packet.packetSha256, reviewerSessionId),
        );
        await submitPublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role,
          reviewPath,
        });
      }

      const status = await inspectPublicationStatus(fixture.root, fixture.projectId);
      assert.equal(status.reviewState, "complete");
      assert.equal(status.readinessVerdict, "target-journal-submission-ready");
      const closure = await closePublication(fixture.root, fixture.projectId);
      assert.equal(closure.readinessVerdict, "target-journal-submission-ready");
      assert.equal(closure.manuscript.sha256, frozen.manuscript.sha256);
      assert.equal(closure.reviews.length, 4);
      assert.match(closure.closureSha256, /^[a-f0-9]{64}$/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects producer/reviewer identity reuse and reviewer session reuse", async () => {
    const fixture = await publicationFixture("review-independence");
    try {
      await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        producerAgent: "codex",
        producerSessionId: "native-producer-session",
      });
      await assert.rejects(
        preparePublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role: "evidence",
          reviewerAgent: "claude",
          reviewerSessionId: "native-producer-session",
        }),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_REVIEW_NOT_INDEPENDENT",
      );
      await preparePublicationReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence",
        reviewerAgent: "claude",
        reviewerSessionId: "fresh-reviewer-session",
      });
      await assert.rejects(
        preparePublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role: "methods-reproducibility",
          reviewerAgent: "claude",
          reviewerSessionId: "fresh-reviewer-session",
        }),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_REVIEW_NOT_INDEPENDENT",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("starts a new generation and invalidates every review after the manuscript changes", async () => {
    const fixture = await publicationFixture("review-invalidation");
    try {
      const first = await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        producerAgent: "codex",
        producerSessionId: "native-generation-one",
      });
      const packet = await preparePublicationReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence",
        reviewerAgent: "claude",
        reviewerSessionId: "generation-one-reviewer",
      });
      const reviewPath = join(fixture.root, "first-review.json");
      await writeJsonAtomic(
        reviewPath,
        reviewRecord("evidence", packet.packetSha256, "generation-one-reviewer"),
      );
      await submitPublicationReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence",
        reviewPath,
      });

      await writeFile(fixture.manuscript, "# Revised final manuscript\n\nMaterial revision.\n");
      const second = await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        producerAgent: "codex",
        producerSessionId: "native-generation-two",
      });
      assert.notEqual(second.generationSha256, first.generationSha256);
      const status = await inspectPublicationStatus(fixture.root, fixture.projectId);
      assert.equal(status.completedReviewRoles.length, 0);
      assert.equal(status.reviewState, "not-started");
      await assert.rejects(
        closePublication(fixture.root, fixture.projectId),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_REVIEW_INCOMPLETE",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not let an editor upgrade a mechanically blocked assessment", async () => {
    const fixture = await publicationFixture("bounded-editor", {
      outcomes: [
        {
          id: "outcome-central",
          role: "central",
          label: "Unobserved promised outcome",
          supportStatus: "unobserved",
          claimIds: ["claim-central"],
          resultIds: ["result-central"],
        },
      ],
    });
    try {
      await freezePublicationManuscript({
        root: fixture.root,
        projectId: fixture.projectId,
        manuscriptPath: fixture.manuscript,
        assessmentPath: fixture.assessment,
        supplementPaths: [],
        producerAgent: "codex",
        producerSessionId: "native-blocked-assessment",
      });
      for (const role of REVIEW_ROLES) {
        const reviewerSessionId = `blocked-${role}`;
        const packet = await preparePublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role,
          reviewerAgent: "claude",
          reviewerSessionId,
        });
        const reviewPath = join(fixture.root, `blocked-${role}.json`);
        await writeJsonAtomic(
          reviewPath,
          reviewRecord(role, packet.packetSha256, reviewerSessionId),
        );
        await submitPublicationReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role,
          reviewPath,
        });
      }
      const status = await inspectPublicationStatus(fixture.root, fixture.projectId);
      assert.equal(status.mechanicalIssues.includes("CENTRAL_OUTCOME_UNOBSERVED"), true);
      assert.notEqual(status.readinessVerdict, "target-journal-submission-ready");
      const closure = await closePublication(fixture.root, fixture.projectId);
      assert.equal(closure.readinessVerdict, "revision-required");
      assert.match(closure.boundedStatement, /not submission-ready/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function publicationFixture(
  projectId: string,
  assessmentOverride: Partial<PublicationAssessment> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-publication-workflow-"));
  await initializeResearchWorkspace(root, "Publication workflow");
  const policy = publicationPolicy(projectId);
  await initializeProject(
    root,
    projectId,
    "Does the studied intervention produce the observed central outcome?",
    undefined,
    false,
    undefined,
    policy,
  );
  const project = await loadProject(root, projectId);
  const outputRoot = join(workspacePaths(root).projects, projectId, "outputs");
  const snapshotCore = {
    schemaVersion: 1,
    kind: "tiangong-evidence-snapshot",
    snapshotId: "snapshot-final",
    parentSnapshotId: null,
    parentSnapshotSha256: null,
    projectId,
    questionSha256: sha256Text(project.question),
    createdAt: "2026-08-12T00:00:00.000Z",
    ledgerHead: "1".repeat(64),
    evidenceRecord: { path: "outputs/evidence.json", sha256: "2".repeat(64) },
    acquisitionRecord: { path: "outputs/acquisition.json", sha256: "3".repeat(64) },
    receipts: [],
    artifacts: [],
    sources: [{ id: "peer-1", fullTextAvailable: true }],
    activitySummary: {
      total: 1,
      byKind: { web: 1 },
      blockedChallenges: 0,
      linkedCandidateIds: ["peer-1"],
    },
    coverage: {
      dimensions: [{ id: "central-outcome", status: "covered", sourceIds: ["peer-1"] }],
    },
    limitations: [],
    delta: {
      addedSourceIds: ["peer-1"],
      changedSourceIds: [],
      removedSourceIds: [],
      unchangedSourceIds: [],
      addedArtifactIds: [],
      removedArtifactIds: [],
    },
  };
  const snapshotSha256 = sha256Text(canonicalJson(snapshotCore));
  const snapshot = { ...snapshotCore, snapshotSha256 };
  await writeJsonAtomic(join(outputRoot, "evidence-snapshot.json"), snapshot);
  await writeJsonAtomic(join(outputRoot, "analysis.json"), {
    schemaVersion: 1,
    findings: [],
    limitations: [],
  });
  await writeFile(join(outputRoot, "report.md"), "# Frozen research report\n");
  await writeJsonAtomic(join(outputRoot, "closure.json"), {
    schemaVersion: 1,
    projectId,
    status: "complete",
    publicationPolicy: {
      resolvedPolicySha256: policy.resolvedPolicySha256,
      approvalSha256: policy.approvalSha256,
    },
    evidenceSnapshot: { snapshotId: snapshot.snapshotId, snapshotSha256 },
  });
  for (const workPackage of project.packages) {
    workPackage.status = "complete";
    workPackage.completedAt = "2026-08-12T00:00:00.000Z";
  }
  project.status = "complete";
  project.evidenceState.currentSnapshotId = snapshot.snapshotId;
  project.evidenceState.currentSnapshotSha256 = snapshotSha256;
  project.evidenceState.closureSnapshotId = snapshot.snapshotId;
  await saveProject(root, project);

  const manuscript = join(root, "final-manuscript.md");
  const supplement = join(root, "supplement.csv");
  const assessment = join(root, "publication-assessment.json");
  await writeFile(manuscript, "# Final manuscript\n\nObserved central outcome.\n");
  await writeFile(supplement, "measure,value\noutcome,1\n");
  await writeJsonAtomic(assessment, publicationAssessment(assessmentOverride));
  return { root, projectId, policy, manuscript, supplement, assessment, snapshotSha256 };
}

function publicationPolicy(projectId: string): ResearchPolicyBinding {
  return {
    goal: "top-journal",
    projectId,
    articleType: "original-empirical",
    field: "engineering-computing",
    journalClass: "discipline-flagship",
    targetJournal: "Example Journal",
    resolvedPolicySha256: "a".repeat(64),
    approvalSha256: "b".repeat(64),
    verdictCeiling: "target-journal-submission-ready",
    documents: [],
    resolvedRules: [],
    resolvedConstraints: {},
    requiredReviewers: [...REVIEW_ROLES],
    approvedAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2027-08-12T00:00:00.000Z",
  };
}

function publicationAssessment(override: Partial<PublicationAssessment>): PublicationAssessment {
  return {
    schemaVersion: 1,
    title: "Observed central outcome in a validated study",
    claims: [
      {
        id: "claim-central",
        role: "central",
        statement: "The studied intervention changes the central outcome.",
        evidenceSourceIds: ["peer-1"],
        dimensionIds: ["central-outcome"],
        resultIds: ["result-central"],
      },
    ],
    outcomes: [
      {
        id: "outcome-central",
        role: "central",
        label: "Observed central outcome",
        supportStatus: "field-observation",
        claimIds: ["claim-central"],
        resultIds: ["result-central"],
      },
    ],
    titleOutcomeIds: ["outcome-central"],
    results: [
      {
        id: "result-central",
        role: "central",
        resultClass: "field-observation",
        statement: "The central outcome was observed.",
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

function reviewRecord(
  role: PublicationReviewRole,
  packetSha256: string,
  reviewerSessionId: string,
) {
  return {
    schemaVersion: 1,
    role,
    packetSha256,
    reviewerSessionId,
    decision: role === "journal-editor" ? "submission-ready" : "pass",
    findings: [],
    boundedRecommendation: "The exact frozen manuscript satisfies this review role.",
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function invokeCli(argv: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    env: {},
    stdout: { write: (value: string) => void stdout.push(value) },
    stderr: { write: (value: string) => void stderr.push(value) },
  });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}
