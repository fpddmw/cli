import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/io.js";
import { exportProjectAuditBundle } from "../src/research/workspace/audit-bundle.js";
import {
  initializeProject,
  loadProject,
  nextReadyPackage,
  nextScientificGate,
  saveProject,
} from "../src/research/workspace/projects.js";
import {
  assertScientificGateForStage,
  inspectScientificReviewStatus,
  prepareScientificReview,
  scientificGateAssessmentSchema,
  scientificReviewSchema,
  submitScientificReview,
  type ScientificReviewPacket,
} from "../src/research/workspace/scientific-review.js";
import { prepareNativeResearchStage } from "../src/research/workspace/runtime.js";
import { sha256Text, workspacePaths, writeJsonAtomic } from "../src/research/workspace/storage.js";
import type {
  ResearchPolicyBinding,
  ScientificReviewRole,
} from "../src/research/workspace/types.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";
import { scientificDesignInput } from "./helpers/scientific-design.js";

describe("top-journal early scientific reviews", () => {
  it("revalidates frozen gate objects before entering the native producer stage", async () => {
    const fixture = await projectFixture("scientific-runtime-gate");
    try {
      await assert.rejects(
        prepareNativeResearchStage({
          root: fixture.root,
          projectId: fixture.projectId,
          stage: "discover",
          hostAgent: "codex",
        }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "RESEARCH_SCIENTIFIC_GATE_REQUIRED");
          return true;
        },
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires a fresh hash-bound research-design review before discovery", async () => {
    const fixture = await projectFixture("scientific-design-review");
    const auditDestination = join(
      tmpdir(),
      `tiangong-scientific-policy-audit-${process.pid}-${Date.now()}`,
    );
    try {
      const assessmentPath = join(fixture.root, "research-design-assessment.json");
      await writeJsonAtomic(assessmentPath, researchDesignAssessment(fixture.designSha256));
      const packet = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "research-design",
        assessmentPath,
        reviewerAgent: "claude",
        reviewerSessionId: "fresh-design-reviewer-session",
      });
      assert.equal(packet.role, "research-design");
      assert.equal(packet.mechanicalAssessment.issueCodes.length, 0);
      assert.deepEqual(packet.mechanicalAssessment.designEvaluation, {
        readyForDesignReview: true,
        issueCodes: [],
        effectiveIndependentUnits: 4,
        requiredEvidenceRoles: 5,
      });
      assert.match(packet.packetSha256, /^[a-f0-9]{64}$/);
      const packetPolicy = packet.policy as typeof packet.policy & {
        bindingSha256: string;
        objectLocator: string;
      };
      assert.match(packetPolicy.bindingSha256, /^[a-f0-9]{64}$/);
      assert.equal(
        packetPolicy.objectLocator,
        `projects/${fixture.projectId}/scientific/policy/objects/${packetPolicy.bindingSha256}.json`,
      );
      const policyBytes = await readFile(
        join(workspacePaths(fixture.root).control, packetPolicy.objectLocator),
        "utf8",
      );
      assert.equal(sha256Text(policyBytes), packetPolicy.bindingSha256);
      assert.deepEqual(JSON.parse(policyBytes), policyBinding(fixture.projectId));
      const audit = await exportProjectAuditBundle({
        root: fixture.root,
        projectId: fixture.projectId,
        destination: auditDestination,
      });
      assert.ok(
        audit.files.some(
          (file) =>
            file.path === `project/scientific/policy/objects/${packetPolicy.bindingSha256}.json`,
        ),
      );
      assert.deepEqual(packet.lifecycle, {
        producerExecution: "native-host-app",
        baseStages: ["discover", "acquire", "analyze", "synthesize", "review", "close"],
        earlyScientificReviews: ["research-design", "evidence-construct", "pilot-methods"],
        finalPublicationReviews: [
          "evidence",
          "methods-reproducibility",
          "domain-novelty",
          "journal-editor",
        ],
        finalManuscriptFreezeRequired: true,
        newGenerationOnMaterialChange: true,
        revisionReserveIncluded: true,
      });

      const reviewPath = join(fixture.root, "research-design-review.json");
      await writeJsonAtomic(reviewPath, passingReview(packet, "fresh-design-reviewer-session"));
      const submitted = await submitScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "research-design",
        reviewPath,
      });
      assert.equal(submitted.status, "passed");
      const project = await loadProject(fixture.root, fixture.projectId);
      assert.equal(nextReadyPackage(project)?.id, "discover");
      assert.deepEqual(nextScientificGate(project), {
        role: "evidence-construct",
        blocksPackage: "acquire",
        status: "pending",
      });
      await assertScientificGateForStage(fixture.root, project, "discover");

      const persisted = await readFile(
        join(workspacePaths(fixture.root).projects, fixture.projectId, "project.json"),
        "utf8",
      );
      const journal = await readFile(workspacePaths(fixture.root).journal, "utf8");
      assert.doesNotMatch(persisted, /fresh-design-reviewer-session/);
      assert.doesNotMatch(journal, /fresh-design-reviewer-session/);
    } finally {
      await Promise.all([
        rm(fixture.root, { recursive: true, force: true }),
        rm(auditDestination, { recursive: true, force: true }),
      ]);
    }
  });

  it("exposes pending uncertainty freezes as policy-bound future obligations and enforces them at the due gate", async () => {
    const fixture = await projectFixture("scientific-future-freeze", {
      pendingUncertainty: true,
    });
    try {
      const assessmentPath = join(fixture.root, "future-freeze-design-assessment.json");
      await writeJsonAtomic(assessmentPath, researchDesignAssessment(fixture.designSha256));
      const packet = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "research-design",
        assessmentPath,
        reviewerAgent: "claude",
        reviewerSessionId: "future-freeze-design-reviewer",
      });
      const mechanical = packet.mechanicalAssessment as typeof packet.mechanicalAssessment & {
        futureGateObligations: Array<{
          code: string;
          dueGate: string;
          objectIds: string[];
          policyRuleIds: string[];
        }>;
      };
      assert.deepEqual(mechanical.futureGateObligations, [
        {
          code: "UNCERTAINTY_STATE_VALUES_NOT_FROZEN",
          dueGate: "evidence-construct",
          objectIds: ["uncertainty-vehicle-load-factor"],
          policyRuleIds: ["uncertainty-propagated"],
        },
      ]);
      assert.equal(packet.mechanicalAssessment.canPass, true);

      const reviewPath = join(fixture.root, "future-freeze-design-review.json");
      await writeJsonAtomic(reviewPath, passingReview(packet, "future-freeze-design-reviewer"));
      await submitScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "research-design",
        reviewPath,
      });
      await completePackage(fixture, "discover", "evidence.json");
      const evidencePath = join(fixture.root, "future-freeze-evidence-assessment.json");
      await writeJsonAtomic(
        evidencePath,
        evidenceAssessment(fixture.designSha256, fixture.design, true),
      );
      const duePacket = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence-construct",
        assessmentPath: evidencePath,
        reviewerAgent: "claude",
        reviewerSessionId: "future-freeze-evidence-reviewer",
      });
      assert.ok(
        duePacket.mechanicalAssessment.issueCodes.includes("UNCERTAINTY_STATE_VALUES_NOT_FROZEN"),
      );
      assert.ok(duePacket.mechanicalAssessment.issueCodes.includes("POLICY_RULE_DUE_UNRESOLVED"));
      assert.equal(duePacket.mechanicalAssessment.canPass, false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("exposes pending model and environment freezes before they become pilot-methods blockers", async () => {
    const fixture = await projectFixture("scientific-future-model-freeze", {
      pendingModels: true,
    });
    try {
      const assessmentPath = join(fixture.root, "future-model-design-assessment.json");
      await writeJsonAtomic(assessmentPath, researchDesignAssessment(fixture.designSha256));
      const packet = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "research-design",
        assessmentPath,
        reviewerAgent: "claude",
        reviewerSessionId: "future-model-design-reviewer",
      });
      const future = (
        packet.mechanicalAssessment as typeof packet.mechanicalAssessment & {
          futureGateObligations: Array<{
            code: string;
            dueGate: string;
            objectIds: string[];
            policyRuleIds: string[];
          }>;
        }
      ).futureGateObligations;
      assert.deepEqual(
        new Set(future.map((obligation) => obligation.code)),
        new Set(["MODEL_IMPLEMENTATION_NOT_FROZEN", "MODEL_ENVIRONMENT_LOCK_NOT_FROZEN"]),
      );
      assert.ok(future.every((obligation) => obligation.dueGate === "pilot-methods"));
      assert.ok(
        future.every(
          (obligation) =>
            obligation.objectIds.length === 2 &&
            obligation.policyRuleIds.includes("model-calibrated-or-justified"),
        ),
      );
      assert.equal(packet.mechanicalAssessment.canPass, true);

      const reviewPath = join(fixture.root, "future-model-design-review.json");
      await writeJsonAtomic(reviewPath, passingReview(packet, "future-model-design-reviewer"));
      await submitScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "research-design",
        reviewPath,
      });
      await completePackage(fixture, "discover", "evidence.json");
      await passEvidenceConstruct(fixture);
      await completePackage(fixture, "acquire", "acquisition.json");
      await writeJsonAtomic(
        join(
          workspacePaths(fixture.root).projects,
          fixture.projectId,
          "outputs",
          "evidence-snapshot.json",
        ),
        { schemaVersion: 1, snapshotSha256: "e".repeat(64) },
      );
      const pilotPath = join(fixture.root, "future-model-pilot-assessment.json");
      await writeJsonAtomic(pilotPath, pilotAssessment(fixture.designSha256, fixture.design));
      const duePacket = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "pilot-methods",
        assessmentPath: pilotPath,
        reviewerAgent: "claude",
        reviewerSessionId: "future-model-pilot-reviewer",
      });
      for (const code of [
        "MODEL_IMPLEMENTATION_NOT_FROZEN",
        "MODEL_ENVIRONMENT_LOCK_NOT_FROZEN",
        "POLICY_RULE_DUE_UNRESOLVED",
      ]) {
        assert.ok(duePacket.mechanicalAssessment.issueCodes.includes(code), code);
      }
      assert.equal(duePacket.mechanicalAssessment.canPass, false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("promotes inherited gap evidence into the portable design-review packet and rejects drift", async () => {
    const fixture = await projectFixture("scientific-gap-lineage");
    const assessmentPath = join(fixture.root, "gap-lineage-assessment.json");
    const auditDestination = join(
      tmpdir(),
      `tiangong-gap-lineage-audit-${process.pid}-${Date.now()}`,
    );
    try {
      await writeJsonAtomic(assessmentPath, researchDesignAssessment(fixture.designSha256));
      const packet = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "research-design",
        assessmentPath,
        reviewerAgent: "claude",
        reviewerSessionId: "gap-lineage-reviewer-session",
      });
      assert.equal(packet.stageInputs.length, fixture.design.knownGaps.length + 4);
      const typedStageInputs = packet.stageInputs as Array<
        (typeof packet.stageInputs)[number] & {
          purpose: string;
          ownerId: string;
          sourceLocator: string;
          hashBasis: string;
        }
      >;
      assert.deepEqual(
        new Set(typedStageInputs.map((record) => record.purpose)),
        new Set(["inherited-gap", "model-implementation", "model-environment-lock"]),
      );
      assert.ok(typedStageInputs.every((record) => record.hashBasis === "raw-file-bytes"));
      assert.ok(
        typedStageInputs.every(
          (record) =>
            record.ownerId.length > 0 &&
            record.sourceLocator.length > 0 &&
            record.path.includes(record.sha256),
        ),
      );
      assert.ok(
        packet.stageInputs.every((record) =>
          record.path.startsWith(`projects/${fixture.projectId}/scientific/lineage/objects/`),
        ),
      );
      const audit = await exportProjectAuditBundle({
        root: fixture.root,
        projectId: fixture.projectId,
        destination: auditDestination,
      });
      for (const record of packet.stageInputs) {
        assert.ok(
          audit.files.some(
            (file) => file.path === `project/${record.path.split("/").slice(2).join("/")}`,
          ),
        );
      }

      const promoted = packet.stageInputs[0]!;
      await writeFile(join(workspacePaths(fixture.root).control, promoted.path), "tampered\n");
      const reviewPath = join(fixture.root, "gap-lineage-review.json");
      await writeJsonAtomic(reviewPath, passingReview(packet, "gap-lineage-reviewer-session"));
      await assert.rejects(
        submitScientificReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role: "research-design",
          reviewPath,
        }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "RESEARCH_SCIENTIFIC_GATE_INVALID");
          return true;
        },
      );
    } finally {
      await Promise.all([
        rm(fixture.root, { recursive: true, force: true }),
        rm(auditDestination, { recursive: true, force: true }),
      ]);
    }
  });

  it("identifies a drifted inherited-gap object without disclosing its workspace locator", async () => {
    const fixture = await projectFixture("scientific-gap-diagnostic");
    try {
      const gap = fixture.design.knownGaps[0]!;
      const artifact = gap.sourceArtifacts[0]!;
      await writeFile(
        join(workspacePaths(fixture.root).control, artifact.objectLocator),
        "drifted\n",
      );
      const assessmentPath = join(fixture.root, "gap-diagnostic-assessment.json");
      await writeJsonAtomic(assessmentPath, researchDesignAssessment(fixture.designSha256));
      await assert.rejects(
        prepareScientificReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role: "research-design",
          assessmentPath,
          reviewerAgent: "claude",
          reviewerSessionId: "gap-diagnostic-reviewer-session",
        }),
        (error: unknown) => {
          const typed = error as { code?: string; details?: Record<string, unknown> };
          assert.equal(typed.code, "RESEARCH_SCIENTIFIC_GATE_INVALID");
          assert.deepEqual(typed.details, {
            role: "research-design",
            gapId: gap.id,
            artifactKind: artifact.kind,
            reason: "content-hash-mismatch",
          });
          assert.doesNotMatch(JSON.stringify(typed.details), /\.tiangong-research|\/tmp\//);
          return true;
        },
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not let reviewer prose upgrade a failed real-record canary or role coverage", async () => {
    const fixture = await projectFixture("scientific-evidence-review");
    try {
      await passResearchDesign(fixture);
      await completePackage(fixture, "discover", "evidence.json");
      const assessmentPath = join(fixture.root, "evidence-construct-invalid.json");
      const invalidAssessment = evidenceAssessment(fixture.designSha256, fixture.design, false);
      await writeJsonAtomic(assessmentPath, invalidAssessment);
      const packet = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence-construct",
        assessmentPath,
        reviewerAgent: "claude",
        reviewerSessionId: "evidence-reviewer-invalid-session",
      });
      assert.deepEqual(
        new Set(packet.mechanicalAssessment.issueCodes),
        new Set([
          "CANARY_NOT_REAL",
          "CENTRAL_EDGE_UNCONSTRUCTED",
          "EVIDENCE_ROLE_FULLTEXT_INSUFFICIENT",
          "EVIDENCE_ROLE_DATED_INSUFFICIENT",
          "EVIDENCE_ROLE_PEER_REVIEWED_INSUFFICIENT",
          "EVIDENCE_ROLE_DIMENSION_UNCOVERED",
          "EVIDENCE_ROLE_SOURCE_TYPE_UNCOVERED",
          "EVIDENCE_UNIQUE_SOURCE_COVERAGE_INSUFFICIENT",
          "CLOSEST_WORK_DISPOSITION_INCOMPLETE",
          "CENTRAL_CONTEXT_OVERFLOW",
        ]),
      );
      const reviewPath = join(fixture.root, "evidence-review-invalid.json");
      await writeJsonAtomic(reviewPath, passingReview(packet, "evidence-reviewer-invalid-session"));
      const submitted = await submitScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence-construct",
        reviewPath,
      });
      assert.equal(submitted.status, "revision-required");
      assert.equal(nextReadyPackage(await loadProject(fixture.root, fixture.projectId)), undefined);

      const validAssessmentPath = join(fixture.root, "evidence-construct-valid.json");
      await writeJsonAtomic(
        validAssessmentPath,
        evidenceAssessment(fixture.designSha256, fixture.design, true),
      );
      const revisedPacket = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence-construct",
        assessmentPath: validAssessmentPath,
        reviewerAgent: "claude",
        reviewerSessionId: "evidence-reviewer-revised-session",
      });
      const revisedReviewPath = join(fixture.root, "evidence-review-valid.json");
      await writeJsonAtomic(
        revisedReviewPath,
        passingReview(revisedPacket, "evidence-reviewer-revised-session"),
      );
      assert.equal(
        (
          await submitScientificReview({
            root: fixture.root,
            projectId: fixture.projectId,
            role: "evidence-construct",
            reviewPath: revisedReviewPath,
          })
        ).status,
        "passed",
      );
      assert.equal(
        nextReadyPackage(await loadProject(fixture.root, fixture.projectId))?.id,
        "acquire",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not count the same sources repeatedly across evidence roles", async () => {
    const fixture = await projectFixture("scientific-evidence-global-coverage");
    try {
      await passResearchDesign(fixture);
      await completePackage(fixture, "discover", "evidence.json");
      const project = await loadProject(fixture.root, fixture.projectId);
      project.evidenceRequirements = {
        dimensions: fixture.design.evidenceRoles.flatMap((role) => role.coverageDimensionIds),
        sourceTypes: fixture.design.evidenceRoles.flatMap((role) => role.sourceTypeRequirements),
        minSources: 20,
        minFullTextSources: 10,
        minDatedSources: 12,
        publicationDateFrom: "2015-01-01",
        publicationDateTo: "2026-08-15",
      };
      await saveProject(fixture.root, project);
      const assessment = evidenceAssessment(fixture.designSha256, fixture.design, true);
      const sharedIndependent = Array.from({ length: 6 }, (_, index) => `shared-${index}`);
      const sharedFullText = sharedIndependent.slice(0, 6);
      const sharedDated = sharedIndependent.slice(0, 4);
      for (const coverage of assessment.evidenceRoleCoverage) {
        coverage.independentSourceIds = sharedIndependent;
        coverage.fullTextSourceIds = sharedFullText;
        coverage.datedSourceIds = sharedDated;
        coverage.peerReviewedSourceIds = sharedFullText;
      }
      const assessmentPath = join(fixture.root, "evidence-construct-reused-sources.json");
      await writeJsonAtomic(assessmentPath, assessment);
      const packet = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "evidence-construct",
        assessmentPath,
        reviewerAgent: "claude",
        reviewerSessionId: "evidence-reviewer-reused-source-session",
      });
      assert.deepEqual(
        new Set(packet.mechanicalAssessment.issueCodes),
        new Set([
          "EVIDENCE_UNIQUE_SOURCE_COVERAGE_INSUFFICIENT",
          "EVIDENCE_UNIQUE_FULLTEXT_COVERAGE_INSUFFICIENT",
          "EVIDENCE_UNIQUE_DATED_COVERAGE_INSUFFICIENT",
        ]),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a pilot that turns 4 independent structures into false 200000-resample precision", async () => {
    const fixture = await projectFixture("scientific-pilot-review");
    try {
      await passResearchDesign(fixture);
      await completePackage(fixture, "discover", "evidence.json");
      await passEvidenceConstruct(fixture);
      await completePackage(fixture, "acquire", "acquisition.json");
      await writeJsonAtomic(
        join(
          workspacePaths(fixture.root).projects,
          fixture.projectId,
          "outputs",
          "evidence-snapshot.json",
        ),
        { schemaVersion: 1, snapshotSha256: "e".repeat(64) },
      );

      const invalidPath = join(fixture.root, "pilot-invalid.json");
      await writeJsonAtomic(
        invalidPath,
        pilotAssessment(fixture.designSha256, fixture.design, {
          originalUnitCount: 12,
          independentClusterCount: 4,
          effectiveIndependentUnits: 12,
          clusterKeyIds: ["row-id"],
          resamplingUnit: "cell",
          resamplingIterations: 200000,
          resamplingMethod: "cluster-bootstrap",
          resamplingStateSpaceSize: 200000,
          reportingPrecision: "Report six decimal places from 200000 nominal resamples.",
          minimumDetectableDifference: "A 0.0001 discrepancy is detectable.",
        }),
      );
      const packet = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "pilot-methods",
        assessmentPath: invalidPath,
        reviewerAgent: "claude",
        reviewerSessionId: "pilot-reviewer-invalid-session",
      });
      assert.deepEqual(
        new Set(packet.mechanicalAssessment.issueCodes),
        new Set([
          "EFFECTIVE_SAMPLE_SIZE_INFLATED",
          "RESAMPLING_UNIT_INVALID",
          "PILOT_SAMPLE_DEFINITION_DRIFT",
          "PILOT_CLUSTER_DEFINITION_DRIFT",
          "PILOT_RESAMPLING_PLAN_DRIFT",
          "PILOT_PRECISION_PLAN_DRIFT",
        ]),
      );
      const invalidReview = join(fixture.root, "pilot-review-invalid.json");
      await writeJsonAtomic(invalidReview, passingReview(packet, "pilot-reviewer-invalid-session"));
      assert.equal(
        (
          await submitScientificReview({
            root: fixture.root,
            projectId: fixture.projectId,
            role: "pilot-methods",
            reviewPath: invalidReview,
          })
        ).status,
        "revision-required",
      );
      assert.equal(nextReadyPackage(await loadProject(fixture.root, fixture.projectId)), undefined);

      const validPath = join(fixture.root, "pilot-valid.json");
      await writeJsonAtomic(validPath, pilotAssessment(fixture.designSha256, fixture.design));
      const validPacket = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "pilot-methods",
        assessmentPath: validPath,
        reviewerAgent: "claude",
        reviewerSessionId: "pilot-reviewer-valid-session",
      });
      const validReview = join(fixture.root, "pilot-review-valid.json");
      await writeJsonAtomic(
        validReview,
        passingReview(validPacket, "pilot-reviewer-valid-session"),
      );
      await submitScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "pilot-methods",
        reviewPath: validReview,
      });
      const project = await loadProject(fixture.root, fixture.projectId);
      assert.equal(nextReadyPackage(project)?.id, "analyze");
      await assertScientificGateForStage(fixture.root, project, "analyze");
      const status = await inspectScientificReviewStatus(fixture.root, fixture.projectId);
      assert.equal(status.reviewState, "complete");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects session reuse and tampered immutable review bytes", async () => {
    const fixture = await projectFixture("scientific-review-integrity");
    try {
      const assessmentPath = join(fixture.root, "design-assessment.json");
      await writeJsonAtomic(assessmentPath, researchDesignAssessment(fixture.designSha256));
      const packet = await prepareScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "research-design",
        assessmentPath,
        reviewerAgent: "claude",
        reviewerSessionId: "one-reviewer-session",
      });
      const reviewPath = join(fixture.root, "design-review.json");
      await writeJsonAtomic(reviewPath, passingReview(packet, "one-reviewer-session"));
      await submitScientificReview({
        root: fixture.root,
        projectId: fixture.projectId,
        role: "research-design",
        reviewPath,
      });
      await completePackage(fixture, "discover", "evidence.json");
      const evidencePath = join(fixture.root, "evidence-assessment.json");
      await writeJsonAtomic(
        evidencePath,
        evidenceAssessment(fixture.designSha256, fixture.design, true),
      );
      await assert.rejects(
        prepareScientificReview({
          root: fixture.root,
          projectId: fixture.projectId,
          role: "evidence-construct",
          assessmentPath: evidencePath,
          reviewerAgent: "claude",
          reviewerSessionId: "one-reviewer-session",
        }),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            "RESEARCH_SCIENTIFIC_REVIEW_SESSION_REUSED",
          );
          return true;
        },
      );

      const project = await loadProject(fixture.root, fixture.projectId);
      const packetPolicy = packet.policy as typeof packet.policy & { objectLocator: string };
      const storedPolicy = join(workspacePaths(fixture.root).control, packetPolicy.objectLocator);
      const originalPolicyBytes = await readFile(storedPolicy, "utf8");
      await writeFile(storedPolicy, '{"tampered":true}\n');
      await assert.rejects(
        assertScientificGateForStage(fixture.root, project, "discover"),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "RESEARCH_SCIENTIFIC_GATE_INVALID");
          return true;
        },
      );
      await writeFile(storedPolicy, originalPolicyBytes);
      const reviewSha = project.scientificDesign!.gates["research-design"].reviewSha256!;
      const storedReview = join(
        workspacePaths(fixture.root).projects,
        fixture.projectId,
        "scientific",
        "reviews",
        "research-design",
        `${reviewSha}.json`,
      );
      await writeFile(storedReview, '{"tampered":true}\n');
      await assert.rejects(
        assertScientificGateForStage(fixture.root, project, "discover"),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "RESEARCH_SCIENTIFIC_GATE_INVALID");
          return true;
        },
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("publishes closed schemas for every early review role", () => {
    for (const role of [
      "research-design",
      "evidence-construct",
      "pilot-methods",
    ] as ScientificReviewRole[]) {
      assert.equal(scientificGateAssessmentSchema(role).additionalProperties, false);
      assert.equal(scientificReviewSchema(role).additionalProperties, false);
    }
  });

  it("exposes review prepare, submit, schemas, status, and the next safe action through the CLI", async () => {
    const fixture = await projectFixture("scientific-review-cli");
    try {
      const assessmentPath = join(fixture.root, "cli-design-assessment.json");
      await writeJsonAtomic(assessmentPath, researchDesignAssessment(fixture.designSha256));
      const prepared = await invokeCli([
        "research",
        "project",
        "scientific",
        "review",
        "prepare",
        fixture.projectId,
        "--role",
        "research-design",
        "--assessment",
        assessmentPath,
        "--reviewer-agent",
        "claude",
        "--reviewer-session",
        "cli-independent-review-session",
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(prepared.exitCode, 0, prepared.stderr);
      const packet = JSON.parse(prepared.stdout) as ScientificReviewPacket;
      const reviewPath = join(fixture.root, "cli-design-review.json");
      await writeJsonAtomic(reviewPath, passingReview(packet, "cli-independent-review-session"));
      const submitted = await invokeCli([
        "research",
        "project",
        "scientific",
        "review",
        "submit",
        fixture.projectId,
        "--role",
        "research-design",
        "--review",
        reviewPath,
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(submitted.exitCode, 0, submitted.stderr);

      const statusResult = await invokeCli([
        "research",
        "status",
        "--project",
        fixture.projectId,
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(statusResult.exitCode, 0, statusResult.stderr);
      const status = JSON.parse(statusResult.stdout) as {
        projects: Array<{
          scientificReview: { reviewState: string; nextGate: { role: string } };
          recommendedAction: string;
        }>;
      };
      assert.equal(status.projects[0]?.scientificReview.reviewState, "awaiting-review");
      assert.equal(status.projects[0]?.scientificReview.nextGate.role, "evidence-construct");
      assert.match(status.projects[0]?.recommendedAction ?? "", /evidence-construct/);

      for (const role of [
        "research-design",
        "evidence-construct",
        "pilot-methods",
      ] as ScientificReviewRole[]) {
        for (const kind of ["scientific-assessment", "scientific-review"]) {
          const schemaResult = await invokeCli([
            "research",
            "schema",
            "show",
            `${kind}-${role}`,
            "--json",
          ]);
          assert.equal(schemaResult.exitCode, 0, schemaResult.stderr);
          assert.equal(
            (JSON.parse(schemaResult.stdout) as { additionalProperties: boolean })
              .additionalProperties,
            false,
          );
        }
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function projectFixture(
  projectId: string,
  options: { pendingUncertainty?: boolean; pendingModels?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-review-"));
  await initializeResearchWorkspace(root, "Scientific review workflow");
  const policyRules = [
    ...(options.pendingUncertainty ? ["uncertainty-propagated"] : []),
    ...(options.pendingModels ? ["model-calibrated-or-justified"] : []),
  ];
  const policy = policyBinding(projectId, policyRules);
  const designInput = await scientificDesignInput(root, projectId, {
    targetJournal: policy.targetJournal,
    policyRules,
    ...(options.pendingUncertainty === undefined
      ? {}
      : { pendingUncertainty: options.pendingUncertainty }),
    ...(options.pendingModels === undefined ? {} : { pendingModels: options.pendingModels }),
  });
  const project = await initializeProject(
    root,
    projectId,
    "How can model discrepancy be bounded without inventing field validation?",
    undefined,
    false,
    undefined,
    policy,
    designInput,
  );
  return {
    root,
    projectId,
    designSha256: project.scientificDesign!.designSha256,
    design: designInput.design.contract,
  };
}

async function passResearchDesign(fixture: Awaited<ReturnType<typeof projectFixture>>) {
  const assessmentPath = join(fixture.root, `${fixture.projectId}-design-assessment.json`);
  await writeJsonAtomic(assessmentPath, researchDesignAssessment(fixture.designSha256));
  const packet = await prepareScientificReview({
    root: fixture.root,
    projectId: fixture.projectId,
    role: "research-design",
    assessmentPath,
    reviewerAgent: "claude",
    reviewerSessionId: `${fixture.projectId}-design-reviewer`,
  });
  const reviewPath = join(fixture.root, `${fixture.projectId}-design-review.json`);
  await writeJsonAtomic(reviewPath, passingReview(packet, `${fixture.projectId}-design-reviewer`));
  await submitScientificReview({
    root: fixture.root,
    projectId: fixture.projectId,
    role: "research-design",
    reviewPath,
  });
}

async function passEvidenceConstruct(fixture: Awaited<ReturnType<typeof projectFixture>>) {
  const assessmentPath = join(fixture.root, `${fixture.projectId}-evidence-assessment.json`);
  await writeJsonAtomic(
    assessmentPath,
    evidenceAssessment(fixture.designSha256, fixture.design, true),
  );
  const packet = await prepareScientificReview({
    root: fixture.root,
    projectId: fixture.projectId,
    role: "evidence-construct",
    assessmentPath,
    reviewerAgent: "claude",
    reviewerSessionId: `${fixture.projectId}-evidence-reviewer`,
  });
  const reviewPath = join(fixture.root, `${fixture.projectId}-evidence-review.json`);
  await writeJsonAtomic(
    reviewPath,
    passingReview(packet, `${fixture.projectId}-evidence-reviewer`),
  );
  await submitScientificReview({
    root: fixture.root,
    projectId: fixture.projectId,
    role: "evidence-construct",
    reviewPath,
  });
}

async function completePackage(
  fixture: Awaited<ReturnType<typeof projectFixture>>,
  packageId: "discover" | "acquire",
  outputName: string,
) {
  const project = await loadProject(fixture.root, fixture.projectId);
  const workPackage = project.packages.find((candidate) => candidate.id === packageId)!;
  workPackage.status = "complete";
  workPackage.completedAt = new Date().toISOString();
  await writeJsonAtomic(
    join(workspacePaths(fixture.root).projects, fixture.projectId, "outputs", outputName),
    { schemaVersion: 1, packageId },
  );
  await saveProject(fixture.root, project);
}

function researchDesignAssessment(designSha256: string) {
  return {
    schemaVersion: 1,
    role: "research-design",
    designSha256,
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
  };
}

function evidenceAssessment(
  designSha256: string,
  design: Awaited<ReturnType<typeof projectFixture>>["design"],
  valid: boolean,
) {
  return {
    schemaVersion: 1,
    role: "evidence-construct",
    designSha256,
    recommendation: "pass",
    constructCanary: {
      usesRealRecords: valid,
      outcomeBlind: true,
      resultValuesInspected: false,
      rowCount: valid ? 10 : 0,
      constructedEdgeIds: valid
        ? design.edges.filter((edge) => edge.role === "central").map((edge) => edge.id)
        : [],
      failedEdgeIds: valid
        ? []
        : design.edges.filter((edge) => edge.role === "central").map((edge) => edge.id),
      artifactSha256s: valid ? ["c".repeat(64)] : [],
    },
    evidenceRoleCoverage: design.evidenceRoles.map((role, roleIndex) => ({
      roleId: role.id,
      fullTextSourceIds: valid
        ? Array.from({ length: role.minimumFullText }, (_, index) => `source-${roleIndex}-${index}`)
        : [],
      independentSourceIds: valid
        ? Array.from(
            { length: role.minimumIndependentSources },
            (_, index) => `source-${roleIndex}-${index}`,
          )
        : [],
      datedSourceIds: valid
        ? Array.from(
            { length: role.minimumDatedSources },
            (_, index) => `source-${roleIndex}-${index}`,
          )
        : [],
      peerReviewedSourceIds:
        valid && role.peerReviewedRequired
          ? Array.from(
              { length: role.minimumFullText },
              (_, index) => `source-${roleIndex}-${index}`,
            )
          : [],
      dimensionIds: valid ? role.coverageDimensionIds : [],
      sourceTypes: valid ? role.sourceTypeRequirements : [],
    })),
    closestWorkDispositionComplete: valid,
    centralEvidenceFitsContext: valid,
    findings: [],
  };
}

function pilotAssessment(
  designSha256: string,
  design: Awaited<ReturnType<typeof projectFixture>>["design"],
  centralAuditOverride: Partial<{
    originalUnitCount: number;
    independentClusterCount: number;
    effectiveIndependentUnits: number;
    clusterKeyIds: string[];
    resamplingUnit: string;
    resamplingIterations: number;
    resamplingMethod: "exact-enumeration" | "cluster-bootstrap" | "none";
    resamplingStateSpaceSize: number;
    reportingPrecision: string;
    minimumDetectableDifference: string | null;
  }> = {},
) {
  const validationAudits = design.validationPlans.map((plan) => ({
    validationPlanId: plan.id,
    outcomeBlind: plan.outcomeBlind,
    originalUnitCount: plan.originalUnitCount,
    independentClusterCount: plan.independentClusterCount,
    effectiveIndependentUnits: plan.effectiveIndependentUnits,
    clusterKeyIds: [...plan.clusterKeyIds],
    independenceJustification: plan.independenceJustification,
    resamplingUnit: plan.resamplingUnit,
    resamplingIterations: plan.resamplingIterations,
    resamplingMethod: plan.resamplingMethod,
    resamplingStateSpaceSize: plan.resamplingStateSpaceSize,
    reportingPrecision: plan.reportingPrecision,
    minimumDetectableDifference: plan.minimumDetectableDifference,
    independentValidationStatus: plan.independentValidation.status,
    independentValidationGapId: plan.independentValidation.gapId,
  }));
  const centralAudit = validationAudits.find(
    (audit) => audit.validationPlanId === "validation-cross-model",
  );
  assert.ok(centralAudit);
  Object.assign(centralAudit, centralAuditOverride);
  return {
    schemaVersion: 1,
    role: "pilot-methods",
    designSha256,
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
    validationAudits,
    decisionLossMetricIds: design.baselinePlan.decisionLossMetrics.map((metric) => metric.id),
    findings: [],
  };
}

function passingReview(packet: ScientificReviewPacket, reviewerSessionId: string) {
  return {
    schemaVersion: 1,
    role: packet.role,
    packetSha256: packet.packetSha256,
    reviewerSessionSha256: packet.reviewer.sessionSha256,
    decision: "pass",
    findings: [],
    boundedRecommendation: `Independent review from ${reviewerSessionId.length} opaque bytes passes the exact packet.`,
  };
}

function policyBinding(projectId: string, resolvedRules: string[] = []): ResearchPolicyBinding {
  return {
    goal: "top-journal",
    projectId,
    articleType: "computational-modeling",
    field: "pavement-engineering",
    journalClass: "discipline-flagship",
    targetJournal: "International Journal of Pavement Engineering",
    resolvedPolicySha256: "a".repeat(64),
    approvalSha256: "b".repeat(64),
    verdictCeiling: "target-journal-submission-ready",
    documents: [],
    resolvedRules,
    resolvedConstraints: {},
    requiredReviewers: ["evidence", "methods-reproducibility", "domain-novelty", "journal-editor"],
    approvedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2027-08-14T00:00:00.000Z",
  };
}

async function invokeCli(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    env: {},
    stdout: { write: (chunk) => ((stdout += chunk), true) },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
  };
  const exitCode = await runCli(argv, io);
  return { exitCode, stdout, stderr };
}
