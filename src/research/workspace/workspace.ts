import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import { CliError } from "../../errors.js";
import { declaredCredentialIds, verifyCapabilities } from "./capabilities.js";
import { packageVersion, RESEARCH_PACKAGE_NAME, RESEARCH_PROTOCOL_VERSION } from "./constants.js";
import { inspectResearchContext, isWorkspaceMarker } from "./context.js";
import { appendJournalEvent, verifyJournal } from "./journal.js";
import { loadProjectEvidenceReceipts } from "./evidence.js";
import { executeAgent, type AgentExecutionRequest } from "./executor.js";
import { parseStructuredStageOutput, schemaForStage } from "./schemas.js";
import {
  acquireFileLock,
  canonicalJson,
  ensureDirectory,
  isObject,
  pathExists,
  readJsonFile,
  requireAbsolutePath,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type {
  AgentRoute,
  DoctorCheck,
  ProjectState,
  RuntimeLock,
  WorkspaceConfig,
  WorkspaceDoctorResult,
  WorkspaceMarker,
  ResearchMode,
  ExecutionResult,
  AgentRuntimeFingerprint,
  WorkspaceDoctorAttestation,
} from "./types.js";

const DOCTOR_ATTESTATION_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_BUDGET = {
  maxTokens: 320_000,
  maxCostUsd: 60,
  maxWallSeconds: 72 * 60 * 60,
  maxFilesPerPackage: 20,
  maxBytesPerPackage: 20 * 1024 * 1024,
  maxAttemptsPerPackage: 3,
  confirmationCostUsd: 10,
  packageMaxTokens: {
    discover: 80_000,
    analyze: 55_000,
    synthesize: 60_000,
    review: 120_000,
  },
  packageMaxWallSeconds: {
    discover: 2 * 60 * 60,
    analyze: 2 * 60 * 60,
    synthesize: 60 * 60,
    review: 60 * 60,
  },
  maxOutputTokens: 4_000,
  maxRepairTokens: 4_000,
  maxBrokerResponseBytes: 512 * 1024,
  maxBrokerContextTokens: 12_000,
  maxBrokerItems: 100,
  maxInputContextTokens: 12_000,
} as const;

export async function initializeResearchWorkspace(
  targetPath: string,
  name: string | undefined,
  mode: ResearchMode = "smoke-test",
): Promise<{ workspace: string; workspaceId: string; created: string[] }> {
  const root = requireAbsolutePath(targetPath, "Workspace path");
  await mkdir(root, { recursive: true, mode: 0o755 });
  const selectedInfo = await lstat(root);
  if (!selectedInfo.isDirectory() || selectedInfo.isSymbolicLink()) {
    throw new CliError(`Workspace path must be a regular directory: ${root}`, {
      code: "RESEARCH_WORKSPACE_PATH_INVALID",
      exitCode: 2,
    });
  }
  const paths = workspacePaths(root);
  if (await pathExists(paths.control)) {
    throw new CliError(`Research workspace state already exists: ${paths.control}`, {
      code: "RESEARCH_WORKSPACE_EXISTS",
      exitCode: 2,
    });
  }

  const workspaceName = normalizeWorkspaceName(name ?? basename(root));
  const workspaceId = randomUUID();
  const now = new Date().toISOString();
  const marker: WorkspaceMarker = {
    schemaVersion: 1,
    kind: "tiangong-research-workspace",
    workspaceId,
    name: workspaceName,
    createdAt: now,
  };
  const config: WorkspaceConfig = {
    schemaVersion: 1,
    mode,
    producer: {
      agent: "codex",
      binary: "codex",
      model: null,
      effort: "low",
      verbosity: "low",
    },
    reviewer: { agent: "claude", binary: "claude", model: null, effort: "low" },
    budget: { ...DEFAULT_BUDGET },
  };
  const runtimeLock: RuntimeLock = {
    schemaVersion: 1,
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    packageName: RESEARCH_PACKAGE_NAME,
    packageVersion: packageVersion(),
    workspaceId,
  };

  await ensureDirectory(paths.control);
  await Promise.all([
    ensureDirectory(paths.evidenceCache),
    ensureDirectory(paths.evidenceObjects),
    ensureDirectory(paths.projects),
    ensureDirectory(paths.runtime),
    ensureDirectory(paths.locks),
  ]);
  await writeJsonAtomic(paths.marker, marker);
  await writeJsonAtomic(paths.config, config);
  await writeJsonAtomic(paths.runtimeLock, runtimeLock);
  await writeJsonAtomic(paths.capabilityDeclarations, { schemaVersion: 1, capabilities: [] });
  await writeFile(
    paths.envExample,
    [
      "# Map capability-declared logical credential IDs to owner-provided values.",
      "TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={}",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(join(paths.control, ".gitignore"), ".env\nlocks/\nruntime/\n", "utf8");
  await appendJournalEvent(paths.journal, "workspace.initialized", workspaceId, {
    workspaceId,
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
  });

  return {
    workspace: root,
    workspaceId,
    created: [
      paths.marker,
      paths.config,
      paths.runtimeLock,
      paths.capabilityDeclarations,
      paths.envExample,
      paths.journal,
    ],
  };
}

export async function requireResearchWorkspace(inputPath: string): Promise<string> {
  const inspection = await inspectResearchContext(inputPath);
  if (inspection.role !== "workspace" || !inspection.root) {
    throw new CliError(`Path is not inside a valid Tiangong research workspace: ${inputPath}`, {
      code: "RESEARCH_WORKSPACE_REQUIRED",
      exitCode: 2,
      details: inspection,
    });
  }
  return inspection.root;
}

export async function loadWorkspaceMarker(root: string): Promise<WorkspaceMarker> {
  const marker = await readJsonFile<unknown>(
    workspacePaths(root).marker,
    "Research workspace marker",
  );
  if (!isWorkspaceMarker(marker)) {
    throw new CliError("Research workspace marker has an unsupported shape.", {
      code: "RESEARCH_WORKSPACE_INVALID",
      exitCode: 2,
    });
  }
  return marker;
}

export async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig> {
  const config = await readJsonFile<unknown>(workspacePaths(root).config, "Research configuration");
  if (!isWorkspaceConfig(config)) {
    throw new CliError("Research configuration has an unsupported shape.", {
      code: "RESEARCH_CONFIG_INVALID",
      exitCode: 2,
    });
  }
  return config;
}

export interface DoctorOptions {
  agentSmoke?: boolean;
  environment?: NodeJS.ProcessEnv;
  executor?: (request: AgentExecutionRequest) => Promise<ExecutionResult>;
}

export async function doctorResearchWorkspace(
  inputPath: string,
  options: DoctorOptions = {},
): Promise<WorkspaceDoctorResult> {
  const workspace = await requireResearchWorkspace(inputPath);
  const paths = workspacePaths(workspace);
  const checks: DoctorCheck[] = [];

  const marker = await checked(checks, "workspace-marker", async () => {
    const value = await loadWorkspaceMarker(workspace);
    return { value, detail: `workspaceId=${value.workspaceId}` };
  });
  const config = await checked(checks, "workspace-config", async () => {
    const value = await loadWorkspaceConfig(workspace);
    return {
      value,
      detail: `producer=${value.producer.agent} reviewer=${value.reviewer.agent}`,
    };
  });
  await checked(checks, "runtime-lock", async () => {
    const lock = await requireCurrentRuntimeLock(workspace, marker);
    return { value: lock, detail: `${lock.packageName}@${lock.packageVersion}` };
  });
  await checked(checks, "journal-chain", async () => {
    const result = await verifyJournal(paths.journal);
    return { value: result, detail: `${result.events} event(s), head=${result.head.slice(0, 12)}` };
  });
  const credentialIds = await checked(checks, "capability-policy", async () => {
    const result = await verifyCapabilities(workspace);
    if (result.status !== "verified") {
      throw new Error(result.errors.join("; ") || "capability verification failed");
    }
    return {
      value: await declaredCredentialIds(workspace),
      detail: `${result.checked} locked capability declaration(s)`,
    };
  });
  await checked(checks, "credential-environment", async () => {
    const result = await inspectCredentialEnvironment(paths.env, credentialIds ?? new Set());
    return { value: result, detail: result };
  });
  await checked(checks, "project-state", async () => {
    const projects = await readProjectStates(paths.projects);
    return { value: projects, detail: `${projects.length} project(s)` };
  });
  await checked(checks, "evidence-store", async () => {
    const projects = await readProjectStates(paths.projects);
    let receipts = 0;
    for (const project of projects) {
      receipts += (await loadProjectEvidenceReceipts(workspace, project.id)).length;
    }
    return { value: receipts, detail: `${receipts} verified broker evidence receipt(s)` };
  });
  if (config && config.producer.agent === config.reviewer.agent) {
    checks.push({
      id: "independent-review-route",
      status: "fail",
      detail: "Producer and reviewer must use different agent families.",
    });
  } else if (config) {
    checks.push({
      id: "independent-review-route",
      status: "pass",
      detail: `${config.producer.agent} -> ${config.reviewer.agent}`,
    });
  }
  if (
    config?.mode === "production-research" &&
    (!config.producer.model || !config.reviewer.model)
  ) {
    checks.push({
      id: "explicit-model-routes",
      status: "fail",
      detail: "Production research requires explicit producer and reviewer model IDs.",
    });
  } else if (config) {
    checks.push({
      id: "explicit-model-routes",
      status: config.mode === "production-research" ? "pass" : "warn",
      detail:
        config.mode === "production-research"
          ? `${config.producer.model} -> ${config.reviewer.model}`
          : "Smoke-test mode does not require pinned model IDs.",
    });
  }
  if (
    config?.mode === "production-research" &&
    (!config.producer.pricing || !config.reviewer.pricing)
  ) {
    checks.push({
      id: "explicit-agent-pricing",
      status: "fail",
      detail: "Production research requires explicit input, cached-input, and output prices.",
    });
  } else if (config) {
    checks.push({
      id: "explicit-agent-pricing",
      status: config.mode === "production-research" ? "pass" : "warn",
      detail:
        config.mode === "production-research"
          ? "Producer and reviewer pricing are configured."
          : "Smoke-test mode permits zero/unknown price accounting.",
    });
  }
  if (config) {
    if (options.agentSmoke) {
      const smokeResults: AgentSmokeResult[] = [];
      for (const route of [config.producer, config.reviewer]) {
        const result = await checked(checks, `agent-sandbox-smoke.${route.agent}`, async () => {
          const value = await runAgentSmokeCheck(
            workspace,
            config,
            route,
            options.environment ?? process.env,
            options.executor ?? executeAgent,
          );
          return { value, detail: agentSmokeDetail(value) };
        });
        if (result) smokeResults.push(result);
      }
      const smoke =
        smokeResults.length === 2
          ? {
              runtimes: smokeResults
                .map((result) => result.runtime)
                .sort((left, right) => left.agent.localeCompare(right.agent)),
              smokeUsage: smokeResults
                .map((result) => result.usage)
                .sort((left, right) => left.agent.localeCompare(right.agent)),
            }
          : undefined;
      checks.push({
        id: "agent-sandbox-smoke",
        status: smoke ? "pass" : "fail",
        detail: smoke
          ? "Both isolated producer and reviewer smoke checks passed."
          : `${smokeResults.length}/2 isolated agent smoke checks passed.`,
      });
      if (
        smoke &&
        config.mode === "production-research" &&
        !checks.some((check) => check.status === "fail")
      ) {
        await checked(checks, "doctor-attestation", async () => {
          const value = await persistDoctorAttestation(workspace, config, marker!, smoke);
          return {
            value,
            detail: `valid until ${value.expiresAt}; sha256=${value.attestationSha256.slice(0, 12)}`,
          };
        });
      }
    } else {
      checks.push({
        id: "agent-sandbox-smoke",
        status: config.mode === "production-research" ? "fail" : "warn",
        detail:
          "Producer/reviewer execution smoke was not run; rerun doctor with --agent-smoke before production research.",
      });
    }
  }

  return {
    workspace,
    status: checks.some((check) => check.status === "fail") ? "blocked" : "ready",
    checks,
  };
}

interface AgentSmokeResult {
  runtime: AgentRuntimeFingerprint;
  usage: WorkspaceDoctorAttestation["smokeUsage"][number];
}

interface DoctorSmokeBundle {
  runtimes: AgentRuntimeFingerprint[];
  smokeUsage: WorkspaceDoctorAttestation["smokeUsage"];
}

async function runAgentSmokeCheck(
  workspace: string,
  config: WorkspaceConfig,
  route: AgentRoute,
  environment: NodeJS.ProcessEnv,
  executor: (request: AgentExecutionRequest) => Promise<ExecutionResult>,
): Promise<AgentSmokeResult> {
  const smokeRoot = join(
    workspacePaths(workspace).runtime,
    `doctor-${route.agent}-${randomUUID()}`,
  );
  await ensureDirectory(smokeRoot);
  try {
    const projectRoot = join(smokeRoot, "project");
    await ensureDirectory(projectRoot);
    const result = await executor({
      route,
      prompt:
        'Return exactly the JSON object {"ok":true}. This checks executable, authentication, structured output, and capsule sandbox readiness only.',
      outputSchema: schemaForStage("doctor"),
      requestId: randomUUID(),
      purpose: "doctor",
      capsuleRoot: smokeRoot,
      projectRoot,
      workspaceRoot: workspace,
      timeoutSeconds: 120,
      maxTurns: 2,
      maxOutputTokens: 128,
      maxCostUsd: Math.min(0.25, config.budget.maxCostUsd),
      toolPolicy: "none",
      environment,
      brokerUrl: null,
    });
    if (result.exitCode !== 0) {
      const diagnostic = [result.stderr.trim(), result.stdout.trim()]
        .filter(Boolean)
        .join("\n")
        .slice(0, 2_000);
      throw new Error(
        `${route.agent} smoke failed: ${diagnostic || `executor exited ${result.exitCode}`}`,
      );
    }
    parseStructuredStageOutput("doctor", result.stdout);
    if (!result.runtime) {
      throw new Error(`${route.agent} smoke did not return a runtime fingerprint`);
    }
    return {
      runtime: result.runtime,
      usage: {
        agent: route.agent,
        tokens: result.tokens,
        inputTokens: result.inputTokens,
        cachedInputTokens: result.cachedInputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        wallSeconds: result.wallSeconds,
        telemetry: result.telemetry,
      },
    };
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

function agentSmokeDetail(result: AgentSmokeResult): string {
  const usage = result.usage;
  const detail = [
    `${result.runtime.agent}@${result.runtime.binaryVersion}`,
    `model=${result.runtime.model ?? "unknown"}`,
    `effort=${result.runtime.effort ?? "unknown"}`,
    `tokens=${usage.tokens}`,
    `input=${usage.inputTokens}`,
    `cached=${usage.cachedInputTokens}`,
    `output=${usage.outputTokens}`,
    `costUsd=${usage.costUsd}`,
    `wallSeconds=${Math.round(usage.wallSeconds * 1000) / 1000}`,
  ];
  if (usage.telemetry?.providerErrors.length) {
    detail.push(`providerErrors=${JSON.stringify(usage.telemetry.providerErrors)}`);
  }
  return detail.join(" ");
}

async function persistDoctorAttestation(
  root: string,
  expectedConfig: WorkspaceConfig,
  marker: WorkspaceMarker,
  smoke: DoctorSmokeBundle,
): Promise<WorkspaceDoctorAttestation> {
  return withWorkspaceLock(root, "workspace.doctor.attest", async () => {
    const paths = workspacePaths(root);
    const config = await loadWorkspaceConfig(root);
    if (canonicalJson(config) !== canonicalJson(expectedConfig)) {
      throw new Error("workspace configuration changed during doctor smoke");
    }
    const capabilities = await verifyCapabilities(root);
    if (capabilities.status !== "verified") {
      throw new Error("capability lock changed during doctor smoke");
    }
    const checkedAt = new Date().toISOString();
    const core = {
      schemaVersion: 1 as const,
      workspaceId: marker.workspaceId,
      checkedAt,
      expiresAt: new Date(Date.parse(checkedAt) + DOCTOR_ATTESTATION_TTL_MS).toISOString(),
      configSha256: sha256Text(canonicalJson(config)),
      runtimeLockSha256: await sha256File(paths.runtimeLock),
      capabilityDeclarationsSha256: await sha256File(paths.capabilityDeclarations),
      capabilityLockSha256: await sha256File(paths.capabilityLock),
      doctorSchemaSha256: sha256Text(canonicalJson(schemaForStage("doctor"))),
      runtimes: smoke.runtimes,
      smokeUsage: smoke.smokeUsage,
    };
    const value: WorkspaceDoctorAttestation = {
      ...core,
      attestationSha256: sha256Text(canonicalJson(core)),
    };
    await writeJsonAtomic(paths.doctorAttestation, value);
    await appendJournalEvent(paths.journal, "workspace.doctor.attested", marker.workspaceId, {
      attestationSha256: value.attestationSha256,
      checkedAt: value.checkedAt,
      expiresAt: value.expiresAt,
      runtimes: value.runtimes,
      smokeUsage: value.smokeUsage,
    });
    return value;
  });
}

export async function verifyDoctorAttestation(root: string): Promise<{
  status: "verified" | "missing" | "invalid" | "expired" | "drifted";
  errors: string[];
  attestation: WorkspaceDoctorAttestation | null;
}> {
  const paths = workspacePaths(root);
  const value = await readJsonFile<unknown>(paths.doctorAttestation, "Doctor attestation").catch(
    () => null,
  );
  if (!isDoctorAttestation(value)) {
    return {
      status: value === null ? "missing" : "invalid",
      errors: ["doctor attestation is missing or invalid"],
      attestation: null,
    };
  }
  const { attestationSha256, ...core } = value;
  const errors: string[] = [];
  if (sha256Text(canonicalJson(core)) !== attestationSha256)
    errors.push("attestation hash mismatch");
  const marker = await loadWorkspaceMarker(root);
  const config = await loadWorkspaceConfig(root);
  if (value.workspaceId !== marker.workspaceId) errors.push("workspace ID drifted");
  if (value.configSha256 !== sha256Text(canonicalJson(config)))
    errors.push("workspace config drifted");
  if (value.runtimeLockSha256 !== (await sha256File(paths.runtimeLock)))
    errors.push("runtime lock drifted");
  if (value.capabilityDeclarationsSha256 !== (await sha256File(paths.capabilityDeclarations))) {
    errors.push("capability declarations drifted");
  }
  if (value.capabilityLockSha256 !== (await sha256File(paths.capabilityLock).catch(() => ""))) {
    errors.push("capability lock drifted");
  }
  if (value.doctorSchemaSha256 !== sha256Text(canonicalJson(schemaForStage("doctor")))) {
    errors.push("doctor schema drifted");
  }
  if (errors.length) return { status: "drifted", errors, attestation: value };
  if (Date.parse(value.expiresAt) <= Date.now()) {
    return { status: "expired", errors: ["doctor attestation expired"], attestation: value };
  }
  return { status: "verified", errors: [], attestation: value };
}

function isDoctorAttestation(value: unknown): value is WorkspaceDoctorAttestation {
  if (!isObject(value) || value.schemaVersion !== 1) return false;
  const hashFields = [
    value.configSha256,
    value.runtimeLockSha256,
    value.capabilityDeclarationsSha256,
    value.capabilityLockSha256,
    value.doctorSchemaSha256,
    value.attestationSha256,
  ];
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(value.checkedAt)) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    hashFields.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) ||
    !Array.isArray(value.runtimes) ||
    value.runtimes.length !== 2 ||
    !Array.isArray(value.smokeUsage) ||
    value.smokeUsage.length !== 2
  ) {
    return false;
  }
  return value.runtimes.every(
    (runtime) =>
      isObject(runtime) &&
      (runtime.agent === "codex" || runtime.agent === "claude") &&
      (runtime.model === null || typeof runtime.model === "string") &&
      typeof runtime.binarySha256 === "string" &&
      /^[0-9a-f]{64}$/.test(runtime.binarySha256) &&
      typeof runtime.wrapperSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(runtime.wrapperSha256) &&
      typeof runtime.adapterSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(runtime.adapterSha256) &&
      typeof runtime.binaryVersion === "string" &&
      typeof runtime.platform === "string" &&
      typeof runtime.architecture === "string",
  );
}

export async function withWorkspaceLock<T>(
  root: string,
  operation: string,
  callback: () => Promise<T>,
): Promise<T> {
  await requireCurrentRuntimeLock(root);
  const paths = workspacePaths(root);
  const release = await acquireFileLock(join(paths.locks, "workspace.lock"), {
    pid: process.pid,
    operation,
    acquiredAt: new Date().toISOString(),
  });
  try {
    return await callback();
  } finally {
    await release();
  }
}

export async function requireCurrentRuntimeLock(
  root: string,
  knownMarker?: WorkspaceMarker,
): Promise<RuntimeLock> {
  const paths = workspacePaths(root);
  const marker = knownMarker ?? (await loadWorkspaceMarker(root));
  const lock = await readJsonFile<unknown>(paths.runtimeLock, "Research runtime lock");
  if (!isRuntimeLock(lock) || lock.workspaceId !== marker.workspaceId) {
    throw new CliError("Research runtime lock does not match the current workspace.", {
      code: "RESEARCH_RUNTIME_LOCK_INVALID",
      exitCode: 3,
    });
  }
  if (lock.protocolVersion !== RESEARCH_PROTOCOL_VERSION) {
    throw new CliError(`Unsupported research protocol version: ${lock.protocolVersion}.`, {
      code: "RESEARCH_RUNTIME_LOCK_INVALID",
      exitCode: 3,
    });
  }
  const currentVersion = packageVersion();
  if (lock.packageVersion !== currentVersion) {
    throw new CliError(
      `Research runtime lock requires ${lock.packageName}@${lock.packageVersion}; active CLI is ${currentVersion}.`,
      { code: "RESEARCH_RUNTIME_VERSION_MISMATCH", exitCode: 3 },
    );
  }
  return lock;
}

async function inspectCredentialEnvironment(
  path: string,
  declaredIds: Set<string>,
): Promise<string> {
  if (!(await pathExists(path))) return "not configured; no credentials loaded";
  const info = await stat(path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("credential environment must have owner-only permissions");
  }
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  let found = false;
  for (const sourceLine of lines) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) throw new Error("credential environment contains a malformed line");
    const key = line.slice(0, equals).trim();
    if (key !== "TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON" || found) {
      throw new Error(`credential environment contains an unsupported key: ${key}`);
    }
    const raw = line.slice(equals + 1).trim();
    const value = JSON.parse(raw || "{}") as unknown;
    if (
      !isObject(value) ||
      Object.entries(value).some(
        ([credentialId, credentialValue]) =>
          !isLogicalCredentialId(credentialId) ||
          !declaredIds.has(credentialId) ||
          typeof credentialValue !== "string" ||
          Buffer.byteLength(credentialValue, "utf8") < 8,
      )
    ) {
      throw new Error("credential map must contain logical IDs and non-trivial string values");
    }
    found = true;
  }
  return found ? "configured with owner-only permissions" : "configured without credentials";
}

async function readProjectStates(projectsPath: string): Promise<ProjectState[]> {
  const entries = await readdir(projectsPath, { withFileTypes: true });
  const states: ProjectState[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const state = await readJsonFile<unknown>(
      join(projectsPath, entry.name, "project.json"),
      `Project ${entry.name}`,
    );
    if (!isProjectStateShape(state) || state.id !== entry.name) {
      throw new Error(`project ${entry.name} has an unsupported state shape`);
    }
    states.push(state);
  }
  return states;
}

function isWorkspaceConfig(value: unknown): value is WorkspaceConfig {
  if (!isObject(value) || value.schemaVersion !== 1) return false;
  if (value.mode !== "smoke-test" && value.mode !== "production-research") return false;
  if (!isAgentRoute(value.producer) || !isAgentRoute(value.reviewer)) return false;
  const budget = value.budget;
  return (
    isObject(budget) &&
    positiveInteger(budget.maxTokens) &&
    positiveNumber(budget.maxCostUsd) &&
    positiveInteger(budget.maxWallSeconds) &&
    positiveInteger(budget.maxFilesPerPackage) &&
    positiveInteger(budget.maxBytesPerPackage) &&
    positiveInteger(budget.maxAttemptsPerPackage) &&
    positiveNumber(budget.confirmationCostUsd) &&
    isObject(budget.packageMaxTokens) &&
    positiveInteger(budget.packageMaxTokens.discover) &&
    positiveInteger(budget.packageMaxTokens.analyze) &&
    positiveInteger(budget.packageMaxTokens.synthesize) &&
    positiveInteger(budget.packageMaxTokens.review) &&
    isObject(budget.packageMaxWallSeconds) &&
    positiveInteger(budget.packageMaxWallSeconds.discover) &&
    positiveInteger(budget.packageMaxWallSeconds.analyze) &&
    positiveInteger(budget.packageMaxWallSeconds.synthesize) &&
    positiveInteger(budget.packageMaxWallSeconds.review) &&
    positiveInteger(budget.maxOutputTokens) &&
    positiveInteger(budget.maxRepairTokens) &&
    budget.maxRepairTokens <= budget.maxOutputTokens &&
    positiveInteger(budget.maxBrokerResponseBytes) &&
    positiveInteger(budget.maxBrokerContextTokens) &&
    budget.maxBrokerContextTokens >= 16 &&
    positiveInteger(budget.maxBrokerItems) &&
    positiveInteger(budget.maxInputContextTokens)
  );
}

function isAgentRoute(value: unknown): value is AgentRoute {
  if (
    !(
      isObject(value) &&
      (value.agent === "codex" || value.agent === "claude") &&
      typeof value.binary === "string" &&
      value.binary.length > 0 &&
      (value.wrapperTargetBinary === undefined ||
        (typeof value.wrapperTargetBinary === "string" &&
          isAbsolute(value.wrapperTargetBinary) &&
          isAbsolute(value.binary) &&
          value.wrapperTargetBinary !== value.binary)) &&
      (value.model === null || (typeof value.model === "string" && value.model.length > 0)) &&
      (value.pricing === undefined || isAgentPricing(value.pricing))
    )
  ) {
    return false;
  }
  const effort = value.effort;
  if (
    effort !== undefined &&
    !(
      (value.agent === "codex" &&
        ["minimal", "low", "medium", "high", "xhigh"].includes(String(effort))) ||
      (value.agent === "claude" &&
        ["low", "medium", "high", "xhigh", "max"].includes(String(effort)))
    )
  ) {
    return false;
  }
  if (
    value.verbosity !== undefined &&
    (value.agent !== "codex" || !["low", "medium", "high"].includes(String(value.verbosity)))
  ) {
    return false;
  }
  return true;
}

function isAgentPricing(value: unknown): boolean {
  return (
    isObject(value) &&
    nonNegativeNumber(value.inputUsdPerMillionTokens) &&
    nonNegativeNumber(value.cachedInputUsdPerMillionTokens) &&
    nonNegativeNumber(value.outputUsdPerMillionTokens)
  );
}

function isRuntimeLock(value: unknown): value is RuntimeLock {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    value.protocolVersion === 1 &&
    value.packageName === RESEARCH_PACKAGE_NAME &&
    typeof value.packageVersion === "string" &&
    typeof value.workspaceId === "string"
  );
}

function isProjectStateShape(value: unknown): value is ProjectState {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    typeof value.question === "string" &&
    (value.budgetConfirmedAt === null || typeof value.budgetConfirmedAt === "string") &&
    ["ready", "running", "blocked", "complete"].includes(String(value.status)) &&
    Array.isArray(value.inputs) &&
    isObject(value.evidenceRequirements) &&
    Array.isArray(value.packages) &&
    isObject(value.usage) &&
    typeof value.usage.inputTokens === "number" &&
    typeof value.usage.cachedInputTokens === "number" &&
    typeof value.usage.outputTokens === "number"
  );
}

async function checked<T>(
  checks: DoctorCheck[],
  id: string,
  callback: () => Promise<{ value: T; detail: string }>,
): Promise<T | undefined> {
  try {
    const result = await callback();
    checks.push({ id, status: "pass", detail: result.detail });
    return result.value;
  } catch (error) {
    checks.push({
      id,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function normalizeWorkspaceName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f]/.test(normalized)) {
    throw new CliError("Workspace name must contain 1-100 printable characters.", {
      code: "RESEARCH_WORKSPACE_NAME_INVALID",
      exitCode: 2,
    });
  }
  return normalized;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isLogicalCredentialId(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value);
}
