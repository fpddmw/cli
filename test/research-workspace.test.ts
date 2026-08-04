import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { lockCapabilities, verifyCapabilities } from "../src/research/workspace/capabilities.js";
import { startCapabilityBroker } from "../src/research/workspace/broker.js";
import { inspectResearchContext } from "../src/research/workspace/context.js";
import { executeAgent } from "../src/research/workspace/executor.js";
import {
  addProjectInput,
  initializeProject,
  loadProject,
} from "../src/research/workspace/projects.js";
import { runResearchWorkspace, type PackageExecutor } from "../src/research/workspace/runtime.js";
import { workspacePaths } from "../src/research/workspace/storage.js";
import {
  doctorResearchWorkspace,
  initializeResearchWorkspace,
} from "../src/research/workspace/workspace.js";

describe("research workspace lifecycle", () => {
  it("initializes one current workspace format and resolves its role", async () => {
    const root = await temporaryDirectory();
    try {
      const before = await inspectResearchContext(root);
      assert.equal(before.role, "unmanaged");
      assert.deepEqual(before.allowedOperations, [
        "research.context.inspect",
        "research.workspace.init",
      ]);

      const initialized = await initializeResearchWorkspace(root, "Climate materials study");
      assert.equal(initialized.workspace, root);
      assert.equal(initialized.created.length, 6);
      const paths = workspacePaths(root);
      const marker = JSON.parse(await readFile(paths.marker, "utf8")) as Record<string, unknown>;
      assert.equal(marker.kind, "tiangong-research-workspace");
      assert.equal(marker.name, "Climate materials study");

      const after = await inspectResearchContext(join(root, ".tiangong-research", "projects"));
      assert.equal(after.role, "workspace");
      assert.equal(after.root, root);
      assert.ok(after.allowedOperations.includes("research.run"));

      const doctor = await doctorResearchWorkspace(root);
      assert.equal(doctor.status, "ready");
      assert.ok(doctor.checks.every((check) => check.status !== "fail"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a partial state directory as invalid", async () => {
    const root = await temporaryDirectory();
    try {
      await mkdir(join(root, ".tiangong-research"));
      const result = await inspectResearchContext(root);
      assert.equal(result.role, "invalid");
      assert.equal(result.violations[0]?.code, "WORKSPACE_MARKER_MISSING");
      assert.deepEqual(result.allowedOperations, ["research.context.inspect"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported workspace credential keys", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      await writeFile(paths.env, "UNSCOPED_TOKEN=not-a-real-value\n", { mode: 0o600 });
      await chmod(paths.env, 0o600);
      const doctor = await doctorResearchWorkspace(root);
      assert.equal(doctor.status, "blocked");
      assert.equal(
        doctor.checks.find((check) => check.id === "credential-environment")?.status,
        "fail",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects control-directory files as project inputs", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "protected-input", "Evaluate one protected input boundary.");
      const credentialPath = workspacePaths(root).env;
      await writeFile(
        credentialPath,
        'TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"source.example.api":"secret-value"}\n',
        { mode: 0o600 },
      );
      await assert.rejects(
        addProjectInput(root, "protected-input", credentialPath, "primary"),
        /cannot come from a research control directory/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks mutation when the workspace runtime version differs", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      const lock = JSON.parse(await readFile(paths.runtimeLock, "utf8")) as {
        packageVersion: string;
      };
      lock.packageVersion = "0.0.0";
      await writeFile(paths.runtimeLock, `${JSON.stringify(lock, null, 2)}\n`);

      const doctor = await doctorResearchWorkspace(root);
      assert.equal(doctor.status, "blocked");
      assert.equal(doctor.checks.find((check) => check.id === "runtime-lock")?.status, "fail");
      await assert.rejects(
        initializeProject(root, "wrong-runtime", "Evaluate a pinned runtime boundary."),
        /active CLI/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("research capability locks", () => {
  it("locks a regular skill tree and detects content drift", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const skillPath = join(skillParent, "sample-evidence");
      await mkdir(skillPath);
      await writeFile(
        join(skillPath, "SKILL.md"),
        "---\nname: sample-evidence\ndescription: Gather bounded evidence for a declared question.\n---\n\n# Sample\n",
      );
      await writeFile(join(skillPath, "method.txt"), "stable method\n");
      const declarations = {
        schemaVersion: 1,
        capabilities: [
          {
            id: "method.evidence",
            skillPath,
            permissions: ["project-read", "candidate-write"],
            credentials: [],
          },
        ],
      };
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(declarations, null, 2)}\n`,
      );

      const lock = await lockCapabilities(root);
      assert.equal(lock.capabilities.length, 1);
      assert.match(lock.capabilities[0]!.treeSha256, /^[0-9a-f]{64}$/);
      assert.match(lock.capabilities[0]!.policySha256, /^[0-9a-f]{64}$/);
      assert.equal((await verifyCapabilities(root)).status, "verified");

      declarations.capabilities[0]!.permissions.push("controlled-command");
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(declarations, null, 2)}\n`,
      );
      assert.equal((await verifyCapabilities(root)).status, "drifted");
      declarations.capabilities[0]!.permissions.pop();
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(declarations, null, 2)}\n`,
      );
      await writeFile(join(skillPath, "method.txt"), "changed method\n");
      const drift = await verifyCapabilities(root);
      assert.equal(drift.status, "drifted");
      assert.match(drift.errors[0] ?? "", /differs/);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("exposes a scoped MCP broker and refuses non-HTTPS targets", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const skillPath = join(skillParent, "public-source-fetch");
      await mkdir(skillPath);
      await writeFile(
        join(skillPath, "SKILL.md"),
        "---\nname: public-source-fetch\ndescription: Fetch a bounded public source for an admitted research task.\n---\n\n# Public Source Fetch\n",
      );
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            capabilities: [
              {
                id: "method.public-source",
                skillPath,
                permissions: ["project-read", "candidate-write", "brokered-network"],
                allowedHosts: ["example.test"],
                credentials: [],
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      await lockCapabilities(root);
      const capsuleProject = join(root, ".tiangong-research", "runtime", "broker-test", "project");
      await mkdir(capsuleProject, { recursive: true });
      const broker = await startCapabilityBroker(root, "broker-test", capsuleProject);
      assert.ok(broker);
      try {
        const listed = await rpc(broker.url, "tools/list", {});
        assert.equal(
          (
            (
              (listed.result as Record<string, unknown>).tools as Array<Record<string, unknown>>
            )[0] ?? {}
          ).name,
          "fetch_candidate_source",
        );
        const called = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "http://example.test/source",
          },
        });
        const result = called.result as Record<string, unknown>;
        assert.equal(result.isError, true);
        assert.match(
          String(((result.content as Array<Record<string, unknown>>)[0] ?? {}).text),
          /HTTPS/,
        );
        const outsideScope = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://other.test/source",
          },
        });
        assert.match(
          String(
            (
              (
                (outsideScope.result as Record<string, unknown>).content as Array<
                  Record<string, unknown>
                >
              )[0] ?? {}
            ).text,
          ),
          /outside capability scope/,
        );
      } finally {
        await broker.stop();
      }
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });
});

describe("research project execution", () => {
  it(
    "runs an executor inside the platform capsule and parses accounting",
    { skip: platform() !== "darwin" && platform() !== "linux" },
    async () => {
      const capsule = await temporaryDirectory();
      try {
        const projectRoot = join(capsule, "project");
        await mkdir(projectRoot);
        const credentialPath = join(capsule, ".tiangong-research", ".env");
        await mkdir(join(capsule, ".tiangong-research"));
        await writeFile(credentialPath, "sandbox-secret-value\n", { mode: 0o600 });
        const binary = join(capsule, "fake-codex");
        await writeFile(
          binary,
          [
            "#!/bin/sh",
            `if cat ${JSON.stringify(credentialPath)} >/dev/null 2>&1; then`,
            '  printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"credential readable"}}\'',
            "else",
            '  printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"bounded result"}}\'',
            "fi",
            'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":3}}\'',
            "",
          ].join("\n"),
        );
        await chmod(binary, 0o755);
        const result = await executeAgent({
          route: { agent: "codex", binary, model: null },
          prompt: "Perform the bounded task.",
          capsuleRoot: capsule,
          projectRoot,
          workspaceRoot: capsule,
          timeoutSeconds: 10,
          environment: { PATH: process.env.PATH },
          brokerUrl: null,
        });
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, "bounded result");
        assert.equal(result.tokens, 5);
      } finally {
        await rm(capsule, { recursive: true, force: true });
      }
    },
  );

  it("registers immutable inputs and closes through different agent families", async () => {
    const root = await temporaryDirectory();
    const inputParent = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(
        root,
        "gpu-resource-impact",
        "How do advanced GPU process nodes change environmental resource burdens?",
      );
      const inputPath = join(inputParent, "inventory.csv");
      await writeFile(inputPath, "node,water_liters\n5nm,42\n3nm,57\n");
      const input = await addProjectInput(root, "gpu-resource-impact", inputPath, "primary");
      assert.equal(input.role, "primary");
      assert.match(input.sha256, /^[0-9a-f]{64}$/);

      const agents: string[] = [];
      const baseExecutor = fakeExecutor(agents);
      const inspectingExecutor: PackageExecutor = async (request) => {
        const capsuleState = JSON.parse(
          await readFile(join(request.projectRoot, "project.json"), "utf8"),
        ) as { inputs: Array<{ path: string }> };
        assert.ok(capsuleState.inputs.every((item) => item.path.startsWith("inputs/")));
        assert.equal(JSON.stringify(capsuleState).includes(inputParent), false);
        return baseExecutor(request);
      };
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        inspectingExecutor,
      );
      assert.equal(result.status, "complete");
      assert.equal(result.stopReason, "all-projects-complete");
      assert.equal(result.cycles, 5);
      assert.deepEqual(agents, ["codex", "codex", "codex", "claude"]);

      const project = await loadProject(root, "gpu-resource-impact");
      assert.equal(project.status, "complete");
      assert.ok(project.packages.every((workPackage) => workPackage.status === "complete"));
      const closure = JSON.parse(
        await readFile(
          join(root, ".tiangong-research", "projects", project.id, "outputs", "closure.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      assert.equal(closure.status, "complete");
      assert.equal((closure.artifacts as unknown[]).length, 4);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(inputParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("runs independent projects concurrently", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(
        root,
        "project-alpha",
        "Assess water impacts of a manufacturing change.",
      );
      await initializeProject(
        root,
        "project-beta",
        "Assess energy impacts of a manufacturing change.",
      );
      const sharedInput = join(root, "shared-evidence.txt");
      await writeFile(sharedInput, "measured manufacturing evidence\n");
      await addProjectInput(root, "project-alpha", sharedInput, "primary");
      await addProjectInput(root, "project-beta", sharedInput, "primary");
      let active = 0;
      let maximumActive = 0;
      const base = fakeExecutor([]);
      const concurrentExecutor: PackageExecutor = async (request) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
        try {
          return await base(request);
        } finally {
          active -= 1;
        }
      };

      const result = await runResearchWorkspace(
        root,
        { maxParallel: 2, maxCycles: 10, dryRun: false, environment: {} },
        concurrentExecutor,
      );
      assert.equal(result.status, "complete");
      assert.ok(maximumActive >= 2);
      assert.equal(result.projects.length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records usage and blocks output import when a hard budget is exceeded", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        budget: { maxTokens: number };
      };
      config.budget.maxTokens = 5;
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await initializeProject(root, "bounded-project", "Evaluate one bounded evidence question.");

      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 2, dryRun: false, environment: {} },
        fakeExecutor([]),
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.stopReason, "project-blocked");
      const project = await loadProject(root, "bounded-project");
      assert.equal(project.usage.tokens, 10);
      assert.equal(project.packages[0]?.status, "failed");
      await assert.rejects(
        readFile(
          join(root, ".tiangong-research", "projects", project.id, "outputs", "evidence.json"),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows mechanical closure at the exact agent budget", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        budget: { maxTokens: number };
      };
      config.budget.maxTokens = 40;
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await initializeProject(root, "exact-budget", "Evaluate exact budget closure behavior.");
      const inputPath = join(root, "exact-budget-evidence.txt");
      await writeFile(inputPath, "measured exact-budget evidence\n");
      await addProjectInput(root, "exact-budget", inputPath, "primary");

      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        fakeExecutor([]),
      );
      assert.equal(result.status, "complete");
      assert.equal(result.stopReason, "all-projects-complete");
      assert.equal(result.projects[0]?.usage.tokens, 40);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks execution when producer and reviewer use the same agent family", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        reviewer: { agent: string; binary: string; model: string | null };
      };
      config.reviewer = { agent: "codex", binary: "codex", model: null };
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await initializeProject(root, "same-family", "Evaluate one independently reviewed question.");

      const doctor = await doctorResearchWorkspace(root);
      assert.equal(doctor.status, "blocked");
      await assert.rejects(
        runResearchWorkspace(
          root,
          { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
          fakeExecutor([]),
        ),
        /different agent families/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("research workspace CLI", () => {
  it("exposes only the current command family", async () => {
    const root = await temporaryDirectory();
    try {
      const initialized = await invoke(["research", "workspace", "init", root, "--json"]);
      assert.equal(initialized.exitCode, 0);
      assert.equal((JSON.parse(initialized.stdout) as Record<string, unknown>).workspace, root);

      const context = await invoke(["research", "context", "inspect", "--path", root, "--json"]);
      assert.equal(context.exitCode, 0);
      assert.equal((JSON.parse(context.stdout) as Record<string, unknown>).role, "workspace");

      const project = await invoke([
        "research",
        "project",
        "init",
        "current-interface",
        "--workspace",
        root,
        "--question",
        "What evidence is required to evaluate the declared system?",
        "--json",
      ]);
      assert.equal(project.exitCode, 0);

      const dryRun = await invoke(["research", "run", "--workspace", root, "--dry-run", "--json"]);
      assert.equal(dryRun.exitCode, 0);
      assert.equal((JSON.parse(dryRun.stdout) as Record<string, unknown>).status, "dry-run");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fakeExecutor(agentLog: string[]): PackageExecutor {
  return async (request) => {
    agentLog.push(request.route.agent);
    const stage = request.prompt.match(/^Stage: ([a-z]+)$/m)?.[1];
    const outputs = join(request.projectRoot, "outputs");
    if (stage === "discover") {
      const capsuleState = JSON.parse(
        await readFile(join(request.projectRoot, "project.json"), "utf8"),
      ) as { inputs: Array<{ id: string; path: string }> };
      const admittedInput = capsuleState.inputs[0];
      await writeFile(
        join(outputs, "evidence.json"),
        `${JSON.stringify({
          sources: admittedInput
            ? [
                {
                  id: "source-1",
                  title: "Measured inventory",
                  locator: admittedInput.path,
                  relevance: "Directly measures the declared comparison.",
                  provenance: { kind: "input", id: admittedInput.id },
                },
              ]
            : [],
          limitations: [],
        })}\n`,
      );
    } else if (stage === "analyze") {
      await writeFile(
        join(outputs, "analysis.json"),
        `${JSON.stringify({
          findings: [
            {
              id: "finding-1",
              statement: "The admitted inventory supports a bounded comparison.",
              evidence: ["source-1"],
              uncertainty: "Bounded by the admitted inventory.",
            },
          ],
        })}\n`,
      );
    } else if (stage === "synthesize") {
      await writeFile(
        join(outputs, "report.md"),
        "# Findings\n\nThe admitted inventory supports a bounded comparison.\n",
      );
    } else if (stage === "review") {
      const packet = JSON.parse(
        await readFile(join(request.projectRoot, "inputs", "review-packet.json"), "utf8"),
      ) as { packetSha256: string };
      await writeFile(
        join(outputs, "review.json"),
        `${JSON.stringify({
          packetSha256: packet.packetSha256,
          decision: "pass",
          issues: [],
          rationale: "Claims remain within the admitted evidence.",
        })}\n`,
      );
    } else {
      throw new Error(`Unexpected stage: ${stage ?? "missing"}`);
    }
    return {
      exitCode: 0,
      stdout: `${stage} complete`,
      stderr: "",
      tokens: 10,
      costUsd: 0.01,
      wallSeconds: 0.1,
    };
  };
}

async function invoke(
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env: {},
    stdout: { write: (chunk: string) => void (stdout += chunk) },
    stderr: { write: (chunk: string) => void (stderr += chunk) },
  });
  return { exitCode, stdout, stderr };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tiangong-research-workspace-test-"));
}

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}
