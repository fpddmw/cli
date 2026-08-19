import { open, lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { isAlias, parseDocument, stringify, visit } from "yaml";

import { CliError } from "../../errors.js";
import {
  EXTERNAL_SKILL_CONTEXT_PROFILE,
  EXTERNAL_SKILL_MEDIA_PROFILE,
  EXTERNAL_SKILL_PROFILE,
} from "./external-skills.js";
import {
  configuredResearchSecrets,
  sanitizeResearchRecord,
  sanitizeResearchText,
  sanitizeResearchValue,
} from "./sanitization.js";
import {
  RESEARCH_SETUP_CREDENTIALS,
  RESEARCH_SETUP_SETTINGS,
  RESEARCH_SETUP_SKILLS,
  type ResearchSetupCredential,
  type ResearchSetupSetting,
} from "./setup-catalog.js";
import { exactResearchCliCommand } from "./setup-invocation.js";
import {
  applyResearchSetupPlan,
  createResearchSetupPlan,
  loadAndVerifyResearchSetupPlan,
  resolveResearchSetupWorkspacePath,
  type ApplyResearchSetupOptions,
  type ResearchSetupAgentRoutePlan,
  type ResearchSetupPlan,
  type ResearchSetupPlanInput,
  type ResearchSetupState,
} from "./setup.js";
import {
  canonicalJson,
  ensureDirectory,
  isObject,
  pathExists,
  readJsonFile,
  sha256Text,
  workspacePaths,
} from "./storage.js";
import type { ResearchMode } from "./types.js";

const MAX_DECLARATION_BYTES = 256 * 1024;
const MAX_DECLARATION_ENV_BYTES = 64 * 1024;
const MAX_DECLARATION_ENV_VALUE_BYTES = 16 * 1024;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BRAVE_SKILL_IDS = new Set(
  RESEARCH_SETUP_SKILLS.filter((skill) => skill.sourceId === "brave-search-skills").map(
    (skill) => skill.id,
  ),
);

type DeclarationRequirement = "required" | "conditional" | "optional";
type DeclarativeEvidenceProfile = "none" | "brave-baseline" | "brave-context" | "brave-media";

interface DeclarationSkillChoice {
  enabled: boolean;
  licenseId: string;
}

interface DeclarationCredentialChoice {
  requirement: DeclarationRequirement;
  appliesTo: string[];
  enabled: boolean;
  environment: string;
}

interface DeclarationSettingChoice {
  requirement: DeclarationRequirement;
  appliesTo: string[];
  enabled: boolean;
  value: string | null;
}

interface ResearchSetupDeclaration {
  schemaVersion: 2;
  kind: "tiangong-research-setup";
  workspace: {
    name?: string;
    mode: ResearchMode;
  };
  install: {
    scope: "project" | "global";
    agents: Array<"codex" | "claude-code">;
  };
  selection: {
    skills: Record<string, DeclarationSkillChoice>;
  };
  acceptedLicenseIds: string[];
  credentials: Record<string, DeclarationCredentialChoice>;
  settings: Record<string, DeclarationSettingChoice>;
  agentRoutes: Partial<ResearchSetupAgentRoutePlan> &
    Pick<ResearchSetupAgentRoutePlan, "producerAgent" | "reviewerAgent">;
  reviewerExecution: {
    transport: "native-direct" | "sandbox-bridge";
    isolationProvider: "platform-capsule";
  };
  verification: {
    live: boolean;
    allowSyntheticUnstructureUpload: boolean;
    agentSmoke: boolean;
  };
  confirmations: {
    networkDownloads: boolean;
    globalMutation: boolean;
    agentSmokeCost: boolean;
  };
  replaceExistingPlan: boolean;
}

interface ResearchSetupDeclarationBinding {
  schemaVersion: 1;
  kind: "tiangong-research-setup-declaration-binding";
  configurationSha256: string;
  planSha256: string;
}

export interface LoadedResearchSetupDeclaration {
  workspace: string;
  configurationPath: string;
  environmentPath: string | null;
  configurationSha256: string;
  planInput: Omit<ResearchSetupPlanInput, "workspace" | "environment">;
  environment: NodeJS.ProcessEnv;
  publicSummary: {
    mode: ResearchMode;
    evidenceProfile: DeclarativeEvidenceProfile;
    selectedSkillIds: string[];
    enabledCredentialIds: string[];
    declaredCredentialIds: string[];
    verification: ResearchSetupDeclaration["verification"];
    environmentFileUsed: boolean;
  };
}

interface DeclarativeSetupApplicationResult {
  schemaVersion: 1;
  plan: ResearchSetupPlan;
  state: ResearchSetupState;
  report: null | {
    overallReadiness?: "READY" | "PARTIALLY_READY" | "BLOCKED";
    [key: string]: unknown;
  };
}

export interface ResearchSetupDeclarationOperations {
  createPlan(input: ResearchSetupPlanInput): Promise<ResearchSetupPlan>;
  loadPlan(planPath: string): Promise<ResearchSetupPlan>;
  applyPlan(
    planPath: string,
    options: ApplyResearchSetupOptions,
  ): Promise<DeclarativeSetupApplicationResult>;
}

export async function initializeResearchSetupDeclaration(workspace: string): Promise<{
  schemaVersion: 1;
  workspace: string;
  configurationPath: string;
  environmentExamplePath: string;
  next: {
    minimumAction: string;
    setupCommand: string;
  };
}> {
  const root = await resolveResearchSetupWorkspacePath(workspace);
  const paths = workspacePaths(root);
  const targets = [
    paths.setupDeclaration,
    paths.setupDeclarationEnvExample,
    resolve(paths.control, ".gitignore"),
  ];
  if ((await Promise.all(targets.map(pathExists))).some(Boolean)) {
    throw declarationError({
      code: "RESEARCH_SETUP_DECLARATION_EXISTS",
      step: "declarative-init",
      reason: "Declarative setup files already exist and will not be overwritten.",
      minimumAction: "Review the existing setup.yaml and setup.env.example files in place.",
      retryArgs: ["research", "setup", "--workspace", root, "--json"],
      exitCode: 3,
    });
  }

  await ensureDirectory(paths.control);
  const declaration = defaultDeclaration(root);
  await writeNewTextFile(paths.setupDeclaration, declarationTemplate(declaration), 0o644);
  await writeNewTextFile(
    paths.setupDeclarationEnvExample,
    declarationEnvironmentExample(declaration),
    0o600,
  );
  await writeNewTextFile(resolve(paths.control, ".gitignore"), "setup.env\n", 0o644);

  return {
    schemaVersion: 1,
    workspace: root,
    configurationPath: paths.setupDeclaration,
    environmentExamplePath: paths.setupDeclarationEnvExample,
    next: {
      minimumAction:
        "Review setup.yaml, explicitly accept licenses and costs, optionally copy setup.env.example to owner-only setup.env, then run setup again.",
      setupCommand: exactResearchCliCommand(["research", "setup", "--workspace", root, "--json"]),
    },
  };
}

export async function discoverResearchSetupDeclaration(
  workspace: string,
  options: { configurationPath?: string; environmentPath?: string } = {},
): Promise<{ configurationPath: string; environmentPath: string | null } | null> {
  const requestedRoot = resolve(workspace);
  const rootInfo = await lstat(requestedRoot).catch(() => null);
  if (!rootInfo && options.configurationPath === undefined) return null;
  const root = await resolveResearchSetupWorkspacePath(requestedRoot);
  const paths = workspacePaths(root);
  const configurationPath = options.configurationPath
    ? requireAbsoluteDeclarationPath(options.configurationPath, "--config")
    : paths.setupDeclaration;
  if (!(await pathExists(configurationPath))) {
    if (!options.configurationPath) return null;
    throw declarationError({
      code: "RESEARCH_SETUP_DECLARATION_NOT_FOUND",
      step: "declarative-discovery",
      reason: "The explicitly selected declarative setup file does not exist.",
      minimumAction: "Create the reviewed YAML file or remove --config to use the Wizard.",
      retryArgs: ["research", "setup", "init", "--workspace", root, "--json"],
      exitCode: 2,
    });
  }
  const environmentPath = options.environmentPath
    ? requireAbsoluteDeclarationPath(options.environmentPath, "--env-file")
    : (await pathExists(paths.setupDeclarationEnv))
      ? paths.setupDeclarationEnv
      : null;
  if (options.environmentPath && !(await pathExists(environmentPath!))) {
    throw declarationError({
      code: "RESEARCH_SETUP_DECLARATION_ENV_INVALID",
      step: "declarative-environment",
      reason: "The explicitly selected setup environment file does not exist.",
      minimumAction: "Create the owner-only env file or omit --env-file.",
      retryArgs: ["research", "setup", "--workspace", root, "--json"],
      exitCode: 2,
    });
  }
  return { configurationPath, environmentPath };
}

export async function loadResearchSetupDeclaration(input: {
  workspace: string;
  configurationPath?: string;
  environmentPath?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<LoadedResearchSetupDeclaration> {
  const root = await resolveResearchSetupWorkspacePath(input.workspace);
  const discovered = await discoverResearchSetupDeclaration(root, {
    ...(input.configurationPath === undefined
      ? {}
      : { configurationPath: input.configurationPath }),
    ...(input.environmentPath === undefined ? {} : { environmentPath: input.environmentPath }),
  });
  if (!discovered) {
    throw declarationError({
      code: "RESEARCH_SETUP_DECLARATION_NOT_FOUND",
      step: "declarative-discovery",
      reason: "No workspace-local declarative setup file was found.",
      minimumAction: "Run setup init to create a reviewed template, or use the interactive Wizard.",
      retryArgs: ["research", "setup", "init", "--workspace", root, "--json"],
      exitCode: 2,
    });
  }

  const configurationText = await readRegularBoundedFile({
    path: discovered.configurationPath,
    maximumBytes: MAX_DECLARATION_BYTES,
    code: "RESEARCH_SETUP_DECLARATION_INVALID",
    step: "declarative-configuration",
    label: "Declarative setup YAML",
  });
  const declaration = parseResearchSetupDeclaration(configurationText);
  validateExplicitCatalogDeclaration(declaration);
  validateRequiredVerification(declaration);
  const resolvedSelection = resolveDeclarationSelection(declaration);
  const configurationSha256 = sha256Text(canonicalJson(declaration));
  const sourceEnvironment = input.environment ?? process.env;
  const environment = { ...sourceEnvironment };
  const referencedNames = new Set(
    Object.values(declaration.credentials).map((credential) => credential.environment),
  );

  if (discovered.environmentPath) {
    const fileEnvironment = await readDeclarationEnvironment(discovered.environmentPath);
    const undeclared = [...fileEnvironment.keys()].filter((name) => !referencedNames.has(name));
    if (undeclared.length) {
      throw declarationError({
        code: "RESEARCH_SETUP_DECLARATION_ENV_INVALID",
        step: "declarative-environment",
        reason: "The setup environment file contains variables not referenced by setup.yaml.",
        minimumAction:
          "Keep only environment variable names explicitly listed by setup.yaml credentials.",
        retryArgs: ["research", "setup", "--workspace", root, "--json"],
        exitCode: 2,
        diagnostics: { undeclaredVariableCount: undeclared.length },
      });
    }
    for (const [name, value] of fileEnvironment) {
      const ambient = sourceEnvironment[name];
      if (ambient !== undefined && ambient !== value) {
        throw declarationError({
          code: "RESEARCH_SETUP_DECLARATION_ENV_CONFLICT",
          step: "declarative-environment",
          reason: "A credential source differs between the owner environment and setup.env.",
          minimumAction:
            "Remove one source or make the named values identical; setup will not choose silently.",
          retryArgs: ["research", "setup", "--workspace", root, "--json"],
          exitCode: 2,
        });
      }
      environment[name] = value;
    }
  }

  for (const [credentialId, credential] of Object.entries(declaration.credentials)) {
    if (
      !credential.enabled &&
      Buffer.byteLength(environment[credential.environment] ?? "", "utf8") > 0
    ) {
      throw declarationError({
        code: "RESEARCH_SETUP_DECLARATION_ENV_INVALID",
        step: "declarative-environment",
        reason: `A disabled credential has a non-empty configured value: ${credentialId}.`,
        minimumAction:
          "Enable the credential explicitly in setup.yaml or remove its value from setup.env and the owner environment.",
        retryArgs: ["research", "setup", "--workspace", root, "--json"],
        exitCode: 2,
        diagnostics: { disabledCredentialId: credentialId },
      });
    }
  }

  const credentialEnvironment: Record<string, string> = {};
  for (const [credentialId, credential] of Object.entries(declaration.credentials)) {
    if (credential.enabled) credentialEnvironment[credentialId] = credential.environment;
  }
  const settings: Record<string, string> = {};
  for (const [settingId, setting] of Object.entries(declaration.settings)) {
    if (setting.enabled) settings[settingId] = setting.value!;
  }

  const planInput: LoadedResearchSetupDeclaration["planInput"] = {
    ...(declaration.workspace.name === undefined ? {} : { name: declaration.workspace.name }),
    mode: declaration.workspace.mode,
    evidenceProfile: resolvedSelection.planEvidenceProfile,
    skillIds: [...resolvedSelection.nonBraveSkillIds],
    scope: declaration.install.scope,
    agents: [...declaration.install.agents],
    acceptedLicenseIds: [...declaration.acceptedLicenseIds],
    credentialEnvironment,
    settings,
    agentRoutes: structuredClone(declaration.agentRoutes),
    reviewerExecution: structuredClone(declaration.reviewerExecution),
    liveChecks: declaration.verification.live,
    allowSyntheticUnstructureUpload: declaration.verification.allowSyntheticUnstructureUpload,
    agentSmoke: declaration.verification.agentSmoke,
    confirmNetworkDownloads: declaration.confirmations.networkDownloads,
    confirmGlobalMutation: declaration.confirmations.globalMutation,
    confirmAgentSmokeCost: declaration.confirmations.agentSmokeCost,
    replacePlan: declaration.replaceExistingPlan,
  };

  return {
    workspace: root,
    configurationPath: discovered.configurationPath,
    environmentPath: discovered.environmentPath,
    configurationSha256,
    planInput,
    environment,
    publicSummary: {
      mode: declaration.workspace.mode,
      evidenceProfile: resolvedSelection.declarativeEvidenceProfile,
      selectedSkillIds: [...resolvedSelection.selectedSkillIds],
      enabledCredentialIds: Object.keys(credentialEnvironment).sort(),
      declaredCredentialIds: Object.keys(declaration.credentials).sort(),
      verification: { ...declaration.verification },
      environmentFileUsed: discovered.environmentPath !== null,
    },
  };
}

export async function executeResearchSetupDeclaration(input: {
  workspace: string;
  configurationPath?: string;
  environmentPath?: string;
  environment?: NodeJS.ProcessEnv;
  operations?: Partial<ResearchSetupDeclarationOperations>;
}): Promise<{
  schemaVersion: 1;
  mode: "declarative";
  status: "ready" | "incomplete";
  exitCode: 0 | 3;
  reusedPlan: boolean;
  configuration: {
    path: string;
    sha256: string;
    environmentFileUsed: boolean;
  };
  plan: ResearchSetupPlan;
  state: ResearchSetupState;
  report: DeclarativeSetupApplicationResult["report"];
}> {
  const loaded = await loadResearchSetupDeclaration(input);
  const operations: ResearchSetupDeclarationOperations = {
    createPlan: input.operations?.createPlan ?? createResearchSetupPlan,
    loadPlan: input.operations?.loadPlan ?? loadAndVerifyResearchSetupPlan,
    applyPlan: input.operations?.applyPlan ?? applyResearchSetupPlan,
  };
  const paths = workspacePaths(loaded.workspace);
  let reusedPlan = false;
  let plan: ResearchSetupPlan;

  if (await pathExists(paths.setupPlan)) {
    const existingPlan = await operations.loadPlan(paths.setupPlan);
    const binding = await loadDeclarationBinding(paths.setupDeclarationBinding);
    if (
      binding &&
      binding.configurationSha256 === loaded.configurationSha256 &&
      binding.planSha256 === existingPlan.planSha256
    ) {
      reusedPlan = true;
      plan = existingPlan;
    } else {
      if (!loaded.planInput.replacePlan) {
        throw declarationError({
          code: "RESEARCH_SETUP_DECLARATION_CHANGED",
          step: "declarative-plan",
          reason: "The current immutable plan is not bound to this declarative configuration.",
          minimumAction:
            "Review the configuration change and set replaceExistingPlan: true for one explicit replacement.",
          retryArgs: ["research", "setup", "status", "--workspace", loaded.workspace, "--json"],
          exitCode: 3,
        });
      }
      plan = await operations.createPlan({
        ...loaded.planInput,
        workspace: loaded.workspace,
        environment: loaded.environment,
        replacePlan: true,
        declarativeConfigurationSha256: loaded.configurationSha256,
      });
    }
  } else {
    if (await pathExists(paths.setupDeclarationBinding)) {
      throw declarationError({
        code: "RESEARCH_SETUP_DECLARATION_BINDING_INVALID",
        step: "declarative-plan",
        reason: "A declarative binding exists without its immutable setup plan.",
        minimumAction:
          "Stop and audit the setup control directory; do not reconstruct state by hand.",
        retryArgs: ["research", "setup", "status", "--workspace", loaded.workspace, "--json"],
        exitCode: 3,
      });
    }
    plan = await operations.createPlan({
      ...loaded.planInput,
      workspace: loaded.workspace,
      environment: loaded.environment,
      replacePlan: false,
      declarativeConfigurationSha256: loaded.configurationSha256,
    });
  }

  const applied = await operations.applyPlan(paths.setupPlan, {
    environment: loaded.environment,
  });
  const ready = applied.state.status === "ready" && applied.report?.overallReadiness === "READY";
  const result = {
    schemaVersion: 1 as const,
    mode: "declarative" as const,
    status: ready ? ("ready" as const) : ("incomplete" as const),
    exitCode: ready ? (0 as const) : (3 as const),
    reusedPlan,
    configuration: {
      path: loaded.configurationPath,
      sha256: loaded.configurationSha256,
      environmentFileUsed: loaded.environmentPath !== null,
    },
    plan,
    state: applied.state,
    report: applied.report,
  };
  return sanitizeResearchValue(
    result,
    configuredResearchSecrets(loaded.environment),
  ) as typeof result;
}

function parseResearchSetupDeclaration(source: string): ResearchSetupDeclaration {
  const document = parseDocument(source, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length || document.warnings.length) {
    throw invalidDeclaration("The declarative setup YAML is malformed.", {
      yamlErrorCount: document.errors.length,
      yamlWarningCount: document.warnings.length,
    });
  }
  let containsAliasOrAnchor = false;
  visit(document, (_key, node) => {
    if (
      isAlias(node) ||
      (typeof node === "object" &&
        node !== null &&
        "anchor" in node &&
        typeof node.anchor === "string" &&
        node.anchor.length > 0)
    ) {
      containsAliasOrAnchor = true;
    }
  });
  if (containsAliasOrAnchor) {
    throw invalidDeclaration("YAML aliases and anchors are not supported.");
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw invalidDeclaration("The declarative setup YAML could not be converted safely.");
  }
  if (!validateDeclaration(value)) {
    throw invalidDeclaration("The declarative setup YAML does not match the closed schema.", {
      schemaErrors: declarationSchemaErrors(validateDeclaration.errors),
    });
  }
  return value;
}

function validateRequiredVerification(declaration: ResearchSetupDeclaration): void {
  const missing: string[] = [];
  if (!declaration.verification.live) missing.push("/verification/live");
  if (!declaration.verification.agentSmoke) missing.push("/verification/agentSmoke");
  if (!declaration.confirmations.agentSmokeCost) {
    missing.push("/confirmations/agentSmokeCost");
  }
  if ((declaration.install.scope === "global") !== declaration.confirmations.globalMutation) {
    missing.push("/confirmations/globalMutation");
  }
  if (missing.length) {
    throw invalidDeclaration(
      "Declarative setup must authorize full live and independent-reviewer verification.",
      { incompleteFields: missing },
    );
  }
}

async function readDeclarationEnvironment(path: string): Promise<Map<string, string>> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw unsafeDeclarationEnvironment(
      "The setup environment file must be a regular non-symlink file.",
    );
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw unsafeDeclarationEnvironment(
      "The setup environment file must not be readable or writable by group or other users.",
    );
  }
  if (info.size > MAX_DECLARATION_ENV_BYTES) {
    throw unsafeDeclarationEnvironment("The setup environment file exceeds 64 KiB.");
  }
  const content = await readFile(path, "utf8");
  if (content.includes("\0")) {
    throw invalidDeclarationEnvironment("The setup environment file contains a NUL byte.");
  }
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r\n|\n|\r/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    if (rawLine.startsWith("export ")) {
      throw invalidDeclarationEnvironment("Shell export syntax is not supported in setup.env.");
    }
    const equals = rawLine.indexOf("=");
    if (equals <= 0) {
      throw invalidDeclarationEnvironment("Each setup.env entry must use NAME=value syntax.");
    }
    const name = rawLine.slice(0, equals);
    let value = rawLine.slice(equals + 1);
    if (!ENVIRONMENT_NAME.test(name)) {
      throw invalidDeclarationEnvironment("A setup.env variable name is malformed.");
    }
    if (values.has(name)) {
      throw invalidDeclarationEnvironment("The setup environment file contains a duplicate name.");
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (Buffer.byteLength(value, "utf8") > MAX_DECLARATION_ENV_VALUE_BYTES) {
      throw invalidDeclarationEnvironment("A setup.env value exceeds the supported bound.");
    }
    values.set(name, value);
  }
  return values;
}

async function readRegularBoundedFile(input: {
  path: string;
  maximumBytes: number;
  code: string;
  step: string;
  label: string;
}): Promise<string> {
  const info = await lstat(input.path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > input.maximumBytes) {
    throw declarationError({
      code: input.code,
      step: input.step,
      reason: `${input.label} must be a bounded regular non-symlink file.`,
      minimumAction: "Restore the reviewed workspace-local file and retry.",
      retryArgs: ["research", "setup", "--help"],
      exitCode: 2,
    });
  }
  return readFile(input.path, "utf8");
}

async function loadDeclarationBinding(
  path: string,
): Promise<ResearchSetupDeclarationBinding | null> {
  if (!(await pathExists(path))) return null;
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) {
    throw invalidDeclarationBinding();
  }
  const value = await readJsonFile<unknown>(path, "Declarative setup binding").catch(() => null);
  if (
    !isObject(value) ||
    Object.keys(value).length !== 4 ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-research-setup-declaration-binding" ||
    typeof value.configurationSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.configurationSha256) ||
    typeof value.planSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.planSha256)
  ) {
    throw invalidDeclarationBinding();
  }
  return value as unknown as ResearchSetupDeclarationBinding;
}

async function writeNewTextFile(path: string, content: string, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode).catch(() => null);
  if (!handle) {
    throw declarationError({
      code: "RESEARCH_SETUP_DECLARATION_EXISTS",
      step: "declarative-init",
      reason: "A declarative setup target appeared and was not overwritten.",
      minimumAction: "Review the existing file before retrying.",
      retryArgs: ["research", "setup", "--help"],
      exitCode: 3,
    });
  }
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function defaultDeclaration(root: string): ResearchSetupDeclaration {
  const enabledSkillIds = new Set(
    RESEARCH_SETUP_SKILLS.filter((skill) => skill.defaultSelected).map((skill) => skill.id),
  );
  return {
    schemaVersion: 2,
    kind: "tiangong-research-setup",
    workspace: { name: basename(root), mode: "production-research" },
    install: { scope: "project", agents: ["codex"] },
    selection: {
      skills: Object.fromEntries(
        RESEARCH_SETUP_SKILLS.map((skill) => [
          skill.id,
          {
            enabled: enabledSkillIds.has(skill.id),
            licenseId: skill.license.id,
          },
        ]),
      ),
    },
    acceptedLicenseIds: [],
    credentials: Object.fromEntries(
      RESEARCH_SETUP_CREDENTIALS.map((credential) => [
        credential.id,
        {
          requirement: declarationRequirement(credential, enabledSkillIds),
          appliesTo: [...credential.requiredBy],
          enabled:
            credential.required &&
            credential.requiredBy.some((skillId) => enabledSkillIds.has(skillId)),
          environment: credential.defaultEnvironmentName,
        },
      ]),
    ),
    settings: Object.fromEntries(
      RESEARCH_SETUP_SETTINGS.map((setting) => [
        setting.id,
        {
          requirement: declarationRequirement(setting, enabledSkillIds),
          appliesTo: [...setting.requiredBy],
          enabled:
            setting.required && setting.requiredBy.some((skillId) => enabledSkillIds.has(skillId)),
          value: setting.defaultValue,
        },
      ]),
    ),
    agentRoutes: {
      producerAgent: "codex",
      reviewerAgent: "claude",
      producerModel: null,
      reviewerModel: null,
      producerPricing: null,
      reviewerPricing: null,
    },
    reviewerExecution: {
      transport: "native-direct",
      isolationProvider: "platform-capsule",
    },
    verification: {
      live: true,
      allowSyntheticUnstructureUpload: false,
      agentSmoke: true,
    },
    confirmations: {
      networkDownloads: false,
      globalMutation: false,
      agentSmokeCost: false,
    },
    replaceExistingPlan: false,
  };
}

function declarationTemplate(value: ResearchSetupDeclaration): string {
  return [
    "# Every current catalog Skill, credential, and setting is explicit below.",
    "# Review each enabled flag, license, endpoint, model, price, and confirmation.",
    "# This file contains no secret values. Credential values belong only in owner-only",
    "# setup.env, the same named owner environment variables, or the logical stores.",
    "# Set confirmations to true only after the human owner accepts each action/cost.",
    stringify(value, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
}

function declarationEnvironmentExample(declaration: ResearchSetupDeclaration): string {
  return [
    "# Copy this file to setup.env and run chmod 600 .tiangong-research/setup.env.",
    "# Every catalog credential is visible. Leave disabled optional values empty.",
    "# A non-empty disabled value is rejected instead of being used implicitly.",
    "# Values are imported into owner-only logical stores and never into setup.yaml.",
    ...RESEARCH_SETUP_CREDENTIALS.flatMap((definition) => {
      const choice = declaration.credentials[definition.id]!;
      return [
        "",
        `# ${definition.id}: ${choice.requirement}; enabled=${String(choice.enabled)}`,
        `${choice.environment}=`,
      ];
    }),
    "",
  ].join("\n");
}

function declarationRequirement(
  input: { required: boolean; requiredBy: readonly string[] },
  selectedSkillIds: ReadonlySet<string>,
): DeclarationRequirement {
  if (!input.required) return "optional";
  if (input.requiredBy.length === 0) return "required";
  return input.requiredBy.some((skillId) => selectedSkillIds.has(skillId))
    ? "required"
    : "conditional";
}

function requireAbsoluteDeclarationPath(path: string, option: string): string {
  if (!isAbsolute(path)) {
    throw declarationError({
      code: "RESEARCH_SETUP_DECLARATION_PATH_INVALID",
      step: "declarative-discovery",
      reason: `${option} must be an absolute file path.`,
      minimumAction: "Pass an absolute reviewed path or use workspace-local auto-discovery.",
      retryArgs: ["research", "setup", "--help"],
      exitCode: 2,
    });
  }
  return resolve(path);
}

function resolveDeclarationSelection(declaration: ResearchSetupDeclaration): {
  selectedSkillIds: string[];
  nonBraveSkillIds: string[];
  declarativeEvidenceProfile: DeclarativeEvidenceProfile;
  planEvidenceProfile: ResearchSetupPlanInput["evidenceProfile"];
} {
  const selectedSkillIds = RESEARCH_SETUP_SKILLS.filter(
    (skill) => declaration.selection.skills[skill.id]!.enabled,
  ).map((skill) => skill.id);
  const enabledBraveIds = selectedSkillIds.filter((skillId) => BRAVE_SKILL_IDS.has(skillId));
  const profiles: Array<{
    declarative: DeclarativeEvidenceProfile;
    plan: ResearchSetupPlanInput["evidenceProfile"];
    skillIds: string[];
  }> = [
    { declarative: "none", plan: "none", skillIds: [] },
    {
      declarative: "brave-baseline",
      plan: EXTERNAL_SKILL_PROFILE,
      skillIds: ["brave.web-search", "brave.news-search"],
    },
    {
      declarative: "brave-context",
      plan: EXTERNAL_SKILL_CONTEXT_PROFILE,
      skillIds: ["brave.web-search", "brave.news-search", "brave.llm-context"],
    },
    {
      declarative: "brave-media",
      plan: EXTERNAL_SKILL_MEDIA_PROFILE,
      skillIds: [
        "brave.web-search",
        "brave.news-search",
        "brave.llm-context",
        "brave.images-search",
        "brave.videos-search",
      ],
    },
  ];
  const matched = profiles.find((profile) => sameStringSet(enabledBraveIds, profile.skillIds));
  if (!matched) {
    throw invalidDeclaration(
      "Enabled Brave Skills must form one complete supported evidence profile.",
      {
        enabledBraveSkillIds: enabledBraveIds,
        supportedProfiles: profiles.map((profile) => ({
          id: profile.declarative,
          skillIds: profile.skillIds,
        })),
      },
    );
  }
  return {
    selectedSkillIds,
    nonBraveSkillIds: selectedSkillIds.filter((skillId) => !BRAVE_SKILL_IDS.has(skillId)),
    declarativeEvidenceProfile: matched.declarative,
    planEvidenceProfile: matched.plan,
  };
}

function validateExplicitCatalogDeclaration(declaration: ResearchSetupDeclaration): void {
  const problems: Array<{ path: string; rule: string }> = [];
  validateExactRecordKeys(
    declaration.selection.skills,
    RESEARCH_SETUP_SKILLS.map((skill) => skill.id),
    "/selection/skills",
    problems,
  );
  validateExactRecordKeys(
    declaration.credentials,
    RESEARCH_SETUP_CREDENTIALS.map((credential) => credential.id),
    "/credentials",
    problems,
  );
  validateExactRecordKeys(
    declaration.settings,
    RESEARCH_SETUP_SETTINGS.map((setting) => setting.id),
    "/settings",
    problems,
  );

  const selectedSkillIds = new Set(
    RESEARCH_SETUP_SKILLS.filter((skill) => declaration.selection.skills[skill.id]?.enabled).map(
      (skill) => skill.id,
    ),
  );
  for (const skill of RESEARCH_SETUP_SKILLS) {
    const choice = declaration.selection.skills[skill.id];
    if (choice && choice.licenseId !== skill.license.id) {
      problems.push({ path: `/selection/skills/${skill.id}/licenseId`, rule: "catalog-drift" });
    }
  }

  const environmentOwners = new Map<string, string>();
  for (const definition of RESEARCH_SETUP_CREDENTIALS) {
    const choice = declaration.credentials[definition.id];
    if (!choice) continue;
    validateCatalogChoiceMetadata(
      `/credentials/${definition.id}`,
      choice,
      definition,
      selectedSkillIds,
      problems,
    );
    const applies = definition.requiredBy.some((skillId) => selectedSkillIds.has(skillId));
    if (definition.required && choice.enabled !== applies) {
      problems.push({
        path: `/credentials/${definition.id}/enabled`,
        rule: applies ? "required-when-selected" : "disabled-when-unused",
      });
    } else if (!definition.required && !applies && choice.enabled) {
      problems.push({
        path: `/credentials/${definition.id}/enabled`,
        rule: "disabled-when-unused",
      });
    }
    const priorOwner = environmentOwners.get(choice.environment);
    if (priorOwner) {
      problems.push({
        path: `/credentials/${definition.id}/environment`,
        rule: "duplicate-environment-name",
      });
    } else {
      environmentOwners.set(choice.environment, definition.id);
    }
  }

  for (const definition of RESEARCH_SETUP_SETTINGS) {
    const choice = declaration.settings[definition.id];
    if (!choice) continue;
    validateCatalogChoiceMetadata(
      `/settings/${definition.id}`,
      choice,
      definition,
      selectedSkillIds,
      problems,
    );
    const applies = definition.requiredBy.some((skillId) => selectedSkillIds.has(skillId));
    if (definition.required && choice.enabled !== applies) {
      problems.push({
        path: `/settings/${definition.id}/enabled`,
        rule: applies ? "required-when-selected" : "disabled-when-unused",
      });
    } else if (!definition.required && !applies && choice.enabled) {
      problems.push({
        path: `/settings/${definition.id}/enabled`,
        rule: "disabled-when-unused",
      });
    }
    if (choice.enabled && (choice.value === null || choice.value.length === 0)) {
      problems.push({ path: `/settings/${definition.id}/value`, rule: "enabled-value-required" });
    }
  }

  if (problems.length) {
    throw invalidDeclaration(
      "The declarative setup must explicitly and exactly match the current catalog.",
      { catalogProblems: problems.slice(0, 32), catalogProblemCount: problems.length },
    );
  }
  resolveDeclarationSelection(declaration);
}

function validateCatalogChoiceMetadata(
  path: string,
  choice: DeclarationCredentialChoice | DeclarationSettingChoice,
  definition: ResearchSetupCredential | ResearchSetupSetting,
  selectedSkillIds: ReadonlySet<string>,
  problems: Array<{ path: string; rule: string }>,
): void {
  if (choice.requirement !== declarationRequirement(definition, selectedSkillIds)) {
    problems.push({ path: `${path}/requirement`, rule: "catalog-drift" });
  }
  if (!sameStringSet(choice.appliesTo, definition.requiredBy)) {
    problems.push({ path: `${path}/appliesTo`, rule: "catalog-drift" });
  }
}

function validateExactRecordKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  path: string,
  problems: Array<{ path: string; rule: string }>,
): void {
  const expected = new Set(expectedKeys);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) problems.push({ path: `${path}/${key}`, rule: "missing" });
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) problems.push({ path: `${path}/${key}`, rule: "unknown" });
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function invalidDeclaration(reason: string, diagnostics?: Record<string, unknown>): CliError {
  return declarationError({
    code: "RESEARCH_SETUP_DECLARATION_INVALID",
    step: "declarative-configuration",
    reason,
    minimumAction:
      "Correct setup.yaml against the generated closed template; secret values belong only in setup.env or the owner environment.",
    retryArgs: ["research", "setup", "--help"],
    exitCode: 2,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
}

function unsafeDeclarationEnvironment(reason: string): CliError {
  return declarationError({
    code: "RESEARCH_SETUP_DECLARATION_ENV_UNSAFE",
    step: "declarative-environment",
    reason,
    minimumAction: "Use a regular non-symlink file and run chmod 600 .tiangong-research/setup.env.",
    retryArgs: ["research", "setup", "--help"],
    exitCode: 2,
  });
}

function invalidDeclarationEnvironment(reason: string): CliError {
  return declarationError({
    code: "RESEARCH_SETUP_DECLARATION_ENV_INVALID",
    step: "declarative-environment",
    reason,
    minimumAction:
      "Use one literal NAME=value line for each variable referenced by setup.yaml; shell evaluation is not supported.",
    retryArgs: ["research", "setup", "--help"],
    exitCode: 2,
  });
}

function invalidDeclarationBinding(): CliError {
  return declarationError({
    code: "RESEARCH_SETUP_DECLARATION_BINDING_INVALID",
    step: "declarative-plan",
    reason: "The declarative configuration binding is malformed or unsafe.",
    minimumAction: "Stop and audit the immutable plan and binding; do not edit either by hand.",
    retryArgs: ["research", "setup", "status", "--json"],
    exitCode: 3,
  });
}

function declarationError(input: {
  code: string;
  step: string;
  reason: string;
  minimumAction: string;
  retryArgs: string[];
  exitCode: number;
  diagnostics?: Record<string, unknown>;
}): CliError {
  const reason = sanitizeResearchText(input.reason);
  return new CliError(reason, {
    code: input.code,
    exitCode: input.exitCode,
    details: sanitizeResearchRecord({
      step: input.step,
      reason,
      minimumAction: input.minimumAction,
      retryCommand: exactResearchCliCommand(input.retryArgs),
      ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    }),
  });
}

function declarationSchemaErrors(
  errors: ErrorObject[] | null | undefined,
): Array<{ path: string; rule: string }> {
  return (errors ?? []).slice(0, 16).map((error) => ({
    path: error.instancePath || "/",
    rule: error.keyword,
  }));
}

const pricingSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "inputUsdPerMillionTokens",
        "cachedInputUsdPerMillionTokens",
        "outputUsdPerMillionTokens",
      ],
      properties: {
        inputUsdPerMillionTokens: { type: "number", minimum: 0 },
        cachedInputUsdPerMillionTokens: { type: "number", minimum: 0 },
        outputUsdPerMillionTokens: { type: "number", minimum: 0 },
      },
    },
  ],
} as const;

const declarationSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "workspace",
    "install",
    "selection",
    "acceptedLicenseIds",
    "credentials",
    "settings",
    "agentRoutes",
    "reviewerExecution",
    "verification",
    "confirmations",
    "replaceExistingPlan",
  ],
  properties: {
    schemaVersion: { const: 2 },
    kind: { const: "tiangong-research-setup" },
    workspace: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        mode: { enum: ["smoke-test", "production-research"] },
      },
    },
    install: {
      type: "object",
      additionalProperties: false,
      required: ["scope", "agents"],
      properties: {
        scope: { enum: ["project", "global"] },
        agents: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: { enum: ["codex", "claude-code"] },
        },
      },
    },
    selection: {
      type: "object",
      additionalProperties: false,
      required: ["skills"],
      properties: {
        skills: {
          type: "object",
          minProperties: 1,
          maxProperties: 64,
          propertyNames: { type: "string", minLength: 1, maxLength: 200 },
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            required: ["enabled", "licenseId"],
            properties: {
              enabled: { type: "boolean" },
              licenseId: { type: "string", minLength: 1, maxLength: 200 },
            },
          },
        },
      },
    },
    acceptedLicenseIds: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    credentials: {
      type: "object",
      minProperties: 1,
      maxProperties: 64,
      propertyNames: { type: "string", minLength: 1, maxLength: 200 },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["requirement", "appliesTo", "enabled", "environment"],
        properties: {
          requirement: { enum: ["required", "conditional", "optional"] },
          appliesTo: {
            type: "array",
            maxItems: 64,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 200 },
          },
          enabled: { type: "boolean" },
          environment: { type: "string", pattern: ENVIRONMENT_NAME.source },
        },
      },
    },
    settings: {
      type: "object",
      minProperties: 1,
      maxProperties: 64,
      propertyNames: { type: "string", minLength: 1, maxLength: 200 },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["requirement", "appliesTo", "enabled", "value"],
        properties: {
          requirement: { enum: ["required", "conditional", "optional"] },
          appliesTo: {
            type: "array",
            maxItems: 64,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 200 },
          },
          enabled: { type: "boolean" },
          value: { type: ["string", "null"], maxLength: 4096 },
        },
      },
    },
    agentRoutes: {
      type: "object",
      additionalProperties: false,
      required: ["producerAgent", "reviewerAgent"],
      properties: {
        producerAgent: { enum: ["codex", "claude"] },
        reviewerAgent: { enum: ["codex", "claude"] },
        producerModel: { type: ["string", "null"], maxLength: 200 },
        reviewerModel: { type: ["string", "null"], maxLength: 200 },
        producerPricing: pricingSchema,
        reviewerPricing: pricingSchema,
      },
    },
    reviewerExecution: {
      type: "object",
      additionalProperties: false,
      required: ["transport", "isolationProvider"],
      properties: {
        transport: { enum: ["native-direct", "sandbox-bridge"] },
        isolationProvider: { const: "platform-capsule" },
      },
    },
    verification: {
      type: "object",
      additionalProperties: false,
      required: ["live", "allowSyntheticUnstructureUpload", "agentSmoke"],
      properties: {
        live: { type: "boolean" },
        allowSyntheticUnstructureUpload: { type: "boolean" },
        agentSmoke: { type: "boolean" },
      },
    },
    confirmations: {
      type: "object",
      additionalProperties: false,
      required: ["networkDownloads", "globalMutation", "agentSmokeCost"],
      properties: {
        networkDownloads: { type: "boolean" },
        globalMutation: { type: "boolean" },
        agentSmokeCost: { type: "boolean" },
      },
    },
    replaceExistingPlan: { type: "boolean" },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const validateDeclaration = ajv.compile(
  declarationSchema,
) as ValidateFunction<ResearchSetupDeclaration>;
