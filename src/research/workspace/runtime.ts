import { cp, lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

import { CliError } from "../../errors.js";
import { stageLockedCapabilities, verifyCapabilities } from "./capabilities.js";
import { startCapabilityBroker, type CapabilityBroker } from "./broker.js";
import { executeAgent, type AgentExecutionRequest } from "./executor.js";
import { appendJournalEvent, readJournal, verifyJournal } from "./journal.js";
import {
  listProjects,
  loadProject,
  nextReadyPackage,
  packageById,
  refreshProject,
  saveProject,
} from "./projects.js";
import {
  ensureDirectory,
  canonicalJson,
  fileRecord,
  isObject,
  pathExists,
  regularTreeFiles,
  resolveContained,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "./storage.js";
import type {
  AgentRoute,
  ExecutionResult,
  OutputRecord,
  ProjectState,
  RunRecord,
  WorkPackage,
  WorkspaceConfig,
} from "./types.js";
import { loadWorkspaceConfig, withWorkspaceLock } from "./workspace.js";

export interface RunOptions {
  maxParallel: number;
  maxCycles: number;
  dryRun: boolean;
  environment: NodeJS.ProcessEnv;
}

export type PackageExecutor = (request: AgentExecutionRequest) => Promise<ExecutionResult>;

export interface WorkspaceRunResult {
  workspace: string;
  status: "complete" | "blocked" | "ready" | "dry-run";
  stopReason:
    | "dry-run"
    | "all-projects-complete"
    | "project-blocked"
    | "cycle-limit"
    | "no-ready-work"
    | "no-projects";
  cycles: number;
  executed: Array<{ projectId: string; packageId: string; status: string }>;
  projects: Array<{
    id: string;
    status: ProjectState["status"];
    readyPackage: string | null;
    usage: ProjectState["usage"];
  }>;
}

export async function runResearchWorkspace(
  root: string,
  options: RunOptions,
  packageExecutor: PackageExecutor = executeAgent,
): Promise<WorkspaceRunResult> {
  validateRunOptions(options);
  if (options.dryRun) return dryRunResult(root);
  return withWorkspaceLock(root, "research.run", async () => {
    const config = await loadWorkspaceConfig(root);
    if (config.producer.agent === config.reviewer.agent) {
      throw new CliError("Research producer and reviewer must use different agent families.", {
        code: "RESEARCH_REVIEW_ROUTE_INVALID",
        exitCode: 3,
      });
    }
    const capabilities = await verifyCapabilities(root);
    if (capabilities.status !== "verified") {
      throw new CliError("Research capabilities are not locked and verified.", {
        code: "RESEARCH_CAPABILITY_DRIFT",
        exitCode: 3,
        details: capabilities,
      });
    }
    const executed: WorkspaceRunResult["executed"] = [];
    let cycles = 0;

    while (cycles < options.maxCycles) {
      const projects = await listProjects(root);
      const selected = projects
        .map((project) => ({ project, workPackage: nextReadyPackage(project) }))
        .filter(
          (item): item is { project: ProjectState; workPackage: WorkPackage } =>
            Boolean(item.workPackage) &&
            item.project.status !== "blocked" &&
            item.project.status !== "complete",
        )
        .slice(0, options.maxParallel);
      if (!selected.length) break;
      cycles += 1;
      const results = await Promise.all(
        selected.map(({ project, workPackage }) =>
          executeWorkPackage(
            root,
            project.id,
            workPackage.id,
            config,
            options.environment,
            packageExecutor,
          ),
        ),
      );
      executed.push(...results);
    }

    return summarizeRun(root, cycles, executed, options.maxCycles);
  });
}

async function executeWorkPackage(
  root: string,
  projectId: string,
  packageId: string,
  config: WorkspaceConfig,
  environment: NodeJS.ProcessEnv,
  packageExecutor: PackageExecutor,
): Promise<{ projectId: string; packageId: string; status: string }> {
  const project = await loadProject(root, projectId);
  const workPackage = packageById(project, packageId);
  const now = new Date().toISOString();
  workPackage.status = "running";
  workPackage.attempts += 1;
  workPackage.startedAt = now;
  workPackage.lastError = null;
  project.status = "running";
  project.updatedAt = now;
  await saveProject(root, project);
  await appendJournalEvent(workspacePaths(root).journal, "package.started", projectId, {
    projectId,
    packageId,
    attempt: workPackage.attempts,
  });

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  let capsuleRoot: string | undefined;
  let broker: CapabilityBroker | undefined;
  let accountedResult: ExecutionResult | undefined;
  try {
    if (workPackage.kind !== "verify") assertBudget(project, config);
    let result: ExecutionResult;
    let outputs: OutputRecord[];
    let executor: AgentRoute["agent"] | "mechanical";
    if (workPackage.kind === "verify") {
      result = await closeProjectMechanically(root, project, workPackage);
      accountedResult = result;
      outputs = await outputRecords(root, project, workPackage.expectedOutputs);
      executor = "mechanical";
    } else {
      const capsule = await createCapsule(root, project, workPackage, runId);
      capsuleRoot = capsule.capsuleRoot;
      const route = workPackage.executor === "reviewer" ? config.reviewer : config.producer;
      executor = route.agent;
      broker = await startCapabilityBroker(root, project.id, capsule.projectRoot);
      result = await packageExecutor({
        route,
        prompt: packagePrompt(
          project,
          workPackage,
          capsule.inputManifest,
          capsule.stagedSkills,
          capsule.reviewPacketSha256,
        ),
        capsuleRoot: capsule.capsuleRoot,
        projectRoot: capsule.projectRoot,
        workspaceRoot: root,
        timeoutSeconds: remainingWallSeconds(project, config),
        environment,
        brokerUrl: broker?.url ?? null,
      });
      accountedResult = result;
      if (result.exitCode !== 0) {
        throw new Error(`executor exited ${result.exitCode}: ${bounded(result.stderr, 1000)}`);
      }
      assertProjectedBudget(project, config, result);
      outputs = await validateAndImportOutputs(
        root,
        project,
        workPackage,
        capsule.projectRoot,
        config,
        capsule.reviewPacketSha256,
      );
    }

    const completedAt = new Date().toISOString();
    project.usage.tokens += result.tokens;
    project.usage.costUsd = roundMoney(project.usage.costUsd + result.costUsd);
    project.usage.wallSeconds += result.wallSeconds;
    workPackage.status = "complete";
    workPackage.completedAt = completedAt;
    workPackage.lastError = null;
    refreshProject(project);
    await saveProject(root, project);
    const record: RunRecord = {
      schemaVersion: 1,
      runId,
      projectId,
      packageId,
      executor,
      startedAt,
      completedAt,
      exitCode: result.exitCode,
      tokens: result.tokens,
      costUsd: result.costUsd,
      wallSeconds: result.wallSeconds,
      outputs,
      stdoutSha256: sha256Text(result.stdout),
      stderrSha256: sha256Text(result.stderr),
    };
    await writeJsonAtomic(join(projectRoot(root, projectId), "runs", `${runId}.json`), record);
    await appendJournalEvent(workspacePaths(root).journal, "package.completed", projectId, {
      projectId,
      packageId,
      runId,
      executor,
      outputs,
      usage: { tokens: result.tokens, costUsd: result.costUsd, wallSeconds: result.wallSeconds },
    });
    return { projectId, packageId, status: "complete" };
  } catch (error) {
    const failedProject = await loadProject(root, projectId);
    const failedPackage = packageById(failedProject, packageId);
    const message = bounded(error instanceof Error ? error.message : String(error), 2000);
    if (accountedResult) {
      failedProject.usage.tokens += accountedResult.tokens;
      failedProject.usage.costUsd = roundMoney(
        failedProject.usage.costUsd + accountedResult.costUsd,
      );
      failedProject.usage.wallSeconds += accountedResult.wallSeconds;
    }
    failedPackage.lastError = message;
    failedPackage.completedAt = new Date().toISOString();
    const nonRetryable = error instanceof CliError && error.code === "RESEARCH_BUDGET_EXHAUSTED";
    failedPackage.status =
      !nonRetryable && failedPackage.attempts < failedPackage.maxAttempts ? "retry" : "failed";
    refreshProject(failedProject);
    await saveProject(root, failedProject);
    await appendJournalEvent(workspacePaths(root).journal, "package.failed", projectId, {
      projectId,
      packageId,
      runId,
      attempt: failedPackage.attempts,
      retryable: failedPackage.status === "retry",
      error: message,
      usage: accountedResult
        ? {
            tokens: accountedResult.tokens,
            costUsd: accountedResult.costUsd,
            wallSeconds: accountedResult.wallSeconds,
          }
        : { tokens: 0, costUsd: 0, wallSeconds: 0 },
    });
    return { projectId, packageId, status: failedPackage.status };
  } finally {
    if (broker) await broker.stop();
    if (capsuleRoot) await rm(capsuleRoot, { recursive: true, force: true });
  }
}

async function createCapsule(
  root: string,
  project: ProjectState,
  workPackage: WorkPackage,
  runId: string,
): Promise<{
  capsuleRoot: string;
  projectRoot: string;
  inputManifest: Array<{ id: string; role: string; path: string; sha256: string }>;
  stagedSkills: string[];
  reviewPacketSha256: string | null;
}> {
  const paths = workspacePaths(root);
  const capsuleRoot = join(paths.runtime, runId);
  const capsuleProject = join(capsuleRoot, "project");
  await ensureDirectory(capsuleProject);
  await ensureDirectory(join(capsuleProject, "outputs"));

  const canonicalOutputs = join(projectRoot(root, project.id), "outputs");
  if (await pathExists(canonicalOutputs)) {
    for (const source of await regularTreeFiles(canonicalOutputs)) {
      const logical = relative(canonicalOutputs, source);
      const destination = join(capsuleProject, "outputs", logical);
      await ensureDirectory(dirname(destination));
      await cp(source, destination, { force: false });
    }
  }

  const inputManifest: Array<{ id: string; role: string; path: string; sha256: string }> = [];
  for (const input of project.inputs) {
    if ((await sha256File(input.path)) !== input.sha256) {
      throw new Error(`input drift detected: ${input.id}`);
    }
    const logical = join("inputs", input.id, basename(input.path)).replaceAll("\\", "/");
    const destination = join(capsuleProject, logical);
    await ensureDirectory(dirname(destination));
    await cp(input.path, destination, { force: false });
    inputManifest.push({ id: input.id, role: input.role, path: logical, sha256: input.sha256 });
  }
  await writeJsonAtomic(join(capsuleProject, "inputs", "manifest.json"), inputManifest);
  await writeJsonAtomic(join(capsuleProject, "project.json"), {
    ...project,
    inputs: project.inputs.map((input, index) => ({
      ...input,
      path: inputManifest[index]?.path ?? "inputs/unavailable",
    })),
  });
  const stagedSkills = await stageLockedCapabilities(root, join(capsuleProject, "skills"));
  const reviewPacketSha256 =
    workPackage.stage === "review"
      ? await writeReviewPacket(capsuleProject, project, inputManifest)
      : null;
  return {
    capsuleRoot,
    projectRoot: capsuleProject,
    inputManifest,
    stagedSkills,
    reviewPacketSha256,
  };
}

async function writeReviewPacket(
  capsuleProject: string,
  project: ProjectState,
  inputManifest: Array<{ id: string; role: string; path: string; sha256: string }>,
): Promise<string> {
  const artifactPaths = ["outputs/evidence.json", "outputs/analysis.json", "outputs/report.md"];
  const packet = {
    schemaVersion: 1,
    projectId: project.id,
    questionSha256: sha256Text(project.question),
    inputs: inputManifest,
    artifacts: await Promise.all(
      artifactPaths.map((logicalPath) =>
        fileRecord(resolveContained(capsuleProject, logicalPath), logicalPath),
      ),
    ),
  };
  const packetSha256 = sha256Text(canonicalJson(packet));
  await writeJsonAtomic(join(capsuleProject, "inputs", "review-packet.json"), {
    ...packet,
    packetSha256,
  });
  return packetSha256;
}

async function validateAndImportOutputs(
  root: string,
  project: ProjectState,
  workPackage: WorkPackage,
  capsuleProject: string,
  config: WorkspaceConfig,
  reviewPacketSha256: string | null,
): Promise<OutputRecord[]> {
  const admitted: Array<{ logicalPath: string; content: string; record: OutputRecord }> = [];
  let totalBytes = 0;
  if (workPackage.expectedOutputs.length > config.budget.maxFilesPerPackage) {
    throw new Error("declared output count exceeds the package file budget");
  }
  for (const logicalPath of workPackage.expectedOutputs) {
    const source = resolveContained(capsuleProject, logicalPath);
    const record = await fileRecord(source, logicalPath);
    totalBytes += record.bytes;
    if (totalBytes > config.budget.maxBytesPerPackage) {
      throw new Error("package outputs exceed the byte budget");
    }
    await validateOutputShape(root, project, logicalPath, source, reviewPacketSha256);
    admitted.push({ logicalPath, content: await readFile(source, "utf8"), record });
  }
  for (const output of admitted) {
    const destination = resolveContained(projectRoot(root, project.id), output.logicalPath);
    await ensureDirectory(dirname(destination));
    await writeTextAtomic(destination, output.content);
  }
  return admitted.map((output) => output.record);
}

async function validateOutputShape(
  root: string,
  project: ProjectState,
  logicalPath: string,
  path: string,
  reviewPacketSha256: string | null,
): Promise<void> {
  const content = await readFile(path, "utf8");
  if (!content.trim()) throw new Error(`${logicalPath} is empty`);
  if (!logicalPath.endsWith(".json")) return;
  const value = JSON.parse(content) as unknown;
  if (!isObject(value)) throw new Error(`${logicalPath} must contain a JSON object`);
  if (logicalPath.endsWith("evidence.json")) {
    if (
      !Array.isArray(value.sources) ||
      value.sources.length === 0 ||
      !Array.isArray(value.limitations) ||
      value.limitations.some((item) => typeof item !== "string")
    ) {
      throw new Error("evidence.json must contain sources and limitations arrays");
    }
    await validateEvidenceSources(root, project, value.sources);
  }
  if (logicalPath.endsWith("analysis.json")) {
    if (!Array.isArray(value.findings) || value.findings.length === 0) {
      throw new Error("analysis.json must contain a non-empty findings array");
    }
    await validateFindings(path, value.findings);
  }
  if (logicalPath.endsWith("review.json")) {
    if (
      (value.decision !== "pass" && value.decision !== "revise") ||
      !Array.isArray(value.issues) ||
      typeof value.rationale !== "string" ||
      !value.rationale.trim() ||
      !reviewPacketSha256 ||
      value.packetSha256 !== reviewPacketSha256
    ) {
      throw new Error("review.json must bind the review packet, decision, issues, and rationale");
    }
    if (value.decision !== "pass") throw new Error("independent review requested revision");
  }
}

async function validateEvidenceSources(
  root: string,
  project: ProjectState,
  sources: unknown[],
): Promise<void> {
  const inputLocators = new Map(
    project.inputs.map((input) => [
      input.id,
      join("inputs", input.id, basename(input.path)).replaceAll("\\", "/"),
    ]),
  );
  const brokerLocators = new Map<string, string>();
  for (const event of await readJournal(workspacePaths(root).journal)) {
    if (event.scope !== project.id || event.type !== "capability.fetch.completed") continue;
    const attemptId = event.payload.attemptId;
    const locator = event.payload.path;
    if (typeof attemptId === "string" && typeof locator === "string") {
      brokerLocators.set(attemptId, locator);
    }
  }
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (
      !isObject(source) ||
      typeof source.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source.id) ||
      sourceIds.has(source.id) ||
      typeof source.title !== "string" ||
      !source.title.trim() ||
      typeof source.locator !== "string" ||
      !source.locator.trim() ||
      typeof source.relevance !== "string" ||
      !source.relevance.trim() ||
      !isObject(source.provenance) ||
      (source.provenance.kind !== "input" && source.provenance.kind !== "broker") ||
      typeof source.provenance.id !== "string"
    ) {
      throw new Error("evidence.json contains an invalid or duplicate source");
    }
    const expectedLocator =
      source.provenance.kind === "input"
        ? inputLocators.get(source.provenance.id)
        : brokerLocators.get(source.provenance.id);
    if (!expectedLocator || expectedLocator !== source.locator) {
      throw new Error(`evidence source ${source.id} has invalid provenance`);
    }
    sourceIds.add(source.id);
  }
}

async function validateFindings(path: string, findings: unknown[]): Promise<void> {
  const evidencePath = join(dirname(path), "evidence.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as unknown;
  if (!isObject(evidence) || !Array.isArray(evidence.sources)) {
    throw new Error("analysis requires admitted evidence.json");
  }
  const sourceIds = new Set(
    evidence.sources
      .filter((source): source is Record<string, unknown> => isObject(source))
      .map((source) => source.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const findingIds = new Set<string>();
  for (const finding of findings) {
    if (
      !isObject(finding) ||
      typeof finding.id !== "string" ||
      !finding.id.trim() ||
      findingIds.has(finding.id) ||
      typeof finding.statement !== "string" ||
      !finding.statement.trim() ||
      !Array.isArray(finding.evidence) ||
      finding.evidence.length === 0 ||
      finding.evidence.some((id) => typeof id !== "string" || !sourceIds.has(id)) ||
      typeof finding.uncertainty !== "string" ||
      !finding.uncertainty.trim()
    ) {
      throw new Error("analysis.json contains an invalid or untraceable finding");
    }
    findingIds.add(finding.id);
  }
}

async function closeProjectMechanically(
  root: string,
  project: ProjectState,
  workPackage: WorkPackage,
): Promise<ExecutionResult> {
  const required = [
    "outputs/evidence.json",
    "outputs/analysis.json",
    "outputs/report.md",
    "outputs/review.json",
  ];
  const artifacts = await outputRecords(root, project, required);
  const review = JSON.parse(
    await readFile(resolveContained(projectRoot(root, project.id), "outputs/review.json"), "utf8"),
  ) as unknown;
  if (!isObject(review) || review.decision !== "pass") {
    throw new Error("project cannot close without a passing independent review");
  }
  const journal = await verifyJournal(workspacePaths(root).journal);
  const closure = {
    schemaVersion: 1,
    projectId: project.id,
    status: "complete",
    closedAt: new Date().toISOString(),
    questionSha256: sha256Text(project.question),
    artifacts,
    journalHead: journal.head,
  };
  const closurePath = resolveContained(
    projectRoot(root, project.id),
    workPackage.expectedOutputs[0]!,
  );
  await writeJsonAtomic(closurePath, closure);
  return { exitCode: 0, stdout: "", stderr: "", tokens: 0, costUsd: 0, wallSeconds: 0 };
}

async function outputRecords(
  root: string,
  project: ProjectState,
  logicalPaths: string[],
): Promise<OutputRecord[]> {
  return Promise.all(
    logicalPaths.map((logicalPath) =>
      fileRecord(resolveContained(projectRoot(root, project.id), logicalPath), logicalPath),
    ),
  );
}

function packagePrompt(
  project: ProjectState,
  workPackage: WorkPackage,
  inputs: Array<{ id: string; role: string; path: string; sha256: string }>,
  stagedSkills: string[],
  reviewPacketSha256: string | null,
): string {
  const stageInstructions: Record<WorkPackage["stage"], string> = {
    discover:
      'Create outputs/evidence.json with non-empty sources and a limitations array. Every source needs id, title, locator, relevance, and provenance {kind: "input"|"broker", id}. Input provenance IDs and locators must match the declared input manifest. Broker provenance must match a receipt returned by fetch_candidate_source. Do not invent unavailable evidence.',
    analyze:
      "Read outputs/evidence.json and create outputs/analysis.json with non-empty findings. Each finding needs id, statement, evidence source IDs, and uncertainty.",
    synthesize:
      "Read the admitted evidence and findings, then create outputs/report.md. Separate supported conclusions, uncertainty, limitations, and next actions.",
    review: `Independently inspect inputs/review-packet.json and all packet artifacts. Create outputs/review.json with packetSha256 ${reviewPacketSha256 ?? "unavailable"}, decision "pass" or "revise", an issues array, and a non-empty rationale. Use "pass" only when every material claim is traceable to admitted evidence.`,
    close: "No agent action is allowed for mechanical closure.",
  };
  return [
    "Operate only inside this isolated research capsule.",
    `Project: ${project.id}`,
    `Question: ${project.question}`,
    `Stage: ${workPackage.stage}`,
    `Declared inputs: ${JSON.stringify(inputs)}`,
    `Staged capability directories: ${JSON.stringify(stagedSkills.map((path) => `skills/${basename(path)}`))}`,
    stageInstructions[workPackage.stage],
    `Write only the declared stage outputs: ${workPackage.expectedOutputs.join(", ")}.`,
    "Do not edit project.json, the input manifest, prior outputs, or staged capability files.",
  ].join("\n\n");
}

async function dryRunResult(root: string): Promise<WorkspaceRunResult> {
  const projects = await listProjects(root);
  return {
    workspace: root,
    status: "dry-run",
    stopReason: "dry-run",
    cycles: 0,
    executed: [],
    projects: projects.map((project) => ({
      id: project.id,
      status: refreshProject(project).status,
      readyPackage: nextReadyPackage(project)?.id ?? null,
      usage: project.usage,
    })),
  };
}

async function summarizeRun(
  root: string,
  cycles: number,
  executed: WorkspaceRunResult["executed"],
  maxCycles: number,
): Promise<WorkspaceRunResult> {
  const projects = await listProjects(root);
  const summaries = projects.map((project) => ({
    id: project.id,
    status: refreshProject(project).status,
    readyPackage: nextReadyPackage(project)?.id ?? null,
    usage: project.usage,
  }));
  const status =
    summaries.length > 0 && summaries.every((project) => project.status === "complete")
      ? "complete"
      : summaries.some((project) => project.status === "blocked")
        ? "blocked"
        : "ready";
  const stopReason =
    summaries.length === 0
      ? "no-projects"
      : status === "complete"
        ? "all-projects-complete"
        : status === "blocked"
          ? "project-blocked"
          : cycles >= maxCycles
            ? "cycle-limit"
            : "no-ready-work";
  return { workspace: root, status, stopReason, cycles, executed, projects: summaries };
}

function assertBudget(project: ProjectState, config: WorkspaceConfig): void {
  const exceeded =
    project.usage.tokens >= config.budget.maxTokens ||
    project.usage.costUsd >= config.budget.maxCostUsd ||
    project.usage.wallSeconds >= config.budget.maxWallSeconds;
  if (exceeded) {
    throw new CliError(`Research budget is exhausted for project ${project.id}.`, {
      code: "RESEARCH_BUDGET_EXHAUSTED",
      exitCode: 3,
      details: { usage: project.usage, budget: config.budget },
    });
  }
}

function assertProjectedBudget(
  project: ProjectState,
  config: WorkspaceConfig,
  result: ExecutionResult,
): void {
  const projected = {
    tokens: project.usage.tokens + result.tokens,
    costUsd: project.usage.costUsd + result.costUsd,
    wallSeconds: project.usage.wallSeconds + result.wallSeconds,
  };
  if (
    projected.tokens > config.budget.maxTokens ||
    projected.costUsd > config.budget.maxCostUsd ||
    projected.wallSeconds > config.budget.maxWallSeconds
  ) {
    throw new CliError(`Research execution exceeded a hard budget for project ${project.id}.`, {
      code: "RESEARCH_BUDGET_EXHAUSTED",
      exitCode: 3,
      details: { projected, budget: config.budget },
    });
  }
}

function remainingWallSeconds(project: ProjectState, config: WorkspaceConfig): number {
  return Math.max(1, Math.floor(config.budget.maxWallSeconds - project.usage.wallSeconds));
}

function projectRoot(root: string, projectId: string): string {
  return join(workspacePaths(root).projects, projectId);
}

function validateRunOptions(options: RunOptions): void {
  if (
    !Number.isInteger(options.maxParallel) ||
    options.maxParallel < 1 ||
    options.maxParallel > 8
  ) {
    throw new CliError("--max-parallel must be an integer from 1 to 8.", {
      code: "RESEARCH_RUN_OPTION_INVALID",
      exitCode: 2,
    });
  }
  if (!Number.isInteger(options.maxCycles) || options.maxCycles < 1 || options.maxCycles > 100) {
    throw new CliError("--max-cycles must be an integer from 1 to 100.", {
      code: "RESEARCH_RUN_OPTION_INVALID",
      exitCode: 2,
    });
  }
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function bounded(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}
