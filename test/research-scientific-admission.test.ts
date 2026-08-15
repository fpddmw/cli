import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/io.js";
import { evaluateProjectPreflight } from "../src/research/workspace/preflight.js";
import {
  forkProject,
  initializeProject,
  loadProject,
  nextReadyPackage,
  nextScientificGate,
} from "../src/research/workspace/projects.js";
import {
  readAndVerifyScientificDesign,
  type VerifiedScientificDesign,
} from "../src/research/workspace/scientific-design.js";
import { sha256File, workspacePaths } from "../src/research/workspace/storage.js";
import type { ResearchPolicyBinding } from "../src/research/workspace/types.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";
import { scientificDesignInput } from "./helpers/scientific-design.js";

const validFixture = resolve("test/fixtures/scientific-design/ev-r9-narrowed-valid.json");

describe("top-journal scientific design admission", () => {
  it("requires, freezes, and hash-binds a native-producer scientific design", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-admission-"));
    const projectId = "scientific-admission";
    try {
      await initializeResearchWorkspace(root, undefined);
      await assert.rejects(
        initializeProject(
          root,
          projectId,
          "How should compatible engineering models be compared without claiming field truth?",
          undefined,
          false,
          undefined,
          policy(projectId),
        ),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "RESEARCH_SCIENTIFIC_DESIGN_REQUIRED");
          return true;
        },
      );

      const verified = await projectDesign(root, projectId);
      const project = await initializeProject(
        root,
        projectId,
        "How should compatible engineering models be compared without claiming field truth?",
        undefined,
        false,
        undefined,
        policy(projectId),
        {
          design: verified,
          producerAgent: "codex",
          producerSessionId: "native-producer-session-do-not-persist",
        },
      );

      assert.equal(project.scientificDesign?.designSha256, verified.sha256);
      assert.equal(project.scientificDesign?.centralStudyKind, "cross-model-comparison");
      assert.equal(project.scientificDesign?.producer.agent, "codex");
      assert.match(project.scientificDesign?.producer.sessionSha256 ?? "", /^[a-f0-9]{64}$/);
      assert.equal(nextReadyPackage(project), undefined);
      assert.deepEqual(nextScientificGate(project), {
        role: "research-design",
        blocksPackage: "discover",
        status: "pending",
      });

      const objectPath = join(root, ".tiangong-research", project.scientificDesign!.objectLocator);
      assert.equal((await lstat(objectPath)).isFile(), true);
      assert.equal(await sha256File(objectPath), verified.sha256);
      const persisted = await readFile(
        join(root, ".tiangong-research", "projects", projectId, "project.json"),
        "utf8",
      );
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.doesNotMatch(persisted, /native-producer-session-do-not-persist/);
      assert.doesNotMatch(journal, /native-producer-session-do-not-persist/);
      assert.equal(
        (await loadProject(root, projectId)).scientificDesign?.designSha256,
        verified.sha256,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects project-id drift and a symlinked design source", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-source-"));
    try {
      await assert.rejects(
        readAndVerifyScientificDesign(validFixture, "another-project"),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            "RESEARCH_SCIENTIFIC_DESIGN_PROJECT_MISMATCH",
          );
          return true;
        },
      );
      const link = join(root, "design.json");
      await symlink(validFixture, link);
      await assert.rejects(readAndVerifyScientificDesign(link), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "RESEARCH_SCIENTIFIC_DESIGN_PATH_INVALID");
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds journal candidate approval status to the exact Research Policy at admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-policy-status-"));
    try {
      await initializeResearchWorkspace(root, undefined);
      const exactId = "scientific-exact-policy-status";
      await assert.rejects(
        initializeProject(
          root,
          exactId,
          "Can a candidate journal be treated as approved?",
          undefined,
          false,
          undefined,
          policy(exactId),
          {
            design: await projectDesign(root, exactId, "candidate-only"),
            producerAgent: "codex",
            producerSessionId: "exact-policy-candidate-session",
          },
        ),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            "RESEARCH_SCIENTIFIC_DESIGN_POLICY_MISMATCH",
          );
          return true;
        },
      );

      const genericId = "scientific-generic-policy-status";
      const genericPolicy = policy(genericId);
      genericPolicy.targetJournal = null;
      await assert.rejects(
        initializeProject(
          root,
          genericId,
          "Can a generic journal class silently approve one exact journal?",
          undefined,
          false,
          undefined,
          genericPolicy,
          {
            design: await projectDesign(root, genericId, "policy-approved"),
            producerAgent: "codex",
            producerSessionId: "generic-policy-approved-session",
          },
        ),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            "RESEARCH_SCIENTIFIC_DESIGN_POLICY_MISMATCH",
          );
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reserves all early reviews, final reviews, and one revision before admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-budget-"));
    const projectId = "scientific-budget";
    try {
      await initializeResearchWorkspace(root, undefined, "production-research");
      const design = await projectDesign(root, projectId);
      const first = await evaluateProjectPreflight(
        root,
        "Can the full article lifecycle close?",
        null,
        null,
        {
          scientificDesign: design,
          publicationPolicy: policy(projectId),
        },
      );
      assert.equal(first.budget.lifecycleReservation.enabled, true);
      assert.deepEqual(first.budget.lifecycleReservation.reviewCounts, {
        earlyScientific: 3,
        finalPublication: 4,
        revisions: 1,
      });
      assert.ok(first.budget.lifecycleReservation.totalTokens > first.budget.tokenReservation);
      assert.ok(first.budget.lifecycleReservation.totalWallSeconds > first.budget.wallReservation);

      const configPath = workspacePaths(root).config;
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        budget: { maxTokens: number };
      };
      config.budget.maxTokens = first.budget.lifecycleReservation.totalTokens - 1;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const blocked = await evaluateProjectPreflight(
        root,
        "Can the full article lifecycle close?",
        null,
        null,
        { scientificDesign: design, publicationPolicy: policy(projectId) },
      );
      assert.ok(
        blocked.gaps.some((gap) =>
          gap.startsWith("full-lifecycle-token-reservation-exceeds-total:"),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cross-checks journal approval, evidence-role floors, dimensions, and validation disposition before admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-cross-contract-"));
    const projectId = "scientific-cross-contract";
    try {
      await initializeResearchWorkspace(root, undefined);
      const design = await projectDesign(root, projectId);
      const publicationPolicy = policy(projectId);
      publicationPolicy.resolvedRules = ["independent-validation-required"];
      (design.contract as unknown as Record<string, unknown>).policyRuleDispositions = [];
      const requirements = {
        dimensions: [
          "central-model-definitions",
          "closest-prior-work",
          "cross-model-validation",
          "pavement-context",
          "overlay-rule",
          "material-conversion",
          "counterevidence",
          "limitations",
        ],
        sourceTypes: [
          "academic-paper",
          "official-data",
          "government-technical-report",
          "standard",
          "counterevidence",
        ],
        minSources: 20,
        minFullTextSources: 10,
        minDatedSources: 12,
        publicationDateFrom: "2015-01-01",
        publicationDateTo: "2026-08-15",
      };
      const valid = await evaluateProjectPreflight(
        root,
        "Can the EV study clear design?",
        requirements,
        null,
        {
          scientificDesign: design,
          publicationPolicy,
        },
      );
      assert.ok(
        valid.gaps.includes(
          "scientific-design-contract:policy-rule-disposition-missing:independent-validation-required",
        ),
      );

      const dischargedDesign = structuredClone(design);
      (
        dischargedDesign.contract as unknown as {
          policyRuleDispositions: Array<Record<string, unknown>>;
        }
      ).policyRuleDispositions = [
        {
          ruleId: "independent-validation-required",
          status: "satisfied-by-design",
          dueGate: "research-design",
          rationale:
            "The central validation plan binds a genuinely independent data-generating process before discovery.",
          claimIds: ["claim-discrepancy"],
          evidenceRoleIds: ["role-central-data"],
          validationPlanIds: ["validation-cross-model"],
          knownGapIds: [],
          uncertaintyParameterIds: [],
          modelStructureIds: [],
        },
      ];
      const dischargedPlan = dischargedDesign.contract.validationPlans.find(
        (plan) => plan.id === "validation-cross-model",
      );
      assert.ok(dischargedPlan);
      dischargedPlan.independentValidation.status = "available";
      dischargedPlan.independentValidation.gapId = null;
      dischargedPlan.independentDataGeneratingProcess = true;
      const discharged = await evaluateProjectPreflight(
        root,
        "Can the EV study clear design?",
        requirements,
        null,
        { scientificDesign: dischargedDesign, publicationPolicy },
      );
      assert.deepEqual(
        discharged.gaps.filter((gap) => gap.startsWith("scientific-design-contract:")),
        [],
      );

      const badDesign = structuredClone(design);
      (
        badDesign.contract as unknown as {
          policyRuleDispositions: Array<Record<string, unknown>>;
        }
      ).policyRuleDispositions = [
        {
          ruleId: "independent-validation-required",
          status: "scope-limited",
          dueGate: "research-design",
          rationale:
            "The design makes no model-accuracy claim because field validation is unavailable.",
          claimIds: ["claim-discrepancy"],
          evidenceRoleIds: ["role-central-data"],
          validationPlanIds: ["validation-cross-model"],
          knownGapIds: ["gap-powertrain-wim"],
          uncertaintyParameterIds: [],
          modelStructureIds: [],
        },
      ];
      badDesign.contract.identity.targetJournals.approvalStatus = "candidate-only";
      const counterevidence = badDesign.contract.evidenceRoles.find(
        (role) => role.id === "role-counterevidence",
      );
      assert.ok(counterevidence);
      counterevidence.coverageDimensionIds = ["counterevidence"];
      for (const role of badDesign.contract.evidenceRoles) {
        role.minimumIndependentSources = 1;
        role.minimumFullText = 1;
        role.minimumDatedSources = 1;
      }
      const centralValidation = badDesign.contract.validationPlans.find(
        (plan) => plan.id === "validation-cross-model",
      );
      assert.ok(centralValidation);
      centralValidation.independentValidation.status = "planned";
      centralValidation.independentValidation.gapId = null;

      const blocked = await evaluateProjectPreflight(
        root,
        "Can the EV study clear design?",
        requirements,
        null,
        { scientificDesign: badDesign, publicationPolicy },
      );
      for (const gap of [
        "scientific-design-contract:policy-journal-unapproved",
        "scientific-design-contract:evidence-dimension-uncovered:limitations",
        "scientific-design-contract:evidence-source-floor-insufficient:5/20",
        "scientific-design-contract:evidence-fulltext-floor-insufficient:5/10",
        "scientific-design-contract:evidence-dated-floor-insufficient:5/12",
        "scientific-design-contract:independent-validation-undispositioned:validation-cross-model",
        "scientific-design-contract:policy-rule-scope-conflict:independent-validation-required",
      ]) {
        assert.ok(blocked.gaps.includes(gap), `missing cross-contract gap ${gap}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes the authoritative scientific-design schema through the CLI", async () => {
    const result = await invoke(["research", "schema", "show", "scientific-design", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const schema = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.$id, "https://schemas.tiangong.ai/research/scientific-design-v1.json");

    const compatible = await invoke([
      "research",
      "schema",
      "show",
      "scientific-review-research-design",
      "--compatibility",
      "claude-code",
      "--json",
    ]);
    assert.equal(compatible.exitCode, 0, compatible.stderr);
    const compatibleSchema = JSON.parse(compatible.stdout) as Record<string, unknown>;
    assert.equal(compatibleSchema.$schema, undefined);
    assert.equal(compatibleSchema.$id, undefined);
    assert.equal(compatibleSchema.additionalProperties, false);

    const help = await invoke(["research", "--help"]);
    assert.equal(help.exitCode, 0, help.stderr);
    assert.match(
      help.stdout,
      /project init .*--design <absolute-json> --design-producer-agent codex\|claude --design-producer-session <opaque-id>/,
    );
  });

  it("creates a new authoritative top-journal generation only with target-specific reapproval", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-generation-"));
    try {
      await initializeResearchWorkspace(root, undefined);
      const sourceId = "scientific-generation-r1";
      const targetId = "scientific-generation-r2";
      await initializeProject(
        root,
        sourceId,
        "How should a top-journal recovery generation remain scientifically auditable?",
        undefined,
        false,
        undefined,
        policy(sourceId),
        await scientificDesignInput(root, sourceId),
      );
      await assert.rejects(forkProject(root, sourceId, targetId), (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_REQUIRED",
        );
        return true;
      });

      const targetPolicy = policy(targetId);
      const targetDesign = await scientificDesignInput(root, targetId);
      const fork = await forkProject(root, sourceId, targetId, undefined, {
        publicationPolicy: targetPolicy,
        scientificDesign: targetDesign,
      });
      assert.equal(fork.publicationPolicy?.projectId, targetId);
      assert.equal(fork.scientificDesign?.designSha256, targetDesign.design.sha256);
      assert.equal(fork.scientificDesign?.gates["research-design"].status, "pending");
      assert.equal(fork.lineage.supersedes, sourceId);
      assert.equal((await loadProject(root, sourceId)).lineage.supersededBy, targetId);
      assert.equal(nextReadyPackage(fork), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function projectDesign(
  root: string,
  projectId: string,
  approvalStatus: "candidate-only" | "policy-approved" = "policy-approved",
): Promise<VerifiedScientificDesign> {
  const target = join(root, `${projectId}-design.json`);
  const value = JSON.parse(await readFile(validFixture, "utf8")) as {
    projectId: string;
    identity: { targetJournals: { approvalStatus: "candidate-only" | "policy-approved" } };
  };
  value.projectId = projectId;
  value.identity.targetJournals.approvalStatus = approvalStatus;
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  return readAndVerifyScientificDesign(target, projectId);
}

function policy(projectId: string): ResearchPolicyBinding {
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
    resolvedRules: [],
    resolvedConstraints: {},
    requiredReviewers: ["evidence", "methods-reproducibility", "domain-novelty", "journal-editor"],
    approvedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2027-08-14T00:00:00.000Z",
  };
}

async function invoke(argv: string[]) {
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
