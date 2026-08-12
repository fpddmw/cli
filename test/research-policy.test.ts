import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import { initializeProject } from "../src/research/workspace/projects.js";
import {
  approveResearchPolicy,
  initializeResearchPolicy,
  inspectResearchPolicyCatalog,
  inspectResearchPolicyStatus,
  loadApprovedResearchPolicy,
} from "../src/research/workspace/research-policy.js";
import { prepareNativeResearchStage } from "../src/research/workspace/runtime.js";
import { sha256File } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

describe("top-journal Research Policy", () => {
  it("copies explicit defaults, requires a completed brief, and invalidates approval on drift", async () => {
    const root = await temporaryDirectory();
    const source = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, "Policy workspace");
      await writePolicyPack(source);
      const catalog = await inspectResearchPolicyCatalog(source);
      assert.deepEqual(catalog.categories, {
        articleTypes: ["original-empirical"],
        fields: ["engineering-computing"],
        journalClasses: ["discipline-flagship"],
      });

      const initialized = await initializeResearchPolicy({
        root,
        projectId: "top-journal-paper",
        sourceRoot: source,
        articleType: "original-empirical",
        field: "engineering-computing",
        journalClass: "discipline-flagship",
      });
      assert.equal(initialized.status, "default-unapproved");
      assert.equal(initialized.defaultDocuments, 7);
      assert.equal(initialized.customDocuments, 0);
      await assert.rejects(
        approveResearchPolicy(root, "top-journal-paper", { confirm: true }),
        (error: unknown) => errorCode(error) === "RESEARCH_PUBLICATION_BRIEF_INCOMPLETE",
      );

      const briefPath = join(root, "research-policy", "top-journal-paper", "publication-brief.md");
      const brief = await readFile(briefPath, "utf8");
      await writeFile(
        briefPath,
        brief
          .replace("__DEFINE_CENTRAL_QUESTION__", "Does treatment X improve outcome Y?")
          .replace("__DEFINE_CENTRAL_CLAIM__", "Treatment X improves outcome Y.")
          .replace("__DEFINE_CENTRAL_OUTCOME__", "Observed change in outcome Y")
          .replace("__DEFINE_CONTRIBUTION_TYPE__", "new-empirical-estimate"),
      );
      const draft = await inspectResearchPolicyStatus(root, "top-journal-paper");
      assert.equal(draft.status, "custom-draft");

      const approved = await approveResearchPolicy(root, "top-journal-paper", {
        confirm: true,
        acknowledgeDefaults: true,
      });
      assert.equal(approved.status, "custom-approved");
      assert.equal(approved.verdictCeiling, "top-journal-candidate");
      assert.match(approved.resolvedPolicySha256 ?? "", /^[a-f0-9]{64}$/);
      const binding = await loadApprovedResearchPolicy(root, "top-journal-paper");
      assert.equal(binding.verdictCeiling, "top-journal-candidate");
      assert.equal(binding.targetJournal, null);
      assert.equal(binding.resolvedConstraints?.minDirectPeerReviewedFullText, 5);

      const manifestPath = join(
        root,
        ".tiangong-research",
        "policies",
        "projects",
        "top-journal-paper",
        "template-manifest.json",
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        manifestSha256: string;
        selection: { field: string };
      };
      manifest.selection.field = "tampered-field";
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      await assert.rejects(
        loadApprovedResearchPolicy(root, "top-journal-paper"),
        (error: unknown) => errorCode(error) === "RESEARCH_POLICY_INVALID",
      );
      manifest.selection.field = "engineering-computing";
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      await lockCapabilities(root);
      await initializeProject(
        root,
        "top-journal-paper",
        "Does treatment X improve the central outcome Y?",
        undefined,
        false,
        undefined,
        binding,
      );

      const packet = await prepareNativeResearchStage({
        root,
        projectId: "top-journal-paper",
        stage: "discover",
        hostAgent: "codex",
      });
      assert.ok(packet.publicationPolicy);
      assert.equal(packet.publicationPolicy?.documents.length, binding.documents.length);
      assert.match(packet.prompt, /approved Research Policy/i);
      for (const document of packet.publicationPolicy?.documents ?? []) {
        assert.equal(
          await sha256File(document.path),
          document.sha256,
          `staged policy hash must match for ${document.id}`,
        );
      }

      const stale = await inspectResearchPolicyStatus(root, "top-journal-paper", {
        now: new Date("2030-01-01T00:00:00.000Z"),
      });
      assert.equal(stale.status, "stale");

      await writeFile(briefPath, `${await readFile(briefPath, "utf8")}\nMaterial change.\n`);
      const changed = await inspectResearchPolicyStatus(root, "top-journal-paper");
      assert.equal(changed.status, "changed");
      await assert.rejects(
        loadApprovedResearchPolicy(root, "top-journal-paper"),
        (error: unknown) => errorCode(error) === "RESEARCH_POLICY_CHANGED",
      );
      await assert.rejects(
        prepareNativeResearchStage({
          root,
          projectId: "top-journal-paper",
          stage: "discover",
          hostAgent: "codex",
        }),
        (error: unknown) => errorCode(error) === "RESEARCH_POLICY_CHANGED",
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(source, { recursive: true, force: true }),
      ]);
    }
  });

  it("reports conflicting policy identity before approval", async () => {
    const root = await temporaryDirectory();
    const source = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, "Policy workspace");
      await writePolicyPack(source);
      await initializeResearchPolicy({
        root,
        projectId: "conflicting-paper",
        sourceRoot: source,
        articleType: "original-empirical",
        field: "engineering-computing",
        journalClass: "discipline-flagship",
      });
      const articlePolicy = join(root, "research-policy", "conflicting-paper", "article-type.md");
      await writeFile(
        articlePolicy,
        (await readFile(articlePolicy, "utf8")).replace(
          "articleType: original-empirical",
          "articleType: computational-modeling",
        ),
      );
      const status = await inspectResearchPolicyStatus(root, "conflicting-paper");
      assert.equal(status.status, "conflict");
      assert.ok(status.conflicts.some((value) => value.includes("articleType")));
      await assert.rejects(
        approveResearchPolicy(root, "conflicting-paper", {
          confirm: true,
          acknowledgeDefaults: true,
        }),
        (error: unknown) => errorCode(error) === "RESEARCH_POLICY_CONFLICT",
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(source, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects a symlinked policy source and blocks a top-journal project without policy", async () => {
    const root = await temporaryDirectory();
    const source = await temporaryDirectory();
    const linked = join(await temporaryDirectory(), "linked-skill");
    try {
      await initializeResearchWorkspace(root, "Policy workspace");
      await writePolicyPack(source);
      await symlink(source, linked);
      await assert.rejects(
        inspectResearchPolicyCatalog(linked),
        (error: unknown) => errorCode(error) === "RESEARCH_POLICY_SOURCE_INVALID",
      );

      const output: string[] = [];
      const errors: string[] = [];
      const exitCode = await runCli(
        [
          "research",
          "project",
          "init",
          "missing-policy",
          "--question",
          "Evaluate a top journal policy gate.",
          "--goal",
          "top-journal",
          "--workspace",
          root,
          "--json",
        ],
        {
          env: {},
          stdout: { write: (value: string) => void output.push(value) },
          stderr: { write: (value: string) => void errors.push(value) },
        },
      );
      assert.equal(exitCode, 2);
      assert.equal(output.length, 0);
      assert.equal(JSON.parse(errors.join("\n")).error.code, "RESEARCH_POLICY_REQUIRED");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(source, { recursive: true, force: true }),
        rm(join(linked, ".."), { recursive: true, force: true }),
      ]);
    }
  });
});

async function writePolicyPack(root: string): Promise<void> {
  const policyRoot = join(root, "assets", "research-policy", "defaults");
  const documents: Array<[string, string, string, string]> = [
    ["baseline/top-journal.md", "baseline.top-journal", "baseline", "bundled-default"],
    [
      "article-types/original-empirical.md",
      "article.original-empirical",
      "article-type",
      "bundled-default",
    ],
    ["fields/engineering-computing.md", "field.engineering-computing", "field", "bundled-default"],
    [
      "journal-classes/discipline-flagship.md",
      "journal-class.discipline-flagship",
      "journal-class",
      "bundled-default",
    ],
    ["reviewer-rubrics/evidence.md", "reviewer.evidence", "reviewer-rubric", "bundled-default"],
    [
      "reviewer-rubrics/journal-editor.md",
      "reviewer.journal-editor",
      "reviewer-rubric",
      "bundled-default",
    ],
    [
      "project/publication-brief.md",
      "project.publication-brief-template",
      "publication-brief",
      "project-template",
    ],
  ];
  for (const [relative, id, kind, templateClass] of documents) {
    const path = join(policyRoot, relative);
    await mkdir(join(path, ".."), { recursive: true });
    const isBrief = kind === "publication-brief";
    await writeFile(
      path,
      `---\nschemaVersion: 1\nid: ${id}\nkind: ${kind}\ntemplateClass: ${templateClass}\npolicyVersion: 1\ntargetTier: top\narticleType: original-empirical\nfield: engineering-computing\njournalClass: discipline-flagship\ntargetJournal: none\ncentralQuestion: ${isBrief ? "__DEFINE_CENTRAL_QUESTION__" : "defined"}\ncentralClaim: ${isBrief ? "__DEFINE_CENTRAL_CLAIM__" : "defined"}\ncentralOutcome: ${isBrief ? "__DEFINE_CENTRAL_OUTCOME__" : "defined"}\ncontributionType: ${isBrief ? "__DEFINE_CONTRIBUTION_TYPE__" : "defined"}\nrules:\n  - central-claim-directly-supported\nconstraints:\n  minDirectPeerReviewedFullText: ${kind === "article-type" ? 5 : 2}\nrequiredReviewers:\n  - evidence\nreviewAfterDays: 180\n---\n\n# ${id}\n\nPolicy content.\n`,
    );
  }
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tiangong-research-policy-"));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
