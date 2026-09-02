import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import { readVerifiedJournal } from "../src/research/workspace/journal.js";
import { initializeProject, loadProject } from "../src/research/workspace/projects.js";
import { workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

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
