import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import { readVerifiedJournal } from "../src/research/workspace/journal.js";
import {
  addProjectInput,
  initializeProject,
  loadProject,
} from "../src/research/workspace/projects.js";
import { sha256File, workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";
import { loadCurrentEvidenceSnapshot } from "../src/research/workspace/acquisition.js";
import {
  freezeEvidenceContentSnapshot,
  registerEvidenceAtom,
} from "../src/research/workspace/content-evidence.js";
import { recordDiscoveryAssessmentBatch } from "../src/research/workspace/discovery.js";
import { listEvidenceCandidates } from "../src/research/workspace/evidence-ledger.js";
import {
  prepareNativeResearchStage,
  runResearchWorkspace,
  submitNativeResearchStage,
} from "../src/research/workspace/runtime.js";

async function cli(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env: {},
    stdout: {
      write: (value: string) => {
        stdout += value;
      },
    },
    stderr: {
      write: (value: string) => {
        stderr += value;
      },
    },
  });
  return { exitCode, stdout, stderr };
}

function contractInput() {
  return {
    schemaVersion: 1,
    originalRequest:
      "Compare electricity and water evidence, retaining uncertainty and counterevidence.",
    requirements: [
      {
        id: "electricity",
        text: "Assess the available electricity evidence.",
        acceptance: "Provide a traceable comparison and explicit uncertainty.",
        checkKind: "evidence",
        designClaimIds: [],
        coverageDimensionIds: ["research-question"],
      },
      {
        id: "water",
        text: "Assess water evidence independently from electricity.",
        acceptance: "Provide water evidence or identify the exact unresolved data requirement.",
        checkKind: "evidence",
        designClaimIds: [],
        coverageDimensionIds: ["research-question"],
      },
    ],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tiangong-task-contract-"));
  const files = await mkdtemp(join(tmpdir(), "tiangong-task-contract-files-"));
  await initializeResearchWorkspace(root, undefined);
  await lockCapabilities(root);
  await initializeProject(
    root,
    "task-project",
    "Compare electricity and water evidence without presupposing a result.",
  );
  const task = async (args: string[], projectId = "task-project") =>
    cli([
      "research",
      "project",
      "task",
      ...args.slice(0, 1),
      projectId,
      ...args.slice(1),
      "--workspace",
      root,
      "--json",
    ]);
  const inputPath = join(files, "requirements.json");
  await writeFile(inputPath, JSON.stringify(contractInput()));
  return {
    root,
    files,
    inputPath,
    task,
    cleanup: () =>
      Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(files, { recursive: true, force: true }),
      ]),
  };
}

describe("lightweight original task and authorized scope", () => {
  it("records exact native check results without certifying execution or completing the task", async () => {
    const fx = await acquiredFixture();
    try {
      const resultFile = join(fx.files, "observed-result.json");
      await writeFile(
        resultFile,
        JSON.stringify({
          difference: 0,
          interpretation: "A bounded synthetic null-result fixture.",
        }),
      );
      const input = acceptanceInput(fx.rows[0]!, fx.atom.atomId, [resultFile], "negative-result");
      const recorded = await recordAcceptance(fx, input);
      assert.equal(recorded.exitCode, 0, recorded.stderr);
      const receipt = JSON.parse(recorded.stdout);
      assert.equal(receipt.executionCertified, false);
      assert.equal(receipt.trust, "native-observation");
      assert.equal(receipt.results[0].sha256, await sha256File(resultFile));
      assert.doesNotMatch(recorded.stdout, new RegExp(fx.files));
      const before = await readFile(workspacePaths(fx.root).journal);
      const replay = await recordAcceptance(fx, input);
      assert.equal(replay.exitCode, 0, replay.stderr);
      assert.equal(JSON.parse(replay.stdout).recordSha256, receipt.recordSha256);
      assert.deepEqual(await readFile(workspacePaths(fx.root).journal), before);
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.equal(status.currentScope.status, "incomplete");
      assert.equal(status.currentScope.requirements[0].status, "recorded");
      assert.equal(status.currentScope.requirements[0].outcome, "negative-result");
      const stored = join(
        workspacePaths(fx.root).projects,
        "task-project",
        receipt.results[0].path,
      );
      await chmod(stored, 0o600);
      await writeFile(stored, "modified result\n");
      const tampered = await fx.task(["status"]);
      assert.equal(tampered.exitCode, 3);
      assert.equal(JSON.parse(tampered.stderr).error.code, "RESEARCH_TASK_ARTIFACT_DRIFT");
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects invented execution certification and evidence IDs before recording acceptance", async () => {
    const fx = await acquiredFixture();
    try {
      const before = await readFile(workspacePaths(fx.root).journal);
      const input = acceptanceInput(fx.rows[0]!, fx.atom.atomId, [], "satisfied");
      for (const invalidInput of [
        { ...input, executionCertified: true },
        { ...input, evidenceAtomIds: ["invented-atom"] },
        { ...input, requirementSha256: "b".repeat(64) },
      ]) {
        const result = await recordAcceptance(fx, invalidInput);
        assert.equal(result.exitCode, 3);
        assert.match(result.stderr, /RESEARCH_TASK_/);
      }
      assert.deepEqual(await readFile(workspacePaths(fx.root).journal), before);
    } finally {
      await fx.cleanup();
    }
  });

  it("uses the existing single independent review to accept valid negative findings and close task coverage", async () => {
    const fx = await acquiredFixture();
    try {
      for (const row of fx.rows) {
        const recorded = await recordAcceptance(
          fx,
          acceptanceInput(row, fx.atom.atomId, [], "negative-result"),
        );
        assert.equal(recorded.exitCode, 0, recorded.stderr);
      }
      await finishProducer(fx);
      let reviewCalls = 0;
      const run = await runResearchWorkspace(
        fx.root,
        { maxParallel: 1, maxCycles: 2, dryRun: false, environment: {} },
        async (request) => {
          reviewCalls += 1;
          const packet = JSON.parse(
            await readFile(join(request.projectRoot, "inputs/review-packet.json"), "utf8"),
          );
          assert.equal(packet.taskAcceptance.requirements.length, 2);
          assert.ok(
            Array.isArray(request.outputSchema?.required) &&
              request.outputSchema.required.includes("taskAssessment"),
          );
          const review = {
            schemaVersion: 1,
            packetSha256: packet.packetSha256,
            decision: "pass",
            issues: [],
            rationale: "Bounded independent fixture review.",
            taskAssessment: {
              contextSha256: packet.taskAcceptance.contextSha256,
              requirements: packet.taskAcceptance.requirements.map(
                (row: { requirementSha256: string }) => ({
                  requirementSha256: row.requirementSha256,
                  decision: "answered",
                  reason: "The declared null-result criterion is met within the exact fixture.",
                }),
              ),
            },
          };
          return {
            exitCode: 0,
            stdout: JSON.stringify(review),
            stderr: "",
            tokens: 10,
            inputTokens: 5,
            cachedInputTokens: 0,
            outputTokens: 5,
            costUsd: 0,
            wallSeconds: 0,
            model: null,
            runtime: null,
          };
        },
      );
      assert.equal(run.status, "complete", JSON.stringify(run));
      assert.equal(reviewCalls, 1);
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.equal(status.currentScope.status, "complete");
      assert.equal(status.originalScope.status, "complete");
      assert.ok(
        status.currentScope.requirements.every(
          (row: { status: string }) => row.status === "reviewed",
        ),
      );
      assert.equal(status.executionCertified, false);
    } finally {
      await fx.cleanup();
    }
  });

  it("does not promote an inconclusive check just because the workflow reviewer returns pass", async () => {
    const fx = await acquiredFixture();
    try {
      for (const row of fx.rows) {
        const recorded = await recordAcceptance(
          fx,
          acceptanceInput(row, fx.atom.atomId, [], "inconclusive"),
        );
        assert.equal(recorded.exitCode, 0, recorded.stderr);
      }
      await finishProducer(fx);
      const run = await runResearchWorkspace(
        fx.root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        async (request) => {
          const packet = JSON.parse(
            await readFile(join(request.projectRoot, "inputs/review-packet.json"), "utf8"),
          );
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              schemaVersion: 1,
              packetSha256: packet.packetSha256,
              decision: "pass",
              issues: [],
              rationale: "An invalid overclaim fixture.",
              taskAssessment: {
                contextSha256: packet.taskAcceptance.contextSha256,
                requirements: packet.taskAcceptance.requirements.map(
                  (row: { requirementSha256: string }) => ({
                    requirementSha256: row.requirementSha256,
                    decision: "answered",
                    reason: "Improperly promotes an inconclusive result.",
                  }),
                ),
              },
            }),
            stderr: "",
            tokens: 10,
            inputTokens: 5,
            cachedInputTokens: 0,
            outputTokens: 5,
            costUsd: 0,
            wallSeconds: 0,
            model: null,
            runtime: null,
          };
        },
      );
      assert.notEqual(run.status, "complete");
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.equal(status.currentScope.status, "incomplete");
    } finally {
      await fx.cleanup();
    }
  });
  it("defines immutable requirements and derives separate original/current completion without a model", async () => {
    const fx = await fixture();
    try {
      const unassessed = await fx.task(["status"]);
      assert.equal(unassessed.exitCode, 0, unassessed.stderr);
      assert.equal(JSON.parse(unassessed.stdout).status, "not-configured");
      const defined = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(defined.exitCode, 0, defined.stderr);
      const binding = JSON.parse(defined.stdout);
      assert.match(binding.contractSha256, /^[a-f0-9]{64}$/);
      const before = await readFile(workspacePaths(fx.root).journal);
      const repeated = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(repeated.exitCode, 0, repeated.stderr);
      assert.equal(JSON.parse(repeated.stdout).contractSha256, binding.contractSha256);
      assert.deepEqual(await readFile(workspacePaths(fx.root).journal), before);
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.equal(status.originalScope.status, "incomplete");
      assert.equal(status.currentScope.status, "incomplete");
      assert.deepEqual(
        status.currentScope.requirements.map((entry: { id: string }) => entry.id),
        ["electricity", "water"],
      );
      assert.ok(
        status.currentScope.requirements.every(
          (entry: { status: string }) => entry.status === "unanswered",
        ),
      );
      assert.equal(status.executionCertified, false);
    } finally {
      await fx.cleanup();
    }
  });

  it("requires exact separate scope authorization and keeps withdrawn original requirements visible", async () => {
    const fx = await fixture();
    try {
      const defined = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(defined.exitCode, 0, defined.stderr);
      const original = JSON.parse(defined.stdout).contractSha256;
      const input = join(fx.files, "scope.json");
      await writeFile(
        input,
        JSON.stringify({
          schemaVersion: 1,
          reason: "Owner proposes postponing the unavailable water dataset.",
          requirements: [contractInput().requirements[0]],
        }),
      );
      const proposed = await cli([
        "research",
        "project",
        "task",
        "scope",
        "propose",
        "task-project",
        "--input",
        input,
        "--expected-contract",
        original,
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(proposed.exitCode, 0, proposed.stderr);
      const proposal = JSON.parse(proposed.stdout);
      assert.deepEqual(proposal.changes.withdrawnRequirementIds, ["water"]);
      assert.equal(JSON.parse((await fx.task(["status"])).stdout).contractSha256, original);
      const approve = (confirmation?: string) =>
        cli([
          "research",
          "project",
          "task",
          "scope",
          "approve",
          "task-project",
          "--proposal",
          proposal.proposalSha256,
          ...(confirmation ? ["--confirm-change", confirmation] : []),
          "--workspace",
          fx.root,
          "--json",
        ]);
      const missing = await approve();
      assert.equal(missing.exitCode, 3);
      assert.equal(JSON.parse(missing.stderr).error.code, "RESEARCH_TASK_SCOPE_APPROVAL_REQUIRED");
      const mismatched = await approve("a".repeat(64));
      assert.equal(mismatched.exitCode, 3);
      const accepted = await approve(proposal.proposalSha256);
      assert.equal(accepted.exitCode, 0, accepted.stderr);
      const status = JSON.parse((await fx.task(["status"])).stdout);
      assert.notEqual(status.contractSha256, original);
      assert.equal(status.originalContractSha256, original);
      assert.deepEqual(
        status.currentScope.requirements.map((entry: { id: string }) => entry.id),
        ["electricity"],
      );
      assert.equal(
        status.originalScope.requirements.find((entry: { id: string }) => entry.id === "water")
          .status,
        "withdrawn",
      );
      assert.equal(status.originalScope.status, "incomplete");
      assert.equal(status.scopeAuthorization.kind, "operator-confirmation");
      const events = await readVerifiedJournal(workspacePaths(fx.root).journal);
      assert.equal(
        events.filter((event) => event.type === "project.task.scope.approved").length,
        1,
      );
      const replay = await approve(proposal.proposalSha256);
      assert.equal(replay.exitCode, 0, replay.stderr);
      assert.deepEqual(await readVerifiedJournal(workspacePaths(fx.root).journal), events);
      assert.equal(
        (await loadProject(fx.root, "task-project")).question,
        "Compare electricity and water evidence without presupposing a result.",
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects producer approval flags, duplicate IDs and sensitive content before committing a task", async () => {
    const fx = await fixture();
    try {
      const before = await readFile(workspacePaths(fx.root).journal);
      for (const value of [
        { ...contractInput(), approved: true },
        {
          ...contractInput(),
          requirements: [contractInput().requirements[0], contractInput().requirements[0]],
        },
        {
          ...contractInput(),
          originalRequest: "Authorization: Bearer private-test-token-123456789",
        },
      ]) {
        await writeFile(fx.inputPath, JSON.stringify(value));
        const result = await fx.task(["define", "--input", fx.inputPath]);
        assert.equal(result.exitCode, 3);
        assert.equal(JSON.parse(result.stderr).error.code, "RESEARCH_TASK_INVALID");
        assert.doesNotMatch(result.stdout + result.stderr, /private-test-token/);
      }
      assert.deepEqual(await readFile(workspacePaths(fx.root).journal), before);
    } finally {
      await fx.cleanup();
    }
  });

  it("preserves original requirements through a fork without inheriting completion", async () => {
    const fx = await fixture();
    try {
      const defined = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(defined.exitCode, 0, defined.stderr);
      const forked = await cli([
        "research",
        "project",
        "fork",
        "task-project",
        "--to",
        "task-successor",
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(forked.exitCode, 0, forked.stderr);
      const status = await fx.task(["status"], "task-successor");
      assert.equal(status.exitCode, 0, status.stderr);
      const result = JSON.parse(status.stdout);
      assert.equal(result.originalContractSha256, JSON.parse(defined.stdout).contractSha256);
      assert.deepEqual(
        result.originalScope.requirements.map((entry: { id: string }) => entry.id),
        ["electricity", "water"],
      );
      assert.equal(result.currentScope.status, "incomplete");
      assert.equal(result.origin.projectId, "task-project");
    } finally {
      await fx.cleanup();
    }
  });

  it("exposes task schemas offline and puts the bound task in the native stage packet", async () => {
    const schema = await cli(["research", "schema", "show", "task-contract", "--json"]);
    assert.equal(schema.exitCode, 0, schema.stderr);
    assert.equal(JSON.parse(schema.stdout).additionalProperties, false);
    const fx = await fixture();
    try {
      const defined = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(defined.exitCode, 0, defined.stderr);
      const prepared = await cli([
        "research",
        "project",
        "stage",
        "prepare",
        "task-project",
        "--stage",
        "discover",
        "--host-agent",
        "codex",
        "--workspace",
        fx.root,
        "--json",
      ]);
      assert.equal(prepared.exitCode, 0, prepared.stderr);
      const packet = JSON.parse(prepared.stdout);
      assert.equal(packet.taskContract.contractSha256, JSON.parse(defined.stdout).contractSha256);
      assert.deepEqual(
        packet.taskContract.requirements.map((entry: { id: string }) => entry.id),
        ["electricity", "water"],
      );
      const late = await fx.task(["define", "--input", fx.inputPath]);
      assert.equal(late.exitCode, 0, late.stderr); // An exact read-only acknowledgement is harmless.
    } finally {
      await fx.cleanup();
    }
  });
});

async function acquiredFixture() {
  const fx = await fixture();
  const defined = await fx.task(["define", "--input", fx.inputPath]);
  assert.equal(defined.exitCode, 0, defined.stderr);
  const inputPath = join(fx.files, "evidence.txt");
  await writeFile(
    inputPath,
    "Synthetic electricity and water comparison: no measured difference in this fixture.\n",
  );
  await addProjectInput(fx.root, "task-project", inputPath, "primary");
  const discover = await prepareNativeResearchStage({
    root: fx.root,
    projectId: "task-project",
    stage: "discover",
    hostAgent: "codex",
  });
  const [candidate] = await listEvidenceCandidates(fx.root, "task-project");
  assert.ok(candidate);
  await recordDiscoveryAssessmentBatch({
    root: fx.root,
    projectId: "task-project",
    value: {
      schemaVersion: 1,
      assessments: [
        {
          decision: "admit",
          candidateId: candidate.id,
          sourceId: "source-1",
          sourceType: "primary",
          relevance: "Direct fixture data.",
          quality: { level: "primary", rationale: "Exact synthetic input." },
          applicability: "Fixture only.",
          coverageDimensions: ["research-question"],
          limitations: [],
        },
      ],
    },
  });
  await submitFixtureStage(fx, discover, {
    schemaVersion: 2,
    limitations: [],
    dimensionJudgments: [{ id: "research-question", status: "covered" }],
    gaps: [],
  });
  const acquire = await prepareNativeResearchStage({
    root: fx.root,
    projectId: "task-project",
    stage: "acquire",
    hostAgent: "codex",
  });
  await submitFixtureStage(fx, acquire, {
    schemaVersion: 1,
    decisions: [
      {
        sourceId: "source-1",
        candidateId: candidate.id,
        artifactIds: [],
        status: "accepted",
        rationale: "Exact readable input.",
        limitations: [],
      },
    ],
    limitations: [],
    gaps: [],
  });
  const snapshot = await loadCurrentEvidenceSnapshot(fx.root, "task-project");
  const artifact = snapshot.artifacts[0]!;
  const atom = await registerEvidenceAtom({
    root: fx.root,
    projectId: "task-project",
    value: {
      schemaVersion: 1,
      atomId: "task-fixture-atom",
      sourceId: "source-1",
      candidateId: candidate.id,
      artifactId: artifact.artifactId,
      locator: { kind: "line-range", startLine: 1, endLine: 1 },
      statement: "The fixture records a null comparison.",
      evidenceRoleIds: [],
      coverageDimensionIds: ["research-question"],
      evidenceFunction: "support",
      scope: "Deterministic protocol fixture only.",
      limitations: [],
    },
  });
  await freezeEvidenceContentSnapshot(fx.root, "task-project");
  const rows = JSON.parse((await fx.task(["status"])).stdout).currentScope.requirements as Array<{
    id: string;
    requirementSha256: string;
  }>;
  return { ...fx, artifact, atom, rows };
}

function acceptanceInput(
  row: { id: string; requirementSha256: string },
  atomId: string,
  resultFiles: string[],
  outcome: string,
) {
  return {
    schemaVersion: 1,
    requirementId: row.id,
    requirementSha256: row.requirementSha256,
    previousRecordSha256: null,
    outcome,
    summary: "Observed fixture result with explicit limitations, not a CLI-certified execution.",
    checkKind: "evidence",
    reportedCommand: null,
    sourceIds: ["source-1"],
    evidenceAtomIds: [atomId],
    analysisFindingIds: [],
    resultFiles,
    limitations: ["Synthetic protocol fixture; not a scientific conclusion."],
  };
}

async function recordAcceptance(fx: Awaited<ReturnType<typeof fixture>>, value: object) {
  const path = join(fx.files, "acceptance.json");
  await writeFile(path, JSON.stringify(value));
  return cli([
    "research",
    "project",
    "task",
    "acceptance",
    "record",
    "task-project",
    "--input",
    path,
    "--workspace",
    fx.root,
    "--json",
  ]);
}

async function submitFixtureStage(
  fx: Awaited<ReturnType<typeof fixture>>,
  packet: Awaited<ReturnType<typeof prepareNativeResearchStage>>,
  value: object,
) {
  const outputPath = join(fx.files, `${packet.stage}.json`);
  await writeFile(outputPath, JSON.stringify(value));
  return submitNativeResearchStage({
    root: fx.root,
    projectId: "task-project",
    sessionId: packet.sessionId,
    outputPath,
    confirmedModel: packet.expectedModel,
  });
}

async function finishProducer(fx: Awaited<ReturnType<typeof acquiredFixture>>) {
  const analyze = await prepareNativeResearchStage({
    root: fx.root,
    projectId: "task-project",
    stage: "analyze",
    hostAgent: "codex",
  });
  const inference = JSON.parse(
    await readFile(
      join(workspacePaths(fx.root).projects, "task-project", "outputs/inference-snapshot.json"),
      "utf8",
    ),
  );
  await submitFixtureStage(fx, analyze, {
    schemaVersion: 2,
    inferenceSnapshotSha256: inference.snapshotSha256,
    analysisRun: {
      id: "native-fixture-observation",
      mode: "qualitative",
      status: "not-applicable",
      implementationSha256s: [],
      environmentSha256s: [],
      inputArtifactSha256s: [fx.artifact.sha256],
      command: null,
      randomSeed: null,
      limitations: [],
    },
    findings: [
      {
        id: "finding-1",
        statement: "This fixture supplies bounded null-result evidence.",
        evidence: ["source-1"],
        evidenceAtomIds: [fx.atom.atomId],
        claimIds: [],
        analysisArtifactSha256s: [],
        uncertainty: "Synthetic fixture only.",
        applicability: "Protocol verification, not real-world inference.",
      },
    ],
    limitations: [],
  });
  const synthesize = await prepareNativeResearchStage({
    root: fx.root,
    projectId: "task-project",
    stage: "synthesize",
    hostAgent: "codex",
  });
  await submitFixtureStage(fx, synthesize, {
    schemaVersion: 1,
    reportMarkdown:
      "# Bounded null result\n\nThe synthetic fixture supplies a null comparison with explicit limitations. This is protocol validation, not a real scientific study.\n",
  });
}
