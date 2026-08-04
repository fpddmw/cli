import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import { RESEARCH_CONTROL_DIRECTORY } from "./constants.js";
import { appendJournalEvent } from "./journal.js";
import {
  ensureDirectory,
  fileSize,
  readJsonFile,
  sha256File,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type { ProjectInput, ProjectState, WorkPackage, WorkspaceConfig } from "./types.js";
import { loadWorkspaceConfig, withWorkspaceLock } from "./workspace.js";

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export async function initializeProject(
  root: string,
  projectId: string,
  question: string,
): Promise<ProjectState> {
  validateProjectId(projectId);
  const normalizedQuestion = question.trim();
  if (normalizedQuestion.length < 8 || normalizedQuestion.length > 4000) {
    throw new CliError("Research question must contain 8-4000 characters.", {
      code: "RESEARCH_QUESTION_INVALID",
      exitCode: 2,
    });
  }
  return withWorkspaceLock(root, "project.init", async () => {
    const paths = workspacePaths(root);
    const projectRoot = join(paths.projects, projectId);
    const projectPath = join(projectRoot, "project.json");
    const existing = await lstat(projectRoot).catch(() => undefined);
    if (existing) {
      throw new CliError(`Research project already exists: ${projectId}`, {
        code: "RESEARCH_PROJECT_EXISTS",
        exitCode: 2,
      });
    }
    const config = await loadWorkspaceConfig(root);
    const now = new Date().toISOString();
    const project: ProjectState = {
      schemaVersion: 1,
      id: projectId,
      question: normalizedQuestion,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      inputs: [],
      packages: defaultWorkPackages(config),
      usage: { tokens: 0, costUsd: 0, wallSeconds: 0 },
    };
    await Promise.all([
      ensureDirectory(projectRoot),
      ensureDirectory(join(projectRoot, "outputs")),
      ensureDirectory(join(projectRoot, "runs")),
    ]);
    await writeJsonAtomic(projectPath, project);
    await appendJournalEvent(paths.journal, "project.initialized", projectId, {
      projectId,
      questionSha256: await hashQuestion(normalizedQuestion),
    });
    return project;
  });
}

export async function addProjectInput(
  root: string,
  projectId: string,
  inputPath: string,
  role: ProjectInput["role"],
): Promise<ProjectInput> {
  validateProjectId(projectId);
  const canonicalInput = resolve(inputPath);
  if (canonicalInput !== inputPath) {
    throw new CliError(`Input path must be absolute: ${inputPath}`, {
      code: "RESEARCH_INPUT_INVALID",
      exitCode: 2,
    });
  }
  if (canonicalInput.split(sep).includes(RESEARCH_CONTROL_DIRECTORY)) {
    throw new CliError("Research inputs cannot come from a research control directory.", {
      code: "RESEARCH_INPUT_INVALID",
      exitCode: 2,
    });
  }
  const info = await lstat(canonicalInput).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new CliError(`Research input must be a regular file: ${inputPath}`, {
      code: "RESEARCH_INPUT_INVALID",
      exitCode: 2,
    });
  }
  return withWorkspaceLock(root, "project.input.add", async () => {
    const project = await loadProject(root, projectId);
    const sha256 = await sha256File(canonicalInput);
    const existing = project.inputs.find((input) => input.sha256 === sha256 && input.role === role);
    if (existing) return existing;
    const input: ProjectInput = {
      id: `${slug(basename(canonicalInput))}-${sha256.slice(0, 12)}`,
      role,
      path: canonicalInput,
      sha256,
      bytes: await fileSize(canonicalInput),
      addedAt: new Date().toISOString(),
    };
    project.inputs.push(input);
    project.inputs.sort((left, right) => left.id.localeCompare(right.id));
    project.updatedAt = new Date().toISOString();
    await saveProject(root, project);
    await appendJournalEvent(workspacePaths(root).journal, "project.input.added", projectId, {
      projectId,
      inputId: input.id,
      role,
      sha256,
      bytes: input.bytes,
    });
    return input;
  });
}

export async function loadProject(root: string, projectId: string): Promise<ProjectState> {
  validateProjectId(projectId);
  const project = await readJsonFile<ProjectState>(
    join(workspacePaths(root).projects, projectId, "project.json"),
    `Research project ${projectId}`,
  );
  validateProjectShape(project, projectId);
  return project;
}

export async function listProjects(root: string): Promise<ProjectState[]> {
  const entries = await readdir(workspacePaths(root).projects, { withFileTypes: true });
  const projects: ProjectState[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    projects.push(await loadProject(root, entry.name));
  }
  return projects;
}

export async function saveProject(root: string, project: ProjectState): Promise<void> {
  validateProjectShape(project, project.id);
  await writeJsonAtomic(join(workspacePaths(root).projects, project.id, "project.json"), project);
}

export function refreshProject(project: ProjectState): ProjectState {
  for (const workPackage of project.packages) {
    if (workPackage.status !== "pending" && workPackage.status !== "retry") continue;
    const dependenciesComplete = workPackage.dependencies.every(
      (dependency) =>
        project.packages.find((candidate) => candidate.id === dependency)?.status === "complete",
    );
    if (dependenciesComplete) workPackage.status = "ready";
  }
  if (project.packages.some((item) => item.status === "failed")) project.status = "blocked";
  else if (project.packages.every((item) => item.status === "complete"))
    project.status = "complete";
  else if (project.packages.some((item) => item.status === "running")) project.status = "running";
  else project.status = "ready";
  project.updatedAt = new Date().toISOString();
  return project;
}

export function nextReadyPackage(project: ProjectState): WorkPackage | undefined {
  refreshProject(project);
  return project.packages.find((workPackage) => workPackage.status === "ready");
}

export function packageById(project: ProjectState, packageId: string): WorkPackage {
  const workPackage = project.packages.find((candidate) => candidate.id === packageId);
  if (!workPackage) {
    throw new CliError(`Unknown work package ${packageId} in project ${project.id}.`, {
      code: "RESEARCH_PACKAGE_INVALID",
      exitCode: 2,
    });
  }
  return workPackage;
}

function defaultWorkPackages(config: WorkspaceConfig): WorkPackage[] {
  const maxAttempts = config.budget.maxAttemptsPerPackage;
  return [
    workPackage(
      "discover",
      "discover",
      "agent",
      "producer",
      [],
      ["outputs/evidence.json"],
      maxAttempts,
    ),
    workPackage(
      "analyze",
      "analyze",
      "agent",
      "producer",
      ["discover"],
      ["outputs/analysis.json"],
      maxAttempts,
    ),
    workPackage(
      "synthesize",
      "synthesize",
      "agent",
      "producer",
      ["analyze"],
      ["outputs/report.md"],
      maxAttempts,
    ),
    workPackage(
      "review",
      "review",
      "agent",
      "reviewer",
      ["synthesize"],
      ["outputs/review.json"],
      maxAttempts,
    ),
    workPackage("close", "close", "verify", "mechanical", ["review"], ["outputs/closure.json"], 1),
  ];
}

function workPackage(
  id: string,
  stage: WorkPackage["stage"],
  kind: WorkPackage["kind"],
  executor: WorkPackage["executor"],
  dependencies: string[],
  expectedOutputs: string[],
  maxAttempts: number,
): WorkPackage {
  return {
    id,
    stage,
    kind,
    executor,
    dependencies,
    expectedOutputs,
    status: dependencies.length ? "pending" : "ready",
    attempts: 0,
    maxAttempts,
    lastError: null,
    startedAt: null,
    completedAt: null,
  };
}

function validateProjectShape(project: ProjectState, expectedId: string): void {
  if (
    project.schemaVersion !== 1 ||
    project.id !== expectedId ||
    !PROJECT_ID_PATTERN.test(project.id) ||
    typeof project.question !== "string" ||
    !Array.isArray(project.inputs) ||
    !Array.isArray(project.packages) ||
    !project.usage ||
    typeof project.usage.tokens !== "number" ||
    typeof project.usage.costUsd !== "number" ||
    typeof project.usage.wallSeconds !== "number"
  ) {
    throw new CliError(`Research project state is invalid: ${expectedId}`, {
      code: "RESEARCH_PROJECT_INVALID",
      exitCode: 2,
    });
  }
  const packageIds = new Set(project.packages.map((item) => item.id));
  if (
    packageIds.size !== project.packages.length ||
    project.packages.some(
      (item) =>
        !["agent", "verify"].includes(item.kind) ||
        !["producer", "reviewer", "mechanical"].includes(item.executor) ||
        item.dependencies.some((dependency) => !packageIds.has(dependency)) ||
        item.expectedOutputs.some((path) => !path.startsWith("outputs/")),
    )
  ) {
    throw new CliError(`Research project work packages are invalid: ${expectedId}`, {
      code: "RESEARCH_PROJECT_INVALID",
      exitCode: 2,
    });
  }
}

function validateProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new CliError(
      "Project ID must contain 3-64 lowercase letters, digits, or hyphens and start with a letter or digit.",
      { code: "RESEARCH_PROJECT_ID_INVALID", exitCode: 2 },
    );
  }
}

function slug(value: string): string {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return result || randomUUID().slice(0, 8);
}

async function hashQuestion(question: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(question, "utf8").digest("hex");
}
