import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { startCapabilityBroker } from "../src/research/workspace/broker.js";
import {
  loadCapabilityDeclarations,
  lockCapabilities,
  verifyCapabilities,
} from "../src/research/workspace/capabilities.js";
import { inspectResearchContext } from "../src/research/workspace/context.js";
import {
  EXTERNAL_SKILL_CONTEXT_PROFILE,
  EXTERNAL_SKILL_MEDIA_PROFILE,
  EXTERNAL_SKILL_PROFILE,
} from "../src/research/workspace/external-skills.js";
import {
  inspectResearchSetupCatalog,
  RESEARCH_SETUP_INSTALLER,
  RESEARCH_SETUP_SKILLS,
  setupTargetRoot,
} from "../src/research/workspace/setup-catalog.js";
import {
  applyResearchSetupPlan,
  createResearchSetupPlan,
  doctorResearchSetup,
  inspectResearchSetupStatus,
  loadAndVerifyResearchSetupPlan,
  retryResearchSetup,
  runResearchSetupCompanion,
  setResearchSetupCredentialFromEnvironment,
} from "../src/research/workspace/setup.js";
import {
  createResearchSetupWizardTheme,
  executeResearchSetupWizard,
  formatResearchSetupWizardNote,
  readResearchSetupCredentialStdin,
  shouldUseResearchSetupWizardColor,
  type ResearchSetupWizardNoteTone,
  type ResearchSetupWizardPrompt,
} from "../src/research/workspace/setup-wizard.js";
import {
  canonicalJson,
  hashRegularTree,
  sha256File,
  sha256Text,
  workspacePaths,
} from "../src/research/workspace/storage.js";

describe("research setup catalog and immutable plans", () => {
  it("reports a separately sourced, pinned, role-aware recommendation catalog", async () => {
    const root = await temporaryDirectory();
    try {
      const catalog = await inspectResearchSetupCatalog({ selectedPath: root });
      assert.equal(catalog.policy.bundledSkills, false);
      assert.equal(catalog.policy.userInitiatedOnly, true);
      assert.equal(catalog.policy.runtimeInstall, false);
      assert.equal(catalog.policy.defaultScope, "project");
      assert.equal(catalog.policy.defaultInstallMode, "copy");
      assert.equal(catalog.policy.floatingUpdates, false);
      assert.deepEqual(catalog.installer, RESEARCH_SETUP_INSTALLER);
      assert.equal(catalog.entries.length, 15);
      assert.ok(catalog.entries.every((entry) => entry.bundled === false));
      assert.ok(catalog.entries.every((entry) => entry.userInitiatedOnly === true));
      assert.ok(catalog.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.expectedTreeSha256)));
      assert.ok(catalog.sources.every((source) => /^[0-9a-f]{40}$/.test(source.immutableRef)));
      assert.equal(
        catalog.sources.find((source) => source.id === "tiangong-ai-skills")?.immutableRef,
        "a300a49803c193b686e7cde55b5f2d170f993af5",
      );
      assert.ok(catalog.roles.evidenceCapabilities.includes("tiangong.kb-sci-search"));
      assert.deepEqual(catalog.roles.orchestrators, ["tiangong.auto-research"]);
      assert.ok(catalog.roles.inputPreprocessors.includes("tiangong.document-granular-decompose"));
      assert.ok(catalog.roles.acquisitionAdapters.includes("tiangong.academic-paper-download"));
      assert.ok(catalog.roles.postClosureAuthoring.includes("anthropic.docx"));
      assert.deepEqual(
        Object.fromEntries(
          catalog.entries
            .filter((entry) => entry.sourceId === "brave-search-skills")
            .map((entry) => [entry.skillName, entry.sourceRelativePath]),
        ),
        {
          "web-search": "skills/web-search",
          "news-search": "skills/news-search",
          "llm-context": "skills/llm-context",
          "images-search": "skills/images-search",
          "videos-search": "skills/videos-search",
        },
      );
      assert.equal(
        catalog.entries.find((entry) => entry.id === "anthropic.doc-coauthoring")?.license.label,
        "NOASSERTION",
      );
      assert.match(
        catalog.entries.find((entry) => entry.id === "anthropic.docx")?.license.notice ?? "",
        /not open source/i,
      );
      assert.deepEqual(catalog.conflictGroups, []);
      assert.deepEqual(catalog.selectionGuidance.pptCreation, {
        preferredSkillId: "hugohe3.ppt-master",
        situationalSkillIds: ["anthropic.pptx"],
        maySelectTogether: true,
        automaticSelection: false,
        guidance:
          "Prefer PPT Master for creating PPT presentations; use Anthropic PPTX when its workflow better fits the task. Both remain explicit post-closure choices.",
      });
      assert.deepEqual(
        catalog.entries
          .filter((entry) => entry.sourceId === "tiangong-ai-skills" && entry.defaultSelected)
          .map((entry) => entry.id),
        ["tiangong.auto-research"],
      );
      assert.equal(
        setupTargetRoot({
          workspace: root,
          scope: "global",
          agent: "codex",
          environment: {
            HOME: join(root, "operator-home"),
            CODEX_HOME: join(root, "ignored-codex-home"),
          },
        }),
        join(root, "operator-home", ".agents", "skills"),
      );
      assert.equal(
        setupTargetRoot({
          workspace: root,
          scope: "global",
          agent: "claude-code",
          environment: { CLAUDE_CONFIG_DIR: join(root, "operator-claude") },
        }),
        join(root, "operator-claude", "skills"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds every Brave evidence profile to the pinned upstream skills directory", async () => {
    const profiles = [
      {
        profile: EXTERNAL_SKILL_PROFILE,
        expectedPaths: ["skills/web-search", "skills/news-search"],
      },
      {
        profile: EXTERNAL_SKILL_CONTEXT_PROFILE,
        expectedPaths: ["skills/web-search", "skills/news-search", "skills/llm-context"],
      },
      {
        profile: EXTERNAL_SKILL_MEDIA_PROFILE,
        expectedPaths: [
          "skills/web-search",
          "skills/news-search",
          "skills/llm-context",
          "skills/images-search",
          "skills/videos-search",
        ],
      },
    ] as const;
    for (const testCase of profiles) {
      const root = await temporaryDirectory();
      try {
        const plan = await createResearchSetupPlan({
          workspace: root,
          mode: "production-research",
          evidenceProfile: testCase.profile,
          skillIds: [],
          acceptedLicenseIds: ["brave-search-skills:MIT"],
          credentialEnvironment: { "brave.search.api-key": "BRAVE_API_KEY" },
          confirmNetworkDownloads: true,
        });
        assert.deepEqual(
          plan.skills
            .filter((skill) => skill.sourceId === "brave-search-skills")
            .map((skill) => skill.sourceRelativePath)
            .sort(),
          [...testCase.expectedPaths].sort(),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("creates a hash-bound plan before workspace initialization and exposes setup context", async () => {
    const root = await temporaryDirectory();
    try {
      const plan = await createEmptyPlan(root);
      assert.equal(plan.workspace.path, root);
      assert.equal(plan.install.scope, "project");
      assert.deepEqual(plan.install.targets, [
        { agent: "codex", root: join(root, ".agents", "skills") },
      ]);
      assert.match(plan.planSha256, /^[0-9a-f]{64}$/);
      assert.equal(
        plan.mutations.find((mutation) => mutation.step === "workspace")?.target,
        workspacePaths(root).control,
      );
      const context = await inspectResearchContext(root);
      assert.equal(context.role, "setup");
      assert.ok(context.allowedOperations.includes("research.setup.apply"));
      const loaded = await loadAndVerifyResearchSetupPlan(workspacePaths(root).setupPlan);
      assert.deepEqual(loaded, plan);
      if (platform() !== "win32") {
        assert.equal((await lstat(workspacePaths(root).setupPlan)).mode & 0o222, 0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit licenses and rejects ambiguous or unsafe selections", async () => {
    const root = await temporaryDirectory();
    try {
      await assert.rejects(
        createResearchSetupPlan({
          workspace: root,
          mode: "production-research",
          evidenceProfile: "none",
          skillIds: [],
          acceptedLicenseIds: [],
          confirmNetworkDownloads: false,
        }),
        errorCode("RESEARCH_SETUP_SELECTION_INVALID"),
      );
      await assert.rejects(
        createResearchSetupPlan({
          workspace: root,
          mode: "smoke-test",
          evidenceProfile: "none",
          skillIds: ["tiangong.academic-paper-download"],
          acceptedLicenseIds: [],
          confirmNetworkDownloads: true,
        }),
        errorCode("RESEARCH_SETUP_LICENSE_NOT_ACCEPTED"),
      );
      await assert.rejects(
        createResearchSetupPlan({
          workspace: root,
          mode: "smoke-test",
          evidenceProfile: "none",
          skillIds: [],
          acceptedLicenseIds: [],
          liveChecks: false,
          allowSyntheticUnstructureUpload: true,
          confirmNetworkDownloads: false,
        }),
        errorCode("RESEARCH_SETUP_CONFIRMATION_REQUIRED"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows PPT Master and Anthropic PPTX in the same explicit setup plan", async () => {
    const root = await temporaryDirectory();
    try {
      const plan = await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: ["anthropic.pptx", "hugohe3.ppt-master"],
        acceptedLicenseIds: ["anthropic-skills:document-terms", "ppt-master:MIT"],
        confirmNetworkDownloads: true,
      });
      assert.deepEqual(plan.selection.skillIds, ["anthropic.pptx", "hugohe3.ppt-master"]);
      assert.deepEqual(
        plan.skills.map((skill) => skill.role),
        ["post-closure-authoring", "post-closure-authoring"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects both direct tampering and hash-valid catalog reinterpretation", async () => {
    const root = await temporaryDirectory();
    try {
      await createEmptyPlan(root);
      const planPath = workspacePaths(root).setupPlan;
      await chmod(planPath, 0o600);
      const plan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
      const workspace = plan.workspace as Record<string, unknown>;
      workspace.name = "tampered";
      await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      await assert.rejects(
        loadAndVerifyResearchSetupPlan(planPath),
        errorCode("RESEARCH_SETUP_PLAN_TAMPERED"),
      );

      const mutations = plan.mutations as Array<Record<string, unknown>>;
      mutations[0]!.target = join(root, "wrong-control-target");
      const { planSha256: _oldHash, ...unsigned } = plan;
      plan.planSha256 = sha256Text(canonicalJson(unsigned));
      await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      await assert.rejects(
        loadAndVerifyResearchSetupPlan(planPath),
        errorCode("RESEARCH_SETUP_PLAN_CATALOG_DRIFT"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("archives an old immutable generation before explicit replacement", async () => {
    const root = await temporaryDirectory();
    try {
      const first = await createEmptyPlan(root);
      const firstBytes = await readFile(workspacePaths(root).setupPlan, "utf8");
      const second = await createResearchSetupPlan({
        workspace: root,
        name: "replacement",
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        acceptedLicenseIds: [],
        confirmNetworkDownloads: false,
        replacePlan: true,
      });
      assert.notEqual(first.planSha256, second.planSha256);
      assert.equal(
        await readFile(
          join(workspacePaths(root).control, "setup-history", first.planSha256, "setup-plan.json"),
          "utf8",
        ),
        firstBytes,
      );
      const applied = await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
      });
      assert.equal(applied.state.status, "partially-ready");
      assert.equal((await inspectResearchContext(root)).role, "workspace");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves owner custom capability credentials while staging a setup credential", async () => {
    const root = await temporaryDirectory();
    const customSecret = "owner-custom-capability-secret";
    const braveSecret = "owner-brave-setup-secret";
    try {
      await createResearchSetupPlan({
        workspace: root,
        mode: "production-research",
        evidenceProfile: EXTERNAL_SKILL_PROFILE,
        skillIds: [],
        acceptedLicenseIds: ["brave-search-skills:MIT"],
        credentialEnvironment: { "brave.search.api-key": "BRAVE_API_KEY" },
        confirmNetworkDownloads: true,
      });
      const skillPath = join(root, "owner-custom-skill");
      await mkdir(skillPath);
      await writeFile(join(skillPath, "SKILL.md"), "# owner custom capability\n");
      const expectedTreeSha256 = await hashRegularTree(skillPath);
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify({
          schemaVersion: 1,
          capabilities: [
            {
              id: "database.owner.custom",
              skillPath,
              source: {
                type: "local",
                locator: "owner-custom-fixture",
                immutableRef: `sha256:${expectedTreeSha256}`,
                expectedTreeSha256,
                license: "MIT",
                catalogId: null,
              },
              requiredForDiscovery: false,
              permissions: ["project-read", "candidate-write", "brokered-network"],
              allowedHosts: ["owner.example.test"],
              http: {
                endpoint: "https://owner.example.test/",
                accept: "application/json",
                allowedContentTypes: ["application/json"],
                maxResponseBytes: 4096,
                maxItems: 10,
              },
              coverage: {
                dimensions: ["*"],
                sourceTypes: ["*"],
                discoveryScopes: ["database:owner"],
                fullText: false,
                publicationDates: true,
              },
              credentials: [
                {
                  id: "database.owner.api-key",
                  allowedHosts: ["owner.example.test"],
                  headerName: "Authorization",
                  prefix: "Bearer ",
                },
              ],
              healthCheck: null,
            },
          ],
        })}\n`,
      );
      await writeFile(
        workspacePaths(root).env,
        `TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"database.owner.api-key":"${customSecret}"}\n`,
        { mode: 0o600 },
      );
      await chmod(workspacePaths(root).env, 0o600);

      const result = await setResearchSetupCredentialFromEnvironment({
        workspace: root,
        credentialId: "brave.search.api-key",
        environmentName: "BRAVE_API_KEY",
        environment: { BRAVE_API_KEY: braveSecret },
      });
      assert.equal(JSON.stringify(result).includes(braveSecret), false);
      assert.equal(JSON.stringify(result).includes(customSecret), false);
      const stored = await readFile(workspacePaths(root).env, "utf8");
      assert.equal(stored.includes(customSecret), true);
      assert.equal(stored.includes(braveSecret), true);
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.equal(journal.includes(customSecret), false);
      assert.equal(journal.includes(braveSecret), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles all deselected setup-managed capabilities while preserving custom capabilities and Skill bytes", async () => {
    const root = await temporaryDirectory();
    try {
      await createEmptyPlan(root);
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, { skipDoctor: true });
      const capabilities = [];
      for (const [id, skillName, catalogId] of [
        ["method.brave.llm-context", "llm-context", "external.brave.llm-context"],
        [
          "database.tiangong.sci-search",
          "tiangong-kb-sci-search",
          "first-party.tiangong.kb-sci-search",
        ],
        ["database.owner.custom", "owner-custom-search", null],
      ] as const) {
        const skillPath = join(root, ".agents", "skills", skillName);
        await mkdir(skillPath, { recursive: true });
        await writeFile(
          join(skillPath, "SKILL.md"),
          `---\nname: ${skillName}\ndescription: Fixture capability.\n---\n\n# Fixture\n`,
        );
        const expectedTreeSha256 = await hashRegularTree(skillPath);
        capabilities.push({
          id,
          skillPath,
          source: {
            type: "git",
            locator:
              catalogId === null
                ? "https://github.com/example/owner-custom-search.git"
                : catalogId.startsWith("external.brave")
                  ? "https://github.com/brave/brave-search-skills.git"
                  : "https://github.com/tiangong-ai/skills.git",
            immutableRef: "a".repeat(40),
            expectedTreeSha256,
            license: "MIT",
            catalogId,
          },
          requiredForDiscovery: false,
          permissions: ["project-read"],
          allowedHosts: [],
          http: null,
          coverage: null,
          credentials: [],
          healthCheck: null,
        });
      }
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify({ schemaVersion: 1, capabilities }, null, 2)}\n`,
      );
      await lockCapabilities(root);
      await writeFile(
        workspacePaths(root).env,
        'TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"obsolete.context.key":"obsolete-broker-secret"}\n',
        { mode: 0o600 },
      );
      await writeFile(
        workspacePaths(root).setupAdapterEnv,
        'TIANGONG_RESEARCH_ADAPTER_CREDENTIALS_JSON={"semantic-scholar.api-key":"obsolete-adapter-secret"}\n',
        { mode: 0o600 },
      );

      await createResearchSetupPlan({
        workspace: root,
        name: "reconciled",
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        acceptedLicenseIds: [],
        confirmNetworkDownloads: false,
        replacePlan: true,
      });
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, { skipDoctor: true });

      const declarations = await loadCapabilityDeclarations(root);
      assert.deepEqual(
        declarations.capabilities.map((capability) => capability.id),
        ["database.owner.custom"],
      );
      assert.equal((await verifyCapabilities(root)).status, "verified");
      assert.equal(
        await pathExistsSafe(join(root, ".agents", "skills", "llm-context", "SKILL.md")),
        true,
      );
      assert.equal(
        await pathExistsSafe(join(root, ".agents", "skills", "tiangong-kb-sci-search", "SKILL.md")),
        true,
      );
      assert.equal((await readFile(workspacePaths(root).env, "utf8")).includes("secret"), false);
      assert.equal(
        (await readFile(workspacePaths(root).setupAdapterEnv, "utf8")).includes("secret"),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("research setup execution and operator safety", () => {
  it("applies an empty smoke setup without invoking any installer or network command", async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    try {
      await createEmptyPlan(root);
      const result = await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        runner: async ({ command }) => {
          calls.push(command);
          return { exitCode: 0, stdout: "unexpected", stderr: "" };
        },
      });
      assert.equal(result.state.status, "partially-ready");
      assert.equal(calls.length, 0);
      assert.equal((await inspectResearchContext(root)).role, "workspace");
      const status = await inspectResearchSetupStatus(root);
      assert.equal(status.state.status, "partially-ready");
      assert.equal(status.installations.length, 0);
      assert.match(
        await readFile(workspacePaths(root).journal, "utf8"),
        /research\.setup\.applied/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks missing required credentials before downloads and sanitizes retry failures", async () => {
    const root = await temporaryDirectory();
    const secret = "opaque-fixture-owner-secret";
    const calls: string[] = [];
    try {
      await createResearchSetupPlan({
        workspace: root,
        mode: "production-research",
        evidenceProfile: EXTERNAL_SKILL_PROFILE,
        skillIds: [],
        acceptedLicenseIds: ["brave-search-skills:MIT"],
        credentialEnvironment: { "brave.search.api-key": "OWNER_VALUE" },
        confirmNetworkDownloads: true,
      });
      await assert.rejects(
        applyResearchSetupPlan(workspacePaths(root).setupPlan, {
          skipDoctor: true,
          environment: {},
          runner: async ({ command }) => {
            calls.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
        errorCode("RESEARCH_SETUP_CREDENTIAL_PREFLIGHT_FAILED"),
      );
      assert.equal(calls.length, 0);

      await assert.rejects(
        retryResearchSetup({
          workspace: root,
          step: "credential-preflight",
          options: {
            skipDoctor: true,
            environment: { OWNER_VALUE: secret },
            runner: async ({ command }) => {
              calls.push(command);
              return { exitCode: 9, stdout: "", stderr: `registry failure ${secret}` };
            },
          },
        }),
        errorCode("RESEARCH_SETUP_COMMAND_FAILED"),
      );
      assert.deepEqual(calls, ["npm"]);
      const persisted = `${await readFile(workspacePaths(root).setupState, "utf8")}\n${await readFile(
        workspacePaths(root).journal,
        "utf8",
      )}`;
      assert.equal(persisted.includes(secret), false);
      assert.match(persisted, /\[REDACTED\]/);
      const credentialStore = await readFile(workspacePaths(root).env, "utf8");
      assert.equal(credentialStore.includes(secret), true);
      if (platform() !== "win32") {
        assert.equal((await lstat(workspacePaths(root).env)).mode & 0o077, 0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds global destinations into the plan and refuses a symlinked agent home", async () => {
    const root = await temporaryDirectory();
    const homes = await temporaryDirectory();
    const realHome = join(homes, "real-codex-home");
    const linkedHome = join(homes, "linked-codex-home");
    try {
      await mkdir(realHome);
      await symlink(realHome, linkedHome);
      const plan = await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [],
        scope: "global",
        agents: ["codex"],
        acceptedLicenseIds: [],
        confirmNetworkDownloads: false,
        confirmGlobalMutation: true,
        environment: { HOME: linkedHome },
      });
      assert.equal(plan.install.targets[0]?.root, join(linkedHome, ".agents", "skills"));
      await assert.rejects(
        applyResearchSetupPlan(workspacePaths(root).setupPlan, {
          skipDoctor: true,
          environment: { HOME: join(homes, "different-home") },
        }),
        errorCode("RESEARCH_SETUP_SYMLINK_BLOCKED"),
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(homes, { recursive: true, force: true }),
      ]);
    }
  });

  it("applies a Claude-only acquisition plan without assuming a Codex target", async () => {
    const root = await temporaryDirectory();
    const homes = await temporaryDirectory();
    const claudeConfig = join(homes, "claude-config");
    const skill = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.academic-paper-download",
    )!;
    const originalTreeSha256 = skill.expectedTreeSha256;
    try {
      const skillDirectory = join(claudeConfig, "skills", skill.skillName);
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(join(skillDirectory, "SKILL.md"), "# pinned fixture\n");
      skill.expectedTreeSha256 = await hashRegularTree(skillDirectory);
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        scope: "global",
        agents: ["claude-code"],
        acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
        confirmNetworkDownloads: true,
        confirmGlobalMutation: true,
        environment: { CLAUDE_CONFIG_DIR: claudeConfig },
      });
      const applied = await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        environment: { CLAUDE_CONFIG_DIR: claudeConfig },
      });
      assert.equal(applied.state.status, "partially-ready");
      const status = await inspectResearchSetupStatus(root, {
        CLAUDE_CONFIG_DIR: claudeConfig,
      });
      assert.equal(status.installations[0]?.agent, "claude-code");
      assert.equal(status.installations[0]?.status, "installed");
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(homes, { recursive: true, force: true }),
      ]);
    }
  });

  it("returns a report instead of throwing and removes mapped opaque secrets", async () => {
    const root = await temporaryDirectory();
    const secret = "opaque-value-not-named-like-a-token";
    try {
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: ["tiangong.academic-paper-download"],
        acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
        credentialEnvironment: { "semantic-scholar.api-key": "OWNER_VALUE" },
        confirmNetworkDownloads: true,
      });
      const report = await doctorResearchSetup(root, {
        environment: { OWNER_VALUE: secret },
        runner: async () => ({ exitCode: 0, stdout: `version ${secret}`, stderr: "" }),
      });
      assert.equal(report.readiness, "BLOCKED");
      assert.equal(JSON.stringify(report).includes(secret), false);
      const reportChecks = report.checks as Array<{
        id: string;
        status: string;
        minimumAction: string | null;
      }>;
      const optionalSetting = reportChecks.find(
        (check) => check.id === "setting.unpaywall.contact-email",
      );
      assert.equal(optionalSetting?.status, "pass");
      assert.equal(optionalSetting?.minimumAction, null);
      const optionalCredential = reportChecks.find(
        (check) => check.id === "credential.semantic-scholar.api-key",
      );
      assert.equal(optionalCredential?.status, "pass");
      assert.equal(optionalCredential?.minimumAction, null);
      assert.equal(
        (await readFile(workspacePaths(root).setupReport, "utf8")).includes(secret),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks setup readiness when an explicitly requested agent smoke fails", async () => {
    const root = await temporaryDirectory();
    try {
      await createEmptyPlan(root);
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, { skipDoctor: true });
      const report = await doctorResearchSetup(root, {
        agentSmoke: true,
        environment: {},
        runner: async ({ command }) => ({
          exitCode: 0,
          stdout: `${command} fixture-version`,
          stderr: "",
        }),
        executor: async (request) => ({
          exitCode: 9,
          stdout: "",
          stderr: `${request.route.agent} smoke failed`,
          tokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          wallSeconds: 0,
          model: request.route.model,
          runtime: null,
        }),
      });
      assert.equal(report.readiness, "BLOCKED");
      const checks = report.checks as Array<{ id: string; status: string }>;
      assert.equal(checks.find((check) => check.id === "production-runtime")?.status, "fail");
      assert.equal((report.workspaceDoctor as { status: string } | null)?.status, "blocked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the pinned document companion with a minimal secret environment and no-overwrite atomic output", async () => {
    const root = await temporaryDirectory();
    const inputPath = join(root, "source.pdf");
    const outputPath = join(root, "source.fulltext.md");
    const secret = "document-owner-token-value";
    const skill = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.document-granular-decompose",
    )!;
    const originalTreeSha256 = skill.expectedTreeSha256;
    try {
      await writeFile(inputPath, "%PDF-1.4\nfixture\n%%EOF\n");
      const skillDirectory = join(root, ".agents", "skills", skill.skillName);
      await mkdir(join(skillDirectory, "scripts"), { recursive: true });
      await writeFile(join(skillDirectory, "scripts", "mineru_fulltext_extract.py"), "# fixture\n");
      skill.expectedTreeSha256 = await hashRegularTree(skillDirectory);
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
        credentialEnvironment: { "tiangong.unstructure.auth-token": "OWNER_DOC_TOKEN" },
        settings: { "tiangong.unstructure.base-url": "https://unstructure.example.test" },
        confirmNetworkDownloads: true,
        environment: { OWNER_DOC_TOKEN: secret },
      });
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        environment: { OWNER_DOC_TOKEN: secret },
      });
      let calls = 0;
      const result = await runResearchSetupCompanion(
        {
          workspace: root,
          skillId: "tiangong.document-granular-decompose",
          inputPath,
          outputPath,
          timeoutSeconds: 30,
        },
        {
          environment: {
            PATH: process.env.PATH,
            OWNER_DOC_TOKEN: secret,
            AUTHORIZATION: "must-not-be-inherited",
          },
          runner: async ({ command, args, environment }) => {
            calls += 1;
            assert.equal(command, "python3");
            assert.equal(environment.UNSTRUCTURED_AUTH_TOKEN, secret);
            assert.equal(environment.UNSTRUCTURED_API_BASE_URL, "https://unstructure.example.test");
            assert.equal(environment.OWNER_DOC_TOKEN, undefined);
            assert.equal(environment.AUTHORIZATION, undefined);
            const temporary = args[args.indexOf("--output") + 1];
            assert.ok(temporary);
            assert.notEqual(temporary, outputPath);
            assert.match(temporary!, /^.*\.part$/);
            await writeFile(temporary!, "# Extracted\n\nBound full text.\n");
            return { exitCode: 0, stdout: `${temporary}\n${secret}`, stderr: "" };
          },
        },
      );
      assert.equal(result.status, "complete");
      assert.equal(result.output.path, outputPath);
      assert.equal(await readFile(outputPath, "utf8"), "# Extracted\n\nBound full text.\n");
      assert.equal(calls, 1);
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.equal(journal.includes(secret), false);
      assert.match(journal, /research\.setup\.companion\.document\.completed/);

      await assert.rejects(
        runResearchSetupCompanion(
          {
            workspace: root,
            skillId: "tiangong.document-granular-decompose",
            inputPath,
            outputPath,
          },
          {
            environment: { PATH: process.env.PATH },
            runner: async () => {
              calls += 1;
              return { exitCode: 0, stdout: "", stderr: "" };
            },
          },
        ),
        errorCode("RESEARCH_SETUP_COMPANION_PATH_INVALID"),
      );
      assert.equal(calls, 1);
      assert.equal(await readFile(outputPath, "utf8"), "# Extracted\n\nBound full text.\n");
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds the exact paper result without selecting a concurrent PDF and preserves handoff failure", async () => {
    const root = await temporaryDirectory();
    const outputDirectory = join(root, "papers");
    const secret = "semantic-scholar-owner-key";
    const skill = RESEARCH_SETUP_SKILLS.find(
      (candidate) => candidate.id === "tiangong.academic-paper-download",
    )!;
    const originalTreeSha256 = skill.expectedTreeSha256;
    try {
      await mkdir(outputDirectory);
      const skillDirectory = join(root, ".agents", "skills", skill.skillName);
      await mkdir(join(skillDirectory, "scripts"), { recursive: true });
      await writeFile(join(skillDirectory, "scripts", "fetch.py"), "# fixture\n");
      skill.expectedTreeSha256 = await hashRegularTree(skillDirectory);
      await createResearchSetupPlan({
        workspace: root,
        mode: "smoke-test",
        evidenceProfile: "none",
        skillIds: [skill.id],
        acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
        credentialEnvironment: { "semantic-scholar.api-key": "OWNER_S2_KEY" },
        settings: { "unpaywall.contact-email": "oa@example.test" },
        confirmNetworkDownloads: true,
        environment: { OWNER_S2_KEY: secret },
      });
      await applyResearchSetupPlan(workspacePaths(root).setupPlan, {
        skipDoctor: true,
        environment: { OWNER_S2_KEY: secret },
      });
      const decoyPath = join(outputDirectory, "concurrent-newer.pdf");
      await writeFile(decoyPath, "%PDF-1.4\ndecoy\n%%EOF\n");
      const artifactPath = join(outputDirectory, "bound-paper.pdf");
      const manifestPath = `${artifactPath}.json`;
      const pdf = Buffer.from("%PDF-1.4\nbound-artifact\n%%EOF\n");
      const result = await runResearchSetupCompanion(
        {
          workspace: root,
          skillId: "tiangong.academic-paper-download",
          outputDirectory,
          doi: "10.1234/example",
        },
        {
          environment: {
            PATH: process.env.PATH,
            OWNER_S2_KEY: secret,
            COOKIE: "must-not-be-inherited",
          },
          runner: async ({ args, environment }) => {
            assert.ok(args.includes("10.1234/example"));
            assert.equal(environment.SEMANTIC_SCHOLAR_API_KEY, secret);
            assert.equal(environment.UNPAYWALL_EMAIL, "oa@example.test");
            assert.equal(environment.OWNER_S2_KEY, undefined);
            assert.equal(environment.COOKIE, undefined);
            await writeFile(artifactPath, pdf);
            const digest = await sha256File(artifactPath);
            const manifest = {
              schema_version: "academic-paper-download.artifact.v2",
              doi: "10.1234/example",
              source: "semantic_scholar",
              file: artifactPath,
              size: pdf.length,
              sha256: digest,
            };
            await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                ok: true,
                data: {
                  results: [
                    {
                      success: true,
                      file: artifactPath,
                      manifest: manifestPath,
                      size: pdf.length,
                      sha256: digest,
                    },
                  ],
                },
              }),
              stderr: `provider note ${secret}`,
            };
          },
        },
      );
      assert.equal(result.status, "complete");
      assert.equal(result.artifact.path, artifactPath);
      assert.notEqual(result.artifact.path, decoyPath);
      assert.equal(result.artifact.sha256, await sha256File(artifactPath));

      const handoff = await runResearchSetupCompanion(
        {
          workspace: root,
          skillId: "tiangong.academic-paper-download",
          outputDirectory,
          doi: "10.1234/unresolved",
        },
        {
          environment: { PATH: process.env.PATH },
          runner: async () => ({
            exitCode: 1,
            stdout: JSON.stringify({
              ok: false,
              data: {
                results: [
                  {
                    success: false,
                    file: null,
                    manifest: null,
                    sources_tried: ["unpaywall", "semantic_scholar", "arxiv"],
                    error: { code: "download_unresolved" },
                    browser_handoff: { reason: "explicit handoff" },
                  },
                ],
              },
            }),
            stderr: "OA exhausted",
          }),
        },
      );
      assert.equal(handoff.status, "browser-handoff-required");
      assert.equal(handoff.artifactCommitted, false);
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.equal(journal.includes(secret), false);
      assert.match(journal, /research\.setup\.companion\.paper\.completed/);
      assert.match(journal, /research\.setup\.companion\.paper\.handoff-required/);
    } finally {
      skill.expectedTreeSha256 = originalTreeSha256;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a TTY for the Wizard but supports a fully scripted explicit review", async () => {
    const root = await temporaryDirectory();
    const secret = "wizard-owner-secret-value";
    try {
      const nonInteractive = await invoke(["research", "setup", "--workspace", root, "--json"]);
      assert.equal(nonInteractive.exitCode, 2);
      assert.equal(JSON.parse(nonInteractive.stderr).error.code, "RESEARCH_SETUP_TTY_REQUIRED");

      const prompt = new ScriptedWizardPrompt(root);
      const result = await executeResearchSetupWizard({
        workspace: root,
        environment: { BRAVE_API_KEY: secret },
        prompt,
      });
      assert.equal(result.exitCode, 0);
      assert.equal((result.value as { status: string }).status, "planned");
      const serialized = `${JSON.stringify(result.value)}\n${prompt.notes.join("\n")}`;
      assert.equal(serialized.includes(secret), false);
      const plan = await loadAndVerifyResearchSetupPlan(workspacePaths(root).setupPlan);
      assert.equal(plan.selection.evidenceProfile, EXTERNAL_SKILL_PROFILE);
      assert.ok(plan.selection.skillIds.includes("tiangong.auto-research"));
      assert.ok(plan.selection.skillIds.includes("hugohe3.ppt-master"));
      assert.ok(plan.selection.skillIds.includes("anthropic.pptx"));
      assert.deepEqual(
        prompt.authoringChoices.slice(0, 2).map((choice) => choice.value),
        ["hugohe3.ppt-master", "anthropic.pptx"],
      );
      assert.match(prompt.authoringChoices[0]?.label ?? "", /Preferred for creating PPT/i);
      assert.match(prompt.authoringChoices[1]?.label ?? "", /Situational PPTX/i);
      assert.equal(prompt.noteTones[0], "brand");
      assert.ok(prompt.noteTones.includes("section"));
      assert.ok(prompt.noteTones.includes("summary"));
      assert.ok(prompt.noteTones.includes("success"));
      assert.deepEqual(plan.credentialSources, [
        {
          id: "brave.search.api-key",
          fromEnvironment: "BRAVE_API_KEY",
          storage: "broker",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports secure, stdin, and explicit-skip Wizard credential sources without disclosure", async () => {
    const secret = "wizard-direct-hidden-owner-value";
    for (const inputMethod of ["secure-input", "stdin", "skipped"] as const) {
      const root = await temporaryDirectory();
      const stdinCredentials =
        inputMethod === "stdin" ? { "brave.search.api-key": secret } : undefined;
      try {
        const prompt = new ScriptedWizardPrompt(root, {
          credentialInputMethod: inputMethod,
          secret,
        });
        const result = await executeResearchSetupWizard({
          workspace: root,
          environment: {},
          prompt,
          ...(stdinCredentials === undefined ? {} : { stdinCredentials }),
        });
        assert.equal(result.exitCode, 0);
        assert.equal((result.value as { status: string }).status, "planned");
        const serialized = `${JSON.stringify(result.value)}\n${prompt.notes.join("\n")}`;
        assert.equal(serialized.includes(secret), false);
        const plan = await loadAndVerifyResearchSetupPlan(workspacePaths(root).setupPlan);
        if (inputMethod === "skipped") {
          assert.deepEqual(plan.credentialSources, []);
          assert.match(serialized, /missingRequiredCredentialIds/);
          assert.match(serialized, /brave\.search\.api-key/);
        } else {
          assert.equal(plan.credentialSources.length, 1);
          assert.match(
            plan.credentialSources[0]!.fromEnvironment,
            inputMethod === "stdin" ? /_STDIN_/ : /_SECURE_INPUT_/,
          );
          assert.match(serialized, new RegExp(`"inputMethod": "${inputMethod}"`));
        }
        if (stdinCredentials) assert.equal(stdinCredentials["brave.search.api-key"], secret);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("reads bounded credential stdin by logical ID and writes it before capability installation", async () => {
    const root = await temporaryDirectory();
    const secret = "stdin-password-manager-owner-value";
    try {
      const parsed = await readResearchSetupCredentialStdin(
        nonTtyInput(`${secret}\nsecond-owner-secret\n`),
        ["brave.search.api-key", "tiangong.sci.api-key"],
      );
      assert.deepEqual(Object.keys(parsed), ["brave.search.api-key", "tiangong.sci.api-key"]);
      assert.equal(parsed["brave.search.api-key"], secret);
      await assert.rejects(
        readResearchSetupCredentialStdin(nonTtyInput(`${secret}\nextra\n`), [
          "brave.search.api-key",
        ]),
        errorCode("RESEARCH_SETUP_CREDENTIAL_STDIN_INVALID"),
      );

      await createResearchSetupPlan({
        workspace: root,
        mode: "production-research",
        evidenceProfile: EXTERNAL_SKILL_PROFILE,
        skillIds: [],
        acceptedLicenseIds: ["brave-search-skills:MIT"],
        credentialEnvironment: { "brave.search.api-key": "BRAVE_API_KEY" },
        confirmNetworkDownloads: true,
      });
      let stdout = "";
      let stderr = "";
      const exitCode = await runCli(
        [
          "research",
          "setup",
          "credential",
          "set",
          "--id",
          "brave.search.api-key",
          "--from-stdin",
          "--workspace",
          root,
          "--json",
        ],
        {
          env: {},
          stdin: nonTtyInput(`${secret}\n`),
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: (chunk: string) => void (stderr += chunk) },
        },
      );
      assert.equal(exitCode, 0);
      assert.equal(`${stdout}\n${stderr}`.includes(secret), false);
      assert.equal((await readFile(workspacePaths(root).env, "utf8")).includes(secret), true);
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.equal(journal.includes(secret), false);
      assert.match(journal, /"inputMethod":"stdin"/);
      if (platform() !== "win32") {
        assert.equal((await lstat(workspacePaths(root).env)).mode & 0o077, 0);
      }

      const conflicting = await invoke([
        "research",
        "setup",
        "credential",
        "set",
        "--id",
        "brave.search.api-key",
        "--prompt",
        "--from-env",
        "BRAVE_API_KEY",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(conflicting.exitCode, 2);
      assert.equal(JSON.parse(conflicting.stderr).error.code, "RESEARCH_SETUP_ARGUMENT_INVALID");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses semantic Wizard colors only for human TTY output", () => {
    assert.equal(
      shouldUseResearchSetupWizardColor({
        outputIsTTY: true,
        json: false,
        environment: {},
      }),
      true,
    );
    for (const disabled of [
      { outputIsTTY: false, json: false, environment: {} },
      { outputIsTTY: true, json: true, environment: {} },
      { outputIsTTY: true, json: false, environment: { NO_COLOR: "" } },
      { outputIsTTY: true, json: false, environment: { TERM: "dumb" } },
    ]) {
      assert.equal(shouldUseResearchSetupWizardColor(disabled), false);
    }

    const colored = createResearchSetupWizardTheme(true);
    const success = formatResearchSetupWizardNote("Plan created\nSHA-256: abc", "success", colored);
    const warning = formatResearchSetupWizardNote("Credential missing", "warning", colored);
    assert.match(success, /\u001B\[1;32m/);
    assert.match(warning, /\u001B\[1;33m/);
    assert.match(success, /✓/);

    const plain = formatResearchSetupWizardNote(
      "Plan created\nSHA-256: abc",
      "success",
      createResearchSetupWizardTheme(false),
    );
    assert.equal(plain, "\n✓ Plan created\n  SHA-256: abc\n");
    assert.doesNotMatch(plain, /\u001B\[/);
  });

  it("exposes catalog automation without creating files", async () => {
    const root = await temporaryDirectory();
    try {
      const result = await invoke(["research", "setup", "catalog", "--workspace", root, "--json"]);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).catalog, "tiangong-research-setup-ecosystem");
      assert.equal(await pathExistsSafe(workspacePaths(root).control), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("POST capability broker compatibility", () => {
  it("binds an exact POST body, static header, and credential without persisting request content", async () => {
    const root = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    const secret = "post-capability-owner-secret";
    try {
      const initialized = await invoke(["research", "workspace", "init", root, "--json"]);
      assert.equal(initialized.exitCode, 0, initialized.stderr);
      const skillPath = join(root, "post-search-skill");
      await mkdir(skillPath);
      await writeFile(
        join(skillPath, "SKILL.md"),
        "---\nname: post-search-skill\ndescription: Test bounded POST evidence.\n---\n",
      );
      const skillTreeSha256 = await hashRegularTree(skillPath);
      const declaration = {
        schemaVersion: 1,
        capabilities: [
          {
            id: "database.fixture.post-search",
            skillPath,
            source: {
              type: "local",
              locator: "fixture-post-search",
              immutableRef: `sha256:${skillTreeSha256}`,
              expectedTreeSha256: skillTreeSha256,
              license: "MIT",
              catalogId: null,
            },
            requiredForDiscovery: true,
            permissions: ["project-read", "candidate-write", "brokered-network"],
            allowedHosts: ["post.example.test"],
            http: {
              endpoint: "https://post.example.test/",
              method: "POST",
              accept: "application/json",
              allowedContentTypes: ["application/json"],
              staticHeaders: { "x-region": "test-region" },
              maxRequestBytes: 1024,
              maxResponseBytes: 4096,
              maxItems: 10,
            },
            coverage: {
              dimensions: ["*"],
              sourceTypes: ["academic-paper"],
              discoveryScopes: ["database:fixture"],
              fullText: true,
              publicationDates: true,
            },
            credentials: [
              {
                id: "database.fixture.api-key",
                allowedHosts: ["post.example.test"],
                headerName: "x-api-key",
                prefix: "",
              },
            ],
            healthCheck: null,
          },
        ],
      };
      await writeFile(
        workspacePaths(root).capabilityDeclarations,
        `${JSON.stringify(declaration, null, 2)}\n`,
      );
      await lockCapabilities(root);
      await writeFile(
        workspacePaths(root).env,
        `TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"database.fixture.api-key":"${secret}"}\n`,
        { mode: 0o600 },
      );
      await chmod(workspacePaths(root).env, 0o600);
      let observedMethod = "";
      let observedBody = "";
      let observedRegion = "";
      let observedCredential = "";
      let providerCalls = 0;
      globalThis.fetch = async (request, init) => {
        if (!String(request).startsWith("https://post.example.test/")) {
          return originalFetch(request, init);
        }
        providerCalls += 1;
        observedMethod = init?.method ?? "";
        observedBody = String(init?.body ?? "");
        const headers = new Headers(init?.headers);
        observedRegion = headers.get("x-region") ?? "";
        observedCredential = headers.get("x-api-key") ?? "";
        return new Response('{"records":[{"id":"paper-1"}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const capsuleProject = join(root, ".tiangong-research", "runtime", "post-broker-project");
      await mkdir(capsuleProject, { recursive: true });
      const broker = await startCapabilityBroker(root, "post-broker", capsuleProject);
      assert.ok(broker);
      try {
        const result = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "database.fixture.post-search",
            url: "https://post.example.test/search",
            request_body: { query: "unique-body-not-for-journal", topK: 1 },
          },
        });
        assert.notEqual((result.result as Record<string, unknown>).isError, true);
        assert.equal(observedMethod, "POST");
        assert.equal(observedBody, '{"query":"unique-body-not-for-journal","topK":1}');
        assert.equal(observedRegion, "test-region");
        assert.equal(observedCredential, secret);
        assert.equal(providerCalls, 1);

        const rejected = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "database.fixture.post-search",
            url: "https://post.example.test/search",
            request_body: { token: secret },
          },
        });
        assert.equal((rejected.result as Record<string, unknown>).isError, true);
        assert.equal(providerCalls, 1);
        const journal = await readFile(workspacePaths(root).journal, "utf8");
        assert.equal(journal.includes("unique-body-not-for-journal"), false);
        assert.equal(journal.includes(secret), false);
        assert.match(journal, /requestBodySha256/);
      } finally {
        await broker.stop();
      }
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createEmptyPlan(root: string) {
  return createResearchSetupPlan({
    workspace: root,
    mode: "smoke-test",
    evidenceProfile: "none",
    skillIds: [],
    acceptedLicenseIds: [],
    confirmNetworkDownloads: false,
  });
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

async function pathExistsSafe(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined));
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tiangong-research-setup-test-"));
}

type ScriptedCredentialInputMethod = "secure-input" | "environment" | "stdin" | "skipped";

class ScriptedWizardPrompt implements ResearchSetupWizardPrompt {
  readonly notes: string[] = [];
  readonly noteTones: ResearchSetupWizardNoteTone[] = [];
  readonly authoringChoices: Array<{ value: string; label: string }> = [];

  readonly credentialInputMethod: ScriptedCredentialInputMethod;
  readonly secretValue: string;

  constructor(
    readonly workspace: string,
    options: { credentialInputMethod?: ScriptedCredentialInputMethod; secret?: string } = {},
  ) {
    this.credentialInputMethod = options.credentialInputMethod ?? "environment";
    this.secretValue = options.secret ?? "scripted-hidden-credential";
  }

  note(message: string, tone: ResearchSetupWizardNoteTone = "info"): void {
    this.notes.push(message);
    this.noteTones.push(tone);
  }

  async input(message: string, defaultValue = ""): Promise<string> {
    if (message.includes("Absolute workspace")) return this.workspace;
    return defaultValue;
  }

  async secret(): Promise<string> {
    return this.secretValue;
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    if (message.includes("post-closure authoring")) return true;
    if (message.startsWith("I reviewed and accept")) return true;
    if (message.includes("model IDs")) return false;
    if (message.includes("live provider")) return false;
    if (message.includes("agent smoke")) return false;
    if (message.includes("Authorize downloads")) return true;
    if (message.includes("Create this immutable")) return true;
    if (message.includes("Apply the reviewed")) return false;
    return defaultValue;
  }

  async select<T extends string>(
    message: string,
    _choices: ReadonlyArray<{ value: T; label: string }>,
    defaultValue: T,
  ): Promise<T> {
    if (message === "Research mode") return "production-research" as T;
    if (message.includes("public-internet")) return defaultValue;
    if (message.startsWith("Credential source for")) return this.credentialInputMethod as T;
    if (message === "Install targets") return "codex" as T;
    if (message === "Installation scope") return "project" as T;
    return defaultValue;
  }

  async multiSelect<T extends string>(
    message: string,
    choices: ReadonlyArray<{ value: T; label: string }>,
  ): Promise<T[]> {
    if (message === "Post-closure authoring Skills") {
      this.authoringChoices.push(...choices);
      return ["hugohe3.ppt-master", "anthropic.pptx"] as T[];
    }
    return [];
  }

  close(): void {}
}

function nonTtyInput(value: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  return Object.assign(Readable.from([value]), { isTTY: false });
}
