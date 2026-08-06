import { randomUUID } from "node:crypto";
import { cp, lstat, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { CliError } from "../../errors.js";
import { stageLockedCapabilities, verifyCapabilities } from "./capabilities.js";
import { startCapabilityBroker, type CapabilityBroker } from "./broker.js";
import { loadProjectEvidenceReceipts, stageProjectEvidence } from "./evidence.js";
import { executeAgent, type AgentExecutionRequest } from "./executor.js";
import { renderInputLineContext } from "./input-plan.js";
import { appendJournalEvent, verifyJournal } from "./journal.js";
import {
  RESEARCH_AGENT_PROTOCOL_OVERHEAD_TOKENS,
  RESEARCH_BROKER_MAX_TURNS,
  RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
  RESEARCH_MAX_REPAIR_SOURCE_BYTES,
  RESEARCH_REPAIR_MAX_TURNS,
  RESEARCH_STRUCTURED_OUTPUT_MAX_TURNS,
  reservedAgentPackageCost,
} from "./preflight.js";
import {
  listProjects,
  loadProject,
  nextReadyPackage,
  packageById,
  refreshProject,
  saveProject,
} from "./projects.js";
import {
  configuredResearchSecrets,
  sanitizeResearchRecord,
  sanitizeResearchText,
} from "./sanitization.js";
import { parseStructuredStageOutput, schemaForStage, StructuredOutputError } from "./schemas.js";
import {
  canonicalJson,
  ensureDirectory,
  fileRecord,
  isObject,
  pathExists,
  readJsonFile,
  regularTreeFiles,
  resolveContained,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "./storage.js";
import type {
  AgentExecutionTelemetry,
  AgentPackageStage,
  AgentRoute,
  ExecutionResult,
  FailureKind,
  OutputRecord,
  ProjectState,
  ResearchProgressEvent,
  RunRecord,
  WorkPackage,
  WorkspaceConfig,
  WorkspaceDoctorAttestation,
} from "./types.js";
import { loadWorkspaceConfig, verifyDoctorAttestation, withWorkspaceLock } from "./workspace.js";

export interface RunOptions {
  maxParallel: number;
  maxCycles: number;
  dryRun: boolean;
  environment: NodeJS.ProcessEnv;
  projectId?: string;
  onProgress?: (event: ResearchProgressEvent) => void;
}

export type PackageExecutor = (request: AgentExecutionRequest) => Promise<ExecutionResult>;

export interface WorkspaceRunResult {
  workspace: string;
  requestId: string;
  projectId: string | null;
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
  const requestId = randomUUID();
  if (options.dryRun) return dryRunResult(root, requestId, options.projectId);
  return withWorkspaceLock(root, "research.run", async () => {
    await verifyJournal(workspacePaths(root).journal);
    const config = await loadWorkspaceConfig(root);
    assertExecutionConfiguration(config);
    let doctorAttestation: WorkspaceDoctorAttestation | null = null;
    const capabilities = await verifyCapabilities(root);
    if (capabilities.status !== "verified") {
      throw new CliError("Research capabilities are not locked and verified.", {
        code: "RESEARCH_CAPABILITY_DRIFT",
        exitCode: 3,
        details: capabilities,
      });
    }
    if (config.mode === "production-research") {
      const verification = await verifyDoctorAttestation(root);
      if (verification.status !== "verified" || !verification.attestation) {
        throw new CliError(
          "Production research requires a current successful producer/reviewer doctor smoke.",
          {
            code: "RESEARCH_DOCTOR_ATTESTATION_REQUIRED",
            exitCode: 3,
            details: { status: verification.status, errors: verification.errors },
          },
        );
      }
      doctorAttestation = verification.attestation;
      const unconfirmed = (await projectsForRun(root, options.projectId)).filter(
        (project) =>
          config.budget.maxCostUsd > config.budget.confirmationCostUsd &&
          !project.budgetConfirmedAt,
      );
      if (unconfirmed.length) {
        throw new CliError("Production research budget has not been explicitly confirmed.", {
          code: "RESEARCH_BUDGET_CONFIRMATION_REQUIRED",
          exitCode: 3,
          details: { projects: unconfirmed.map((project) => project.id) },
        });
      }
    }
    emitProgress(
      options,
      progressEvent("run.started", requestId, options.projectId ?? null, null, null),
    );
    const executed: WorkspaceRunResult["executed"] = [];
    let cycles = 0;

    while (cycles < options.maxCycles) {
      const projects = await projectsForRun(root, options.projectId);
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
            options,
            requestId,
            packageExecutor,
            doctorAttestation,
          ),
        ),
      );
      executed.push(...results);
    }

    const result = await summarizeRun(
      root,
      requestId,
      cycles,
      executed,
      options.maxCycles,
      options.projectId,
    );
    emitProgress(
      options,
      progressEvent("run.completed", requestId, options.projectId ?? null, null, null, {
        status: result.status,
        stopReason: result.stopReason,
      }),
    );
    return result;
  });
}

async function executeWorkPackage(
  root: string,
  projectId: string,
  packageId: string,
  config: WorkspaceConfig,
  options: RunOptions,
  requestId: string,
  packageExecutor: PackageExecutor,
  doctorAttestation: WorkspaceDoctorAttestation | null,
): Promise<{ projectId: string; packageId: string; status: string }> {
  const project = await loadProject(root, projectId);
  const workPackage = packageById(project, packageId);
  const now = new Date().toISOString();
  workPackage.status = "running";
  workPackage.attempts += 1;
  workPackage.startedAt = now;
  workPackage.completedAt = null;
  workPackage.lastError = null;
  workPackage.lastFailureKind = null;
  workPackage.retryNotBefore = null;
  project.status = "running";
  project.updatedAt = now;
  await saveProject(root, project);
  await appendJournalEvent(workspacePaths(root).journal, "package.started", projectId, {
    requestId,
    projectId,
    packageId,
    attempt: workPackage.attempts,
  });
  emitProgress(
    options,
    progressEvent(
      "package.started",
      requestId,
      projectId,
      packageId,
      remainingBudget(project, config),
      { attempt: workPackage.attempts },
    ),
  );

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  let capsuleRoot: string | undefined;
  let broker: CapabilityBroker | undefined;
  let accountedResult: ExecutionResult | undefined;
  let promotedOutputs: OutputRecord[] = [];
  let executor: AgentRoute["agent"] | "mechanical" = "mechanical";
  try {
    let result: ExecutionResult;
    if (workPackage.kind === "verify") {
      result = await closeProjectMechanically(root, project, workPackage);
      accountedResult = result;
      promotedOutputs = await outputRecords(root, project, workPackage.expectedOutputs);
    } else {
      const reservation = reservePackageBudget(project, workPackage, config);
      const capsule = await createCapsule(root, project, workPackage, runId);
      capsuleRoot = capsule.capsuleRoot;
      if (capsule.reviewPacketRecord) {
        await appendJournalEvent(
          workspacePaths(root).journal,
          "review.packet.persisted",
          projectId,
          {
            requestId,
            projectId,
            packageId,
            packetSha256: capsule.reviewPacketSha256,
            packet: capsule.reviewPacketRecord,
          },
        );
      }
      const stageContextContent = await stageContextForPackage(
        capsule.projectRoot,
        workPackage,
        config,
      );
      const route = workPackage.executor === "reviewer" ? config.reviewer : config.producer;
      executor = route.agent;
      broker =
        workPackage.stage === "discover"
          ? await startCapabilityBroker(root, project.id, capsule.projectRoot)
          : undefined;
      const primaryBrokerUrl = broker?.url ?? null;
      const inputOnlyProvenance = workPackage.stage === "discover" && primaryBrokerUrl === null;
      const primaryRequest = agentRequest({
        root,
        project,
        workPackage,
        route,
        capsule,
        config,
        options,
        requestId,
        purpose: "primary",
        prompt: packagePrompt(
          project,
          workPackage,
          capsule.inputManifest,
          capsule.stagedSkills,
          capsule.reviewPacketSha256,
          capsule.contextBundle,
          capsule.contextBundleContent,
          stageContextContent,
        ),
        brokerUrl: primaryBrokerUrl,
        inputOnlyProvenance,
        maxOutputTokens: Math.min(config.budget.maxOutputTokens, reservation.tokens),
        maxCostUsd: reservation.costUsd,
        expectedRuntime: runtimeForRoute(doctorAttestation, route),
      });
      assertPreCallTokenReservation(project, workPackage, config, primaryRequest, 0, true);
      result = await withHeartbeat(
        packageExecutor(primaryRequest),
        options,
        requestId,
        project,
        workPackage,
        config,
      );
      accountedResult = result;
      assertExecutorSucceeded(result);
      assertActualPackageBudget(
        project,
        workPackage,
        config,
        result,
        config.budget.maxOutputTokens,
      );
      try {
        await materializeAndValidateStageOutput(
          root,
          project,
          capsule.projectRoot,
          workPackage,
          result.stdout,
          capsule.reviewPacketSha256,
        );
      } catch (error) {
        if (!(error instanceof StructuredOutputError)) throw error;
        const repairTokens = availableRepairTokens(project, workPackage, config, result);
        if (repairTokens < 1) throw error;
        const repairRequest = agentRequest({
          root,
          project,
          workPackage,
          route,
          capsule,
          config,
          options,
          requestId,
          purpose: "repair",
          prompt: repairPrompt(workPackage, result.stdout, error),
          brokerUrl: null,
          inputOnlyProvenance,
          maxOutputTokens: repairTokens,
          maxCostUsd: Math.max(0, reservation.costUsd - result.costUsd),
          maxWallSeconds: Math.max(
            1,
            config.budget.packageMaxWallSeconds[workPackage.stage as AgentPackageStage] -
              result.wallSeconds,
          ),
          expectedRuntime: runtimeForRoute(doctorAttestation, route),
        });
        assertPreCallTokenReservation(
          project,
          workPackage,
          config,
          repairRequest,
          result.tokens,
          false,
        );
        const repair = await withHeartbeat(
          packageExecutor(repairRequest),
          options,
          requestId,
          project,
          workPackage,
          config,
        );
        accountedResult = combineExecutionResults(result, repair);
        assertExecutorSucceeded(repair);
        assertActualPackageBudget(
          project,
          workPackage,
          config,
          accountedResult,
          config.budget.maxOutputTokens + config.budget.maxRepairTokens,
        );
        await materializeAndValidateStageOutput(
          root,
          project,
          capsule.projectRoot,
          workPackage,
          repair.stdout,
          capsule.reviewPacketSha256,
        );
      }
      assertProjectedBudget(project, config, accountedResult);
      promotedOutputs = await validateAndImportOutputs(
        root,
        project,
        workPackage,
        capsule.projectRoot,
        config,
        capsule.reviewPacketSha256,
      );
      if (workPackage.stage === "discover") {
        await assertEvidenceCoverage(root, project);
      }
    }

    const completedAt = new Date().toISOString();
    applyUsage(project, accountedResult);
    workPackage.status = "complete";
    workPackage.completedAt = completedAt;
    workPackage.lastError = null;
    workPackage.lastFailureKind = null;
    workPackage.retryNotBefore = null;
    refreshProject(project);
    await saveProject(root, project);
    await writeRunRecord(root, {
      schemaVersion: 1,
      runId,
      projectId,
      packageId,
      executor,
      startedAt,
      completedAt,
      exitCode: accountedResult.exitCode,
      tokens: accountedResult.tokens,
      inputTokens: accountedResult.inputTokens,
      cachedInputTokens: accountedResult.cachedInputTokens,
      outputTokens: accountedResult.outputTokens,
      costUsd: accountedResult.costUsd,
      wallSeconds: accountedResult.wallSeconds,
      outputs: promotedOutputs,
      stdoutSha256: sha256Text(accountedResult.stdout),
      stderrSha256: sha256Text(accountedResult.stderr),
      failureKind: null,
      failureDetails: null,
      runtime: accountedResult.runtime,
      telemetry: accountedResult.telemetry,
    });
    const usage = usageSlice(accountedResult);
    await appendJournalEvent(workspacePaths(root).journal, "package.completed", projectId, {
      requestId,
      projectId,
      packageId,
      runId,
      executor,
      outputs: promotedOutputs,
      usage,
      runtime: accountedResult.runtime,
    });
    emitProgress(
      options,
      progressEvent(
        "package.completed",
        requestId,
        projectId,
        packageId,
        remainingBudget(project, config),
        { outputs: promotedOutputs, usage },
      ),
    );
    return { projectId, packageId, status: "complete" };
  } catch (error) {
    const failedProject = await loadProject(root, projectId);
    const failedPackage = packageById(failedProject, packageId);
    const secrets = configuredResearchSecrets(options.environment);
    const failureDetails = sanitizedFailureDetails(error, secrets);
    const gapSummary = Array.isArray(failureDetails?.gaps)
      ? failureDetails.gaps.filter((gap): gap is string => typeof gap === "string").join("; ")
      : "";
    const message = bounded(
      sanitizeResearchText(
        `${error instanceof Error ? error.message : String(error)}${gapSummary ? ` ${gapSummary}` : ""}`,
        secrets,
      ),
      2000,
    );
    if (accountedResult) applyUsage(failedProject, accountedResult);
    const classification = classifyFailure(error);
    failedPackage.lastError = message;
    failedPackage.lastFailureKind = classification.kind;
    failedPackage.completedAt = new Date().toISOString();
    const retryable =
      classification.retryable && failedPackage.attempts < failedPackage.maxAttempts;
    failedPackage.status = retryable ? "retry" : "failed";
    failedPackage.retryNotBefore = retryable
      ? retryNotBefore(classification.retryAfterSeconds)
      : null;
    refreshProject(failedProject);
    await saveProject(root, failedProject);
    if (accountedResult) {
      await writeRunRecord(root, {
        schemaVersion: 1,
        runId,
        projectId,
        packageId,
        executor,
        startedAt,
        completedAt: failedPackage.completedAt,
        exitCode: accountedResult.exitCode,
        tokens: accountedResult.tokens,
        inputTokens: accountedResult.inputTokens,
        cachedInputTokens: accountedResult.cachedInputTokens,
        outputTokens: accountedResult.outputTokens,
        costUsd: accountedResult.costUsd,
        wallSeconds: accountedResult.wallSeconds,
        outputs: promotedOutputs,
        stdoutSha256: sha256Text(accountedResult.stdout),
        stderrSha256: sha256Text(accountedResult.stderr),
        failureKind: classification.kind,
        failureDetails,
        runtime: accountedResult.runtime,
        telemetry: accountedResult.telemetry,
      });
    }
    const usage = accountedResult ? usageSlice(accountedResult) : zeroUsageSlice();
    await appendJournalEvent(workspacePaths(root).journal, "package.failed", projectId, {
      requestId,
      projectId,
      packageId,
      runId,
      attempt: failedPackage.attempts,
      retryable,
      retryNotBefore: failedPackage.retryNotBefore,
      failureKind: classification.kind,
      error: message,
      details: failureDetails,
      outputs: promotedOutputs,
      usage,
    });
    emitProgress(
      options,
      progressEvent(
        "package.failed",
        requestId,
        projectId,
        packageId,
        remainingBudget(failedProject, config),
        {
          retryable,
          retryNotBefore: failedPackage.retryNotBefore,
          failureKind: classification.kind,
          error: message,
          details: failureDetails,
          usage,
        },
      ),
    );
    return { projectId, packageId, status: failedPackage.status };
  } finally {
    if (broker) await broker.stop();
    if (capsuleRoot) await rm(capsuleRoot, { recursive: true, force: true });
  }
}

interface Capsule {
  capsuleRoot: string;
  projectRoot: string;
  inputManifest: CapsuleInputRecord[];
  contextBundle: OutputRecord;
  contextBundleContent: string;
  stagedSkills: string[];
  reviewPacketSha256: string | null;
  reviewPacketRecord: OutputRecord | null;
}

interface CapsuleInputRecord {
  id: string;
  role: string;
  path: string;
  sha256: string;
  bytes: number;
  contextPath: string;
  contextSha256: string;
  contextBytes: number;
  fullTextStaged: boolean;
}

async function createCapsule(
  root: string,
  project: ProjectState,
  workPackage: WorkPackage,
  runId: string,
): Promise<Capsule> {
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

  const inputManifest: CapsuleInputRecord[] = [];
  for (const input of project.inputs) {
    if ((await sha256File(input.path)) !== input.sha256) {
      throw new CliError(`Input drift detected: ${input.id}.`, {
        code: "RESEARCH_INPUT_DRIFT",
        exitCode: 3,
      });
    }
    const logical = join("inputs", input.id, basename(input.path)).replaceAll("\\", "/");
    const hasBoundedContext = Boolean(
      (input.contextPath || input.contextRanges?.length) &&
      input.contextSha256 &&
      input.contextBytes !== undefined,
    );
    const fullTextStaged = !hasBoundedContext || workPackage.stage === "review";
    if (fullTextStaged) {
      const destination = join(capsuleProject, logical);
      await ensureDirectory(dirname(destination));
      await cp(input.path, destination, { force: false });
    }
    let contextPath = logical;
    let contextSha256 = input.sha256;
    let contextBytes = input.bytes;
    if (hasBoundedContext) {
      const contextContent = input.contextRanges?.length
        ? await renderInputLineContext(input.path, input.contextRanges)
        : null;
      const actualContextSha256 = contextContent
        ? sha256Text(contextContent)
        : await sha256File(input.contextPath!);
      if (actualContextSha256 !== input.contextSha256) {
        throw new CliError(`Input context drift detected: ${input.id}.`, {
          code: "RESEARCH_INPUT_DRIFT",
          exitCode: 3,
        });
      }
      contextPath = join(
        "inputs",
        input.id,
        "context",
        input.contextPath ? basename(input.contextPath) : "selected-lines.txt",
      ).replaceAll("\\", "/");
      const destination = join(capsuleProject, contextPath);
      await ensureDirectory(dirname(destination));
      if (contextContent === null) {
        await cp(input.contextPath!, destination, { force: false });
      } else {
        await writeTextAtomic(destination, contextContent);
      }
      contextSha256 = input.contextSha256!;
      contextBytes = input.contextBytes!;
    }
    inputManifest.push({
      id: input.id,
      role: input.role,
      path: logical,
      sha256: input.sha256,
      bytes: input.bytes,
      contextPath,
      contextSha256,
      contextBytes,
      fullTextStaged,
    });
  }
  await writeJsonAtomic(join(capsuleProject, "inputs", "manifest.json"), inputManifest);
  const contextBundleContent = await buildInputContextBundle(capsuleProject, inputManifest);
  const contextBundlePath = join(capsuleProject, "inputs", "context-bundle.txt");
  await writeTextAtomic(contextBundlePath, contextBundleContent);
  const contextBundle = await fileRecord(contextBundlePath, "inputs/context-bundle.txt");
  const evidenceReceipts = await stageProjectEvidence(root, project.id, capsuleProject);
  await writeJsonAtomic(
    join(capsuleProject, "inputs", "evidence-receipts.json"),
    evidenceReceipts.map(reviewSafeReceipt),
  );
  await writeJsonAtomic(join(capsuleProject, "project.json"), {
    ...project,
    inputs: project.inputs.map((input, index) => ({
      ...input,
      path: inputManifest[index]?.path ?? "inputs/unavailable",
      contextPath: inputManifest[index]?.contextPath ?? "inputs/unavailable",
    })),
  });
  const stagedSkills = await stageLockedCapabilities(root, join(capsuleProject, "skills"));
  const reviewEvidenceContext =
    workPackage.stage === "review"
      ? await writeReviewEvidenceContext(
          root,
          project.id,
          capsuleProject,
          contextBundleContent,
          evidenceReceipts,
        )
      : null;
  const reviewPacket = reviewEvidenceContext
    ? await writeReviewPacket(
        root,
        capsuleProject,
        project,
        inputManifest,
        evidenceReceipts,
        reviewEvidenceContext.persistent,
      )
    : null;
  return {
    capsuleRoot,
    projectRoot: capsuleProject,
    inputManifest,
    contextBundle,
    contextBundleContent,
    stagedSkills,
    reviewPacketSha256: reviewPacket?.sha256 ?? null,
    reviewPacketRecord: reviewPacket?.record ?? null,
  };
}

async function buildInputContextBundle(
  capsuleProject: string,
  inputManifest: CapsuleInputRecord[],
): Promise<string> {
  const sections = ["TIANGONG BOUNDED INPUT CONTEXT BUNDLE v1"];
  for (const input of [...inputManifest].sort((left, right) => left.id.localeCompare(right.id))) {
    const context = await readFile(resolveContained(capsuleProject, input.contextPath), "utf8");
    sections.push(
      [
        `--- INPUT ${input.id} ---`,
        `role: ${input.role}`,
        `fullEvidenceLocator: ${input.path}`,
        `fullEvidenceSha256: ${input.sha256}`,
        `contextLocator: ${input.contextPath}`,
        `contextSha256: ${input.contextSha256}`,
        "--- BEGIN CONTEXT ---",
        context.trimEnd(),
        "--- END CONTEXT ---",
      ].join("\n"),
    );
  }
  return `${sections.join("\n\n")}\n`;
}

async function writeReviewPacket(
  root: string,
  capsuleProject: string,
  project: ProjectState,
  inputManifest: CapsuleInputRecord[],
  evidenceReceipts: Awaited<ReturnType<typeof loadProjectEvidenceReceipts>>,
  reviewEvidenceContext: OutputRecord,
): Promise<{ sha256: string; record: OutputRecord }> {
  const artifactPaths = ["outputs/evidence.json", "outputs/analysis.json", "outputs/report.md"];
  const evidenceFiles = new Map<string, OutputRecord>();
  for (const receipt of evidenceReceipts) {
    for (const locator of [receipt.locator, receipt.contextLocator]) {
      if (!evidenceFiles.has(locator)) {
        evidenceFiles.set(
          locator,
          await fileRecord(resolveContained(capsuleProject, locator), locator),
        );
      }
    }
  }
  const environment = await reviewEnvironmentPacket(root, project.id);
  const inputFiles = new Map<string, OutputRecord>();
  for (const input of inputManifest) {
    for (const locator of [input.path, input.contextPath]) {
      if (!inputFiles.has(locator)) {
        inputFiles.set(
          locator,
          await fileRecord(resolveContained(capsuleProject, locator), locator),
        );
      }
    }
  }
  await writeJsonAtomic(join(capsuleProject, "inputs", "runtime-fingerprint.json"), environment);
  const packet = {
    schemaVersion: 1,
    projectId: project.id,
    questionSha256: sha256Text(project.question),
    evidenceRequirements: project.evidenceRequirements,
    inputs: inputManifest,
    reviewEvidenceContext,
    inputFiles: [...inputFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
    evidenceReceipts: evidenceReceipts.map(reviewSafeReceipt),
    evidenceFiles: [...evidenceFiles.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    environment,
    environmentFile: await fileRecord(
      join(capsuleProject, "inputs", "runtime-fingerprint.json"),
      "inputs/runtime-fingerprint.json",
    ),
    artifacts: await Promise.all(
      artifactPaths.map((logicalPath) =>
        fileRecord(resolveContained(capsuleProject, logicalPath), logicalPath),
      ),
    ),
  };
  const packetSha256 = sha256Text(canonicalJson(packet));
  const completePacket = {
    ...packet,
    packetSha256,
  };
  await writeJsonAtomic(join(capsuleProject, "inputs", "review-packet.json"), completePacket);
  const record = await persistReviewPacket(root, project.id, completePacket, packetSha256);
  return { sha256: packetSha256, record };
}

async function writeReviewEvidenceContext(
  root: string,
  projectId: string,
  capsuleProject: string,
  inputContextBundle: string,
  evidenceReceipts: Awaited<ReturnType<typeof loadProjectEvidenceReceipts>>,
): Promise<{ capsule: OutputRecord; persistent: OutputRecord }> {
  const sections = [
    "TIANGONG REVIEW EVIDENCE CONTEXT v1",
    "The following are exact, hash-verified bounded views. Full objects are bound in the review packet.",
    inputContextBundle.trimEnd(),
  ];
  const seen = new Set<string>();
  for (const receipt of [...evidenceReceipts].sort((left, right) =>
    left.attemptId.localeCompare(right.attemptId),
  )) {
    if (seen.has(receipt.contextLocator)) continue;
    seen.add(receipt.contextLocator);
    const metadata = reviewSafeReceipt(receipt);
    const content = reviewableTextContentType(receipt.contentType)
      ? await readFile(resolveContained(capsuleProject, receipt.contextLocator), "utf8")
      : "[Binary bounded view omitted from model context; verify the bound file mechanically.]";
    sections.push(
      [
        `--- BROKER RECEIPT ${receipt.attemptId} ---`,
        `metadata: ${JSON.stringify(metadata)}`,
        "--- BEGIN BOUNDED VIEW ---",
        content.trimEnd(),
        "--- END BOUNDED VIEW ---",
      ].join("\n"),
    );
  }
  const logicalPath = "inputs/review-evidence-context.txt";
  const path = resolveContained(capsuleProject, logicalPath);
  const content = `${sections.join("\n\n")}\n`;
  await writeTextAtomic(path, content);
  const capsule = await fileRecord(path, logicalPath);
  const persistentLogicalPath = `review/contexts/${capsule.sha256}.txt`;
  const persistentPath = resolveContained(projectRoot(root, projectId), persistentLogicalPath);
  if (await pathExists(persistentPath)) {
    const existing = await fileRecord(persistentPath, persistentLogicalPath);
    if (existing.sha256 !== capsule.sha256 || existing.bytes !== capsule.bytes) {
      throw new CliError("Content-addressed review evidence context drift detected.", {
        code: "RESEARCH_REVIEW_CONTEXT_DRIFT",
        exitCode: 3,
      });
    }
  } else {
    await ensureDirectory(dirname(persistentPath));
    await writeTextAtomic(persistentPath, content);
  }
  return {
    capsule,
    persistent: await fileRecord(persistentPath, persistentLogicalPath),
  };
}

function reviewableTextContentType(contentType: string): boolean {
  return /^(?:text\/|application\/(?:[^;]+\+)?(?:json|xml|javascript|xhtml\+xml|csv))(?:;|$)/i.test(
    contentType,
  );
}

async function persistReviewPacket(
  root: string,
  projectId: string,
  packet: Record<string, unknown>,
  packetSha256: string,
): Promise<OutputRecord> {
  const logicalPath = `review/packets/${packetSha256}.json`;
  const path = resolveContained(projectRoot(root, projectId), logicalPath);
  if (await pathExists(path)) {
    const existing = await readJsonFile<Record<string, unknown>>(path, "Research review packet");
    verifyReviewPacketValue(existing, packetSha256);
    if (canonicalJson(existing) !== canonicalJson(packet)) {
      throw new CliError("Content-addressed review packet collision or drift detected.", {
        code: "RESEARCH_REVIEW_PACKET_DRIFT",
        exitCode: 3,
      });
    }
  } else {
    await ensureDirectory(dirname(path));
    await writeJsonAtomic(path, packet);
  }
  return fileRecord(path, logicalPath);
}

async function loadVerifiedReviewPacket(
  root: string,
  projectId: string,
  packetSha256: string,
): Promise<OutputRecord> {
  const logicalPath = `review/packets/${packetSha256}.json`;
  const path = resolveContained(projectRoot(root, projectId), logicalPath);
  const packet = await readJsonFile<Record<string, unknown>>(path, "Research review packet");
  verifyReviewPacketValue(packet, packetSha256);
  const context = packet.reviewEvidenceContext;
  if (
    !isObject(context) ||
    typeof context.path !== "string" ||
    typeof context.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(context.sha256) ||
    !Number.isInteger(context.bytes) ||
    context.path !== `review/contexts/${context.sha256}.txt`
  ) {
    throw new CliError("Persistent review packet has an invalid evidence context binding.", {
      code: "RESEARCH_REVIEW_CONTEXT_DRIFT",
      exitCode: 3,
    });
  }
  let actualContext: OutputRecord;
  try {
    actualContext = await fileRecord(
      resolveContained(projectRoot(root, projectId), context.path),
      context.path,
    );
  } catch {
    throw new CliError("Persistent review evidence context is missing or invalid.", {
      code: "RESEARCH_REVIEW_CONTEXT_DRIFT",
      exitCode: 3,
    });
  }
  if (actualContext.sha256 !== context.sha256 || actualContext.bytes !== context.bytes) {
    throw new CliError("Persistent review evidence context failed hash verification.", {
      code: "RESEARCH_REVIEW_CONTEXT_DRIFT",
      exitCode: 3,
    });
  }
  return fileRecord(path, logicalPath);
}

function verifyReviewPacketValue(packet: Record<string, unknown>, packetSha256: string): void {
  const { packetSha256: recordedSha256, ...body } = packet;
  if (recordedSha256 !== packetSha256 || sha256Text(canonicalJson(body)) !== packetSha256) {
    throw new CliError("Persistent review packet failed content-address verification.", {
      code: "RESEARCH_REVIEW_PACKET_DRIFT",
      exitCode: 3,
    });
  }
}

async function reviewEnvironmentPacket(
  root: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  const paths = workspacePaths(root);
  const runtimeLock = await readJsonFile<Record<string, unknown>>(
    paths.runtimeLock,
    "Research runtime lock",
  );
  const capabilityLock = (await pathExists(paths.capabilityLock))
    ? await readJsonFile<Record<string, unknown>>(paths.capabilityLock, "Capability lock")
    : { capabilities: [] };
  const capabilities = Array.isArray(capabilityLock.capabilities)
    ? capabilityLock.capabilities.filter(isObject).map((record) => ({
        id: record.id,
        skillName: record.skillName,
        treeSha256: record.treeSha256,
        policySha256: record.policySha256,
        permissions: record.permissions,
        credentialIds: record.credentialIds,
      }))
    : [];
  const runsPath = join(projectRoot(root, projectId), "runs");
  const priorRuns: Record<string, unknown>[] = [];
  if (await pathExists(runsPath)) {
    for (const path of await regularTreeFiles(runsPath)) {
      const record = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isObject(record)) continue;
      priorRuns.push({
        runId: record.runId,
        packageId: record.packageId,
        executor: record.executor,
        tokens: record.tokens,
        inputTokens: record.inputTokens,
        cachedInputTokens: record.cachedInputTokens,
        outputTokens: record.outputTokens,
        costUsd: record.costUsd,
        outputs: record.outputs,
        runtime: record.runtime,
        telemetry: record.telemetry,
      });
    }
  }
  return {
    schemaVersion: 1,
    cli: {
      packageName: runtimeLock.packageName,
      packageVersion: runtimeLock.packageVersion,
      protocolVersion: runtimeLock.protocolVersion,
    },
    capabilities,
    priorRuns: priorRuns.sort((left, right) =>
      String(left.packageId).localeCompare(String(right.packageId)),
    ),
  };
}

function reviewSafeReceipt(
  receipt: Awaited<ReturnType<typeof loadProjectEvidenceReceipts>>[number],
): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    attemptId: receipt.attemptId,
    capabilityId: receipt.capabilityId,
    status: receipt.status,
    contentType: receipt.contentType,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    sourceSha256: receipt.sourceSha256,
    locator: receipt.locator,
    contextLocator: receipt.contextLocator,
    contextSha256: receipt.contextSha256,
    contextBytes: receipt.contextBytes,
    contextEstimatedTokens: receipt.contextEstimatedTokens,
    contextItems: receipt.contextItems,
    contextOffset: receipt.contextOffset ?? 0,
    contextTotalItems: receipt.contextTotalItems ?? null,
    contextNextOffset: receipt.contextNextOffset ?? null,
    contextTruncated: receipt.contextTruncated,
    retrievedAt: receipt.retrievedAt,
    servedAt: receipt.servedAt,
    cacheHit: receipt.cacheHit,
  };
}

function agentRequest(input: {
  root: string;
  project: ProjectState;
  workPackage: WorkPackage;
  route: AgentRoute;
  capsule: Capsule;
  config: WorkspaceConfig;
  options: RunOptions;
  requestId: string;
  purpose: "primary" | "repair";
  prompt: string;
  brokerUrl: string | null;
  inputOnlyProvenance: boolean;
  maxOutputTokens: number;
  maxCostUsd: number;
  maxWallSeconds?: number;
  expectedRuntime?: WorkspaceDoctorAttestation["runtimes"][number] | undefined;
}): AgentExecutionRequest {
  const toolPolicy =
    input.purpose === "repair" ||
    input.workPackage.stage === "analyze" ||
    input.workPackage.stage === "synthesize" ||
    input.workPackage.stage === "review" ||
    (input.workPackage.stage === "discover" && input.brokerUrl === null)
      ? "none"
      : "workspace-read";
  return {
    route: input.route,
    prompt: input.prompt,
    outputSchema: schemaForStage(
      input.workPackage.stage as AgentPackageStage,
      input.capsule.reviewPacketSha256,
      input.inputOnlyProvenance
        ? { inputOnlyProvenanceIds: input.capsule.inputManifest.map((record) => record.id) }
        : {},
    ),
    requestId: input.requestId,
    purpose: input.purpose,
    capsuleRoot: input.capsule.capsuleRoot,
    projectRoot: input.capsule.projectRoot,
    workspaceRoot: input.root,
    timeoutSeconds: Math.min(
      remainingWallSeconds(input.project, input.config),
      input.maxWallSeconds ??
        input.config.budget.packageMaxWallSeconds[input.workPackage.stage as AgentPackageStage],
    ),
    maxTurns:
      input.purpose === "repair"
        ? RESEARCH_REPAIR_MAX_TURNS
        : toolPolicy === "none"
          ? RESEARCH_STRUCTURED_OUTPUT_MAX_TURNS
          : RESEARCH_BROKER_MAX_TURNS,
    maxOutputTokens: input.maxOutputTokens,
    maxCostUsd: input.maxCostUsd,
    expectedRuntime: input.expectedRuntime,
    toolPolicy,
    environment: input.options.environment,
    brokerUrl: input.brokerUrl,
  };
}

function runtimeForRoute(
  attestation: WorkspaceDoctorAttestation | null,
  route: AgentRoute,
): WorkspaceDoctorAttestation["runtimes"][number] | undefined {
  if (!attestation) return undefined;
  const runtime = attestation.runtimes.find(
    (candidate) => candidate.agent === route.agent && candidate.model === route.model,
  );
  if (!runtime) {
    throw new CliError(`Doctor attestation does not contain the ${route.agent} route.`, {
      code: "RESEARCH_DOCTOR_ATTESTATION_INVALID",
      exitCode: 3,
    });
  }
  return runtime;
}

async function materializeAndValidateStageOutput(
  root: string,
  project: ProjectState,
  capsuleProject: string,
  workPackage: WorkPackage,
  raw: string,
  reviewPacketSha256: string | null,
): Promise<void> {
  if (workPackage.stage === "close" || workPackage.expectedOutputs.length !== 1) {
    throw new CliError("Agent package output declaration is unsupported.", {
      code: "RESEARCH_PACKAGE_INVALID",
      exitCode: 3,
    });
  }
  const parsed = parseStructuredStageOutput(workPackage.stage, raw, reviewPacketSha256);
  const destination = resolveContained(capsuleProject, workPackage.expectedOutputs[0]!);
  const fileContent =
    workPackage.stage === "discover"
      ? `${JSON.stringify(normalizeEvidenceCoverage(project, parsed.value), null, 2)}\n`
      : parsed.fileContent;
  await writeTextAtomic(destination, fileContent);
  await validateOutputShape(root, project, workPackage, destination, reviewPacketSha256);
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
    throw deterministicError("Declared output count exceeds the package file budget.");
  }
  for (const logicalPath of workPackage.expectedOutputs) {
    const source = resolveContained(capsuleProject, logicalPath);
    const record = await fileRecord(source, logicalPath);
    totalBytes += record.bytes;
    if (totalBytes > config.budget.maxBytesPerPackage) {
      throw deterministicError("Package outputs exceed the byte budget.");
    }
    await validateOutputShape(root, project, workPackage, source, reviewPacketSha256);
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
  workPackage: WorkPackage,
  path: string,
  reviewPacketSha256: string | null,
): Promise<void> {
  const content = await readFile(path, "utf8");
  if (!content.trim()) throw deterministicError(`${workPackage.expectedOutputs[0]} is empty.`);
  if (workPackage.stage === "synthesize") return;
  const { value } = parseStructuredStageOutput(
    workPackage.stage as AgentPackageStage,
    content,
    reviewPacketSha256,
  );
  if (workPackage.stage === "discover") {
    await validateEvidenceSources(root, project, value.sources as unknown[]);
  }
  if (workPackage.stage === "analyze") {
    await validateFindings(path, value.findings as unknown[]);
  }
  if (workPackage.stage === "review") {
    if (value.decision !== "pass") {
      throw new CliError("Independent review requested revision.", {
        code: "RESEARCH_REVIEW_REVISION_REQUIRED",
        exitCode: 3,
        details: { issues: value.issues },
      });
    }
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
  const receipts = await loadProjectEvidenceReceipts(root, project.id);
  const brokerLocators = new Map(receipts.map((receipt) => [receipt.attemptId, receipt.locator]));
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (!isObject(source) || !isObject(source.provenance)) {
      throw new StructuredOutputError("discover output contains an invalid evidence source.");
    }
    const id = source.id;
    if (typeof id !== "string" || sourceIds.has(id)) {
      throw new StructuredOutputError("discover output contains a duplicate source ID.", {
        validation: [`source ID must be unique: ${String(id)}`],
      });
    }
    const expectedLocator =
      source.provenance.kind === "input"
        ? inputLocators.get(String(source.provenance.id))
        : source.provenance.kind === "broker"
          ? brokerLocators.get(String(source.provenance.id))
          : undefined;
    if (!expectedLocator || expectedLocator !== source.locator) {
      throw new StructuredOutputError(
        `discover output contains invalid provenance for evidence source ${String(id)}.`,
        {
          validation: [
            "provenance.id must be an exact immutable input ID or broker receipt attemptId",
            "locator must exactly match the locator bound to that provenance record",
          ],
          actual: {
            kind: source.provenance.kind,
            id: source.provenance.id,
            locator: source.locator,
          },
          allowedInputs: [...inputLocators].map(([inputId, locator]) => ({
            kind: "input",
            id: inputId,
            locator,
          })),
          allowedBrokerReceipts: [...brokerLocators].map(([attemptId, locator]) => ({
            kind: "broker",
            id: attemptId,
            locator,
          })),
        },
      );
    }
    if (typeof source.url === "string") assertPublicEvidenceUrl(source.url, id);
    if (
      typeof source.retrievedAt !== "string" ||
      !Number.isFinite(Date.parse(source.retrievedAt))
    ) {
      throw new StructuredOutputError(
        `discover output contains an invalid retrieval date for evidence source ${String(id)}.`,
      );
    }
    if (
      source.publicationDate !== null &&
      publicationDateInterval(source.publicationDate) === null
    ) {
      throw new StructuredOutputError(
        `discover output contains an invalid publication date for evidence source ${String(id)}.`,
      );
    }
    sourceIds.add(id);
  }
}

async function validateFindings(path: string, findings: unknown[]): Promise<void> {
  const evidencePath = join(dirname(path), "evidence.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as unknown;
  if (!isObject(evidence) || !Array.isArray(evidence.sources)) {
    throw deterministicError("Analysis requires admitted evidence.json.");
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
      findingIds.has(finding.id) ||
      !Array.isArray(finding.evidence) ||
      finding.evidence.some((id) => typeof id !== "string" || !sourceIds.has(id))
    ) {
      throw new StructuredOutputError(
        "analyze output contains an invalid or untraceable finding.",
        {
          validation: [
            "finding IDs must be unique and evidence IDs must reference admitted sources",
          ],
          admittedEvidenceIds: [...sourceIds].sort(),
        },
      );
    }
    findingIds.add(finding.id);
  }
}

function normalizeEvidenceCoverage(
  project: ProjectState,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const inputIds = new Set(project.inputs.map((input) => input.id));
  const sources = ((value.sources as Array<Record<string, unknown>>) ?? []).map((source) => {
    const provenance = isObject(source.provenance) ? source.provenance : {};
    return provenance.kind === "input" && inputIds.has(String(provenance.id))
      ? { ...source, fullTextAvailable: true }
      : source;
  });
  const declared = isObject(value.coverage) ? value.coverage : {};
  const computed = computeEvidenceCoverage(project, sources, declared);
  const declaredGaps = Array.isArray(declared.gaps)
    ? declared.gaps.filter((gap): gap is string => typeof gap === "string")
    : [];
  return {
    ...value,
    sources,
    coverage: {
      dimensions: computed.dimensions,
      sourceTypes: computed.sourceTypes,
      fullTextSources: computed.fullTextSources,
      datedSources: computed.datedSources,
      publicationDateRange: computed.publicationDateRange,
      decision: computed.decision,
      gaps: [...new Set([...declaredGaps, ...computed.mechanicalGaps])],
    },
  };
}

function computeEvidenceCoverage(
  project: ProjectState,
  sources: Array<Record<string, unknown>>,
  declared: Record<string, unknown>,
): {
  dimensions: Array<{
    id: string;
    status: "covered" | "partial" | "missing";
    sourceIds: string[];
  }>;
  sourceTypes: string[];
  fullTextSources: number;
  datedSources: number;
  publicationDateRange: { earliest: string | null; latest: string | null };
  decision: "pass" | "insufficient";
  mechanicalGaps: string[];
} {
  const gaps: string[] = [];
  if (sources.length < project.evidenceRequirements.minSources) {
    gaps.push(
      `requires ${project.evidenceRequirements.minSources} source(s), found ${sources.length}`,
    );
  }
  const fullTextSources = sources.filter((source) => source.fullTextAvailable === true).length;
  if (fullTextSources < project.evidenceRequirements.minFullTextSources) {
    gaps.push(
      `requires ${project.evidenceRequirements.minFullTextSources} full-text source(s), found ${fullTextSources}`,
    );
  }
  const publicationIntervals = sources.flatMap((source) => {
    const interval = publicationDateInterval(source.publicationDate);
    return interval ? [interval] : [];
  });
  const requiredFrom = project.evidenceRequirements.publicationDateFrom;
  const requiredTo = project.evidenceRequirements.publicationDateTo;
  const inRangeDatedSources = publicationIntervals.filter(
    (interval) =>
      (requiredFrom === null || interval.latest >= requiredFrom) &&
      (requiredTo === null || interval.earliest <= requiredTo),
  ).length;
  if (inRangeDatedSources < project.evidenceRequirements.minDatedSources) {
    gaps.push(
      `requires ${project.evidenceRequirements.minDatedSources} dated source(s) within the publication boundary, found ${inRangeDatedSources}`,
    );
  }
  const publicationDateRange = {
    earliest: publicationIntervals.length
      ? publicationIntervals.map((interval) => interval.earliest).sort()[0]!
      : null,
    latest: publicationIntervals.length
      ? publicationIntervals
          .map((interval) => interval.latest)
          .sort()
          .at(-1)!
      : null,
  };
  const sourceTypes = [...new Set(sources.map((source) => String(source.sourceType)))].sort();
  for (const sourceType of project.evidenceRequirements.sourceTypes) {
    if (!sourceTypes.includes(sourceType)) gaps.push(`missing required source type: ${sourceType}`);
  }
  const declaredDimensions = Array.isArray(declared.dimensions)
    ? declared.dimensions.filter(isObject)
    : [];
  const dimensions = project.evidenceRequirements.dimensions.map((dimension) => {
    const sourceIds = sources
      .filter(
        (source) =>
          Array.isArray(source.coverageDimensions) && source.coverageDimensions.includes(dimension),
      )
      .map((source) => String(source.id))
      .sort();
    const entry = declaredDimensions.find((item) => item.id === dimension);
    const declaredStatus = entry?.status;
    const status: "covered" | "partial" | "missing" = sourceIds.length
      ? declaredStatus === "covered"
        ? "covered"
        : "partial"
      : "missing";
    if (!sourceIds.length) gaps.push(`missing evidence dimension: ${dimension}`);
    return { id: dimension, status, sourceIds };
  });
  return {
    dimensions,
    sourceTypes,
    fullTextSources,
    datedSources: publicationIntervals.length,
    publicationDateRange,
    decision: gaps.length ? "insufficient" : "pass",
    mechanicalGaps: gaps,
  };
}

async function assertEvidenceCoverage(root: string, project: ProjectState): Promise<void> {
  const path = resolveContained(projectRoot(root, project.id), "outputs/evidence.json");
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const sources = value.sources as Array<Record<string, unknown>>;
  const declared = value.coverage as Record<string, unknown>;
  const computed = computeEvidenceCoverage(project, sources, declared);
  const gaps = [...computed.mechanicalGaps];
  if (
    canonicalJson(declared.dimensions) !== canonicalJson(computed.dimensions) ||
    canonicalJson(declared.sourceTypes) !== canonicalJson(computed.sourceTypes) ||
    declared.fullTextSources !== computed.fullTextSources ||
    declared.datedSources !== computed.datedSources ||
    canonicalJson(declared.publicationDateRange) !== canonicalJson(computed.publicationDateRange)
  ) {
    gaps.push("coverage summary does not match admitted sources");
  }
  if (declared.decision !== computed.decision) {
    gaps.push(`coverage decision must be ${computed.decision}`);
  }
  if (gaps.length) {
    throw new CliError("Evidence coverage is insufficient; downstream packages were not started.", {
      code: "RESEARCH_EVIDENCE_INSUFFICIENT",
      exitCode: 3,
      details: { gaps },
    });
  }
}

function publicationDateInterval(value: unknown): { earliest: string; latest: string } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : null;
  const day = match[3] ? Number(match[3]) : null;
  if (year < 1 || year > 9999 || (month !== null && (month < 1 || month > 12))) return null;
  if (day !== null) {
    const exact = `${match[1]}-${match[2]}-${match[3]}`;
    const timestamp = Date.parse(`${exact}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== exact) {
      return null;
    }
    return { earliest: exact, latest: exact };
  }
  if (month !== null) {
    const monthText = String(month).padStart(2, "0");
    const earliest = `${match[1]}-${monthText}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { earliest, latest: `${match[1]}-${monthText}-${String(lastDay).padStart(2, "0")}` };
  }
  return { earliest: `${match[1]}-01-01`, latest: `${match[1]}-12-31` };
}

async function closeProjectMechanically(
  root: string,
  project: ProjectState,
  workPackage: WorkPackage,
): Promise<ExecutionResult> {
  await assertEvidenceCoverage(root, project);
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
    throw deterministicError("Project cannot close without a passing independent review.");
  }
  await verifyProjectInputBindings(project);
  if (typeof review.packetSha256 !== "string" || !/^[0-9a-f]{64}$/.test(review.packetSha256)) {
    throw deterministicError("Project review does not bind a valid review packet hash.");
  }
  const reviewPacket = await loadVerifiedReviewPacket(root, project.id, review.packetSha256);
  const evidenceReceipts = await loadProjectEvidenceReceipts(root, project.id);
  const journal = await verifyJournal(workspacePaths(root).journal);
  const closure = {
    schemaVersion: 1,
    projectId: project.id,
    status: "complete",
    closedAt: new Date().toISOString(),
    questionSha256: sha256Text(project.question),
    evidenceRequirements: project.evidenceRequirements,
    inputs: project.inputs.map((input) => ({
      id: input.id,
      role: input.role,
      sha256: input.sha256,
      bytes: input.bytes,
      contextSha256: input.contextSha256,
      contextBytes: input.contextBytes,
      contextRanges: input.contextRanges ?? null,
    })),
    reviewPacket: { ...reviewPacket, packetSha256: review.packetSha256 },
    evidenceObjects: evidenceReceipts.map((receipt) => ({
      attemptId: receipt.attemptId,
      locator: receipt.locator,
      sha256: receipt.sha256,
      bytes: receipt.bytes,
    })),
    artifacts,
    journalHead: journal.head,
  };
  const closurePath = resolveContained(
    projectRoot(root, project.id),
    workPackage.expectedOutputs[0]!,
  );
  await writeJsonAtomic(closurePath, closure);
  return zeroExecutionResult();
}

async function verifyProjectInputBindings(project: ProjectState): Promise<void> {
  for (const input of project.inputs) {
    const info = await lstat(input.path).catch(() => undefined);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.size !== input.bytes ||
      (await sha256File(input.path)) !== input.sha256
    ) {
      throw new CliError(`Registered input failed closure verification: ${input.id}.`, {
        code: "RESEARCH_INPUT_DRIFT",
        exitCode: 3,
      });
    }
    if (!input.contextSha256 || input.contextBytes === undefined) continue;
    let contextValid = false;
    if (input.contextRanges?.length) {
      const context = await renderInputLineContext(input.path, input.contextRanges);
      contextValid =
        Buffer.byteLength(context, "utf8") === input.contextBytes &&
        sha256Text(context) === input.contextSha256;
    } else if (input.contextPath) {
      const contextInfo = await lstat(input.contextPath).catch(() => undefined);
      contextValid = Boolean(
        contextInfo?.isFile() &&
        !contextInfo.isSymbolicLink() &&
        contextInfo.size === input.contextBytes &&
        (await sha256File(input.contextPath)) === input.contextSha256,
      );
    }
    if (!contextValid) {
      throw new CliError(`Registered input context failed closure verification: ${input.id}.`, {
        code: "RESEARCH_INPUT_DRIFT",
        exitCode: 3,
      });
    }
  }
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

async function stageContextForPackage(
  capsuleProject: string,
  workPackage: WorkPackage,
  config: WorkspaceConfig,
): Promise<string> {
  const logicalPaths =
    workPackage.stage === "analyze"
      ? ["outputs/evidence.json"]
      : workPackage.stage === "synthesize"
        ? ["outputs/evidence.json", "outputs/analysis.json"]
        : workPackage.stage === "review"
          ? [
              "inputs/review-packet.json",
              "inputs/review-evidence-context.txt",
              "outputs/evidence.json",
              "outputs/analysis.json",
              "outputs/report.md",
            ]
          : [];
  const sections: string[] = [];
  for (const logicalPath of logicalPaths) {
    const content = await readFile(resolveContained(capsuleProject, logicalPath), "utf8");
    sections.push(`### ${logicalPath}\n${content.trimEnd()}`);
  }
  const bundled = sections.join("\n\n");
  const estimatedTokens = Math.ceil(Buffer.byteLength(bundled, "utf8") / 4);
  if (estimatedTokens > config.budget.maxInputContextTokens) {
    throw new CliError(
      `Admitted stage context exceeds the configured input context limit for ${workPackage.id}.`,
      {
        code: "RESEARCH_INPUT_CONTEXT_BUDGET_EXCEEDED",
        exitCode: 3,
        details: {
          packageId: workPackage.id,
          estimatedTokens,
          maxInputContextTokens: config.budget.maxInputContextTokens,
        },
      },
    );
  }
  return bundled;
}

function packagePrompt(
  project: ProjectState,
  workPackage: WorkPackage,
  inputs: CapsuleInputRecord[],
  stagedSkills: string[],
  reviewPacketSha256: string | null,
  contextBundle: OutputRecord,
  contextBundleContent: string,
  stageContextContent: string,
): string {
  const stageInstructions: Record<WorkPackage["stage"], string> = {
    discover:
      "Return the evidence object defined by the supplied JSON Schema. Cite only declared inputs or broker receipts. Each source.id is your concise evidence label; it must not be reused as provenance.id. For declared inputs, provenance must use the exact id and path shown in the declared input manifest, with locator=path. Every declared input binds an exact registered full source, so fullTextAvailable=true even when fullTextStaged=false; that flag means the producer receives only its bounded context while independent review binds both the verified full-file hash and the exact bounded review view. For broker evidence, provenance.id must be the exact receipt attemptId and locator must be the receipt locator (not contextLocator); use contextLocator only to inspect the bounded view. Include source type, retrieval metadata, an excerpt or JSON Pointer when available, quality, applicability, coverage dimensions, limitations, and an honest coverage assessment. A partial dimension is usable but incomplete; missing means no admitted source covers it. coverage.gaps records qualitative limitations and does not alone force an insufficient decision. The CLI mechanically derives local-input full-text availability, sourceTypes, counts, date range, sourceIds, and the pass/insufficient decision from admitted sources and declared minimums. Never place credentials or sensitive URL parameters in any field.",
    analyze:
      "Use only the complete embedded admitted evidence below and return the schema-defined analysis object. Every finding must cite admitted evidence source IDs and state uncertainty and applicability.",
    synthesize:
      "Use only the complete embedded admitted evidence and findings below. Return the schema-defined object whose reportMarkdown separates supported conclusions, uncertainty, limitations, and next actions.",
    review: `Independently inspect the complete embedded review packet, artifacts, and exact bounded evidence views. The CLI has already verified every bound full evidence object's size and SHA-256 and persistently stored the review packet; do not claim to have read beyond the embedded views. Return the schema-defined review bound to packetSha256 ${reviewPacketSha256 ?? "unavailable"}. Use pass only when every material claim is traceable within the admitted evidence and clearly scoped to its limitations.`,
    close: "No agent action is allowed for mechanical closure.",
  };
  const prompt = [
    "Operate only inside this isolated research capsule.",
    `Project: ${project.id}`,
    `Question: ${project.question}`,
    `Stage: ${workPackage.stage}`,
    `Evidence requirements: ${JSON.stringify(project.evidenceRequirements)}`,
    `Declared inputs: ${JSON.stringify(inputs)}`,
    `Bounded input context bundle: ${JSON.stringify(contextBundle)}`,
    `Staged capability directories: ${JSON.stringify(stagedSkills.map((path) => `skills/${basename(path)}`))}`,
    workPackage.stage === "discover"
      ? "Keep broker inspection within the package budget and use bounded views."
      : "Use only the complete embedded stage context; no tools or additional source reads are allowed.",
    stageInstructions[workPackage.stage],
    "Do not write stage output files directly. Your final response must be only the JSON object required by the supplied output schema; the CLI will validate and atomically materialize it.",
    "Do not edit project.json, input manifests, prior outputs, evidence objects, or staged capability files.",
  ];
  if (workPackage.stage === "discover") {
    prompt.push(
      `Exact local-input provenance mappings: ${JSON.stringify(
        inputs.map((input) => ({ kind: "input", id: input.id, locator: input.path })),
      )}`,
      "The complete authorized local-input context is embedded below. Use it directly and do not re-read individual local input files. Full evidence files are intentionally withheld from producer packages when fullTextStaged=false.",
      contextBundleContent,
    );
  }
  if (stageContextContent) {
    prompt.push(
      "The complete admitted stage context is embedded below. Use it directly and do not re-read output files.",
      stageContextContent,
    );
  }
  return prompt.join("\n\n");
}

function repairPrompt(workPackage: WorkPackage, raw: string, error: StructuredOutputError): string {
  return [
    "This is an isolated, low-cost formatting repair. Do not perform research, fetch sources, or add facts.",
    `Stage: ${workPackage.stage}`,
    `Validation failure: ${sanitizeResearchText(error.message)}`,
    `Validation detail: ${JSON.stringify(sanitizeResearchRecord(isObject(error.details) ? error.details : {}))}`,
    "Return only a corrected JSON object satisfying the supplied schema while preserving the source content below.",
    `Invalid output:\n${bounded(sanitizeResearchText(raw), 32_000)}`,
  ].join("\n\n");
}

function assertPreCallTokenReservation(
  project: ProjectState,
  workPackage: WorkPackage,
  config: WorkspaceConfig,
  request: AgentExecutionRequest,
  alreadyUsedTokens: number,
  reserveRepair: boolean,
): void {
  const schemaBytes = Buffer.byteLength(JSON.stringify(request.outputSchema), "utf8");
  const promptBytes = Buffer.byteLength(request.prompt, "utf8");
  const protocolOverhead = RESEARCH_AGENT_PROTOCOL_OVERHEAD_TOKENS[request.route.agent];
  const callInputTokensPerTurn =
    protocolOverhead + Math.ceil((schemaBytes + promptBytes) / RESEARCH_ESTIMATED_BYTES_PER_TOKEN);
  const callInputTokens = callInputTokensPerTurn * request.maxTurns;
  const repairTokens = reserveRepair
    ? (protocolOverhead +
        Math.ceil(
          (schemaBytes + RESEARCH_MAX_REPAIR_SOURCE_BYTES + 2_048) /
            RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
        )) *
        RESEARCH_REPAIR_MAX_TURNS +
      config.budget.maxRepairTokens
    : 0;
  const reservation = {
    alreadyUsedTokens,
    maxTurns: request.maxTurns,
    estimatedCallInputTokensPerTurn: callInputTokensPerTurn,
    estimatedCallInputTokens: callInputTokens,
    outputTokens: request.maxOutputTokens,
    potentialRepairTokens: repairTokens,
    totalTokens: alreadyUsedTokens + callInputTokens + request.maxOutputTokens + repairTokens,
  };
  const packageMaxTokens = config.budget.packageMaxTokens[workPackage.stage as AgentPackageStage];
  const projectRemainingTokens = Math.max(0, config.budget.maxTokens - project.usage.tokens);
  if (
    reservation.totalTokens > packageMaxTokens ||
    reservation.totalTokens > projectRemainingTokens
  ) {
    throw new CliError(
      `Pre-call input/output reservation does not fit package ${workPackage.id}.`,
      {
        code: "RESEARCH_BUDGET_RESERVATION_FAILED",
        exitCode: 3,
        details: {
          packageId: workPackage.id,
          packageMaxTokens,
          projectRemainingTokens,
          reservation,
        },
      },
    );
  }
}

function reservePackageBudget(
  project: ProjectState,
  workPackage: WorkPackage,
  config: WorkspaceConfig,
): { tokens: number; costUsd: number } {
  if (workPackage.stage === "close") return { tokens: 0, costUsd: 0 };
  const route = workPackage.executor === "reviewer" ? config.reviewer : config.producer;
  const tokens = config.budget.packageMaxTokens[workPackage.stage];
  const costUsd = roundMoney(reservedAgentPackageCost(route, tokens, config));
  const wallSeconds = config.budget.packageMaxWallSeconds[workPackage.stage];
  const remaining = remainingBudget(project, config);
  if (
    remaining.tokens < tokens ||
    remaining.costUsd < costUsd ||
    remaining.wallSeconds < wallSeconds
  ) {
    throw new CliError(
      `Remaining budget cannot reserve package ${workPackage.id} for project ${project.id}.`,
      {
        code: "RESEARCH_BUDGET_RESERVATION_FAILED",
        exitCode: 3,
        details: {
          remaining,
          reservation: { tokens, costUsd, wallSeconds },
          packageId: workPackage.id,
        },
      },
    );
  }
  return { tokens, costUsd };
}

function assertActualPackageBudget(
  project: ProjectState,
  workPackage: WorkPackage,
  config: WorkspaceConfig,
  result: ExecutionResult,
  maxOutputTokens: number,
): void {
  if (
    workPackage.stage !== "close" &&
    result.tokens > config.budget.packageMaxTokens[workPackage.stage]
  ) {
    throw new CliError(`Executor exceeded the package token limit for ${workPackage.id}.`, {
      code: "RESEARCH_PACKAGE_BUDGET_EXCEEDED",
      exitCode: 3,
      details: {
        projectId: project.id,
        packageId: workPackage.id,
        actualTokens: result.tokens,
        maxTokens: config.budget.packageMaxTokens[workPackage.stage],
      },
    });
  }
  if (result.outputTokens > maxOutputTokens) {
    throw new CliError(`Executor exceeded the output token limit for ${workPackage.id}.`, {
      code: "RESEARCH_PACKAGE_OUTPUT_BUDGET_EXCEEDED",
      exitCode: 3,
      details: {
        projectId: project.id,
        packageId: workPackage.id,
        actualOutputTokens: result.outputTokens,
        maxOutputTokens,
      },
    });
  }
  if (
    workPackage.stage !== "close" &&
    result.wallSeconds > config.budget.packageMaxWallSeconds[workPackage.stage]
  ) {
    throw new CliError(`Executor exceeded the package wall-time limit for ${workPackage.id}.`, {
      code: "RESEARCH_PACKAGE_WALL_BUDGET_EXCEEDED",
      exitCode: 3,
      details: {
        projectId: project.id,
        packageId: workPackage.id,
        actualWallSeconds: result.wallSeconds,
        maxWallSeconds: config.budget.packageMaxWallSeconds[workPackage.stage],
      },
    });
  }
}

function availableRepairTokens(
  project: ProjectState,
  workPackage: WorkPackage,
  config: WorkspaceConfig,
  primary: ExecutionResult,
): number {
  if (workPackage.stage === "close") return 0;
  if (primary.wallSeconds >= config.budget.packageMaxWallSeconds[workPackage.stage]) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(
      config.budget.maxRepairTokens,
      config.budget.packageMaxTokens[workPackage.stage] - primary.tokens,
      config.budget.maxTokens - project.usage.tokens - primary.tokens,
    ),
  );
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

function remainingBudget(
  project: ProjectState,
  config: WorkspaceConfig,
): NonNullable<ResearchProgressEvent["remainingBudget"]> {
  return {
    tokens: Math.max(0, config.budget.maxTokens - project.usage.tokens),
    costUsd: Math.max(0, roundMoney(config.budget.maxCostUsd - project.usage.costUsd)),
    wallSeconds: Math.max(0, config.budget.maxWallSeconds - project.usage.wallSeconds),
  };
}

function remainingWallSeconds(project: ProjectState, config: WorkspaceConfig): number {
  return Math.max(1, Math.floor(config.budget.maxWallSeconds - project.usage.wallSeconds));
}

function assertExecutionConfiguration(config: WorkspaceConfig): void {
  if (config.producer.agent === config.reviewer.agent) {
    throw new CliError("Research producer and reviewer must use different agent families.", {
      code: "RESEARCH_REVIEW_ROUTE_INVALID",
      exitCode: 3,
    });
  }
  if (config.mode === "production-research" && (!config.producer.model || !config.reviewer.model)) {
    throw new CliError("Production research requires explicit producer and reviewer models.", {
      code: "RESEARCH_MODEL_REQUIRED",
      exitCode: 3,
    });
  }
  if (
    config.mode === "production-research" &&
    (!config.producer.pricing || !config.reviewer.pricing)
  ) {
    throw new CliError("Production research requires explicit producer and reviewer pricing.", {
      code: "RESEARCH_PRICING_REQUIRED",
      exitCode: 3,
    });
  }
}

function assertExecutorSucceeded(result: ExecutionResult): void {
  if (result.exitCode === 0) return;
  const diagnostic = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  throw new CliError(
    `Executor exited ${result.exitCode}: ${bounded(diagnostic || "no diagnostic output", 1000)}`,
    {
      code: "RESEARCH_EXECUTOR_FAILED",
      exitCode: 3,
      details: { exitCode: result.exitCode },
    },
  );
}

function sanitizedFailureDetails(
  error: unknown,
  secrets: readonly string[],
): Record<string, unknown> | null {
  if (!(error instanceof CliError) || !isObject(error.details)) return null;
  const sanitized = sanitizeResearchRecord(error.details, secrets);
  const encoded = JSON.stringify(sanitized);
  if (encoded.length <= 16_000) return sanitized;
  return {
    truncated: true,
    sha256: sha256Text(encoded),
    preview: bounded(encoded, 12_000),
  };
}

function classifyFailure(error: unknown): {
  kind: FailureKind;
  retryable: boolean;
  retryAfterSeconds: number | null;
} {
  if (error instanceof StructuredOutputError) {
    return { kind: "structured-output", retryable: false, retryAfterSeconds: null };
  }
  if (error instanceof CliError) {
    if (error.code.includes("BUDGET")) {
      return { kind: "budget", retryable: false, retryAfterSeconds: null };
    }
    if (
      error.code.includes("CONFIG") ||
      error.code.includes("INVALID") ||
      error.code.includes("DRIFT") ||
      error.code.includes("UNAVAILABLE") ||
      error.code === "RESEARCH_EVIDENCE_INSUFFICIENT" ||
      error.code === "RESEARCH_REVIEW_REVISION_REQUIRED"
    ) {
      return { kind: "configuration", retryable: false, retryAfterSeconds: null };
    }
    if (error.code === "RESEARCH_BROKER_HTTP_ERROR" && isObject(error.details)) {
      const status = error.details.status;
      const retryAfter = numericOrNull(error.details.retryAfterSeconds);
      if (status === 429) {
        return { kind: "rate-limit", retryable: true, retryAfterSeconds: retryAfter };
      }
      if (typeof status === "number" && status >= 500) {
        return { kind: "server", retryable: true, retryAfterSeconds: null };
      }
      return { kind: "deterministic", retryable: false, retryAfterSeconds: null };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /error_max_budget|budget_exhausted|reached maximum budget|max(?:imum)? budget usd|error_max_turns|reached maximum (?:number of )?turns|max_turns/i.test(
      message,
    )
  ) {
    return { kind: "budget", retryable: false, retryAfterSeconds: null };
  }
  if (/\b(401|403|authentication|unauthorized|forbidden|login)\b/i.test(message)) {
    return { kind: "authentication", retryable: false, retryAfterSeconds: null };
  }
  if (/\b429\b|rate.?limit/i.test(message)) {
    const retryAfter = /retry-after(?:seconds)?["':=\s]+(\d+)/i.exec(message)?.[1];
    return {
      kind: "rate-limit",
      retryable: true,
      retryAfterSeconds: retryAfter ? Number(retryAfter) : 60,
    };
  }
  if (/\b5\d\d\b|server error|service unavailable/i.test(message)) {
    return { kind: "server", retryable: true, retryAfterSeconds: null };
  }
  if (/timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|temporary failure/i.test(message)) {
    return { kind: "transient", retryable: true, retryAfterSeconds: null };
  }
  return { kind: "deterministic", retryable: false, retryAfterSeconds: null };
}

function retryNotBefore(retryAfterSeconds: number | null): string | null {
  if (retryAfterSeconds === null) return null;
  return new Date(Date.now() + Math.max(1, retryAfterSeconds) * 1000).toISOString();
}

function combineExecutionResults(
  primary: ExecutionResult,
  repair: ExecutionResult,
): ExecutionResult {
  return {
    exitCode: repair.exitCode,
    stdout: `${primary.stdout}\n${repair.stdout}`,
    stderr: `${primary.stderr}\n${repair.stderr}`.trim(),
    tokens: primary.tokens + repair.tokens,
    inputTokens: primary.inputTokens + repair.inputTokens,
    cachedInputTokens: primary.cachedInputTokens + repair.cachedInputTokens,
    outputTokens: primary.outputTokens + repair.outputTokens,
    costUsd: roundMoney(primary.costUsd + repair.costUsd),
    wallSeconds: primary.wallSeconds + repair.wallSeconds,
    model: repair.model ?? primary.model,
    runtime: repair.runtime ?? primary.runtime,
    telemetry: mergeTelemetry(primary.telemetry, repair.telemetry),
  };
}

function mergeTelemetry(
  primary: AgentExecutionTelemetry | undefined,
  repair: AgentExecutionTelemetry | undefined,
): AgentExecutionTelemetry | undefined {
  if (!primary) return repair;
  if (!repair) return primary;
  return {
    eventCounts: mergeCounts(primary.eventCounts, repair.eventCounts),
    itemCounts: mergeCounts(primary.itemCounts, repair.itemCounts),
    toolCalls: primary.toolCalls + repair.toolCalls,
    providerTurns:
      primary.providerTurns === null && repair.providerTurns === null
        ? null
        : (primary.providerTurns ?? 0) + (repair.providerTurns ?? 0),
    reasoningOutputTokens: primary.reasoningOutputTokens + repair.reasoningOutputTokens,
    providerErrors: [...new Set([...primary.providerErrors, ...repair.providerErrors])].slice(
      0,
      10,
    ),
  };
}

function mergeCounts(
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> {
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) result[key] = (result[key] ?? 0) + value;
  return result;
}

function applyUsage(project: ProjectState, result: ExecutionResult): void {
  project.usage.tokens += result.tokens;
  project.usage.inputTokens += result.inputTokens;
  project.usage.cachedInputTokens += result.cachedInputTokens;
  project.usage.outputTokens += result.outputTokens;
  project.usage.costUsd = roundMoney(project.usage.costUsd + result.costUsd);
  project.usage.wallSeconds += result.wallSeconds;
}

function usageSlice(result: ExecutionResult): Record<string, unknown> {
  return {
    tokens: result.tokens,
    inputTokens: result.inputTokens,
    cachedInputTokens: result.cachedInputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    wallSeconds: result.wallSeconds,
    telemetry: result.telemetry ?? null,
  };
}

function zeroUsageSlice(): Record<string, unknown> {
  return {
    tokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    wallSeconds: 0,
  };
}

function zeroExecutionResult(): ExecutionResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    tokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    wallSeconds: 0,
    model: null,
    runtime: null,
  };
}

async function writeRunRecord(root: string, record: RunRecord): Promise<void> {
  await writeJsonAtomic(
    join(projectRoot(root, record.projectId), "runs", `${record.runId}.json`),
    sanitizeResearchRecord(record as unknown as Record<string, unknown>),
  );
}

async function withHeartbeat<T>(
  operation: Promise<T>,
  options: RunOptions,
  requestId: string,
  project: ProjectState,
  workPackage: WorkPackage,
  config: WorkspaceConfig,
): Promise<T> {
  const timer = setInterval(() => {
    emitProgress(
      options,
      progressEvent(
        "package.heartbeat",
        requestId,
        project.id,
        workPackage.id,
        remainingBudget(project, config),
        { attempt: workPackage.attempts },
      ),
    );
  }, 30_000);
  timer.unref();
  try {
    return await operation;
  } finally {
    clearInterval(timer);
  }
}

function emitProgress(options: RunOptions, event: ResearchProgressEvent): void {
  try {
    options.onProgress?.(
      sanitizeResearchRecord(
        event as unknown as Record<string, unknown>,
        configuredResearchSecrets(options.environment),
      ) as unknown as ResearchProgressEvent,
    );
  } catch {
    // Progress reporting must not alter research execution.
  }
}

function progressEvent(
  type: ResearchProgressEvent["type"],
  requestId: string,
  projectId: string | null,
  packageId: string | null,
  remaining: ResearchProgressEvent["remainingBudget"],
  detail?: Record<string, unknown>,
): ResearchProgressEvent {
  return {
    schemaVersion: 1,
    type,
    timestamp: new Date().toISOString(),
    requestId,
    projectId,
    packageId,
    remainingBudget: remaining,
    ...(detail ? { detail } : {}),
  };
}

async function dryRunResult(
  root: string,
  requestId: string,
  projectId?: string,
): Promise<WorkspaceRunResult> {
  const projects = await projectsForRun(root, projectId);
  return {
    workspace: root,
    requestId,
    projectId: projectId ?? null,
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
  requestId: string,
  cycles: number,
  executed: WorkspaceRunResult["executed"],
  maxCycles: number,
  projectId?: string,
): Promise<WorkspaceRunResult> {
  const projects = await projectsForRun(root, projectId);
  const summaries = projects.map((project) => ({
    id: project.id,
    status: refreshProject(project).status,
    readyPackage: nextReadyPackage(project)?.id ?? null,
    usage: project.usage,
  }));
  const unfinished = summaries.filter((project) => project.status !== "complete");
  const hasReadyPackage = summaries.some((project) => project.readyPackage !== null);
  const status =
    summaries.length > 0 && summaries.every((project) => project.status === "complete")
      ? "complete"
      : unfinished.length > 0 && unfinished.every((project) => project.status === "blocked")
        ? "blocked"
        : "ready";
  const stopReason =
    summaries.length === 0
      ? "no-projects"
      : status === "complete"
        ? "all-projects-complete"
        : hasReadyPackage && cycles >= maxCycles
          ? "cycle-limit"
          : status === "blocked"
            ? "project-blocked"
            : "no-ready-work";
  return {
    workspace: root,
    requestId,
    projectId: projectId ?? null,
    status,
    stopReason,
    cycles,
    executed,
    projects: summaries,
  };
}

async function projectsForRun(root: string, projectId?: string): Promise<ProjectState[]> {
  return projectId ? [await loadProject(root, projectId)] : listProjects(root);
}

function assertPublicEvidenceUrl(value: string, sourceId: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw deterministicError(`Evidence source ${sourceId} contains an invalid URL.`);
  }
  if (url.username || url.password) {
    throw deterministicError(`Evidence source ${sourceId} URL contains credentials.`);
  }
  const sensitive =
    /^(access_token|api[_-]?key|apikey|auth|authorization|code|cookie|key|password|secret|session|sig|signature|token)$/i;
  if ([...url.searchParams.keys()].some((key) => sensitive.test(key))) {
    throw deterministicError(`Evidence source ${sourceId} URL contains sensitive parameters.`);
  }
}

function deterministicError(message: string): CliError {
  return new CliError(message, { code: "RESEARCH_OUTPUT_INVALID", exitCode: 3 });
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

function bounded(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
