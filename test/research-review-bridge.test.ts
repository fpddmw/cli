import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import type { AgentExecutionRequest } from "../src/research/workspace/executor.js";
import {
  createReviewExecutor,
  reviewerBridgePaths,
  startReviewerBridgeSidecar,
} from "../src/research/workspace/review-executor.js";
import { schemaForStage } from "../src/research/workspace/schemas.js";
import {
  hashRegularTree,
  workspacePaths,
  writeJsonAtomic,
} from "../src/research/workspace/storage.js";
import type {
  ExecutionResult,
  ReviewExecutionConfig,
  WorkspaceConfig,
} from "../src/research/workspace/types.js";
import {
  initializeResearchWorkspace,
  loadWorkspaceConfig,
} from "../src/research/workspace/workspace.js";

describe("sandbox-bridge reviewer execution", () => {
  it("fails closed when the explicitly selected bridge is unavailable", async () => {
    const fixture = await bridgeFixture();
    try {
      let nativeFallbackCalls = 0;
      const executor = createReviewExecutor({
        root: fixture.root,
        execution: fixture.execution,
        executeNative: async () => {
          nativeFallbackCalls += 1;
          return successfulResult();
        },
      });

      await assert.rejects(executor.execute(fixture.request), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "RESEARCH_REVIEW_BRIDGE_UNAVAILABLE");
        assert.match(error.message, /start.*reviewer sidecar/i);
        assert.doesNotMatch(JSON.stringify(error.details), /token|authorization|cookie/i);
        return true;
      });
      assert.equal(nativeFallbackCalls, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("executes one exact capsule through a signed sidecar and rejects replay and policy drift", async () => {
    const fixture = await bridgeFixture();
    const stateDirectory = await mkdtemp(join(tmpdir(), "tiangong-review-sidecar-state-"));
    const canonicalStateDirectory = await realpath(stateDirectory);
    let nativeCalls = 0;
    const sidecar = await startReviewerBridgeSidecar({
      root: fixture.root,
      stateDirectory,
      environment: { PATH: process.env.PATH, REVIEW_SECRET: "bridge-secret-value" },
      executeNative: async (request) => {
        nativeCalls += 1;
        assert.equal(request.route.agent, "claude");
        assert.equal(request.route.model, "bridge-reviewer-model");
        assert.equal(request.toolPolicy, "none");
        assert.equal(request.brokerUrl, null);
        assert.ok(request.capsuleRoot.startsWith(`${canonicalStateDirectory}/`));
        assert.ok(request.projectRoot.startsWith(`${request.capsuleRoot}/`));
        assert.equal(
          await readFile(join(request.projectRoot, "review-packet.txt"), "utf8"),
          "packet\n",
        );
        return successfulResult();
      },
    });
    try {
      const nonce = "a".repeat(64);
      const executor = createReviewExecutor({
        root: fixture.root,
        execution: fixture.execution,
        nonceFactory: () => nonce,
        executeNative: async () => {
          throw new Error("sandbox-bridge must never invoke the client native executor");
        },
      });
      const result = await executor.execute(fixture.request);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '{"ok":true}');
      assert.equal(nativeCalls, 1);
      assert.equal(result.reviewAttestation?.transport, "sandbox-bridge");
      assert.equal(result.reviewAttestation?.isolationProvider, "bubblewrap");
      assert.equal(result.reviewAttestation?.toolPolicy, "none");
      assert.match(result.reviewAttestation?.requestSha256 ?? "", /^[a-f0-9]{64}$/);
      assert.match(result.reviewAttestation?.resultSha256 ?? "", /^[a-f0-9]{64}$/);
      assert.match(result.reviewAttestation?.capsuleSha256 ?? "", /^[a-f0-9]{64}$/);
      assert.match(result.reviewAttestation?.policySha256 ?? "", /^[a-f0-9]{64}$/);
      assert.match(result.reviewAttestation?.signerKeyFingerprint ?? "", /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(result), /bridge-secret-value|private-key|state-/);

      await assert.rejects(executor.execute(fixture.request), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "RESEARCH_REVIEW_BRIDGE_NONCE_REPLAY");
        return true;
      });
      assert.equal(nativeCalls, 1);

      const policyDriftExecutor = createReviewExecutor({
        root: fixture.root,
        execution: fixture.execution,
        nonceFactory: () => "b".repeat(64),
      });
      await assert.rejects(
        policyDriftExecutor.execute({ ...fixture.request, toolPolicy: "workspace-read" }),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, "RESEARCH_REVIEW_BRIDGE_SANDBOX_POLICY_INVALID");
          return true;
        },
      );

      const modelDriftExecutor = createReviewExecutor({
        root: fixture.root,
        execution: fixture.execution,
        nonceFactory: () => "c".repeat(64),
      });
      await assert.rejects(
        modelDriftExecutor.execute({
          ...fixture.request,
          route: { ...fixture.request.route, model: "unreviewed-model" },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, "RESEARCH_REVIEW_BRIDGE_MODEL_MISMATCH");
          return true;
        },
      );
      assert.equal(nativeCalls, 1);

      const paths = reviewerBridgePaths(fixture.root);
      const connection = JSON.parse(await readFile(paths.connection, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(connection.protocolVersion, 1);
      assert.equal(connection.workspaceId, sidecar.workspaceId);
      assert.equal(connection.keyFingerprint, sidecar.keyFingerprint);
      assert.doesNotMatch(JSON.stringify(sidecar), /clientToken|privateKey|bridge-secret/);
    } finally {
      await sidecar.close();
      await Promise.all([fixture.cleanup(), rm(stateDirectory, { recursive: true, force: true })]);
    }
  });
});

async function bridgeFixture(): Promise<{
  root: string;
  execution: ReviewExecutionConfig;
  request: AgentExecutionRequest;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "tiangong-review-bridge-workspace-"));
  await initializeResearchWorkspace(root, "bridge-test");
  const config = await loadWorkspaceConfig(root);
  const execution: ReviewExecutionConfig = {
    transport: "sandbox-bridge",
    isolationProvider: "platform-capsule",
  };
  const updated: WorkspaceConfig = {
    ...config,
    reviewer: {
      ...config.reviewer,
      agent: "claude",
      binary: "claude",
      model: "bridge-reviewer-model",
    },
    reviewerExecution: execution,
  };
  await writeJsonAtomic(workspacePaths(root).config, updated);
  const capsuleRoot = join(workspacePaths(root).runtime, "bridge-capsule");
  const projectRoot = join(capsuleRoot, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "review-packet.txt"), "packet\n");
  const request: AgentExecutionRequest = {
    route: updated.reviewer,
    prompt: 'Return exactly {"ok":true}.',
    outputSchema: schemaForStage("doctor"),
    requestId: "bridge-review-request",
    purpose: "doctor",
    capsuleRoot,
    projectRoot,
    workspaceRoot: root,
    timeoutSeconds: 10,
    maxTurns: 1,
    maxOutputTokens: 100,
    maxCostUsd: 1,
    toolPolicy: "none",
    environment: { PATH: process.env.PATH },
    brokerUrl: null,
  };
  assert.match(await hashRegularTree(projectRoot), /^[a-f0-9]{64}$/);
  return {
    root,
    execution,
    request,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function successfulResult(): ExecutionResult {
  return {
    exitCode: 0,
    stdout: '{"ok":true}',
    stderr: "",
    tokens: 3,
    inputTokens: 2,
    cachedInputTokens: 0,
    outputTokens: 1,
    costUsd: 0.001,
    wallSeconds: 0.01,
    model: "bridge-reviewer-model",
    runtime: {
      agent: "claude",
      model: "bridge-reviewer-model",
      effort: "low",
      verbosity: null,
      binarySha256: "1".repeat(64),
      wrapperSha256: "2".repeat(64),
      adapterSha256: "3".repeat(64),
      binaryVersion: "fake-claude 1.0",
      platform: "linux",
      architecture: "arm64",
    },
    isolation: {
      provider: "bubblewrap",
      policySha256: "4".repeat(64),
      readScopes: ["platform-runtime", "agent-runtime", "private-capsule"],
      writeScopes: ["private-capsule"],
      networkPolicy: "reviewer-provider-only",
      toolPolicy: "none",
    },
    telemetry: {
      eventCounts: {},
      itemCounts: {},
      toolCalls: 0,
      providerTurns: 1,
      reasoningOutputTokens: 0,
      providerErrors: [],
    },
  };
}
