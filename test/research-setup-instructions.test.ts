import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { RESEARCH_SETUP_SKILLS } from "../src/research/workspace/setup-catalog.js";
import {
  applyResearchSetupPlan,
  createResearchSetupPlan,
  inspectResearchSetupStatus,
} from "../src/research/workspace/setup.js";
import { hashRegularTree, workspacePaths } from "../src/research/workspace/storage.js";

const CODEX_START = "<!-- tiangong-auto-research:routing:start -->";
const CODEX_END = "<!-- tiangong-auto-research:routing:end -->";
const ROUTING_SENTENCE =
  "For every research request, load the project-installed `tiangong-auto-research` Skill and complete its research-question gate before using any tool.";

describe("research setup project instruction routing", () => {
  it("binds exact project-only Codex and Claude instruction targets into the reviewed plan", async () => {
    const root = await temporaryDirectory();
    try {
      const plan = await createOrchestratorPlan(root, ["codex", "claude-code"]);
      const canonicalRoot = await realpath(root);
      const routing = (plan as unknown as { instructionRouting: InstructionRoutingPlan })
        .instructionRouting;

      assert.equal(routing.policy, "project-only");
      assert.equal(routing.restartRequired, true);
      assert.deepEqual(
        routing.targets.map((target) => ({
          agent: target.agent,
          strategy: target.strategy,
          path: target.path,
          contentIncludesRouting: target.managedContent.includes(ROUTING_SENTENCE),
          validHash: /^[0-9a-f]{64}$/.test(target.managedContentSha256),
        })),
        [
          {
            agent: "claude-code",
            strategy: "owned-file",
            path: join(canonicalRoot, ".claude", "rules", "tiangong-auto-research.md"),
            contentIncludesRouting: true,
            validHash: true,
          },
          {
            agent: "codex",
            strategy: "managed-block",
            path: join(canonicalRoot, "AGENTS.md"),
            contentIncludesRouting: true,
            validHash: true,
          },
        ],
      );
      assert.ok(
        plan.mutations.some(
          (mutation) =>
            mutation.step === "project-instruction-routing" &&
            mutation.target === join(canonicalRoot, "AGENTS.md"),
        ),
      );
      assert.ok(
        plan.mutations.some(
          (mutation) =>
            mutation.step === "project-instruction-routing" &&
            mutation.target ===
              join(canonicalRoot, ".claude", "rules", "tiangong-auto-research.md"),
        ),
      );

      const globalPlanRoot = await temporaryDirectory();
      const globalHome = await temporaryDirectory();
      try {
        const globalPlan = await createResearchSetupPlan({
          workspace: globalPlanRoot,
          mode: "smoke-test",
          evidenceProfile: "none",
          skillIds: [orchestrator().id],
          scope: "global",
          agents: ["codex"],
          acceptedLicenseIds: [orchestrator().license.id],
          confirmNetworkDownloads: true,
          confirmGlobalMutation: true,
          environment: { HOME: globalHome },
        });
        assert.deepEqual(
          (globalPlan as unknown as { instructionRouting: InstructionRoutingPlan })
            .instructionRouting,
          { policy: "project-only", restartRequired: false, targets: [] },
        );
      } finally {
        await Promise.all([
          rm(globalPlanRoot, { recursive: true, force: true }),
          rm(globalHome, { recursive: true, force: true }),
        ]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs idempotent routing bytes, reports restart semantics, and removes only owned bytes", async () => {
    const root = await temporaryDirectory();
    const skill = orchestrator();
    const originalTreeSha256 = skill.expectedTreeSha256;
    const ownerAgents = "# Owner instructions\n\nKeep this exact text.\n";
    try {
      await installOrchestratorFixture(root, ["codex", "claude-code"], skill);
      await writeFile(join(root, "AGENTS.md"), ownerAgents);
      await createOrchestratorPlan(root, ["codex", "claude-code"]);

      await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        runner: noNetworkRunner,
      });
      const codexBytes = await readFile(join(root, "AGENTS.md"), "utf8");
      const claudePath = join(root, ".claude", "rules", "tiangong-auto-research.md");
      const claudeBytes = await readFile(claudePath, "utf8");
      assert.ok(codexBytes.startsWith(ownerAgents));
      assert.equal(count(codexBytes, CODEX_START), 1);
      assert.equal(count(codexBytes, CODEX_END), 1);
      assert.ok(codexBytes.includes(ROUTING_SENTENCE));
      assert.ok(claudeBytes.includes(ROUTING_SENTENCE));

      const status = await inspectResearchSetupStatus(root, {});
      const routing = (status as unknown as { instructionRouting: InstructionRoutingStatus })
        .instructionRouting;
      assert.equal(routing.status, "installed");
      assert.equal(routing.restartRequired, true);
      assert.ok(routing.targets.every((target) => target.status === "installed"));

      await rm(claudePath);
      const missingStatus = await inspectResearchSetupStatus(root, {});
      assert.equal(
        (missingStatus as unknown as { instructionRouting: InstructionRoutingStatus })
          .instructionRouting.status,
        "missing",
      );

      await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        runner: noNetworkRunner,
      });
      assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), codexBytes);
      assert.equal(await readFile(claudePath, "utf8"), claudeBytes);

      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        agents: ["codex", "claude-code"],
        acceptedLicenseIds: [],
        confirmNetworkDownloads: false,
        replacePlan: true,
      });
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        runner: noNetworkRunner,
      });
      assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), ownerAgents);
      assert.equal(await exists(claudePath), false);
      const removedStatus = await inspectResearchSetupStatus(root, {});
      assert.deepEqual(
        (removedStatus as unknown as { instructionRouting: InstructionRoutingStatus })
          .instructionRouting,
        { status: "not-required", restartRequired: false, targets: [] },
      );
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops before mutation on linked or owner-controlled instruction destinations", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const skill = orchestrator();
    const originalTreeSha256 = skill.expectedTreeSha256;
    try {
      await installOrchestratorFixture(root, ["codex", "claude-code"], skill);
      const claudeRule = join(root, ".claude", "rules", "tiangong-auto-research.md");
      await mkdir(join(root, ".claude", "rules"), { recursive: true });
      await writeFile(claudeRule, "# Owner-controlled rule\n");
      await writeFile(join(root, "AGENTS.md"), "# Owner instructions\n");
      await createOrchestratorPlan(root, ["codex", "claude-code"]);

      await assert.rejects(
        applyResearchSetupPlan(workspacePaths(root).setupPlan, {
          skipDoctor: true,
          runner: noNetworkRunner,
        }),
        errorCode("RESEARCH_SETUP_INSTRUCTION_ROUTING_CONFLICT"),
      );
      assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "# Owner instructions\n");
      assert.equal(await readFile(claudeRule, "utf8"), "# Owner-controlled rule\n");

      await rm(root, { recursive: true, force: true });
      await mkdir(root);
      await installOrchestratorFixture(root, ["codex"], skill);
      const outsideFile = join(outside, "outside-agents.md");
      await writeFile(outsideFile, "outside must stay unchanged\n");
      await symlink(outsideFile, join(root, "AGENTS.md"));
      await createOrchestratorPlan(root, ["codex"]);
      await assert.rejects(
        applyResearchSetupPlan(workspacePaths(root).setupPlan, {
          skipDoctor: true,
          runner: noNetworkRunner,
        }),
        errorCode("RESEARCH_SETUP_SYMLINK_BLOCKED"),
      );
      assert.equal(await readFile(outsideFile, "utf8"), "outside must stay unchanged\n");
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects duplicate managed markers without changing owner instructions", async () => {
    const root = await temporaryDirectory();
    const skill = orchestrator();
    const originalTreeSha256 = skill.expectedTreeSha256;
    const ambiguous = [
      "# Owner instructions",
      CODEX_START,
      ROUTING_SENTENCE,
      CODEX_START,
      CODEX_END,
      "",
    ].join("\n");
    try {
      await installOrchestratorFixture(root, ["codex"], skill);
      await writeFile(join(root, "AGENTS.md"), ambiguous);
      await createOrchestratorPlan(root, ["codex"]);
      await assert.rejects(
        applyResearchSetupPlan(workspacePaths(root).setupPlan, {
          skipDoctor: true,
          runner: noNetworkRunner,
        }),
        errorCode("RESEARCH_SETUP_INSTRUCTION_ROUTING_CONFLICT"),
      );
      assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), ambiguous);
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not remove a user-modified managed block", async () => {
    const root = await temporaryDirectory();
    const skill = orchestrator();
    const originalTreeSha256 = skill.expectedTreeSha256;
    try {
      await installOrchestratorFixture(root, ["codex"], skill);
      await writeFile(join(root, "AGENTS.md"), "# Owner instructions\n");
      await createOrchestratorPlan(root, ["codex"]);
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        runner: noNetworkRunner,
      });
      const modified = (await readFile(join(root, "AGENTS.md"), "utf8")).replace(
        ROUTING_SENTENCE,
        "User changed the managed routing instruction.",
      );
      await writeFile(join(root, "AGENTS.md"), modified);

      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        agents: ["codex"],
        acceptedLicenseIds: [],
        confirmNetworkDownloads: false,
        replacePlan: true,
      });
      await assert.rejects(
        applyResearchSetupPlan(workspacePaths(root).setupPlan, {
          skipDoctor: true,
          runner: noNetworkRunner,
        }),
        errorCode("RESEARCH_SETUP_INSTRUCTION_ROUTING_CONFLICT"),
      );
      assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), modified);
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });
});

interface InstructionRoutingPlan {
  policy: "project-only";
  restartRequired: boolean;
  targets: Array<{
    agent: "codex" | "claude-code";
    strategy: "managed-block" | "owned-file";
    path: string;
    managedContent: string;
    managedContentSha256: string;
  }>;
}

interface InstructionRoutingStatus {
  status: "not-required" | "installed" | "missing" | "drifted" | "blocked";
  restartRequired: boolean;
  targets: Array<{ status: "installed" | "missing" | "drifted" | "blocked" }>;
}

function orchestrator() {
  return RESEARCH_SETUP_SKILLS.find((candidate) => candidate.id === "tiangong.auto-research")!;
}

async function createOrchestratorPlan(root: string, agents: Array<"codex" | "claude-code">) {
  const skill = orchestrator();
  return createResearchSetupPlan({
    workspace: root,
    mode: "smoke-test",
    evidenceProfile: "none",
    skillIds: [skill.id],
    agents,
    acceptedLicenseIds: [skill.license.id],
    confirmNetworkDownloads: true,
  });
}

async function installOrchestratorFixture(
  root: string,
  agents: Array<"codex" | "claude-code">,
  skill: ReturnType<typeof orchestrator>,
) {
  for (const agent of agents) {
    const directory =
      agent === "codex"
        ? join(root, ".agents", "skills", skill.skillName)
        : join(root, ".claude", "skills", skill.skillName);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "# Verified orchestrator fixture\n");
    skill.expectedTreeSha256 = await hashRegularTree(directory);
  }
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tiangong-setup-instructions-"));
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined));
}

function count(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

function errorCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && (error as Error & { code?: string }).code === code;
}

async function noNetworkRunner(): Promise<never> {
  throw new Error("verified fixture must not invoke an installer or network command");
}
