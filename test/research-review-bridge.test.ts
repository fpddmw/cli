import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { CliError } from "../src/errors.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import type { AgentExecutionRequest } from "../src/research/workspace/executor.js";
import {
  createReviewExecutor,
  inspectReviewerBridgeStatus,
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
  doctorResearchWorkspace,
  initializeResearchWorkspace,
  loadWorkspaceConfig,
} from "../src/research/workspace/workspace.js";

describe("sandbox-bridge reviewer execution", () => {
  it("exposes safe reviewer sidecar help and structured unavailable status", async () => {
    const fixture = await bridgeFixture();
    try {
      const help = await invoke(["research", "reviewer", "--help"]);
      assert.equal(help.exitCode, 0, help.stderr);
      assert.match(help.stdout, /reviewer serve/);
      assert.match(help.stdout, /reviewer status/);
      assert.match(help.stdout, /reviewer doctor/);

      const status = await invoke([
        "research",
        "reviewer",
        "status",
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(status.exitCode, 3);
      assert.equal(JSON.parse(status.stderr).error.code, "RESEARCH_REVIEW_BRIDGE_UNAVAILABLE");
      assert.doesNotMatch(status.stderr, /clientToken|authorization|cookie/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("serves and stops the exact CLI sidecar without exposing its client secret", async () => {
    const fixture = await bridgeFixture();
    const stateDirectory = await mkdtemp(join(tmpdir(), "tiangong-review-cli-state-"));
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), "bin", "tiangong-ai.js"),
        "research",
        "reviewer",
        "serve",
        "--workspace",
        fixture.root,
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const readyLine = await firstLine(child);
      const ready = JSON.parse(readyLine) as {
        status: string;
        workspaceId: string;
        keyFingerprint: string;
      };
      assert.equal(ready.status, "ready");
      assert.match(ready.keyFingerprint, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(readyLine, /clientToken|authorization|private-key|state-/i);

      const status = await invoke([
        "research",
        "reviewer",
        "status",
        "--workspace",
        fixture.root,
        "--json",
      ]);
      assert.equal(status.exitCode, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).workspaceId, ready.workspaceId);

      child.kill("SIGTERM");
      const [exitCode, signal] = (await once(child, "exit")) as [number | null, string | null];
      assert.equal(exitCode, 0, `sidecar terminated by ${signal ?? "unknown"}`);
      assert.equal(signal, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.all([fixture.cleanup(), rm(stateDirectory, { recursive: true, force: true })]);
    }
  });

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
        return { ...successfulResult(), stderr: "Authorization: Bearer bridge-secret-value" };
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
      assert.match(result.stderr, /\[REDACTED\]/);
      assert.equal(nativeCalls, 1);

      const concurrentExecutor = createReviewExecutor({
        root: fixture.root,
        execution: fixture.execution,
        nonceFactory: () => "d".repeat(64),
      });
      const concurrent = await Promise.allSettled([
        concurrentExecutor.execute(fixture.request),
        concurrentExecutor.execute(fixture.request),
      ]);
      assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
      const concurrentFailure = concurrent.find(
        (entry): entry is PromiseRejectedResult => entry.status === "rejected",
      );
      assert.ok(concurrentFailure?.reason instanceof CliError);
      assert.equal(
        (concurrentFailure.reason as CliError).code,
        "RESEARCH_REVIEW_BRIDGE_NONCE_REPLAY",
      );
      assert.equal(nativeCalls, 2);
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
      assert.equal(nativeCalls, 2);

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
      assert.equal(nativeCalls, 2);

      const paths = reviewerBridgePaths(fixture.root);
      const connection = JSON.parse(await readFile(paths.connection, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(connection.protocolVersion, 1);
      assert.equal(connection.workspaceId, sidecar.workspaceId);
      assert.equal(connection.keyFingerprint, sidecar.keyFingerprint);
      assert.doesNotMatch(JSON.stringify(sidecar), /clientToken|privateKey|bridge-secret/);

      const bridgeStatus = await inspectReviewerBridgeStatus(fixture.root);
      assert.deepEqual(bridgeStatus.negativeProbes, {
        outsideReadBlocked: true,
        outsideWriteBlocked: true,
        workspaceCredentialReadBlocked: true,
        arbitraryCommandSurfaceAbsent: true,
        reviewerToolsDisabled: true,
      });

      const unsupported = await postUnix(paths.socket, "/v1/command", {});
      assert.equal(unsupported.status, 404);
      assert.equal(
        (JSON.parse(unsupported.body) as { error: { code: string } }).error.code,
        "RESEARCH_REVIEW_BRIDGE_ACTION_INVALID",
      );

      await writeFile(
        paths.connection,
        `${JSON.stringify({ ...connection, packageVersion: "0.0.0" }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const versionExecutor = createReviewExecutor({
        root: fixture.root,
        execution: fixture.execution,
        nonceFactory: () => "e".repeat(64),
      });
      await assert.rejects(versionExecutor.execute(fixture.request), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "RESEARCH_REVIEW_BRIDGE_VERSION_MISMATCH");
        return true;
      });
      assert.equal(nativeCalls, 2);

      const untrustedPublicKey = generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString();
      await writeFile(
        paths.connection,
        `${JSON.stringify({ ...connection, publicKey: untrustedPublicKey }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const signatureExecutor = createReviewExecutor({
        root: fixture.root,
        execution: fixture.execution,
        nonceFactory: () => "f".repeat(64),
      });
      await assert.rejects(signatureExecutor.execute(fixture.request), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "RESEARCH_REVIEW_BRIDGE_ATTESTATION_INVALID");
        return true;
      });
      assert.equal(nativeCalls, 3);
    } finally {
      await sidecar.close();
      await Promise.all([fixture.cleanup(), rm(stateDirectory, { recursive: true, force: true })]);
    }
  });

  it("rejects a symlinked sidecar state directory before creating key material", async () => {
    const fixture = await bridgeFixture();
    const parent = await mkdtemp(join(tmpdir(), "tiangong-review-state-link-"));
    const target = join(parent, "target");
    const link = join(parent, "link");
    await mkdir(target);
    await symlink(target, link);
    try {
      await assert.rejects(
        startReviewerBridgeSidecar({
          root: fixture.root,
          stateDirectory: link,
          environment: { PATH: process.env.PATH },
          executeNative: async () => successfulResult(),
        }),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, "RESEARCH_REVIEW_BRIDGE_STATE_INVALID");
          return true;
        },
      );
      await assert.rejects(readFile(join(target, "reviewer-bridge-private-key.pem")), /ENOENT/);
    } finally {
      await Promise.all([fixture.cleanup(), rm(parent, { recursive: true, force: true })]);
    }
  });

  it("runs the workspace reviewer smoke through the explicitly configured bridge", async () => {
    const fixture = await bridgeFixture();
    const stateDirectory = await mkdtemp(join(tmpdir(), "tiangong-review-doctor-state-"));
    await lockCapabilities(fixture.root);
    let sidecarExecutions = 0;
    const sidecar = await startReviewerBridgeSidecar({
      root: fixture.root,
      stateDirectory,
      environment: { PATH: process.env.PATH },
      executeNative: async () => {
        sidecarExecutions += 1;
        return successfulResult();
      },
    });
    try {
      const doctor = await doctorResearchWorkspace(fixture.root, {
        agentSmoke: true,
        environment: { PATH: process.env.PATH },
      });
      assert.equal(doctor.status, "ready");
      assert.equal(
        doctor.checks.find((check) => check.id === "agent-sandbox-smoke")?.status,
        "pass",
      );
      assert.equal(sidecarExecutions, 1);
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

async function invoke(argv: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env: {},
    stdout: { write: (chunk: string) => void (stdout += chunk) },
    stderr: { write: (chunk: string) => void (stderr += chunk) },
  });
  return { exitCode, stdout, stderr };
}

async function postUnix(
  socketPath: string,
  path: string,
  value: unknown,
): Promise<{ status: number; body: string }> {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": body.byteLength },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function firstLine(child: ChildProcess): Promise<string> {
  if (!child.stdout || !child.stderr) throw new Error("sidecar stdio is unavailable");
  return new Promise<string>((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`sidecar did not become ready: ${stderr.slice(0, 500)}`));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolvePromise(stdout.slice(0, newline));
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`sidecar exited ${String(code)} before ready: ${stderr.slice(0, 500)}`));
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}
