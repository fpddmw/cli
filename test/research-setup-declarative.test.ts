import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import {
  discoverResearchSetupDeclaration,
  executeResearchSetupDeclaration,
  initializeResearchSetupDeclaration,
  loadResearchSetupDeclaration,
} from "../src/research/workspace/setup-declarative.js";
import {
  createResearchSetupPlan,
  loadAndVerifyResearchSetupPlan,
} from "../src/research/workspace/setup.js";
import { workspacePaths } from "../src/research/workspace/storage.js";

describe("declarative research setup", () => {
  it("creates safe no-overwrite YAML and env templates without accepting owner consent", async () => {
    const root = await temporaryDirectory();
    try {
      const created = await initializeResearchSetupDeclaration(root);
      const yaml = await readFile(created.configurationPath, "utf8");
      const envExample = await readFile(created.environmentExamplePath, "utf8");
      const ignore = await readFile(join(root, ".tiangong-research", ".gitignore"), "utf8");

      assert.match(yaml, /kind: tiangong-research-setup/);
      assert.match(yaml, /mode: production-research/);
      assert.match(yaml, /networkDownloads: false/);
      assert.match(yaml, /agentSmokeCost: false/);
      assert.match(yaml, /acceptedLicenseIds:\s*\[\]/);
      assert.doesNotMatch(yaml, /owner-secret|example-secret/i);
      assert.match(envExample, /^BRAVE_API_KEY=$/m);
      assert.match(ignore, /^setup\.env$/m);

      await assert.rejects(
        initializeResearchSetupDeclaration(root),
        errorCode("RESEARCH_SETUP_DECLARATION_EXISTS"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes template initialization through the public CLI", async () => {
    const root = await temporaryDirectory();
    try {
      const initialized = await invoke([
        "research",
        "setup",
        "init",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(initialized.exitCode, 0, initialized.stderr);
      const value = JSON.parse(initialized.stdout) as {
        configurationPath: string;
        environmentExamplePath: string;
      };
      assert.equal(value.configurationPath, workspacePaths(await realpath(root)).setupDeclaration);
      assert.equal(
        value.environmentExamplePath,
        workspacePaths(await realpath(root)).setupDeclarationEnvExample,
      );

      const automatic = await invoke(["research", "setup", "--workspace", root, "--json"]);
      assert.equal(automatic.exitCode, 2);
      assert.equal(JSON.parse(automatic.stderr).error.code, "RESEARCH_SETUP_DECLARATION_INVALID");
      assert.doesNotMatch(automatic.stderr, /RESEARCH_SETUP_TTY_REQUIRED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers only the fixed workspace-local YAML and never scans a parent", async () => {
    const parent = await temporaryDirectory();
    const child = join(parent, "child");
    try {
      await mkdir(child);
      await writeConfiguration(parent, validDeclaration());
      assert.equal(await discoverResearchSetupDeclaration(child), null);

      await writeConfiguration(child, validDeclaration());
      assert.deepEqual(await discoverResearchSetupDeclaration(child), {
        configurationPath: workspacePaths(await realpath(child)).setupDeclaration,
        environmentPath: null,
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("loads strict YAML plus an owner-only env companion without persisting secret values", async () => {
    const root = await temporaryDirectory();
    const secret = "declarative-brave-owner-secret";
    try {
      const configurationPath = await writeConfiguration(root, validDeclaration());
      const environmentPath = await writeEnvironment(root, `BRAVE_API_KEY=${secret}\n`);
      const loaded = await loadResearchSetupDeclaration({
        workspace: root,
        configurationPath,
        environmentPath,
        environment: {},
      });

      assert.equal(loaded.planInput.liveChecks, true);
      assert.equal(loaded.planInput.agentSmoke, true);
      assert.equal(loaded.planInput.confirmAgentSmokeCost, true);
      assert.equal(
        loaded.planInput.credentialEnvironment?.["brave.search.api-key"],
        "BRAVE_API_KEY",
      );
      assert.equal(loaded.environment.BRAVE_API_KEY, secret);
      assert.match(loaded.configurationSha256, /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(loaded.planInput).includes(secret), false);
      assert.equal(JSON.stringify(loaded.publicSummary).includes(secret), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe env files, undeclared variables, and ambient/file conflicts", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    try {
      const configurationPath = await writeConfiguration(root, validDeclaration());
      const environmentPath = await writeEnvironment(root, "BRAVE_API_KEY=first-owner-secret\n");

      if (platform() !== "win32") {
        await chmod(environmentPath, 0o644);
        await assert.rejects(
          loadResearchSetupDeclaration({ workspace: root, configurationPath, environmentPath }),
          errorCode("RESEARCH_SETUP_DECLARATION_ENV_UNSAFE"),
        );
        await chmod(environmentPath, 0o600);
      }

      await writeFile(environmentPath, "UNDECLARED_KEY=second-owner-secret\n", { mode: 0o600 });
      await assert.rejects(
        loadResearchSetupDeclaration({ workspace: root, configurationPath, environmentPath }),
        errorCode("RESEARCH_SETUP_DECLARATION_ENV_INVALID"),
      );

      await writeFile(join(outside, "source.env"), "BRAVE_API_KEY=third-owner-secret\n", {
        mode: 0o600,
      });
      await rm(environmentPath, { force: true });
      await symlink(join(outside, "source.env"), environmentPath);
      await assert.rejects(
        loadResearchSetupDeclaration({ workspace: root, configurationPath, environmentPath }),
        errorCode("RESEARCH_SETUP_DECLARATION_ENV_UNSAFE"),
      );

      await rm(environmentPath, { force: true });
      await writeEnvironment(root, "BRAVE_API_KEY=file-owner-secret\n");
      await assert.rejects(
        loadResearchSetupDeclaration({
          workspace: root,
          configurationPath,
          environmentPath,
          environment: { BRAVE_API_KEY: "different-ambient-owner-secret" },
        }),
        errorCode("RESEARCH_SETUP_DECLARATION_ENV_CONFLICT"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects duplicate, aliased, unknown, and incomplete declarations without echoing secrets", async () => {
    const cases = [
      validDeclaration().replace("schemaVersion: 1", "schemaVersion: 1\nschemaVersion: 1"),
      validDeclaration().replace(
        "workspace:\n",
        "shared: &shared production-research\nworkspace:\n",
      ),
      validDeclaration().replace("mode: production-research", "mode: *shared"),
      validDeclaration().replace(
        "replaceExistingPlan: false",
        "rawApiKey: secret-never-print\nreplaceExistingPlan: false",
      ),
      validDeclaration().replace("live: true", "live: false"),
    ];
    for (const content of cases) {
      const root = await temporaryDirectory();
      try {
        const configurationPath = await writeConfiguration(root, content);
        await assert.rejects(
          loadResearchSetupDeclaration({ workspace: root, configurationPath }),
          (error: unknown) => {
            assert.equal(error instanceof Error, true);
            assert.equal(String(error).includes("secret-never-print"), false);
            return errorCode("RESEARCH_SETUP_DECLARATION_INVALID")(error);
          },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("runs full verification, reports partial readiness as failure, and reuses an identical plan", async () => {
    const root = await temporaryDirectory();
    const secret = "declarative-execution-owner-secret";
    try {
      const configurationPath = await writeConfiguration(root, validDeclaration());
      const environmentPath = await writeEnvironment(root, `BRAVE_API_KEY=${secret}\n`);
      const partial = await executeResearchSetupDeclaration({
        workspace: root,
        configurationPath,
        environmentPath,
        environment: {},
        operations: {
          createPlan: createResearchSetupPlan,
          loadPlan: loadAndVerifyResearchSetupPlan,
          applyPlan: async (planPath, options) => {
            assert.equal(options.environment?.BRAVE_API_KEY, secret);
            const plan = await loadAndVerifyResearchSetupPlan(planPath);
            assert.equal(plan.checks.live, true);
            assert.equal(plan.checks.agentSmoke, true);
            return fakeApply(plan, "partially-ready", "PARTIALLY_READY");
          },
        },
      });
      assert.equal(partial.exitCode, 3);
      assert.equal(partial.status, "incomplete");
      assert.equal(partial.reusedPlan, false);
      assert.equal(JSON.stringify(partial).includes(secret), false);
      assert.equal(
        `${await readFile(workspacePaths(root).setupPlan, "utf8")}\n${await readFile(
          workspacePaths(root).setupDeclarationBinding,
          "utf8",
        )}`.includes(secret),
        false,
      );

      const ready = await executeResearchSetupDeclaration({
        workspace: root,
        configurationPath,
        environmentPath,
        environment: {},
        operations: {
          createPlan: async () => {
            throw new Error("an identical declaration must not create another immutable plan");
          },
          loadPlan: loadAndVerifyResearchSetupPlan,
          applyPlan: async (planPath) =>
            fakeApply(await loadAndVerifyResearchSetupPlan(planPath), "ready", "READY"),
        },
      });
      assert.equal(ready.exitCode, 0);
      assert.equal(ready.status, "ready");
      assert.equal(ready.reusedPlan, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit replacement when the declaration changes", async () => {
    const root = await temporaryDirectory();
    try {
      const configurationPath = await writeConfiguration(root, validDeclaration());
      const environmentPath = await writeEnvironment(root, "BRAVE_API_KEY=replace-owner-secret\n");
      const first = await executeResearchSetupDeclaration({
        workspace: root,
        configurationPath,
        environmentPath,
        environment: {},
        operations: {
          createPlan: createResearchSetupPlan,
          loadPlan: loadAndVerifyResearchSetupPlan,
          applyPlan: async (planPath) =>
            fakeApply(await loadAndVerifyResearchSetupPlan(planPath), "ready", "READY"),
        },
      });

      await writeFile(
        configurationPath,
        validDeclaration().replace("name: Declarative Research", "name: Changed Research"),
      );
      await assert.rejects(
        executeResearchSetupDeclaration({
          workspace: root,
          configurationPath,
          environmentPath,
          environment: {},
        }),
        errorCode("RESEARCH_SETUP_DECLARATION_CHANGED"),
      );

      await writeFile(
        configurationPath,
        validDeclaration()
          .replace("name: Declarative Research", "name: Changed Research")
          .replace("replaceExistingPlan: false", "replaceExistingPlan: true"),
      );
      const replaced = await executeResearchSetupDeclaration({
        workspace: root,
        configurationPath,
        environmentPath,
        environment: {},
        operations: {
          createPlan: createResearchSetupPlan,
          loadPlan: loadAndVerifyResearchSetupPlan,
          applyPlan: async (planPath) =>
            fakeApply(await loadAndVerifyResearchSetupPlan(planPath), "ready", "READY"),
        },
      });
      assert.equal(replaced.reusedPlan, false);
      assert.notEqual(replaced.plan.planSha256, first.plan.planSha256);
      assert.equal(
        await readFile(
          join(
            workspacePaths(root).control,
            "setup-history",
            first.plan.planSha256,
            "setup-declaration.json",
          ),
          "utf8",
        ).then((value) => value.includes(first.plan.planSha256)),
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a discovered declaration before checking for a TTY", async () => {
    const root = await temporaryDirectory();
    try {
      await writeConfiguration(
        root,
        validDeclaration().replace(
          "replaceExistingPlan: false",
          "unexpectedSecret: command-path-secret\nreplaceExistingPlan: false",
        ),
      );
      const result = await invoke(["research", "setup", "--workspace", root, "--json"]);
      assert.equal(result.exitCode, 2);
      assert.equal(JSON.parse(result.stderr).error.code, "RESEARCH_SETUP_DECLARATION_INVALID");
      assert.equal(result.stderr.includes("command-path-secret"), false);
      assert.doesNotMatch(result.stderr, /RESEARCH_SETUP_TTY_REQUIRED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns non-zero for apply, status, and doctor until every selected check is ready", async () => {
    const root = await temporaryDirectory();
    try {
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        acceptedLicenseIds: [],
        confirmNetworkDownloads: false,
      });
      const applied = await invoke([
        "research",
        "setup",
        "apply",
        "--workspace",
        root,
        "--skip-doctor",
        "--json",
      ]);
      assert.equal(applied.exitCode, 3, applied.stderr);
      assert.equal(JSON.parse(applied.stdout).state.status, "partially-ready");

      const status = await invoke(["research", "setup", "status", "--workspace", root, "--json"]);
      assert.equal(status.exitCode, 3, status.stderr);

      const doctor = await invoke(["research", "setup", "doctor", "--workspace", root, "--json"]);
      assert.equal(doctor.exitCode, 3, doctor.stderr);
      assert.notEqual(JSON.parse(doctor.stdout).overallReadiness, "READY");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function validDeclaration(): string {
  return `schemaVersion: 1
kind: tiangong-research-setup
workspace:
  name: Declarative Research
  mode: production-research
install:
  scope: project
  agents:
    - codex
selection:
  evidenceProfile: brave-baseline
  skillIds:
    - tiangong.auto-research
acceptedLicenseIds:
  - brave-search-skills:MIT
  - tiangong-ai-skills:MIT
credentialEnvironment:
  brave.search.api-key: BRAVE_API_KEY
settings: {}
agentRoutes:
  producerAgent: codex
  reviewerAgent: claude
  producerModel: gpt-test-producer
  reviewerModel: claude-test-reviewer
  producerPricing:
    inputUsdPerMillionTokens: 1
    cachedInputUsdPerMillionTokens: 0.1
    outputUsdPerMillionTokens: 2
  reviewerPricing:
    inputUsdPerMillionTokens: 1
    cachedInputUsdPerMillionTokens: 0.1
    outputUsdPerMillionTokens: 2
verification:
  live: true
  allowSyntheticUnstructureUpload: false
  agentSmoke: true
confirmations:
  networkDownloads: true
  globalMutation: false
  agentSmokeCost: true
replaceExistingPlan: false
`;
}

async function writeConfiguration(root: string, value: string): Promise<string> {
  const path = workspacePaths(root).setupDeclaration;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
  return path;
}

async function writeEnvironment(root: string, value: string): Promise<string> {
  const path = workspacePaths(root).setupDeclarationEnv;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  if (platform() !== "win32") await chmod(path, 0o600);
  return path;
}

function fakeApply(
  plan: Awaited<ReturnType<typeof loadAndVerifyResearchSetupPlan>>,
  status: "ready" | "partially-ready",
  overallReadiness: "READY" | "PARTIALLY_READY",
) {
  return {
    schemaVersion: 1 as const,
    plan,
    state: {
      schemaVersion: 1 as const,
      planSha256: plan.planSha256,
      status,
      currentStep: null,
      completedSteps: ["doctor"],
      attempts: 1,
      updatedAt: new Date().toISOString(),
      lastError: null,
    },
    report: {
      researchReadiness: "READY" as const,
      overallReadiness,
    },
  };
}

function errorCode(expected: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code: string }).code === expected;
}

async function invoke(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env,
    stdout: { write: (chunk: string) => void (stdout += chunk) },
    stderr: { write: (chunk: string) => void (stderr += chunk) },
  });
  return { exitCode, stdout, stderr };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tiangong-research-declarative-test-"));
}
