import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadCurrentEvidenceSnapshot } from "../src/research/workspace/acquisition.js";
import { loadBoundAcquisitionDesign } from "../src/research/workspace/acquisition-routes.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import {
  freezeEvidenceContentSnapshot,
  registerEvidenceAtom,
} from "../src/research/workspace/content-evidence.js";
import { recordDiscoveryAssessmentBatch } from "../src/research/workspace/discovery.js";
import { listEvidenceCandidates } from "../src/research/workspace/evidence-ledger.js";
import {
  addProjectInput,
  initializeProject,
  loadProject,
} from "../src/research/workspace/projects.js";
import { recordScientificFulfillment } from "../src/research/workspace/scientific-fulfillment.js";
import {
  initializeResearchPolicy,
  approveResearchPolicy,
  loadApprovedResearchPolicy,
} from "../src/research/workspace/research-policy.js";
import {
  prepareNativeResearchStage,
  submitNativeResearchStage,
} from "../src/research/workspace/runtime.js";
import {
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";
import type { ResearchPolicyBinding } from "../src/research/workspace/types.js";
import { passResearchDesignGate, scientificDesignInput } from "./helpers/scientific-design.js";

describe("predeclared scientific parameter fulfillment", () => {
  it("binds exact source-derived states after real native stage admission without changing their identity or units", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-parameter-fulfillment-"));
    const projectId = "parameter-fulfillment";
    try {
      await initializeResearchWorkspace(root, undefined);
      await lockCapabilities(root);
      const policy = await parameterPolicy(root, projectId);
      const designInput = await scientificDesignInput(root, projectId, {
        pendingUncertainty: true,
        policyRules: policy.resolvedRules,
        approvalStatus: "candidate-only",
      });
      const original = designInput.design.contract;
      const parameter = original.uncertaintyParameters.find(
        (item) => item.stateValueStatus === "pending-source-acquisition",
      )!;
      const project = await initializeProject(
        root,
        projectId,
        "Can exact admitted source states fulfill their already declared uncertainty slots?",
        undefined,
        false,
        undefined,
        policy,
        designInput,
      );
      const inputPath = join(root, "source.txt");
      const states = parameter.states.map((state, index) => ({
        stateId: state.id,
        value: String(0.9 + index * 0.1),
        evidenceAtomIds: ["parameter-source-atom"],
      }));
      await writeFile(
        inputPath,
        `Synthetic source states for a deterministic protocol test only: ${states.map((state) => `${state.stateId}=${state.value}`).join(", ")}.\n`,
      );
      await addProjectInput(root, projectId, inputPath, "primary");
      await passResearchDesignGate(root, projectId);
      const discover = await prepareNativeResearchStage({
        root,
        projectId,
        stage: "discover",
        hostAgent: "codex",
      });
      const candidate = (await listEvidenceCandidates(root, projectId))[0]!;
      await recordDiscoveryAssessmentBatch({
        root,
        projectId,
        value: {
          schemaVersion: 1,
          assessments: [
            {
              decision: "admit",
              candidateId: candidate.id,
              sourceId: "parameter-source",
              sourceType: "primary",
              relevance: "Exact synthetic source-derived states.",
              quality: {
                level: "primary",
                rationale: "Deterministic synthetic protocol input, not scientific evidence.",
              },
              applicability: "Protocol test only.",
              coverageDimensions: ["research-question"],
              limitations: [],
            },
          ],
        },
      });
      const output = join(root, "stage-output.json");
      await writeJsonAtomic(output, {
        schemaVersion: 2,
        limitations: [],
        dimensionJudgments: [{ id: "research-question", status: "covered" }],
        gaps: [],
      });
      await submitNativeResearchStage({
        root,
        projectId,
        sessionId: discover.sessionId,
        outputPath: output,
        confirmedModel: discover.expectedModel,
      });
      const acquire = await prepareNativeResearchStage({
        root,
        projectId,
        stage: "acquire",
        hostAgent: "codex",
      });
      await writeJsonAtomic(output, {
        schemaVersion: 1,
        decisions: [
          {
            sourceId: "parameter-source",
            candidateId: candidate.id,
            artifactIds: [],
            status: "accepted",
            rationale: "The admitted input is the exact readable source.",
            limitations: [],
          },
        ],
        gaps: [],
        limitations: [],
      });
      await submitNativeResearchStage({
        root,
        projectId,
        sessionId: acquire.sessionId,
        outputPath: output,
        confirmedModel: acquire.expectedModel,
      });
      const snapshot = await loadCurrentEvidenceSnapshot(root, projectId);
      const artifact = snapshot.artifacts[0]!;
      const atom = await registerEvidenceAtom({
        root,
        projectId,
        value: {
          schemaVersion: 1,
          atomId: "parameter-source-atom",
          sourceId: "parameter-source",
          candidateId: candidate.id,
          artifactId: artifact.artifactId,
          locator: { kind: "line-range", startLine: 1, endLine: 1 },
          statement: "Source states for the protocol fixture.",
          evidenceRoleIds: [parameter.sourceEvidenceRoleIds[0]!],
          coverageDimensionIds: ["research-question"],
          evidenceFunction: "support",
          scope: "Synthetic protocol fixture, not a research conclusion.",
          limitations: [],
        },
      });
      await freezeEvidenceContentSnapshot(root, projectId);
      const input = {
        schemaVersion: 1,
        designSha256: project.scientificDesign!.designSha256,
        parentFulfillmentSha256: null,
        reason:
          "Freeze exactly the source-derived states declared before discovery; all scientific and coverage gates remain in force.",
        modelImplementations: [],
        environmentLocks: [],
        parameterStates: [{ parameterId: parameter.id, states }],
      };
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      await assert.rejects(
        recordScientificFulfillment(root, projectId, {
          ...input,
          parameterStates: [
            {
              parameterId: parameter.id,
              states: states.map((state) => ({ ...state, evidenceAtomIds: ["invented-atom"] })),
            },
          ],
        }),
      );
      await assert.rejects(
        recordScientificFulfillment(root, projectId, {
          ...input,
          parameterStates: [
            {
              parameterId: parameter.id,
              states: [{ ...states[0], value: "NaN" }, ...states.slice(1)],
            },
          ],
        }),
      );
      assert.equal(
        await readFile(workspacePaths(root).journal, "utf8"),
        journal,
        "failed parameter intake commits nothing",
      );
      const record = await recordScientificFulfillment(root, projectId, input);
      assert.deepEqual(await recordScientificFulfillment(root, projectId, input), record);
      assert.ok(
        record.parameterStates[0]!.states.every(
          (state) => state.atoms[0]?.sha256 === atom.atomSha256,
        ),
      );
      const effective = await loadBoundAcquisitionDesign(root, await loadProject(root, projectId));
      const frozen = effective.uncertaintyParameters.find((item) => item.id === parameter.id)!;
      assert.equal(frozen.stateValueStatus, "frozen");
      assert.equal(frozen.freezeBeforeGate, parameter.freezeBeforeGate);
      assert.deepEqual(
        frozen.states.map(({ value: _value, ...state }) => state),
        parameter.states.map(({ value: _value, ...state }) => state),
      );
      assert.deepEqual(effective.claims, original.claims);
      assert.deepEqual(effective.factors, original.factors);
      await assert.rejects(
        recordScientificFulfillment(root, projectId, {
          ...input,
          parentFulfillmentSha256: record.recordSha256,
        }),
        /pending slots/,
      );
      assert.equal(
        (await loadProject(root, projectId)).scientificDesign!.gates["research-design"].status,
        "passed",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function parameterPolicy(root: string, projectId: string): Promise<ResearchPolicyBinding> {
  const sourceRoot = join(root, "synthetic-policy");
  const reviewerRoles = ["evidence", "methods-reproducibility", "domain-novelty", "journal-editor"];
  const documents = [
    ["baseline/top-journal.md", "baseline", "bundled-default"],
    ["article-types/computational-modeling.md", "article-type", "bundled-default"],
    ["fields/pavement-engineering.md", "field", "bundled-default"],
    ["journal-classes/discipline-flagship.md", "journal-class", "bundled-default"],
    ...reviewerRoles.map((role) => [
      `reviewer-rubrics/${role}.md`,
      "reviewer-rubric",
      "bundled-default",
    ]),
    ["project/publication-brief.md", "publication-brief", "project-template"],
    ["journals/exact-journal-template.md", "exact-journal", "exact-journal-template"],
  ];
  for (const [path, kind, templateClass] of documents) {
    const metadata = {
      schemaVersion: 1,
      id: `fixture.${path!.replaceAll("/", ".").replace(/\.md$/, "")}`,
      kind,
      templateClass,
      policyVersion: 1,
      targetTier: "top",
      articleType: "computational-modeling",
      field: "pavement-engineering",
      journalClass: "discipline-flagship",
      targetJournal: "none",
      centralQuestion:
        "Can a frozen source parameter be filled without changing its scientific identity?",
      centralClaim: "Protocol behavior is validated using explicitly synthetic sources.",
      centralOutcome: "Correct hash and parameter bindings, not a scientific estimate.",
      contributionType: "protocol-fixture",
      rules: ["uncertainty-propagated"],
      constraints: {
        requireScientificDesignContract: true,
        requireEarlyScientificReviews: true,
        requireRealRecordConstructCanary: true,
      },
      requiredReviewers: reviewerRoles,
      reviewAfterDays: 365,
    };
    await writeTextAtomic(
      join(sourceRoot, "assets/research-policy/defaults", path!),
      `---\n${JSON.stringify(metadata)}\n---\n\n# Synthetic policy\n\nZero-cost deterministic protocol fixture, not journal approval.\n`,
    );
  }
  await initializeResearchPolicy({
    root,
    projectId,
    sourceRoot,
    articleType: "computational-modeling",
    field: "pavement-engineering",
    journalClass: "discipline-flagship",
  });
  await approveResearchPolicy(root, projectId, { confirm: true, acknowledgeDefaults: true });
  return loadApprovedResearchPolicy(root, projectId);
}
