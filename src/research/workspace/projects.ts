import { randomUUID } from "node:crypto";
import { cp, lstat, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import { RESEARCH_CONTROL_DIRECTORY } from "./constants.js";
import { appendJournalEvent } from "./journal.js";
import { cloneProjectEvidenceReceipts } from "./evidence.js";
import {
  appendEvidenceLedgerEvent,
  cloneEvidenceLedger,
  registerProjectInputCandidates,
} from "./evidence-ledger.js";
import { cloneProjectArtifactRecords } from "./artifacts.js";
import {
  freezeEvidenceSnapshot,
  loadCurrentEvidenceSnapshot,
  loadImmutableEvidenceSnapshotChain,
} from "./acquisition.js";
import { projectInputsFromPlan, reverifyProjectInputPlan } from "./input-plan.js";
import { evaluateProjectPreflight } from "./preflight.js";
import {
  evaluateScientificDesign,
  scientificDesignPolicyGaps,
  type VerifiedScientificDesign,
} from "./scientific-design.js";
import {
  ensureDirectory,
  fileRecord,
  fileSize,
  isObject,
  readJsonFile,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type {
  AgentKind,
  ProjectEvidenceRequirements,
  ProjectInput,
  ProjectInputTrustStatus,
  ResearchPolicyBinding,
  ScientificDesignBinding,
  ScientificReviewRole,
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
  publicationPolicy?: ResearchPolicyBinding,
  scientificDesignInput?: {
    design: VerifiedScientificDesign;
    producerAgent: AgentKind;
    producerSessionId: string;
  },
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
    if (publicationPolicy && !scientificDesignInput) {
      throw new CliError("Top-journal research requires an explicit scientific design contract.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REQUIRED",
        exitCode: 2,
      });
    }
    if (!publicationPolicy && scientificDesignInput) {
      throw new CliError("A scientific design contract requires an approved top-journal policy.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_POLICY_REQUIRED",
        exitCode: 2,
      });
    }
    const scientificDesign = scientificDesignInput
      ? prepareScientificDesignBinding(projectId, publicationPolicy!, scientificDesignInput)
      : null;
    const admittedInputPlan = inputPlan ? await reverifyProjectInputPlan(inputPlan) : undefined;
    if (config.mode === "production-research") {
      const preflight = await evaluateProjectPreflight(
        root,
        normalizedQuestion,
        requirements,
        admittedInputPlan ?? null,
        {
          publicationPolicy: publicationPolicy ?? null,
          scientificDesign: scientificDesignInput?.design ?? null,
        },
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
      publicationPolicy: publicationPolicy ?? null,
      scientificDesign,
      packages: defaultWorkPackages(config),
      usage: {
        tokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallSeconds: 0,
      },
      lineage: initialLineage("primary"),
      handoff: initialHandoffState(),
      evidenceState: initialEvidenceState(),
    };
    await Promise.all([
      ensureDirectory(projectRoot),
      ensureDirectory(join(projectRoot, "outputs")),
      ensureDirectory(join(projectRoot, "runs")),
    ]);
    if (scientificDesign && scientificDesignInput) {
      await writeJsonAtomic(
        join(paths.control, scientificDesign.objectLocator),
        scientificDesignInput.design.contract,
      );
    }
    await writeJsonAtomic(projectPath, project);
    await registerProjectInputCandidates(root, projectId, project.inputs);
    await appendJournalEvent(paths.journal, "project.initialized", projectId, {
      projectId,
      questionSha256: await hashQuestion(normalizedQuestion),
      inputPlanSha256: admittedInputPlan?.sha256 ?? null,
      publicationPolicySha256: publicationPolicy?.resolvedPolicySha256 ?? null,
      scientificDesignSha256: scientificDesign?.designSha256 ?? null,
      scientificDesignProducerSessionSha256: scientificDesign?.producer.sessionSha256 ?? null,
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
  options: {
    trustStatus?: ProjectInputTrustStatus;
    independentlyReproduced?: boolean;
  } = {},
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
      sourceType: "primary",
      dimensions: [],
      fullText: true,
      publicationDate: null,
      trustStatus: options.trustStatus ?? defaultInputTrustStatus(role),
      independentlyReproduced: options.independentlyReproduced ?? false,
      addedAt: new Date().toISOString(),
    };
    project.inputs.push(input);
    project.inputs.sort((left, right) => left.id.localeCompare(right.id));
    project.updatedAt = new Date().toISOString();
    await saveProject(root, project);
    await registerProjectInputCandidates(root, projectId, [input]);
    await appendJournalEvent(workspacePaths(root).journal, "project.input.added", projectId, {
      projectId,
      inputId: input.id,
      role,
      sha256,
      bytes: input.bytes,
      trustStatus: input.trustStatus,
      independentlyReproduced: input.independentlyReproduced,
    });
    return input;
  });
}

function defaultInputTrustStatus(role: ProjectInput["role"]): ProjectInputTrustStatus {
  if (role === "reference") return "reference-only";
  if (role === "replication") return "replication-candidate";
  return "unverified-owner-input";
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
    if (
      project.status === "archived" ||
      project.status === "abandoned" ||
      project.lineage.supersededBy
    ) {
      throw new CliError(
        "Historical projects cannot be retried; continue from the authoritative project.",
        {
          code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE",
          exitCode: 3,
          details: {
            projectId,
            status: project.status,
            supersededBy: project.lineage.supersededBy,
          },
        },
      );
    }
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
  resumeThrough?: "discover" | "acquire" | "analyze" | "synthesize",
  scientificReapproval?: {
    publicationPolicy: ResearchPolicyBinding;
    scientificDesign: {
      design: VerifiedScientificDesign;
      producerAgent: AgentKind;
      producerSessionId: string;
    };
  },
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
    const sourceRequiresScientificReapproval = Boolean(
      source.publicationPolicy || source.scientificDesign,
    );
    if (sourceRequiresScientificReapproval && !scientificReapproval) {
      throw new CliError(
        "A top-journal recovery fork requires a newly approved project-specific policy and scientific design.",
        { code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_REQUIRED", exitCode: 3 },
      );
    }
    if (!sourceRequiresScientificReapproval && scientificReapproval) {
      throw new CliError("Scientific reapproval is valid only for a top-journal source project.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_INVALID",
        exitCode: 2,
      });
    }
    if (source.lineage.supersededBy) {
      throw new CliError(
        `Project ${sourceProjectId} is historical; fork the authoritative project ${source.lineage.supersededBy}.`,
        { code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE", exitCode: 3 },
      );
    }
    if (source.status === "archived" || source.status === "abandoned") {
      throw new CliError(`Project ${sourceProjectId} is ${source.status} and cannot be forked.`, {
        code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE",
        exitCode: 3,
      });
    }
    if (source.handoff.state !== "agent-actionable") {
      throw new CliError(
        `Project ${sourceProjectId} has an unresolved ${source.handoff.state} handoff.`,
        { code: "RESEARCH_PROJECT_HANDOFF_REQUIRED", exitCode: 3 },
      );
    }
    const targetRoot = join(workspacePaths(root).projects, targetProjectId);
    if (await lstat(targetRoot).catch(() => undefined)) {
      throw new CliError(`Research project already exists: ${targetProjectId}`, {
        code: "RESEARCH_PROJECT_EXISTS",
        exitCode: 2,
      });
    }
    const config = await loadWorkspaceConfig(root);
    const targetPolicy = scientificReapproval?.publicationPolicy ?? null;
    if (targetPolicy && targetPolicy.projectId !== targetProjectId) {
      throw new CliError("Recovery policy must be approved for the target project generation.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_INVALID",
        exitCode: 2,
      });
    }
    const targetScientificDesign = scientificReapproval
      ? prepareScientificDesignBinding(
          targetProjectId,
          scientificReapproval.publicationPolicy,
          scientificReapproval.scientificDesign,
        )
      : null;
    if (config.mode === "production-research") {
      const preflight = await evaluateProjectPreflight(
        root,
        source.question,
        source.evidenceRequirements,
        null,
        {
          publicationPolicy: targetPolicy,
          scientificDesign: scientificReapproval?.scientificDesign.design ?? null,
        },
      );
      if (!preflight.readyToInitialize) {
        throw new CliError("Recovery generation was blocked by production preflight.", {
          code: "RESEARCH_PREFLIGHT_BLOCKED",
          exitCode: 3,
          details: { gaps: preflight.gaps, preflightSha256: preflight.preflightSha256 },
        });
      }
    }
    const packages = defaultWorkPackages(config);
    const inheritedStages = resumeThrough
      ? ["discover", "acquire", "analyze", "synthesize"].slice(
          0,
          ["discover", "acquire", "analyze", "synthesize"].indexOf(resumeThrough) + 1,
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
        requiredCapabilityIds: [...(source.evidenceRequirements.requiredCapabilityIds ?? [])],
        requiredCompanionIds: [...(source.evidenceRequirements.requiredCompanionIds ?? [])],
        requiredDiscoveryScopes: [...(source.evidenceRequirements.requiredDiscoveryScopes ?? [])],
      },
      publicationPolicy: targetPolicy,
      scientificDesign: targetScientificDesign,
      packages,
      usage: {
        tokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallSeconds: 0,
      },
      lineage: {
        ...initialLineage("fork"),
        derivedFrom: sourceProjectId,
        supersedes: sourceProjectId,
      },
      handoff: initialHandoffState(),
      evidenceState: initialEvidenceState(),
    };
    await Promise.all([
      ensureDirectory(targetRoot),
      ensureDirectory(join(targetRoot, "outputs")),
      ensureDirectory(join(targetRoot, "runs")),
    ]);
    if (targetScientificDesign && scientificReapproval) {
      await writeJsonAtomic(
        join(workspacePaths(root).control, targetScientificDesign.objectLocator),
        scientificReapproval.scientificDesign.design.contract,
      );
    }
    const inheritedOutputs: Array<{ path: string; sha256: string; bytes: number }> = [];
    const stageOutput: Record<string, string> = {
      discover: "outputs/evidence.json",
      acquire: "outputs/acquisition.json",
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
      await cloneEvidenceLedger(root, sourceProjectId, targetProjectId);
    }
    if (inheritedStages.includes("acquire")) {
      await cloneProjectArtifactRecords(root, sourceProjectId, targetProjectId);
    }
    refreshProject(project);
    await writeJsonAtomic(join(targetRoot, "project.json"), project);
    if (inheritedStages.includes("acquire")) {
      await freezeEvidenceSnapshot(root, project);
      inheritedOutputs.push(
        await fileRecord(
          join(targetRoot, "outputs", "evidence-snapshot.json"),
          "outputs/evidence-snapshot.json",
        ),
      );
      await saveProject(root, project);
    }
    source.lineage.supersededBy = targetProjectId;
    source.evidenceState.staleReason = `Superseded by recovery fork ${targetProjectId}.`;
    refreshProject(source);
    await saveProject(root, source);
    await appendEvidenceLedgerEvent(root, sourceProjectId, "project.superseded", {
      sourceProjectId,
      supersededBy: targetProjectId,
      reason: "recovery-fork",
    });
    await appendJournalEvent(workspacePaths(root).journal, "project.forked", targetProjectId, {
      sourceProjectId,
      targetProjectId,
      resumeThrough: resumeThrough ?? null,
      inheritedOutputs,
      inheritedUsage: false,
      sourceSuperseded: true,
      publicationPolicySha256: targetPolicy?.resolvedPolicySha256 ?? null,
      scientificDesignSha256: targetScientificDesign?.designSha256 ?? null,
      scientificDesignProducerSessionSha256: targetScientificDesign?.producer.sessionSha256 ?? null,
    });
    return project;
  });
}

export async function setProjectDisposition(
  root: string,
  projectId: string,
  disposition: "archived" | "abandoned",
  reason: string,
): Promise<ProjectState> {
  validateProjectId(projectId);
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 8 || normalizedReason.length > 500) {
    throw new CliError("Project disposition reason must contain 8-500 characters.", {
      code: "RESEARCH_PROJECT_DISPOSITION_INVALID",
      exitCode: 2,
    });
  }
  return withWorkspaceLock(root, `project.${disposition}`, async () => {
    const project = refreshProject(await loadProject(root, projectId));
    if (
      project.status === "running" ||
      project.packages.some((item) => item.status === "running")
    ) {
      throw new CliError(
        "Abort the active native stage before archiving or abandoning this project.",
        { code: "RESEARCH_PROJECT_DISPOSITION_INVALID", exitCode: 3 },
      );
    }
    if (project.status === "archived" || project.status === "abandoned") {
      if (project.status === disposition) return project;
      throw new CliError(`Project is already ${project.status}.`, {
        code: "RESEARCH_PROJECT_DISPOSITION_INVALID",
        exitCode: 3,
      });
    }
    if (disposition === "archived" && project.status !== "complete" && project.status !== "stale") {
      throw new CliError(
        "Archive is for complete or superseded history; use abandon for unfinished work.",
        { code: "RESEARCH_PROJECT_DISPOSITION_INVALID", exitCode: 3 },
      );
    }
    if (
      disposition === "abandoned" &&
      (project.status === "complete" || project.status === "stale")
    ) {
      throw new CliError(
        "Abandon is for unfinished work; archive complete or superseded history instead.",
        { code: "RESEARCH_PROJECT_DISPOSITION_INVALID", exitCode: 3 },
      );
    }
    project.status = disposition;
    project.updatedAt = new Date().toISOString();
    await saveProject(root, project);
    await appendJournalEvent(workspacePaths(root).journal, `project.${disposition}`, projectId, {
      projectId,
      disposition,
      reason: normalizedReason,
      supersededBy: project.lineage.supersededBy,
    });
    return project;
  });
}

export async function createProjectAddendum(
  root: string,
  sourceProjectId: string,
  targetProjectId: string,
  scientificReapproval?: {
    publicationPolicy: ResearchPolicyBinding;
    scientificDesign: {
      design: VerifiedScientificDesign;
      producerAgent: AgentKind;
      producerSessionId: string;
    };
  },
): Promise<ProjectState> {
  validateProjectId(sourceProjectId);
  validateProjectId(targetProjectId);
  if (sourceProjectId === targetProjectId) {
    throw new CliError("Addendum target must use a different project ID.", {
      code: "RESEARCH_PROJECT_ADDENDUM_INVALID",
      exitCode: 2,
    });
  }
  return withWorkspaceLock(root, "project.addendum", async () => {
    const source = refreshProject(await loadProject(root, sourceProjectId));
    const sourceRequiresScientificReapproval = Boolean(
      source.publicationPolicy || source.scientificDesign,
    );
    if (sourceRequiresScientificReapproval && !scientificReapproval) {
      throw new CliError(
        "A top-journal addendum requires a newly approved project-specific policy and scientific design.",
        { code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_REQUIRED", exitCode: 3 },
      );
    }
    if (!sourceRequiresScientificReapproval && scientificReapproval) {
      throw new CliError("Scientific reapproval is valid only for a top-journal source project.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_INVALID",
        exitCode: 2,
      });
    }
    if (source.status !== "complete" || source.packages.at(-1)?.stage !== "close") {
      throw new CliError("An addendum requires a mechanically closed source project.", {
        code: "RESEARCH_PROJECT_ADDENDUM_INVALID",
        exitCode: 3,
      });
    }
    if (source.lineage.supersededBy) {
      throw new CliError(
        `Project ${sourceProjectId} is already superseded by ${source.lineage.supersededBy}.`,
        { code: "RESEARCH_PROJECT_ADDENDUM_INVALID", exitCode: 3 },
      );
    }
    const snapshot = await loadCurrentEvidenceSnapshot(root, sourceProjectId);
    const closurePath = join(
      workspacePaths(root).projects,
      sourceProjectId,
      "outputs",
      "closure.json",
    );
    const closure = await readJsonFile<Record<string, unknown>>(
      closurePath,
      `Research closure ${sourceProjectId}`,
    ).catch(() => null);
    const closureSnapshot =
      closure?.evidenceSnapshot &&
      typeof closure.evidenceSnapshot === "object" &&
      !Array.isArray(closure.evidenceSnapshot)
        ? (closure.evidenceSnapshot as Record<string, unknown>)
        : null;
    if (
      closure?.projectId !== sourceProjectId ||
      closure?.status !== "complete" ||
      closureSnapshot?.snapshotId !== snapshot.snapshotId ||
      closureSnapshot?.snapshotSha256 !== snapshot.snapshotSha256 ||
      source.evidenceState.closureSnapshotId !== snapshot.snapshotId ||
      source.evidenceState.currentSnapshotSha256 !== snapshot.snapshotSha256
    ) {
      throw new CliError("Source closure is not bound to its current evidence snapshot.", {
        code: "RESEARCH_PROJECT_ADDENDUM_INVALID",
        exitCode: 3,
      });
    }
    const targetRoot = join(workspacePaths(root).projects, targetProjectId);
    if (await lstat(targetRoot).catch(() => undefined)) {
      throw new CliError(`Research project already exists: ${targetProjectId}`, {
        code: "RESEARCH_PROJECT_EXISTS",
        exitCode: 2,
      });
    }
    const config = await loadWorkspaceConfig(root);
    const targetPolicy = scientificReapproval?.publicationPolicy ?? null;
    if (targetPolicy && targetPolicy.projectId !== targetProjectId) {
      throw new CliError("Addendum policy must be approved for the target project generation.", {
        code: "RESEARCH_SCIENTIFIC_DESIGN_REAPPROVAL_INVALID",
        exitCode: 2,
      });
    }
    const targetScientificDesign = scientificReapproval
      ? prepareScientificDesignBinding(
          targetProjectId,
          scientificReapproval.publicationPolicy,
          scientificReapproval.scientificDesign,
        )
      : null;
    if (config.mode === "production-research") {
      const preflight = await evaluateProjectPreflight(
        root,
        source.question,
        source.evidenceRequirements,
        null,
        {
          publicationPolicy: targetPolicy,
          scientificDesign: scientificReapproval?.scientificDesign.design ?? null,
        },
      );
      if (!preflight.readyToInitialize) {
        throw new CliError("Addendum generation was blocked by production preflight.", {
          code: "RESEARCH_PREFLIGHT_BLOCKED",
          exitCode: 3,
          details: { gaps: preflight.gaps, preflightSha256: preflight.preflightSha256 },
        });
      }
    }
    const now = new Date().toISOString();
    const target: ProjectState = {
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
        requiredCapabilityIds: [...(source.evidenceRequirements.requiredCapabilityIds ?? [])],
        requiredCompanionIds: [...(source.evidenceRequirements.requiredCompanionIds ?? [])],
        requiredDiscoveryScopes: [...(source.evidenceRequirements.requiredDiscoveryScopes ?? [])],
      },
      publicationPolicy: targetPolicy,
      scientificDesign: targetScientificDesign,
      packages: defaultWorkPackages(config),
      usage: {
        tokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallSeconds: 0,
      },
      lineage: {
        kind: "addendum",
        derivedFrom: sourceProjectId,
        supersedes: sourceProjectId,
        supersededBy: null,
        baseSnapshotId: snapshot.snapshotId,
        baseSnapshotSha256: snapshot.snapshotSha256,
      },
      handoff: initialHandoffState(),
      evidenceState: initialEvidenceState(),
    };
    await Promise.all([
      ensureDirectory(targetRoot),
      ensureDirectory(join(targetRoot, "outputs")),
      ensureDirectory(join(targetRoot, "runs")),
      ensureDirectory(join(targetRoot, "evidence", "snapshots")),
    ]);
    if (targetScientificDesign && scientificReapproval) {
      await writeJsonAtomic(
        join(workspacePaths(root).control, targetScientificDesign.objectLocator),
        scientificReapproval.scientificDesign.design.contract,
      );
    }
    const inheritedOutputs: Array<{ path: string; sha256: string; bytes: number }> = [];
    for (const logicalPath of ["outputs/evidence.json", "outputs/acquisition.json"] as const) {
      const sourcePath = join(workspacePaths(root).projects, sourceProjectId, logicalPath);
      const destination = join(targetRoot, logicalPath);
      await cp(sourcePath, destination, { errorOnExist: true, force: false });
      inheritedOutputs.push(await fileRecord(destination, logicalPath));
    }
    const baseSnapshotLogicalPath = "outputs/base-evidence-snapshot.json";
    const sourceSnapshotPath = join(
      workspacePaths(root).projects,
      sourceProjectId,
      "evidence",
      "snapshots",
      `${snapshot.snapshotSha256}.json`,
    );
    const snapshotChain = await loadImmutableEvidenceSnapshotChain(
      root,
      sourceProjectId,
      snapshot.snapshotSha256,
    );
    for (const chainSnapshot of snapshotChain) {
      await cp(
        join(
          workspacePaths(root).projects,
          sourceProjectId,
          "evidence",
          "snapshots",
          `${chainSnapshot.snapshotSha256}.json`,
        ),
        join(targetRoot, "evidence", "snapshots", `${chainSnapshot.snapshotSha256}.json`),
        { errorOnExist: true, force: false },
      );
    }
    await cp(sourceSnapshotPath, join(targetRoot, baseSnapshotLogicalPath), {
      errorOnExist: true,
      force: false,
    });
    inheritedOutputs.push(
      await fileRecord(join(targetRoot, baseSnapshotLogicalPath), baseSnapshotLogicalPath),
    );
    await cloneProjectEvidenceReceipts(root, sourceProjectId, targetProjectId);
    await cloneEvidenceLedger(root, sourceProjectId, targetProjectId);
    await cloneProjectArtifactRecords(root, sourceProjectId, targetProjectId);
    await appendEvidenceLedgerEvent(root, targetProjectId, "addendum.created", {
      sourceProjectId,
      targetProjectId,
      baseSnapshotId: snapshot.snapshotId,
      baseSnapshotSha256: snapshot.snapshotSha256,
    });
    await writeJsonAtomic(join(targetRoot, "project.json"), target);

    source.lineage.supersededBy = targetProjectId;
    source.evidenceState.staleReason = `Superseded by evidence addendum ${targetProjectId}.`;
    refreshProject(source);
    await saveProject(root, source);
    await appendEvidenceLedgerEvent(root, sourceProjectId, "project.superseded", {
      sourceProjectId,
      supersededBy: targetProjectId,
      snapshotId: snapshot.snapshotId,
      snapshotSha256: snapshot.snapshotSha256,
    });
    await appendJournalEvent(
      workspacePaths(root).journal,
      "project.addendum.created",
      targetProjectId,
      {
        sourceProjectId,
        targetProjectId,
        baseSnapshotId: snapshot.snapshotId,
        baseSnapshotSha256: snapshot.snapshotSha256,
        inheritedOutputs,
        originalClosurePreserved: true,
        publicationPolicySha256: targetPolicy?.resolvedPolicySha256 ?? null,
        scientificDesignSha256: targetScientificDesign?.designSha256 ?? null,
        scientificDesignProducerSessionSha256:
          targetScientificDesign?.producer.sessionSha256 ?? null,
      },
    );
    return target;
  });
}

export function refreshProject(project: ProjectState): ProjectState {
  if (project.status === "archived" || project.status === "abandoned") return project;
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
  if (project.lineage.supersededBy || project.evidenceState.staleReason) project.status = "stale";
  else if (project.handoff.state === "user-action-required") project.status = "waiting-user";
  else if (project.handoff.state === "external-response-required")
    project.status = "waiting-external";
  else if (project.packages.some((item) => item.status === "failed")) project.status = "blocked";
  else if (project.packages.every((item) => item.status === "complete"))
    project.status = "complete";
  else if (project.packages.some((item) => item.status === "running")) project.status = "running";
  else project.status = "ready";
  project.updatedAt = new Date().toISOString();
  return project;
}

export function nextReadyPackage(project: ProjectState): WorkPackage | undefined {
  refreshProject(project);
  if (project.handoff.state !== "agent-actionable") return undefined;
  const candidate = project.packages.find((workPackage) => workPackage.status === "ready");
  if (!candidate) return undefined;
  const gate = nextScientificGate(project);
  if (gate && gate.status !== "passed") {
    const packageOrder = ["discover", "acquire", "analyze", "synthesize", "review", "close"];
    if (packageOrder.indexOf(candidate.id) >= packageOrder.indexOf(gate.blocksPackage)) {
      return undefined;
    }
  }
  return candidate;
}

export function nextScientificGate(project: ProjectState): {
  role: ScientificReviewRole;
  blocksPackage: "discover" | "acquire" | "analyze";
  status: ScientificDesignBinding["gates"][ScientificReviewRole]["status"];
} | null {
  if (!project.scientificDesign) return null;
  const ordered: Array<{
    role: ScientificReviewRole;
    blocksPackage: "discover" | "acquire" | "analyze";
  }> = [
    { role: "research-design", blocksPackage: "discover" },
    { role: "evidence-construct", blocksPackage: "acquire" },
    { role: "pilot-methods", blocksPackage: "analyze" },
  ];
  for (const item of ordered) {
    const status = project.scientificDesign.gates[item.role].status;
    if (status !== "passed") return { ...item, status };
  }
  return null;
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
      "acquire",
      "acquire",
      "agent",
      "producer",
      ["discover"],
      ["outputs/acquisition.json"],
      maxAttempts,
    ),
    workPackage(
      "analyze",
      "analyze",
      "agent",
      "producer",
      ["acquire"],
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
    ![
      "ready",
      "running",
      "blocked",
      "complete",
      "stale",
      "waiting-user",
      "waiting-external",
      "archived",
      "abandoned",
    ].includes(project.status) ||
    typeof project.question !== "string" ||
    (project.budgetConfirmedAt !== null && typeof project.budgetConfirmedAt !== "string") ||
    !Array.isArray(project.inputs) ||
    !isEvidenceRequirements(project.evidenceRequirements) ||
    !isScientificDesignBinding(project.scientificDesign, expectedId) ||
    (Boolean(project.publicationPolicy) && project.scientificDesign === null) ||
    !Array.isArray(project.packages) ||
    !project.usage ||
    typeof project.usage.tokens !== "number" ||
    typeof project.usage.inputTokens !== "number" ||
    typeof project.usage.cachedInputTokens !== "number" ||
    typeof project.usage.outputTokens !== "number" ||
    typeof project.usage.costUsd !== "number" ||
    typeof project.usage.wallSeconds !== "number" ||
    !isProjectLineage(project.lineage) ||
    !isProjectHandoff(project.handoff) ||
    !isProjectEvidenceState(project.evidenceState)
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

function initialLineage(kind: ProjectState["lineage"]["kind"]): ProjectState["lineage"] {
  return {
    kind,
    derivedFrom: null,
    supersedes: null,
    supersededBy: null,
    baseSnapshotId: null,
    baseSnapshotSha256: null,
  };
}

function initialEvidenceState(): ProjectState["evidenceState"] {
  return {
    currentSnapshotId: null,
    currentSnapshotSha256: null,
    closureSnapshotId: null,
    staleReason: null,
  };
}

function initialHandoffState(): ProjectState["handoff"] {
  return {
    state: "agent-actionable",
    reasonCode: null,
    summary: null,
    requestedActions: [],
    evidenceGaps: [],
    requestedAt: null,
    resolvedAt: null,
    resolutionNote: null,
  };
}

function prepareScientificDesignBinding(
  projectId: string,
  policy: ResearchPolicyBinding,
  input: {
    design: VerifiedScientificDesign;
    producerAgent: AgentKind;
    producerSessionId: string;
  },
): ScientificDesignBinding {
  const contract = input.design.contract;
  const normalized = `${JSON.stringify(contract, null, 2)}\n`;
  if (
    contract.projectId !== projectId ||
    input.design.sha256 !== sha256Text(normalized) ||
    input.design.bytes !== Buffer.byteLength(normalized, "utf8")
  ) {
    throw new CliError("Scientific design does not match its verified project and hash binding.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_PROJECT_MISMATCH",
      exitCode: 2,
    });
  }
  if (!input.producerSessionId.trim()) {
    throw new CliError("Scientific design requires an opaque native producer session identifier.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_PRODUCER_INVALID",
      exitCode: 2,
    });
  }
  if (
    policy.targetJournal &&
    policy.targetJournal.trim().toLocaleLowerCase("en-US") !==
      contract.identity.targetJournals.primary.trim().toLocaleLowerCase("en-US")
  ) {
    throw new CliError("Scientific design primary journal does not match Research Policy.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_POLICY_MISMATCH",
      exitCode: 2,
    });
  }
  const expectedJournalApprovalStatus = policy.targetJournal ? "policy-approved" : "candidate-only";
  if (contract.identity.targetJournals.approvalStatus !== expectedJournalApprovalStatus) {
    throw new CliError(
      policy.targetJournal
        ? "An exact-journal Research Policy requires a policy-approved scientific design target."
        : "A generic Research Policy may list exact journals only as candidates.",
      {
        code: "RESEARCH_SCIENTIFIC_DESIGN_POLICY_MISMATCH",
        exitCode: 2,
        details: {
          expectedApprovalStatus: expectedJournalApprovalStatus,
          actualApprovalStatus: contract.identity.targetJournals.approvalStatus,
        },
      },
    );
  }
  const evaluation = evaluateScientificDesign(contract);
  if (!evaluation.readyForDesignReview) {
    throw new CliError("Scientific design has blocking mechanical issues.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_BLOCKED",
      exitCode: 3,
      details: { issueCodes: evaluation.issueCodes },
    });
  }
  const policyGaps = scientificDesignPolicyGaps(contract, policy);
  if (policyGaps.length) {
    throw new CliError("Scientific design does not discharge the approved Research Policy.", {
      code: "RESEARCH_SCIENTIFIC_DESIGN_POLICY_MISMATCH",
      exitCode: 3,
      details: { gaps: policyGaps },
    });
  }
  const pendingGate = () => ({
    status: "pending" as const,
    packetSha256: null,
    assessmentSha256: null,
    reviewSha256: null,
    reviewerSessionSha256: null,
  });
  return {
    schemaVersion: 1,
    designSha256: input.design.sha256,
    objectLocator: `projects/${projectId}/scientific/design/objects/${input.design.sha256}.json`,
    centralStudyKind: contract.identity.centralStudyKind,
    producer: {
      agent: input.producerAgent,
      sessionSha256: sha256Text(input.producerSessionId),
    },
    mechanicalIssueCodes: evaluation.issueCodes,
    gates: {
      "research-design": pendingGate(),
      "evidence-construct": pendingGate(),
      "pilot-methods": pendingGate(),
    },
  };
}

function isScientificDesignBinding(
  value: unknown,
  projectId: string,
): value is ScientificDesignBinding | null {
  if (value === null) return true;
  if (!isObject(value) || value.schemaVersion !== 1) return false;
  if (
    typeof value.designSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.designSha256) ||
    value.objectLocator !==
      `projects/${projectId}/scientific/design/objects/${value.designSha256}.json` ||
    typeof value.centralStudyKind !== "string" ||
    !isObject(value.producer) ||
    !["codex", "claude"].includes(String(value.producer.agent)) ||
    typeof value.producer.sessionSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.producer.sessionSha256) ||
    !Array.isArray(value.mechanicalIssueCodes) ||
    value.mechanicalIssueCodes.some((item) => typeof item !== "string") ||
    !isObject(value.gates)
  ) {
    return false;
  }
  const roles: ScientificReviewRole[] = ["research-design", "evidence-construct", "pilot-methods"];
  const gates = value.gates as Record<string, unknown>;
  return roles.every((role) => isScientificGateBinding(gates[role]));
}

function isScientificGateBinding(value: unknown): boolean {
  return (
    isObject(value) &&
    ["pending", "prepared", "passed", "revision-required", "stopped"].includes(
      String(value.status),
    ) &&
    nullableSha256(value.packetSha256) &&
    nullableSha256(value.assessmentSha256) &&
    nullableSha256(value.reviewSha256) &&
    nullableSha256(value.reviewerSessionSha256)
  );
}

function isProjectLineage(value: unknown): value is ProjectState["lineage"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lineage = value as Record<string, unknown>;
  return (
    ["primary", "fork", "addendum"].includes(String(lineage.kind)) &&
    nullableString(lineage.derivedFrom) &&
    nullableString(lineage.supersedes) &&
    nullableString(lineage.supersededBy) &&
    nullableString(lineage.baseSnapshotId) &&
    nullableSha256(lineage.baseSnapshotSha256)
  );
}

function isProjectEvidenceState(value: unknown): value is ProjectState["evidenceState"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    nullableString(state.currentSnapshotId) &&
    nullableSha256(state.currentSnapshotSha256) &&
    nullableString(state.closureSnapshotId) &&
    nullableString(state.staleReason)
  );
}

function isProjectHandoff(value: unknown): value is ProjectState["handoff"] {
  if (!isObject(value)) return false;
  return (
    ["agent-actionable", "user-action-required", "external-response-required"].includes(
      String(value.state),
    ) &&
    nullableString(value.reasonCode) &&
    nullableString(value.summary) &&
    Array.isArray(value.requestedActions) &&
    value.requestedActions.every((item) => typeof item === "string") &&
    Array.isArray(value.evidenceGaps) &&
    value.evidenceGaps.every((item) => typeof item === "string") &&
    nullableString(value.requestedAt) &&
    nullableString(value.resolvedAt) &&
    nullableString(value.resolutionNote)
  );
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableSha256(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

function defaultEvidenceRequirements(config: WorkspaceConfig): ProjectEvidenceRequirements {
  return config.mode === "production-research"
    ? {
        dimensions: ["research-question"],
        sourceTypes: ["primary"],
        requiredCapabilityIds: [],
        requiredCompanionIds: [],
        requiredDiscoveryScopes: [],
        minSources: 3,
        minFullTextSources: 1,
        minDatedSources: 1,
        publicationDateFrom: null,
        publicationDateTo: null,
      }
    : {
        dimensions: ["research-question"],
        sourceTypes: [],
        requiredCapabilityIds: [],
        requiredCompanionIds: [],
        requiredDiscoveryScopes: [],
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
    requiredCapabilityIds: [
      ...new Set((value.requiredCapabilityIds ?? []).map(normalizeRequirementId)),
    ].sort(),
    requiredCompanionIds: [
      ...new Set((value.requiredCompanionIds ?? []).map(normalizeRequirementId)),
    ].sort(),
    requiredDiscoveryScopes: [
      ...new Set((value.requiredDiscoveryScopes ?? []).map(normalizeRequirementId)),
    ].sort(),
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
    ((value as ProjectEvidenceRequirements).requiredCapabilityIds === undefined ||
      (Array.isArray((value as ProjectEvidenceRequirements).requiredCapabilityIds) &&
        (value as ProjectEvidenceRequirements).requiredCapabilityIds!.every(validRequirementId))) &&
    ((value as ProjectEvidenceRequirements).requiredCompanionIds === undefined ||
      (Array.isArray((value as ProjectEvidenceRequirements).requiredCompanionIds) &&
        (value as ProjectEvidenceRequirements).requiredCompanionIds!.every(validRequirementId))) &&
    ((value as ProjectEvidenceRequirements).requiredDiscoveryScopes === undefined ||
      (Array.isArray((value as ProjectEvidenceRequirements).requiredDiscoveryScopes) &&
        (value as ProjectEvidenceRequirements).requiredDiscoveryScopes!.every(
          validRequirementId,
        ))) &&
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
