import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import {
  executeResearchPolicyWizard,
  type ResearchPolicyWizardPrompt,
} from "../src/research/workspace/research-policy-wizard.js";
import { inspectResearchPolicyStatus } from "../src/research/workspace/research-policy.js";
import { RESEARCH_SETUP_SKILLS } from "../src/research/workspace/setup-catalog.js";
import { createResearchSetupPlan } from "../src/research/workspace/setup.js";
import {
  hashRegularTree,
  workspacePaths,
  writeJsonAtomic,
} from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

describe("Research Policy Wizard", () => {
  it("auto-resolves the installed orchestrator and creates an explicit reviewed draft", async () => {
    const fixture = await policyWizardFixture("policy-wizard");
    try {
      const prompt = new ScriptedPolicyPrompt();
      const result = await executeResearchPolicyWizard({
        root: fixture.root,
        projectId: "target-paper",
        prompt,
      });
      assert.equal(result.status.status, "custom-draft");
      assert.equal(result.sourceRoot, await realpath(fixture.orchestratorRoot));
      assert.equal(result.defaultsInUse, true);
      assert.equal(result.approved, false);
      assert.ok(prompt.notes.some((note) => /generic default/i.test(note)));
      const brief = await readFile(
        join(fixture.root, "research-policy", "target-paper", "publication-brief.md"),
        "utf8",
      );
      assert.match(brief, /Does intervention X improve outcome Y/);
      assert.doesNotMatch(brief, /__DEFINE_/);
    } finally {
      fixture.restoreCatalog();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("can explicitly acknowledge defaults and approve the exact generated hash", async () => {
    const fixture = await policyWizardFixture("policy-approve");
    try {
      const result = await executeResearchPolicyWizard({
        root: fixture.root,
        projectId: "approved-paper",
        prompt: new ScriptedPolicyPrompt({ approve: true }),
      });
      assert.equal(result.status.status, "custom-approved");
      assert.equal(result.approved, true);
      assert.match(result.status.resolvedPolicySha256 ?? "", /^[a-f0-9]{64}$/);
    } finally {
      fixture.restoreCatalog();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses a verified orchestrator when research is ready but an optional companion is degraded", async () => {
    const fixture = await policyWizardFixture("policy-partial-setup", false, true);
    try {
      const result = await executeResearchPolicyWizard({
        root: fixture.root,
        projectId: "research-ready-paper",
        prompt: new ScriptedPolicyPrompt(),
      });
      assert.equal(result.status.status, "custom-draft");
      assert.equal(result.sourceRoot, await realpath(fixture.orchestratorRoot));
    } finally {
      fixture.restoreCatalog();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails with an actionable setup error when the orchestrator is not installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-policy-no-orchestrator-"));
    try {
      await initializeResearchWorkspace(root, "No orchestrator");
      const output = await invoke([
        "research",
        "policy",
        "wizard",
        "missing-skill",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(output.exitCode, 2);
      assert.equal(JSON.parse(output.stderr).error.code, "RESEARCH_POLICY_SOURCE_REQUIRED");
      assert.match(output.stderr, /setup.*orchestrator/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects sensitive query credentials in an exact-journal guidelines URL", async () => {
    const fixture = await policyWizardFixture("policy-sensitive-url", true);
    try {
      let observed: unknown;
      try {
        await executeResearchPolicyWizard({
          root: fixture.root,
          projectId: "sensitive-url-paper",
          prompt: new ScriptedPolicyPrompt({ sensitiveUrl: true }),
        });
      } catch (error) {
        observed = error;
      }
      assert.equal(errorCode(observed), "RESEARCH_POLICY_INVALID");
      assert.match(String(observed), /sensitive query/i);
      assert.doesNotMatch(String(observed), /owner-secret-value/);
    } finally {
      fixture.restoreCatalog();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

class ScriptedPolicyPrompt implements ResearchPolicyWizardPrompt {
  readonly notes: string[] = [];

  constructor(readonly options: { approve?: boolean; sensitiveUrl?: boolean } = {}) {}

  note(message: string): void {
    this.notes.push(message);
  }

  async input(message: string, defaultValue = ""): Promise<string> {
    if (message === "Central research question") return "Does intervention X improve outcome Y?";
    if (message === "Central claim") return "Intervention X improves outcome Y.";
    if (message === "Central outcome") return "Observed change in outcome Y";
    if (message === "Contribution type") return "new-empirical-estimate";
    if (message === "Exact target journal") return "Journal of Exact Tests";
    if (message === "Official journal guidelines HTTPS URL") {
      return this.options.sensitiveUrl
        ? "https://journal.example/guide?api_key=owner-secret-value"
        : "https://journal.example/guide";
    }
    if (this.options.sensitiveUrl) {
      return defaultValue || "A substantive journal-specific requirement.";
    }
    return defaultValue;
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    if (message.includes("Approve this exact")) return this.options.approve ?? false;
    if (message.includes("acknowledge")) return this.options.approve ?? false;
    if (message.includes("exact target-journal")) return this.options.sensitiveUrl ?? false;
    return defaultValue;
  }

  async select<T extends string>(
    _message: string,
    _choices: ReadonlyArray<{ value: T; label: string }>,
    defaultValue: T,
  ): Promise<T> {
    return defaultValue;
  }

  close(): void {}
}

async function policyWizardFixture(
  prefix: string,
  includeExactJournal = false,
  optionalCompanionDegraded = false,
): Promise<{
  root: string;
  orchestratorRoot: string;
  restoreCatalog: () => void;
}> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const orchestratorRoot = join(root, ".agents", "skills", "tiangong-auto-research");
  await writePolicyPack(orchestratorRoot, includeExactJournal);
  const orchestrator = RESEARCH_SETUP_SKILLS.find(
    (skill) => skill.id === "tiangong.auto-research",
  )!;
  const originalTreeSha256 = orchestrator.expectedTreeSha256;
  orchestrator.expectedTreeSha256 = await hashRegularTree(orchestratorRoot);
  const setupPlan = await createResearchSetupPlan({
    workspace: root,
    mode: "smoke-test",
    evidenceProfile: "none",
    skillIds: ["tiangong.auto-research"],
    acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
    confirmNetworkDownloads: true,
  });
  await initializeResearchWorkspace(root, "Policy Wizard");
  await writeJsonAtomic(workspacePaths(root).setupState, {
    schemaVersion: 1,
    planSha256: setupPlan.planSha256,
    status: optionalCompanionDegraded ? "partially-ready" : "ready",
    currentStep: null,
    completedSteps: ["install", "doctor"],
    attempts: 1,
    updatedAt: new Date().toISOString(),
    lastError: null,
  });
  if (optionalCompanionDegraded) {
    await writeJsonAtomic(workspacePaths(root).setupReport, {
      schemaVersion: 1,
      workspace: await realpath(root),
      planSha256: setupPlan.planSha256,
      checkedAt: new Date().toISOString(),
      mode: "live",
      readiness: "READY",
      researchReadiness: "READY",
      preprocessingReadiness: "NOT_REQUIRED",
      acquisitionReadiness: "DEGRADED",
      authoringReadiness: "NOT_REQUIRED",
      overallReadiness: "PARTIALLY_READY",
      checks: [],
      capabilityDoctor: null,
      workspaceDoctor: null,
      summary: { pass: 1, warn: 1, fail: 1 },
    });
  }
  return {
    root,
    orchestratorRoot,
    restoreCatalog: () => {
      orchestrator.expectedTreeSha256 = originalTreeSha256;
    },
  };
}

async function writePolicyPack(root: string, includeExactJournal = false): Promise<void> {
  const policyRoot = join(root, "assets", "research-policy", "defaults");
  const docs: Array<[string, string, string, string]> = [
    ["baseline/top-journal.md", "baseline.top-journal", "baseline", "bundled-default"],
    ["article-types/original-empirical.md", "article.original", "article-type", "bundled-default"],
    ["fields/engineering-computing.md", "field.engineering", "field", "bundled-default"],
    [
      "journal-classes/discipline-flagship.md",
      "journal.flagship",
      "journal-class",
      "bundled-default",
    ],
    ["reviewer-rubrics/evidence.md", "reviewer.evidence", "reviewer-rubric", "bundled-default"],
    [
      "reviewer-rubrics/methods-reproducibility.md",
      "reviewer.methods",
      "reviewer-rubric",
      "bundled-default",
    ],
    ["reviewer-rubrics/domain-novelty.md", "reviewer.domain", "reviewer-rubric", "bundled-default"],
    ["reviewer-rubrics/journal-editor.md", "reviewer.editor", "reviewer-rubric", "bundled-default"],
    ["project/publication-brief.md", "project.brief", "publication-brief", "project-template"],
    ...(includeExactJournal
      ? [
          [
            "journals/exact-journal-template.md",
            "journal.exact-template",
            "exact-journal",
            "exact-journal-template",
          ] as [string, string, string, string],
        ]
      : []),
  ];
  for (const [relative, id, kind, templateClass] of docs) {
    const path = join(policyRoot, relative);
    await mkdir(join(path, ".."), { recursive: true });
    const brief = kind === "publication-brief";
    await writeFile(
      path,
      `---\nschemaVersion: 1\nid: ${id}\nkind: ${kind}\ntemplateClass: ${templateClass}\npolicyVersion: 1\ntargetTier: top\narticleType: original-empirical\nfield: engineering-computing\njournalClass: discipline-flagship\ntargetJournal: none\ncentralQuestion: ${brief ? "__DEFINE_CENTRAL_QUESTION__" : "defined"}\ncentralClaim: ${brief ? "__DEFINE_CENTRAL_CLAIM__" : "defined"}\ncentralOutcome: ${brief ? "__DEFINE_CENTRAL_OUTCOME__" : "defined"}\ncontributionType: ${brief ? "__DEFINE_CONTRIBUTION_TYPE__" : "defined"}\nrules:\n  - central-claim-directly-supported\nrequiredReviewers:\n  - evidence\nreviewAfterDays: 180\n---\n\n# ${id}\n\nPolicy content.\n`,
    );
  }
}

async function invoke(
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    env: {},
    stdout: { write: (value: string) => void stdout.push(value) },
    stderr: { write: (value: string) => void stderr.push(value) },
  });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
