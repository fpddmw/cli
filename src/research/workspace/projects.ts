import { randomUUID } from "node:crypto";
import { cp, lstat, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import { RESEARCH_CONTROL_DIRECTORY } from "./constants.js";
import { appendJournalEvent } from "./journal.js";
import { cloneProjectEvidenceReceipts } from "./evidence.js";
import { projectInputsFromPlan, reverifyProjectInputPlan } from "./input-plan.js";
import { evaluateProjectPreflight } from "./preflight.js";
import {
  ensureDirectory,
  fileRecord,
  fileSize,
  readJsonFile,
  sha256File,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type {
  ProjectEvidenceRequirements,
  ProjectInput,
  ProjectState,
  WorkPackage,
  WorkspaceConfig,
  VerifiedProjectInputPlan,
} from "./types.js";
import { loadWorkspaceConfig, withWorkspaceLock } from "./workspace.js";

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export async function initializeProject(
  root: string,
  projectId: string,
  question: string,
  evidenceRequirements?: ProjectEvidenceRequirements,
  budgetConfirmed = false,
  inputPlan?: VerifiedProjectInputPlan,
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
    if (config.mode === "production-research" && !evidenceRequirements) {
      throw new CliError("Production research requires explicit evidence requirements.", {
        code: "RESEARCH_EVIDENCE_REQUIREMENTS_REQUIRED",
        exitCode: 2,
      });
    }
    if (
      config.mode === "production-research" &&
      config.budget.maxCostUsd > config.budget.confirmationCostUsd &&
      !budgetConfirmed
    ) {
      throw new CliError(
        `Production budget requires explicit confirmation above $${config.budget.confirmationCostUsd}.`,
        {
          code: "RESEARCH_BUDGET_CONFIRMATION_REQUIRED",
          exitCode: 2,
          details: {
            maxCostUsd: config.budget.maxCostUsd,
            confirmationCostUsd: config.budget.confirmationCostUsd,
          },
        },
      );
    }
    const requirements = normalizeEvidenceRequirements(
      evidenceRequirements ?? defaultEvidenceRequirements(config),
    );
    const admittedInputPlan = inputPlan ? await reverifyProjectInputPlan(inputPlan) : undefined;
    if (config.mode === "production-research") {
      const preflight = await evaluateProjectPreflight(
        root,
        normalizedQuestion,
        requirements,
        admittedInputPlan ?? null,
      );
      if (!preflight.readyToInitialize) {
        throw new CliError("Production project initialization was blocked by preflight.", {
          code: "RESEARCH_PREFLIGHT_BLOCKED",
          exitCode: 3,
          details: { gaps: preflight.gaps, preflightSha256: preflight.preflightSha256 },
        });
      }
    }
    const now = new Date().toISOString();
    const project: ProjectState = {
      schemaVersion: 1,
      id: projectId,
      question: normalizedQuestion,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      budgetConfirmedAt: budgetConfirmed ? now : null,
      inputs: admittedInputPlan ? projectInputsFromPlan(admittedInputPlan, now) : [],
      evidenceRequirements: requirements,
      packages: defaultWorkPackages(config),
      usage: {
        tokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallSeconds: 0,
      },
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
      inputPlanSha256: admittedInputPlan?.sha256 ?? null,
      inputs: project.inputs.map((input) => ({
        id: input.id,
        role: input.role,
        sha256: input.sha256,
        bytes: input.bytes,
      })),
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

export async function retryProjectPackage(
  root: string,
  projectId: string,
  packageId?: string,
): Promise<ProjectState> {
  validateProjectId(projectId);
  return withWorkspaceLock(root, "project.retry", async () => {
    const project = await loadProject(root, projectId);
    const selected = packageId
      ? packageById(project, packageId)
      : project.packages.find((item) => item.status === "failed" || item.status === "retry");
    if (!selected || (selected.status !== "failed" && selected.status !== "retry")) {
      throw new CliError("Project retry requires a failed or retryable package.", {
        code: "RESEARCH_RETRY_NOT_AVAILABLE",
        exitCode: 2,
      });
    }
    const selectedIndex = project.packages.indexOf(selected);
    const previous = {
      status: selected.status,
      attempts: selected.attempts,
      failureKind: selected.lastFailureKind,
    };
    for (const [index, workPackage] of project.packages.entries()) {
      if (index < selectedIndex) continue;
      workPackage.status = index === selectedIndex ? "ready" : "pending";
      workPackage.maxAttempts = Math.max(workPackage.maxAttempts, workPackage.attempts + 1);
      workPackage.startedAt = null;
      workPackage.completedAt = null;
      workPackage.lastError = null;
      workPackage.lastFailureKind = null;
      workPackage.retryNotBefore = null;
    }
    project.status = "ready";
    project.updatedAt = new Date().toISOString();
    await saveProject(root, project);
    await appendJournalEvent(workspacePaths(root).journal, "project.retry.requested", projectId, {
      projectId,
      packageId: selected.id,
      previous,
      preservedOutputs: true,
    });
    return project;
  });
}

export async function forkProject(
  root: string,
  sourceProjectId: string,
  targetProjectId: string,
  resumeThrough?: "discover" | "analyze" | "synthesize",
): Promise<ProjectState> {
  validateProjectId(sourceProjectId);
  validateProjectId(targetProjectId);
  if (sourceProjectId === targetProjectId) {
    throw new CliError("Fork target must use a different project ID.", {
      code: "RESEARCH_PROJECT_FORK_INVALID",
      exitCode: 2,
    });
  }
  return withWorkspaceLock(root, "project.fork", async () => {
    const source = await loadProject(root, sourceProjectId);
    const targetRoot = join(workspacePaths(root).projects, targetProjectId);
    if (await lstat(targetRoot).catch(() => undefined)) {
      throw new CliError(`Research project already exists: ${targetProjectId}`, {
        code: "RESEARCH_PROJECT_EXISTS",
        exitCode: 2,
      });
    }
    const config = await loadWorkspaceConfig(root);
    const packages = defaultWorkPackages(config);
    const inheritedStages = resumeThrough
      ? ["discover", "analyze", "synthesize"].slice(
          0,
          ["discover", "analyze", "synthesize"].indexOf(resumeThrough) + 1,
        )
      : [];
    for (const stage of inheritedStages) {
      const sourcePackage = source.packages.find((item) => item.stage === stage);
      if (sourcePackage?.status !== "complete") {
        throw new CliError(`Cannot fork through incomplete package: ${stage}.`, {
          code: "RESEARCH_PROJECT_FORK_INVALID",
          exitCode: 2,
        });
      }
    }
    const now = new Date().toISOString();
    for (const workPackage of packages) {
      if (inheritedStages.includes(workPackage.stage)) {
        workPackage.status = "complete";
        workPackage.completedAt = now;
      }
    }
    const project: ProjectState = {
      schemaVersion: 1,
      id: targetProjectId,
      question: source.question,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      budgetConfirmedAt: source.budgetConfirmedAt,
      inputs: source.inputs.map((input) => ({ ...input })),
      evidenceRequirements: {
        ...source.evidenceRequirements,
        dimensions: [...source.evidenceRequirements.dimensions],
        sourceTypes: [...source.evidenceRequirements.sourceTypes],
      },
      packages,
      usage: {
        tokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallSeconds: 0,
      },
    };
    await Promise.all([
      ensureDirectory(targetRoot),
      ensureDirectory(join(targetRoot, "outputs")),
      ensureDirectory(join(targetRoot, "runs")),
    ]);
    const inheritedOutputs: Array<{ path: string; sha256: string; bytes: number }> = [];
    const stageOutput: Record<string, string> = {
      discover: "outputs/evidence.json",
      analyze: "outputs/analysis.json",
      synthesize: "outputs/report.md",
    };
    for (const stage of inheritedStages) {
      const logicalPath = stageOutput[stage]!;
      const sourcePath = join(workspacePaths(root).projects, sourceProjectId, logicalPath);
      const record = await fileRecord(sourcePath, logicalPath);
      const destination = join(targetRoot, logicalPath);
      await ensureDirectory(dirname(destination));
      await cp(sourcePath, destination, { errorOnExist: true, force: false });
      inheritedOutputs.push(record);
    }
    if (inheritedStages.includes("discover")) {
      await cloneProjectEvidenceReceipts(root, sourceProjectId, targetProjectId);
    }
    refreshProject(project);
    await writeJsonAtomic(join(targetRoot, "project.json"), project);
    await appendJournalEvent(workspacePaths(root).journal, "project.forked", targetProjectId, {
      sourceProjectId,
      targetProjectId,
      resumeThrough: resumeThrough ?? null,
      inheritedOutputs,
      inheritedUsage: false,
    });
    return project;
  });
}

export function refreshProject(project: ProjectState): ProjectState {
  const now = Date.now();
  for (const workPackage of project.packages) {
    if (workPackage.status !== "pending" && workPackage.status !== "retry") continue;
    if (
      workPackage.status === "retry" &&
      workPackage.retryNotBefore &&
      Date.parse(workPackage.retryNotBefore) > now
    ) {
      continue;
    }
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
    lastFailureKind: null,
    retryNotBefore: null,
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
    (project.budgetConfirmedAt !== null && typeof project.budgetConfirmedAt !== "string") ||
    !Array.isArray(project.inputs) ||
    !isEvidenceRequirements(project.evidenceRequirements) ||
    !Array.isArray(project.packages) ||
    !project.usage ||
    typeof project.usage.tokens !== "number" ||
    typeof project.usage.inputTokens !== "number" ||
    typeof project.usage.cachedInputTokens !== "number" ||
    typeof project.usage.outputTokens !== "number" ||
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

function defaultEvidenceRequirements(config: WorkspaceConfig): ProjectEvidenceRequirements {
  return config.mode === "production-research"
    ? {
        dimensions: ["research-question"],
        sourceTypes: ["primary"],
        minSources: 3,
        minFullTextSources: 1,
        minDatedSources: 1,
        publicationDateFrom: null,
        publicationDateTo: null,
      }
    : {
        dimensions: ["research-question"],
        sourceTypes: [],
        minSources: 1,
        minFullTextSources: 0,
        minDatedSources: 0,
        publicationDateFrom: null,
        publicationDateTo: null,
      };
}

export function normalizeEvidenceRequirements(
  value: ProjectEvidenceRequirements,
): ProjectEvidenceRequirements {
  const normalized = {
    dimensions: [...new Set(value.dimensions.map(normalizeRequirementId))].sort(),
    sourceTypes: [...new Set(value.sourceTypes.map(normalizeRequirementId))].sort(),
    minSources: value.minSources,
    minFullTextSources: value.minFullTextSources,
    minDatedSources: value.minDatedSources,
    publicationDateFrom: value.publicationDateFrom,
    publicationDateTo: value.publicationDateTo,
  };
  if (!isEvidenceRequirements(normalized)) {
    throw new CliError("Evidence requirements are invalid.", {
      code: "RESEARCH_EVIDENCE_REQUIREMENTS_INVALID",
      exitCode: 2,
    });
  }
  return normalized;
}

function isEvidenceRequirements(value: unknown): value is ProjectEvidenceRequirements {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as ProjectEvidenceRequirements).dimensions) &&
    (value as ProjectEvidenceRequirements).dimensions.length > 0 &&
    (value as ProjectEvidenceRequirements).dimensions.every(validRequirementId) &&
    Array.isArray((value as ProjectEvidenceRequirements).sourceTypes) &&
    (value as ProjectEvidenceRequirements).sourceTypes.every(validRequirementId) &&
    Number.isInteger((value as ProjectEvidenceRequirements).minSources) &&
    (value as ProjectEvidenceRequirements).minSources > 0 &&
    Number.isInteger((value as ProjectEvidenceRequirements).minFullTextSources) &&
    (value as ProjectEvidenceRequirements).minFullTextSources >= 0 &&
    (value as ProjectEvidenceRequirements).minFullTextSources <=
      (value as ProjectEvidenceRequirements).minSources &&
    Number.isInteger((value as ProjectEvidenceRequirements).minDatedSources) &&
    (value as ProjectEvidenceRequirements).minDatedSources >= 0 &&
    (value as ProjectEvidenceRequirements).minDatedSources <=
      (value as ProjectEvidenceRequirements).minSources &&
    validDateBoundary((value as ProjectEvidenceRequirements).publicationDateFrom) &&
    validDateBoundary((value as ProjectEvidenceRequirements).publicationDateTo) &&
    dateRangeOrdered(
      (value as ProjectEvidenceRequirements).publicationDateFrom,
      (value as ProjectEvidenceRequirements).publicationDateTo,
    )
  );
}

function validDateBoundary(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function dateRangeOrdered(from: string | null, to: string | null): boolean {
  return from === null || to === null || from <= to;
}

function normalizeRequirementId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-");
}

function validRequirementId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value);
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
