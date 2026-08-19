import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/io.js";
import { initializeProject } from "../src/research/workspace/projects.js";
import { evaluateProjectPreflight } from "../src/research/workspace/preflight.js";
import { prepareScientificReview } from "../src/research/workspace/scientific-review.js";
import {
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/research/workspace/storage.js";
import type { ResearchPolicyBinding } from "../src/research/workspace/types.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";
import { scientificDesignInput } from "./helpers/scientific-design.js";

describe("scientific object registration", () => {
  it("registers raw model and lock bytes through the public CLI before design review", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-object-"));
    const projectId = "scientific-object-flow";
    try {
      await initializeResearchWorkspace(root, "Scientific object flow");
      const designInput = await scientificDesignInput(root, projectId, {
        modelObjectMode: "external-raw",
      });
      const registeredRecords: Array<Record<string, unknown>> = [];
      for (const source of designInput.modelObjectSources) {
        const registered = await invoke([
          "research",
          "scientific",
          "object",
          "register",
          "--kind",
          source.kind,
          "--path",
          source.path,
          "--media-type",
          source.mediaType,
          "--workspace",
          root,
          "--json",
        ]);
        assert.equal(registered.exitCode, 0, registered.stderr);
        const record = JSON.parse(registered.stdout) as Record<string, unknown>;
        registeredRecords.push(record);
        assert.equal(record.sha256, source.sha256);
        assert.equal(record.objectLocator, source.objectLocator);
        assert.equal(record.objectKind, source.kind);
        assert.equal(record.mediaType, source.mediaType);
        assert.equal(record.hashBasis, "raw-file-bytes");
        assert.equal(`${registered.stdout}\n${registered.stderr}`.includes(source.path), false);

        const repeated = await invoke([
          "research",
          "scientific",
          "object",
          "register",
          "--kind",
          source.kind,
          "--path",
          source.path,
          "--media-type",
          source.mediaType,
          "--workspace",
          root,
          "--json",
        ]);
        assert.equal(repeated.exitCode, 0, repeated.stderr);
        assert.deepEqual(JSON.parse(repeated.stdout), record);

        const inspected = await invoke([
          "research",
          "scientific",
          "object",
          "inspect",
          "--kind",
          source.kind,
          "--locator",
          source.objectLocator,
          "--workspace",
          root,
          "--json",
        ]);
        assert.equal(inspected.exitCode, 0, inspected.stderr);
        assert.deepEqual(JSON.parse(inspected.stdout), record);
      }

      const project = await initializeProject(
        root,
        projectId,
        "Can registered model bytes enter an independent research-design review?",
        undefined,
        false,
        undefined,
        policyBinding(projectId),
        designInput,
      );
      const assessmentPath = join(root, "research-design-assessment.json");
      await writeJsonAtomic(assessmentPath, {
        schemaVersion: 1,
        role: "research-design",
        designSha256: project.scientificDesign!.designSha256,
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
      });
      const packet = await prepareScientificReview({
        root,
        projectId,
        role: "research-design",
        assessmentPath,
        reviewerAgent: "claude",
        reviewerSessionId: "registered-object-reviewer",
      });
      const modelInputs = packet.stageInputs.filter((record) =>
        ["model-implementation", "model-environment-lock"].includes(record.purpose),
      );
      assert.equal(modelInputs.length, designInput.modelObjectSources.length);
      assert.ok(modelInputs.every((record) => record.hashBasis === "raw-file-bytes"));
      assert.ok(modelInputs.every((record) => record.path.endsWith("/blob")));
      assert.deepEqual(
        new Set(modelInputs.map((record) => record.mediaType)),
        new Set(["text/x-python", "text/plain"]),
      );
      assert.ok(modelInputs.every((record) => record.registrationRecordSha256));

      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.ok(designInput.modelObjectSources.every((source) => !journal.includes(source.path)));
      const firstSource = designInput.modelObjectSources[0]!;
      const firstRecord = registeredRecords[0]!;
      await writeTextAtomic(
        join(workspacePaths(root).control, String(firstRecord.recordLocator)),
        '{"tampered":true}\n',
        0o444,
      );
      const invalidRecord = await invoke([
        "research",
        "scientific",
        "object",
        "inspect",
        "--kind",
        firstSource.kind,
        "--locator",
        firstSource.objectLocator,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(invalidRecord.exitCode, 3);
      assert.equal(JSON.parse(invalidRecord.stderr).error.details.reason, "record-invalid");
      assert.equal(`${invalidRecord.stdout}\n${invalidRecord.stderr}`.includes(root), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked, control-directory, and unsupported-media sources without path leakage", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-object-safety-"));
    try {
      await initializeResearchWorkspace(root, "Scientific object safety");
      const source = join(root, "authorization=Bearer-secret-model.py");
      const link = join(root, "linked-model.py");
      const controlSource = join(workspacePaths(root).control, "manual-model.py");
      await writeFile(source, "def evaluate(value):\n    return value\n");
      await symlink(source, link);
      await writeFile(controlSource, "def evaluate(value):\n    return value\n");

      for (const [path, mediaType] of [
        [link, "text/x-python"],
        [controlSource, "text/x-python"],
        [source, "application/octet-stream"],
      ] as const) {
        const result = await invoke([
          "research",
          "scientific",
          "object",
          "register",
          "--kind",
          "model-implementation",
          "--path",
          path,
          "--media-type",
          mediaType,
          "--workspace",
          root,
          "--json",
        ]);
        assert.equal(result.exitCode, 2);
        assert.equal(JSON.parse(result.stderr).error.code, "RESEARCH_SCIENTIFIC_OBJECT_INVALID");
        assert.equal(`${result.stdout}\n${result.stderr}`.includes(root), false);
        assert.equal(`${result.stdout}\n${result.stderr}`.includes("Bearer-secret"), false);
      }
      const invalidJson = join(root, "invalid-object.json");
      await writeFile(invalidJson, '{"not":\n');
      const invalidJsonResult = await invoke([
        "research",
        "scientific",
        "object",
        "register",
        "--kind",
        "model-implementation",
        "--path",
        invalidJson,
        "--media-type",
        "application/json",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(invalidJsonResult.exitCode, 2);
      assert.equal(JSON.parse(invalidJsonResult.stderr).error.details.reason, "json-invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports exact preflight gaps and blocks kind-mismatched frozen bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-object-kind-"));
    const projectId = "scientific-object-kind";
    try {
      await initializeResearchWorkspace(root, "Scientific object kind binding");
      const designInput = await scientificDesignInput(root, projectId, {
        modelObjectMode: "external-raw",
      });
      const preflight = await evaluateProjectPreflight(
        root,
        "Can exact object kinds be proved before scientific project admission?",
        null,
        null,
        { publicationPolicy: policyBinding(projectId), scientificDesign: designInput.design },
      );
      assert.ok(
        preflight.gaps.includes(
          "scientific-object:mechanistic-fatigue-model:implementation:source-not-registered",
        ),
      );

      const implementation = designInput.modelObjectSources.find(
        (source) => source.kind === "model-implementation",
      )!;
      const wrongKind = await invoke([
        "research",
        "scientific",
        "object",
        "register",
        "--kind",
        "environment-lock",
        "--path",
        implementation.path,
        "--media-type",
        implementation.mediaType,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(wrongKind.exitCode, 0, wrongKind.stderr);
      await assert.rejects(
        initializeProject(
          root,
          projectId,
          "Can kind-mismatched scientific objects enter a project?",
          undefined,
          false,
          undefined,
          policyBinding(projectId),
          designInput,
        ),
        (error: unknown) => {
          const typed = error as {
            code?: string;
            details?: { issues?: Array<{ reason: string }> };
          };
          assert.equal(typed.code, "RESEARCH_SCIENTIFIC_OBJECT_BINDING_INVALID");
          assert.ok(typed.details?.issues?.some((issue) => issue.reason === "kind-mismatch"));
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks admission when a registered blob drifts after registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-object-drift-"));
    const projectId = "scientific-object-drift";
    try {
      await initializeResearchWorkspace(root, "Scientific object drift");
      const designInput = await scientificDesignInput(root, projectId, {
        modelObjectMode: "external-raw",
      });
      for (const source of designInput.modelObjectSources) {
        const result = await invoke([
          "research",
          "scientific",
          "object",
          "register",
          "--kind",
          source.kind,
          "--path",
          source.path,
          "--media-type",
          source.mediaType,
          "--workspace",
          root,
          "--json",
        ]);
        assert.equal(result.exitCode, 0, result.stderr);
      }
      const drifted = designInput.modelObjectSources[0]!;
      await writeTextAtomic(
        join(workspacePaths(root).control, drifted.objectLocator),
        "tampered\n",
        0o444,
      );
      await assert.rejects(
        initializeProject(
          root,
          projectId,
          "Can drifted registered scientific objects enter a project?",
          undefined,
          false,
          undefined,
          policyBinding(projectId),
          designInput,
        ),
        (error: unknown) => {
          const typed = error as {
            code?: string;
            details?: { issues?: Array<{ reason: string }> };
          };
          assert.equal(typed.code, "RESEARCH_SCIENTIFIC_OBJECT_BINDING_INVALID");
          assert.ok(
            typed.details?.issues?.some((issue) => issue.reason === "content-hash-mismatch"),
          );
          assert.equal(JSON.stringify(typed.details).includes(root), false);
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("distinguishes a missing registered blob from an unregistered design locator", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-object-missing-"));
    const projectId = "scientific-object-missing";
    try {
      await initializeResearchWorkspace(root, "Scientific object missing blob");
      const designInput = await scientificDesignInput(root, projectId, {
        modelObjectMode: "external-raw",
      });
      for (const source of designInput.modelObjectSources) {
        const result = await invoke([
          "research",
          "scientific",
          "object",
          "register",
          "--kind",
          source.kind,
          "--path",
          source.path,
          "--media-type",
          source.mediaType,
          "--workspace",
          root,
          "--json",
        ]);
        assert.equal(result.exitCode, 0, result.stderr);
      }
      const missing = designInput.modelObjectSources[0]!;
      await rm(join(workspacePaths(root).control, missing.objectLocator));
      await assert.rejects(
        initializeProject(
          root,
          projectId,
          "Can a missing registered blob be distinguished from an unregistered locator?",
          undefined,
          false,
          undefined,
          policyBinding(projectId),
          designInput,
        ),
        (error: unknown) => {
          const typed = error as { details?: { issues?: Array<{ reason: string }> } };
          assert.ok(typed.details?.issues?.some((issue) => issue.reason === "object-missing"));
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not accept a manually copied control-store JSON object as registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-object-manual-"));
    const projectId = "scientific-object-manual";
    try {
      await initializeResearchWorkspace(root, "Scientific object manual copy");
      const designInput = await scientificDesignInput(root, projectId, {
        modelObjectMode: "legacy-control-json",
      });
      await assert.rejects(
        initializeProject(
          root,
          projectId,
          "Can a manually copied JSON object bypass scientific object registration?",
          undefined,
          false,
          undefined,
          policyBinding(projectId),
          designInput,
        ),
        (error: unknown) => {
          const typed = error as { details?: { issues?: Array<{ reason: string }> } };
          assert.ok(
            typed.details?.issues?.some((issue) => issue.reason === "source-not-registered"),
          );
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function policyBinding(projectId: string): ResearchPolicyBinding {
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
