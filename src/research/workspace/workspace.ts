import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { CliError } from "../../errors.js";
import { declaredCredentialIds, verifyCapabilities } from "./capabilities.js";
import { packageVersion, RESEARCH_PACKAGE_NAME, RESEARCH_PROTOCOL_VERSION } from "./constants.js";
import { inspectResearchContext, isWorkspaceMarker } from "./context.js";
import { appendJournalEvent, verifyJournal } from "./journal.js";
import {
  acquireFileLock,
  ensureDirectory,
  isObject,
  pathExists,
  readJsonFile,
  requireAbsolutePath,
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
} from "./types.js";

const DEFAULT_BUDGET = {
  maxTokens: 250_000,
  maxCostUsd: 60,
  maxWallSeconds: 72 * 60 * 60,
  maxFilesPerPackage: 20,
  maxBytesPerPackage: 20 * 1024 * 1024,
  maxAttemptsPerPackage: 3,
} as const;

export async function initializeResearchWorkspace(
  targetPath: string,
  name: string | undefined,
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
    producer: { agent: "codex", binary: "codex", model: null },
    reviewer: { agent: "claude", binary: "claude", model: null },
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

export async function doctorResearchWorkspace(inputPath: string): Promise<WorkspaceDoctorResult> {
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

  return {
    workspace,
    status: checks.some((check) => check.status === "fail") ? "blocked" : "ready",
    checks,
  };
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
  if (!isAgentRoute(value.producer) || !isAgentRoute(value.reviewer)) return false;
  const budget = value.budget;
  return (
    isObject(budget) &&
    positiveInteger(budget.maxTokens) &&
    positiveNumber(budget.maxCostUsd) &&
    positiveInteger(budget.maxWallSeconds) &&
    positiveInteger(budget.maxFilesPerPackage) &&
    positiveInteger(budget.maxBytesPerPackage) &&
    positiveInteger(budget.maxAttemptsPerPackage)
  );
}

function isAgentRoute(value: unknown): value is AgentRoute {
  return (
    isObject(value) &&
    (value.agent === "codex" || value.agent === "claude") &&
    typeof value.binary === "string" &&
    value.binary.length > 0 &&
    (value.model === null || (typeof value.model === "string" && value.model.length > 0))
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
    ["ready", "running", "blocked", "complete"].includes(String(value.status)) &&
    Array.isArray(value.inputs) &&
    Array.isArray(value.packages) &&
    isObject(value.usage)
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

function isLogicalCredentialId(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value);
}
