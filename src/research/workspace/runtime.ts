import { randomUUID } from "node:crypto";
import { cp, lstat, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CliError } from "../../errors.js";
import {
  loadCapabilityDeclarations,
  stageLockedCapabilities,
  verifyCapabilities,
} from "./capabilities.js";
import { startCapabilityBroker, type CapabilityBroker } from "./broker.js";
import {
  commitAcquisitionAssessments,
  freezeEvidenceSnapshot,
  loadCurrentEvidenceSnapshot,
  loadImmutableEvidenceSnapshotChain,
  materializeAcquisitionAudit,
  parseMaterializedAcquisitionAudit,
} from "./acquisition.js";
import { stageEvidenceArtifacts } from "./artifacts.js";
import { commitDiscoveryDecisions, materializeDiscoveryEvidence } from "./discovery.js";
import { inspectDiscoveryProgress, type DiscoveryProgress } from "./discovery-status.js";
import { loadProjectEvidenceReceipts, stageProjectEvidence } from "./evidence.js";
import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  listEvidenceCandidates,
  registerProjectInputCandidates,
} from "./evidence-ledger.js";
import { executeAgent, type AgentExecutionRequest } from "./executor.js";
import { requiredDiscoveryCapabilityIds } from "./external-skills.js";
import { renderInputLineContext } from "./input-plan.js";
import { appendJournalEvent, readJournal, verifyJournal } from "./journal.js";
import {
  calculateAgentCallTokenReservation,
  RESEARCH_BROKER_MAX_TURNS,
  RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
  RESEARCH_MAX_REPAIR_SOURCE_BYTES,
  RESEARCH_REPAIR_MAX_TURNS,
  researchStructuredOutputMaxTurns,
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
import {
  parseEvidenceRecord,
  schemaForDiscoveryAssessmentBatch,
  parseStructuredStageOutput,
  schemaForStage,
  StructuredOutputError,
} from "./schemas.js";
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
    | "native-stage-required"
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
  return runResearchWorkspaceInternal(root, options, packageExecutor, false);
}

/** @internal Test-only seam for exercising deterministic package admission with fake agents. */
export async function runResearchWorkspaceWithInjectedProducerForTesting(
  root: string,
  options: RunOptions,
  packageExecutor: PackageExecutor,
): Promise<WorkspaceRunResult> {
  return runResearchWorkspaceInternal(root, options, packageExecutor, true);
}

async function runResearchWorkspaceInternal(
  root: string,
  options: RunOptions,
  packageExecutor: PackageExecutor,
  allowInjectedProducerForTesting: boolean,
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
          "Production research requires a current successful independent-reviewer doctor smoke.",
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
            (allowInjectedProducerForTesting || item.workPackage?.executor !== "producer") &&
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

export interface NativeStagePacket {
  schemaVersion: 1;
  kind: "tiangong-native-research-stage";
  sessionId: string;
  projectId: string;
  packageId: string;
  stage: "discover" | "acquire" | "analyze" | "synthesize";
  hostAgent: AgentRoute["agent"];
  expectedModel: string | null;
  preparedAt: string;
  bindingSha256: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  discovery: DiscoveryProgress | null;
  limits: {
    maxOutputBytes: number;
    maxOutputTokens: number;
    reservedPackageTokens: number;
    reservedMaxCostUsd: number;
    maxWallSeconds: number;
  };
  commands: {
    fetchEvidence: { argv: string[]; requestSchema: Record<string, unknown> } | null;
    registerCandidate: { argv: string[]; recordSchema: Record<string, unknown> } | null;
    recordAssessment: { argv: string[]; recordSchema: Record<string, unknown> } | null;
    registerArtifact: {
      argv: string[];
      supportedMediaTypes: string[];
      optionalMetadataFields: string[];
    } | null;
    submit: { argv: string[] };
    abort: { argv: string[] };
  };
  rules: string[];
  packetSha256: string;
}

interface NativeStageSession {
  schemaVersion: 1;
  kind: "tiangong-native-research-stage-session";
  packet: NativeStagePacket;
  capsuleRoot: string;
  capsuleProject: string;
  sessionSha256: string;
}

export interface NativeStageStatus {
  status: "none" | "active" | "stale" | "invalid";
  sessionId: string | null;
  stage: string | null;
  preparedAt: string | null;
  reasonCode: string | null;
  recommendedAction: string | null;
}

export async function inspectNativeResearchStage(
  root: string,
  project: ProjectState,
): Promise<NativeStageStatus> {
  const path = nativeStageSessionPath(root, project.id);
  if (!(await pathExists(path))) {
    return {
      status: "none",
      sessionId: null,
      stage: null,
      preparedAt: null,
      reasonCode: null,
      recommendedAction: null,
    };
  }
  try {
    const session = await readNativeStageSession(root, project.id);
    const workPackage = packageById(project, session.packet.packageId);
    const actualBinding = await nativeStageBinding(root, project, workPackage);
    const config = await loadWorkspaceConfig(root);
    const elapsedSeconds = Math.max(
      0,
      (Date.now() - Date.parse(session.packet.preparedAt)) / 1_000,
    );
    const reasonCode =
      workPackage.status !== "running"
        ? "package-not-running"
        : actualBinding !== session.packet.bindingSha256
          ? "binding-drift"
          : elapsedSeconds > config.budget.packageMaxWallSeconds[session.packet.stage]
            ? "wall-time-expired"
            : null;
    return {
      status: reasonCode ? "stale" : "active",
      sessionId: session.packet.sessionId,
      stage: session.packet.stage,
      preparedAt: session.packet.preparedAt,
      reasonCode,
      recommendedAction: reasonCode
        ? `tiangong-ai research project stage abort ${project.id} --session ${session.packet.sessionId} --workspace ${root}`
        : `Resume the current native ${session.packet.stage} stage and submit with the packet command.`,
    };
  } catch (error) {
    return {
      status: "invalid",
      sessionId: null,
      stage: null,
      preparedAt: null,
      reasonCode: error instanceof CliError ? error.code : "RESEARCH_NATIVE_STAGE_SESSION_INVALID",
      recommendedAction:
        "Inspect the invalid native session and use the explicit abort/retry recovery path; do not delete control files manually.",
    };
  }
}

export async function prepareNativeResearchStage(input: {
  root: string;
  projectId: string;
  stage: "discover" | "acquire" | "analyze" | "synthesize";
  hostAgent: AgentRoute["agent"];
}): Promise<NativeStagePacket> {
  return withWorkspaceLock(input.root, "research.native-stage.prepare", async () => {
    await verifyJournal(workspacePaths(input.root).journal);
    const config = await loadWorkspaceConfig(input.root);
    assertExecutionConfiguration(config);
    if (config.producer.agent !== input.hostAgent) {
      throw new CliError(
        `This workspace requires the current native ${config.producer.agent} host, not ${input.hostAgent}.`,
        { code: "RESEARCH_NATIVE_HOST_MISMATCH", exitCode: 3 },
      );
    }
    const capabilityVerification = await verifyCapabilities(input.root);
    if (capabilityVerification.status !== "verified") {
      throw new CliError("Native research requires verified capability locks.", {
        code: "RESEARCH_CAPABILITY_DRIFT",
        exitCode: 3,
        details: capabilityVerification,
      });
    }
    if (config.mode === "production-research") {
      const attestation = await verifyDoctorAttestation(input.root);
      if (attestation.status !== "verified") {
        throw new CliError("Native research requires a current independent-reviewer attestation.", {
          code: "RESEARCH_DOCTOR_ATTESTATION_REQUIRED",
          exitCode: 3,
          details: { status: attestation.status, errors: attestation.errors },
        });
      }
    }
    const project = await loadProject(input.root, input.projectId);
    if (input.stage === "discover") {
      await registerProjectInputCandidates(input.root, project.id, project.inputs);
    }
    if (input.stage === "analyze" || input.stage === "synthesize") {
      await loadCurrentEvidenceSnapshot(input.root, project.id);
    }
    if (
      config.mode === "production-research" &&
      config.budget.maxCostUsd > config.budget.confirmationCostUsd &&
      !project.budgetConfirmedAt
    ) {
      throw new CliError("Production research budget has not been explicitly confirmed.", {
        code: "RESEARCH_BUDGET_CONFIRMATION_REQUIRED",
        exitCode: 3,
      });
    }
    const activePath = nativeStageSessionPath(input.root, project.id);
    if (await pathExists(activePath)) {
      const active = await readNativeStageSession(input.root, project.id);
      if (
        active.packet.stage === input.stage &&
        active.packet.hostAgent === input.hostAgent &&
        project.packages.find((item) => item.id === active.packet.packageId)?.status === "running"
      ) {
        await assertNativeStageBinding(input.root, project, active.packet);
        return active.packet;
      }
      throw new CliError("Another native stage session is already active for this project.", {
        code: "RESEARCH_NATIVE_STAGE_ACTIVE",
        exitCode: 3,
        details: { sessionId: active.packet.sessionId, stage: active.packet.stage },
      });
    }
    const workPackage = nextReadyPackage(project);
    if (!workPackage || workPackage.executor !== "producer" || workPackage.stage !== input.stage) {
      throw new CliError(`Stage ${input.stage} is not the next native producer package.`, {
        code: "RESEARCH_NATIVE_STAGE_NOT_READY",
        exitCode: 3,
        details: { readyPackage: workPackage?.id ?? null },
      });
    }
    if (workPackage.attempts >= workPackage.maxAttempts) {
      throw new CliError("Native producer package exhausted its reviewed attempt limit.", {
        code: "RESEARCH_PACKAGE_ATTEMPTS_EXHAUSTED",
        exitCode: 3,
      });
    }
    const discovery =
      input.stage === "discover"
        ? await inspectDiscoveryProgress(input.root, project, config)
        : null;
    const reservedPackageTokens =
      discovery?.plan.reservedDiscoverTokens ?? config.budget.packageMaxTokens[input.stage];
    const stageOutputTokens = discovery?.plan.outputTokenLimit ?? config.budget.maxOutputTokens;
    const reservation = reservePackageBudget(project, workPackage, config, reservedPackageTokens);
    const sessionId = randomUUID();
    let capsule: Capsule | null = null;
    let preparedStatePersisted = false;
    try {
      capsule = await createCapsule(input.root, project, workPackage, sessionId, config);
      const stageContextContent = await stageContextForPackage(
        capsule.projectRoot,
        project,
        workPackage,
        config,
      );
      const declarations = await loadCapabilityDeclarations(input.root);
      const hasBrokeredEvidence = declarations.capabilities.some((capability) =>
        capability.permissions.includes("brokered-network"),
      );
      const basePrompt = packagePrompt(
        project,
        workPackage,
        capsule.inputManifest,
        capsule.stagedSkills,
        capsule.capabilityDocumentation,
        null,
        capsule.contextBundle,
        capsule.contextBundleContent,
        stageContextContent,
        discovery,
        await listEvidenceCandidates(input.root, project.id),
      );
      const prompt = [
        "Perform this producer stage in the current interactive host session. Do not launch codex exec, claude -p, or any other nested reasoning agent.",
        input.stage === "discover" && hasBrokeredEvidence
          ? "For every internet/database request, write one non-secret request JSON file and invoke the packet's fetchEvidence argv through the CLI control plane. Use only its returned bounded context and receipt. Assess candidates in bounded batches with recordAssessment as they arrive; the final output is only a small coverage closeout. Do not use standalone web search as evidence."
          : input.stage === "acquire"
            ? "Acquire the provisionally admitted sources with the installed external acquisition/document Skills or an explicitly selected user-authorized browser. Register each exact downloaded/decomposed file with registerArtifact before submitting the audit. Never scan a download directory or infer success from file existence."
            : "Do not acquire additional evidence in this stage.",
        basePrompt,
        "Save only the final schema-conforming JSON object to a new regular file, then submit it with the packet's submit command. The CLI remains the sole authority for validation and atomic promotion.",
      ].join("\n\n");
      const preparedAt = new Date().toISOString();
      const bindingSha256 = await nativeStageBinding(input.root, project, workPackage);
      const packetCore = {
        schemaVersion: 1 as const,
        kind: "tiangong-native-research-stage" as const,
        sessionId,
        projectId: project.id,
        packageId: workPackage.id,
        stage: input.stage,
        hostAgent: input.hostAgent,
        expectedModel: config.producer.model,
        preparedAt,
        bindingSha256,
        prompt,
        outputSchema: schemaForStage(
          input.stage,
          null,
          input.stage === "discover" && !hasBrokeredEvidence
            ? { inputOnlyProvenanceIds: capsule.inputManifest.map((record) => record.id) }
            : {},
        ),
        discovery,
        limits: {
          maxOutputBytes: config.budget.maxBytesPerPackage,
          maxOutputTokens: stageOutputTokens,
          reservedPackageTokens,
          reservedMaxCostUsd: reservation.costUsd,
          maxWallSeconds: config.budget.packageMaxWallSeconds[input.stage],
        },
        commands: {
          fetchEvidence:
            input.stage === "discover" && hasBrokeredEvidence
              ? {
                  argv: [
                    "tiangong-ai",
                    "research",
                    "project",
                    "evidence",
                    "fetch",
                    project.id,
                    "--request",
                    "<absolute-request.json>",
                    "--workspace",
                    input.root,
                    "--json",
                  ],
                  requestSchema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["capability_id", "url"],
                    properties: {
                      capability_id: { type: "string" },
                      credential_id: { type: "string" },
                      url: { type: "string", format: "uri" },
                      request_body: { type: "object" },
                      json_pointer: { type: "string" },
                      item_offset: { type: "integer", minimum: 0 },
                      max_items: { type: "integer", minimum: 1 },
                      cache_mode: { enum: ["prefer", "bypass"] },
                    },
                  },
                }
              : null,
          registerArtifact:
            input.stage === "acquire"
              ? {
                  argv: [
                    "tiangong-ai",
                    "research",
                    "project",
                    "evidence",
                    "artifact",
                    "register",
                    project.id,
                    "--candidate",
                    "<candidate-id>",
                    "--path",
                    "<absolute-file>",
                    "--media-type",
                    "<media-type>",
                    "--workspace",
                    input.root,
                    "--json",
                  ],
                  supportedMediaTypes: [
                    "application/pdf",
                    "application/json",
                    "text/plain",
                    "text/markdown",
                    "text/csv",
                    "text/html",
                    "application/zip",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                  ],
                  optionalMetadataFields: [
                    "source-url",
                    "license",
                    "license-url",
                    "host-type",
                    "article-version",
                  ],
                }
              : null,
          recordAssessment:
            input.stage === "discover"
              ? {
                  argv: [
                    "tiangong-ai",
                    "research",
                    "project",
                    "evidence",
                    "assessment",
                    "record",
                    project.id,
                    "--record",
                    "<absolute-assessment-batch.json>",
                    "--workspace",
                    input.root,
                    "--json",
                  ],
                  recordSchema: schemaForDiscoveryAssessmentBatch(),
                }
              : null,
          registerCandidate:
            input.stage === "discover"
              ? {
                  argv: [
                    "tiangong-ai",
                    "research",
                    "project",
                    "evidence",
                    "candidate",
                    "register",
                    project.id,
                    "--record",
                    "<absolute-candidate.json>",
                    "--workspace",
                    input.root,
                    "--json",
                  ],
                  recordSchema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["title"],
                    anyOf: [{ required: ["url"] }, { required: ["doi"] }],
                    properties: {
                      title: { type: "string" },
                      url: { type: "string", format: "uri" },
                      doi: { type: "string" },
                      publicationDate: { type: "string" },
                      excerpt: { type: "string" },
                    },
                  },
                }
              : null,
          submit: {
            argv: [
              "tiangong-ai",
              "research",
              "project",
              "stage",
              "submit",
              project.id,
              "--session",
              sessionId,
              "--output",
              "<absolute-output.json>",
              ...(config.producer.model ? ["--confirm-model", config.producer.model] : []),
              "--workspace",
              input.root,
              "--json",
            ],
          },
          abort: {
            argv: [
              "tiangong-ai",
              "research",
              "project",
              "stage",
              "abort",
              project.id,
              "--session",
              sessionId,
              "--workspace",
              input.root,
              "--json",
            ],
          },
        },
        rules: [
          "Current native host performs producer reasoning; the CLI does not spawn a producer.",
          "Only broker receipts or registered immutable inputs may support discover output.",
          "Only exact, structurally validated, content-addressed artifacts may support full-text acquisition claims.",
          "Do not place credentials, cookies, authorization data, or sensitive URL parameters in request/output files.",
          "A file's existence is not success; submit performs schema, provenance, budget, hash, and atomic-commit checks.",
        ],
      };
      const packet: NativeStagePacket = {
        ...packetCore,
        packetSha256: sha256Text(canonicalJson(packetCore)),
      };
      const sessionCore = {
        schemaVersion: 1 as const,
        kind: "tiangong-native-research-stage-session" as const,
        packet,
        capsuleRoot: capsule.capsuleRoot,
        capsuleProject: capsule.projectRoot,
      };
      const session: NativeStageSession = {
        ...sessionCore,
        sessionSha256: sha256Text(canonicalJson(sessionCore)),
      };
      const now = new Date().toISOString();
      workPackage.status = "running";
      workPackage.attempts += 1;
      workPackage.startedAt = now;
      workPackage.completedAt = null;
      workPackage.lastError = null;
      workPackage.lastFailureKind = null;
      workPackage.retryNotBefore = null;
      refreshProject(project);
      await ensureDirectory(dirname(activePath));
      await writeJsonAtomic(activePath, session);
      await saveProject(input.root, project);
      preparedStatePersisted = true;
      await appendJournalEvent(
        workspacePaths(input.root).journal,
        "native.stage.prepared",
        project.id,
        {
          sessionId,
          packetSha256: packet.packetSha256,
          bindingSha256,
          projectId: project.id,
          packageId: workPackage.id,
          stage: input.stage,
          hostAgent: input.hostAgent,
          expectedModel: config.producer.model,
          accountingMode: "reserved-native-host",
        },
      );
      return packet;
    } catch (error) {
      if (!preparedStatePersisted) {
        await rm(activePath, { force: true });
        if (capsule) await rm(capsule.capsuleRoot, { recursive: true, force: true });
      }
      throw error;
    }
  });
}

export async function submitNativeResearchStage(input: {
  root: string;
  projectId: string;
  sessionId: string;
  outputPath: string;
  confirmedModel: string | null;
}): Promise<{
  projectId: string;
  packageId: string;
  stage: string;
  status: "complete";
  outputs: OutputRecord[];
  usage: Record<string, unknown>;
}> {
  return withWorkspaceLock(input.root, "research.native-stage.submit", async () => {
    const session = await readNativeStageSession(input.root, input.projectId);
    if (session.packet.sessionId !== input.sessionId) {
      throw new CliError("Native stage session ID does not match the active session.", {
        code: "RESEARCH_NATIVE_STAGE_SESSION_MISMATCH",
        exitCode: 3,
      });
    }
    const outputPath = requireNativeOutputPath(input.outputPath);
    const outputInfo = await lstat(outputPath).catch(() => undefined);
    if (!outputInfo?.isFile() || outputInfo.isSymbolicLink()) {
      throw new CliError("Native stage output must be an existing regular non-symlink file.", {
        code: "RESEARCH_NATIVE_STAGE_OUTPUT_INVALID",
        exitCode: 2,
      });
    }
    if (outputInfo.size > session.packet.limits.maxOutputBytes) {
      throw new CliError("Native stage output exceeds the reviewed byte limit.", {
        code: "RESEARCH_NATIVE_STAGE_OUTPUT_INVALID",
        exitCode: 3,
      });
    }
    const raw = await readFile(outputPath, "utf8");
    const config = await loadWorkspaceConfig(input.root);
    assertExecutionConfiguration(config);
    if (input.confirmedModel !== session.packet.expectedModel) {
      throw new CliError("The confirmed native model does not match the reviewed route.", {
        code: "RESEARCH_NATIVE_MODEL_MISMATCH",
        exitCode: 3,
        details: { expectedModel: session.packet.expectedModel },
      });
    }
    const project = await loadProject(input.root, input.projectId);
    const workPackage = packageById(project, session.packet.packageId);
    if (workPackage.status !== "running" || workPackage.executor !== "producer") {
      throw new CliError("The bound native producer package is no longer running.", {
        code: "RESEARCH_NATIVE_STAGE_SESSION_MISMATCH",
        exitCode: 3,
      });
    }
    await assertNativeStageBinding(input.root, project, session.packet);
    try {
      await materializeAndValidateStageOutput(
        input.root,
        project,
        session.capsuleProject,
        workPackage,
        raw,
        null,
      );
      const elapsed = Math.max(0.001, (Date.now() - Date.parse(session.packet.preparedAt)) / 1_000);
      const outputTokens = Math.ceil(
        Buffer.byteLength(raw, "utf8") / RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
      );
      const reservedTokens = session.packet.limits.reservedPackageTokens;
      const result: ExecutionResult = {
        exitCode: 0,
        stdout: raw,
        stderr: "",
        tokens: reservedTokens,
        inputTokens: Math.max(0, reservedTokens - outputTokens),
        cachedInputTokens: 0,
        outputTokens,
        costUsd: roundMoney(reservedAgentPackageCost(config.producer, reservedTokens, config)),
        wallSeconds: elapsed,
        model: config.producer.model,
        runtime: null,
      };
      assertActualPackageBudget(
        project,
        workPackage,
        config,
        result,
        session.packet.limits.maxOutputTokens,
      );
      assertProjectedBudget(project, config, result);
      if (workPackage.stage === "discover") {
        await assertDiscoveryCoverage(
          input.root,
          project,
          resolveContained(session.capsuleProject, "outputs/evidence.json"),
        );
      }
      const outputs = await validateAndImportOutputs(
        input.root,
        project,
        workPackage,
        session.capsuleProject,
        config,
        null,
      );
      if (workPackage.stage === "discover") {
        await commitDiscoveryDecisions(
          input.root,
          project.id,
          parseStructuredStageOutput("discover", raw).value,
        );
      }
      if (workPackage.stage === "acquire") {
        const audit = parseMaterializedAcquisitionAudit(
          JSON.parse(
            await readFile(
              join(projectRoot(input.root, project.id), "outputs", "acquisition.json"),
              "utf8",
            ),
          ),
        );
        await commitAcquisitionAssessments(input.root, project.id, audit);
        await freezeEvidenceSnapshot(input.root, project);
        outputs.push(
          await fileRecord(
            join(projectRoot(input.root, project.id), "outputs", "evidence-snapshot.json"),
            "outputs/evidence-snapshot.json",
          ),
        );
      }
      await commitStageEvidenceBindings(input.root, project, workPackage);
      applyUsage(project, result);
      workPackage.status = "complete";
      workPackage.completedAt = new Date().toISOString();
      workPackage.lastError = null;
      workPackage.lastFailureKind = null;
      workPackage.retryNotBefore = null;
      refreshProject(project);
      await saveProject(input.root, project);
      await writeRunRecord(input.root, {
        schemaVersion: 1,
        runId: session.packet.sessionId,
        projectId: project.id,
        packageId: workPackage.id,
        executor: config.producer.agent,
        startedAt: session.packet.preparedAt,
        completedAt: workPackage.completedAt,
        exitCode: 0,
        tokens: result.tokens,
        inputTokens: result.inputTokens,
        cachedInputTokens: result.cachedInputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        wallSeconds: result.wallSeconds,
        outputs,
        stdoutSha256: sha256Text(raw),
        stderrSha256: sha256Text(""),
        failureKind: null,
        failureDetails: null,
        runtime: null,
        accountingMode: "reserved-native-host",
      });
      const usage = { ...usageSlice(result), accountingMode: "reserved-native-host" };
      await appendJournalEvent(
        workspacePaths(input.root).journal,
        "native.stage.completed",
        project.id,
        {
          sessionId: session.packet.sessionId,
          packetSha256: session.packet.packetSha256,
          projectId: project.id,
          packageId: workPackage.id,
          stage: workPackage.stage,
          outputs,
          usage,
        },
      );
      await rm(nativeStageSessionPath(input.root, project.id), { force: true });
      await rm(session.capsuleRoot, { recursive: true, force: true });
      return {
        projectId: project.id,
        packageId: workPackage.id,
        stage: workPackage.stage,
        status: "complete",
        outputs,
        usage,
      };
    } catch (error) {
      await appendJournalEvent(
        workspacePaths(input.root).journal,
        "native.stage.submit.rejected",
        input.projectId,
        {
          sessionId: session.packet.sessionId,
          packetSha256: session.packet.packetSha256,
          error: bounded(
            sanitizeResearchText(error instanceof Error ? error.message : String(error)),
            1_000,
          ),
        },
      );
      throw error;
    }
  });
}

export async function abortNativeResearchStage(input: {
  root: string;
  projectId: string;
  sessionId: string;
}): Promise<{ projectId: string; packageId: string; status: "ready" | "blocked" }> {
  return withWorkspaceLock(input.root, "research.native-stage.abort", async () => {
    const session = await readNativeStageSession(input.root, input.projectId);
    if (session.packet.sessionId !== input.sessionId) {
      throw new CliError("Native stage session ID does not match the active session.", {
        code: "RESEARCH_NATIVE_STAGE_SESSION_MISMATCH",
        exitCode: 3,
      });
    }
    const project = await loadProject(input.root, input.projectId);
    const workPackage = packageById(project, session.packet.packageId);
    if (workPackage.status !== "running") {
      throw new CliError("The native stage package is not running.", {
        code: "RESEARCH_NATIVE_STAGE_SESSION_MISMATCH",
        exitCode: 3,
      });
    }
    workPackage.status = workPackage.attempts < workPackage.maxAttempts ? "retry" : "failed";
    workPackage.completedAt = new Date().toISOString();
    workPackage.lastError = "Native stage was explicitly aborted before submission.";
    workPackage.lastFailureKind = "deterministic";
    workPackage.retryNotBefore = null;
    refreshProject(project);
    await saveProject(input.root, project);
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "native.stage.aborted",
      project.id,
      {
        sessionId: session.packet.sessionId,
        packetSha256: session.packet.packetSha256,
        projectId: project.id,
        packageId: workPackage.id,
        stage: workPackage.stage,
      },
    );
    await rm(nativeStageSessionPath(input.root, project.id), { force: true });
    await rm(session.capsuleRoot, { recursive: true, force: true });
    return {
      projectId: project.id,
      packageId: workPackage.id,
      status: project.status === "blocked" ? "blocked" : "ready",
    };
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
      if (["analyze", "synthesize", "review"].includes(workPackage.stage)) {
        await loadCurrentEvidenceSnapshot(root, project.id);
      }
      const discovery =
        workPackage.stage === "discover"
          ? await inspectDiscoveryProgress(root, project, config)
          : null;
      const stageOutputTokens = discovery?.plan.outputTokenLimit ?? config.budget.maxOutputTokens;
      const reservation = reservePackageBudget(
        project,
        workPackage,
        config,
        discovery?.plan.reservedDiscoverTokens,
      );
      const capsule = await createCapsule(root, project, workPackage, runId, config);
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
        project,
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
          capsule.capabilityDocumentation,
          capsule.reviewPacketSha256,
          capsule.contextBundle,
          capsule.contextBundleContent,
          stageContextContent,
          discovery,
          await listEvidenceCandidates(root, project.id),
        ),
        brokerUrl: primaryBrokerUrl,
        inputOnlyProvenance,
        maxOutputTokens: Math.min(stageOutputTokens, reservation.tokens),
        ...(discovery ? { brokerCallBudget: discovery.plan.maxCalls } : {}),
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
      assertActualPackageBudget(project, workPackage, config, result, stageOutputTokens);
      let acceptedRaw = result.stdout;
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
          stageOutputTokens + config.budget.maxRepairTokens,
        );
        acceptedRaw = repair.stdout;
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
        await assertDiscoveryCoverage(root, project);
        await commitDiscoveryDecisions(
          root,
          project.id,
          parseStructuredStageOutput("discover", acceptedRaw).value,
        );
      }
      if (workPackage.stage === "acquire") {
        const audit = parseMaterializedAcquisitionAudit(
          JSON.parse(
            await readFile(
              join(projectRoot(root, project.id), "outputs", "acquisition.json"),
              "utf8",
            ),
          ),
        );
        await commitAcquisitionAssessments(root, project.id, audit);
        await freezeEvidenceSnapshot(root, project);
        promotedOutputs.push(
          await fileRecord(
            join(projectRoot(root, project.id), "outputs", "evidence-snapshot.json"),
            "outputs/evidence-snapshot.json",
          ),
        );
      }
      await commitStageEvidenceBindings(root, project, workPackage);
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
  capabilityDocumentation: string;
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
  config: WorkspaceConfig,
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
  const frozenSnapshot = ["analyze", "synthesize", "review"].includes(workPackage.stage)
    ? await loadCurrentEvidenceSnapshot(root, project.id)
    : null;
  const evidenceArtifacts = frozenSnapshot
    ? await stageEvidenceArtifacts(
        root,
        project.id,
        capsuleProject,
        new Set(frozenSnapshot.artifacts.map((artifact) => artifact.artifactId)),
      )
    : [];
  if (
    (workPackage.stage === "analyze" || workPackage.stage === "synthesize") &&
    evidenceArtifacts.length
  ) {
    await writeProducerArtifactContext(
      capsuleProject,
      evidenceArtifacts,
      Math.floor((config.budget.maxInputContextTokens * RESEARCH_ESTIMATED_BYTES_PER_TOKEN) / 2),
    );
  }
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
  const capabilityDocumentation = await buildCapabilityDocumentation(
    capsuleProject,
    stagedSkills,
    config.budget.maxInputContextTokens * RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
  );
  const reviewEvidenceContext =
    workPackage.stage === "review"
      ? await writeReviewEvidenceContext(
          root,
          project.id,
          capsuleProject,
          contextBundleContent,
          evidenceReceipts,
          evidenceArtifacts,
          config.budget.maxInputContextTokens * RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
        )
      : null;
  const reviewPacket = reviewEvidenceContext
    ? await writeReviewPacket(
        root,
        capsuleProject,
        project,
        inputManifest,
        evidenceReceipts,
        evidenceArtifacts,
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
    capabilityDocumentation,
    reviewPacketSha256: reviewPacket?.sha256 ?? null,
    reviewPacketRecord: reviewPacket?.record ?? null,
  };
}

async function buildCapabilityDocumentation(
  capsuleProject: string,
  stagedSkills: string[],
  maxBytes: number,
): Promise<string> {
  const documents = [
    {
      path: "skills/manifest.json",
      content: await readFile(join(capsuleProject, "skills", "manifest.json"), "utf8"),
    },
  ];
  for (const skillPath of stagedSkills) {
    documents.push({
      path: `skills/${basename(skillPath)}/SKILL.md`,
      content: await readFile(join(skillPath, "SKILL.md"), "utf8"),
    });
  }
  const bundle = documents
    .map((document) => `--- ${document.path} ---\n${document.content.trimEnd()}`)
    .join("\n\n");
  const bytes = Buffer.byteLength(bundle, "utf8");
  if (bytes > maxBytes) {
    throw new CliError("Staged external Skill documentation exceeds the input context budget.", {
      code: "RESEARCH_CAPABILITY_CONTEXT_BUDGET_EXCEEDED",
      exitCode: 3,
      details: { bytes, maxBytes, skills: stagedSkills.map((path) => basename(path)) },
    });
  }
  return bundle;
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
  evidenceArtifacts: Awaited<ReturnType<typeof stageEvidenceArtifacts>>,
  reviewEvidenceContext: OutputRecord,
): Promise<{ sha256: string; record: OutputRecord }> {
  const snapshot = await loadCurrentEvidenceSnapshot(root, project.id);
  const immutableSnapshots = await loadImmutableEvidenceSnapshotChain(
    root,
    project.id,
    snapshot.snapshotSha256,
  );
  const snapshotChain = await Promise.all(
    immutableSnapshots.map((immutableSnapshot) => {
      const sha256 = immutableSnapshot.snapshotSha256;
      const logicalPath = `evidence/snapshots/${sha256}.json`;
      return fileRecord(resolveContained(projectRoot(root, project.id), logicalPath), logicalPath);
    }),
  );
  const artifactPaths = [
    "outputs/evidence.json",
    "outputs/acquisition.json",
    "outputs/evidence-snapshot.json",
    "outputs/analysis.json",
    "outputs/report.md",
  ];
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
  for (const artifact of evidenceArtifacts) {
    if (!evidenceFiles.has(artifact.locator)) {
      evidenceFiles.set(
        artifact.locator,
        await fileRecord(resolveContained(capsuleProject, artifact.locator), artifact.locator),
      );
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
    evidenceSnapshot: {
      snapshotId: snapshot.snapshotId,
      snapshotSha256: snapshot.snapshotSha256,
      parentSnapshotId: snapshot.parentSnapshotId,
      parentSnapshotSha256: snapshot.parentSnapshotSha256,
    },
    snapshotChain,
    inputs: inputManifest,
    reviewEvidenceContext,
    inputFiles: [...inputFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
    evidenceReceipts: evidenceReceipts.map(reviewSafeReceipt),
    evidenceArtifacts,
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
  evidenceArtifacts: Awaited<ReturnType<typeof stageEvidenceArtifacts>>,
  maxBytes: number,
): Promise<{ capsule: OutputRecord; persistent: OutputRecord }> {
  const header = [
    "TIANGONG REVIEW EVIDENCE CONTEXT v1",
    "The following are deterministic excerpts from hash-verified bounded views. Full objects and original bounded contexts remain bound in the review packet.",
  ].join("\n");
  const brokerReferences = await loadBrokerReviewReferences(capsuleProject);
  const views: Array<{ prefix: string; content: string; suffix: string; active: boolean }> = [
    {
      prefix: "--- LOCAL INPUT CONTEXT BUNDLE ---\n--- BEGIN BOUNDED REVIEW EXCERPT ---\n",
      content: sanitizeResearchText(inputContextBundle.trimEnd()),
      suffix: "\n--- END BOUNDED REVIEW EXCERPT ---",
      active: true,
    },
  ];
  const seenUnreferencedContexts = new Set<string>();
  const orderedReceipts = [...evidenceReceipts].sort((left, right) => {
    const leftReferenced = (brokerReferences.get(left.attemptId)?.length ?? 0) > 0;
    const rightReferenced = (brokerReferences.get(right.attemptId)?.length ?? 0) > 0;
    if (leftReferenced !== rightReferenced) return leftReferenced ? -1 : 1;
    return left.attemptId.localeCompare(right.attemptId);
  });
  for (const receipt of orderedReceipts) {
    const metadata = reviewSafeReceipt(receipt);
    const references = brokerReferences.get(receipt.attemptId) ?? [];
    // Every admitted receipt gets its own exact projection even when another
    // request produced identical bounded bytes. Only uncited duplicate views
    // may be collapsed; otherwise random receipt UUID ordering can hide the
    // one receipt actually cited by evidence.json.
    if (references.length === 0 && seenUnreferencedContexts.has(receipt.contextLocator)) continue;
    if (references.length === 0) seenUnreferencedContexts.add(receipt.contextLocator);
    const content = references.length
      ? await citedBrokerReviewContent(capsuleProject, receipt, references)
      : "[No admitted evidence source cites this receipt; its raw object and bounded context remain hash-bound in the review packet.]";
    views.push({
      prefix: [
        `--- BROKER RECEIPT ${receipt.attemptId} ---`,
        `metadata: ${JSON.stringify(metadata)}`,
        "--- BEGIN BOUNDED REVIEW EXCERPT ---",
        "",
      ].join("\n"),
      content: content.trimEnd(),
      suffix: "\n--- END BOUNDED REVIEW EXCERPT ---",
      active: references.length > 0,
    });
  }
  for (const artifact of [...evidenceArtifacts].sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId),
  )) {
    const textArtifact = reviewableTextContentType(artifact.mediaType);
    const content = textArtifact
      ? sanitizeResearchText(
          (await readFile(resolveContained(capsuleProject, artifact.locator), "utf8")).trimEnd(),
        )
      : "[Binary artifact omitted from model context; the complete structurally validated file remains hash-bound in the persistent review packet.]";
    const safeMetadata = {
      artifactId: artifact.artifactId,
      candidateId: artifact.candidateId,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      mediaType: artifact.mediaType,
      originalFilename: artifact.originalFilename,
      locator: artifact.locator,
      validation: artifact.validation,
    };
    views.push({
      prefix: [
        `--- FROZEN EVIDENCE ARTIFACT ${artifact.artifactId} ---`,
        `metadata: ${JSON.stringify(safeMetadata)}`,
        "--- BEGIN BOUNDED REVIEW EXCERPT ---",
        "",
      ].join("\n"),
      content,
      suffix: "\n--- END BOUNDED REVIEW EXCERPT ---",
      active: textArtifact,
    });
  }
  const fixedContent = [
    header,
    ...views.map((view) => `${view.prefix}${view.active ? "" : view.content}${view.suffix}`),
  ].join("\n\n");
  const fixedBytes = Buffer.byteLength(`${fixedContent}\n`, "utf8");
  if (fixedBytes > maxBytes) {
    throw new CliError("Review evidence metadata exceeds the configured context budget.", {
      code: "RESEARCH_REVIEW_CONTEXT_BUDGET_EXCEEDED",
      exitCode: 3,
      details: { fixedBytes, maxBytes, views: views.length },
    });
  }
  const activeViews = views.filter((view) => view.active).length;
  const contentBudgetPerView = activeViews ? Math.floor((maxBytes - fixedBytes) / activeViews) : 0;
  const sections = [
    header,
    ...views.map(
      (view) =>
        `${view.prefix}${
          view.active ? boundedUtf8ReviewExcerpt(view.content, contentBudgetPerView) : view.content
        }${view.suffix}`,
    ),
  ];
  const logicalPath = "inputs/review-evidence-context.txt";
  const path = resolveContained(capsuleProject, logicalPath);
  const content = `${sections.join("\n\n")}\n`;
  const actualBytes = Buffer.byteLength(content, "utf8");
  if (actualBytes > maxBytes) {
    throw new CliError("Review evidence context exceeded its deterministic byte budget.", {
      code: "RESEARCH_REVIEW_CONTEXT_BUDGET_EXCEEDED",
      exitCode: 3,
      details: { actualBytes, maxBytes },
    });
  }
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

async function writeProducerArtifactContext(
  capsuleProject: string,
  evidenceArtifacts: Awaited<ReturnType<typeof stageEvidenceArtifacts>>,
  maxBytes: number,
): Promise<OutputRecord> {
  const header = [
    "TIANGONG PRODUCER ARTIFACT CONTEXT v1",
    "Only deterministic sanitized excerpts from producer-visible text artifacts are included. Binary files remain hash-bound but are not treated as read full text.",
  ].join("\n");
  const views = await Promise.all(
    [...evidenceArtifacts]
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
      .map(async (artifact) => {
        const active = reviewableTextContentType(artifact.mediaType);
        return {
          prefix: [
            `--- FROZEN ARTIFACT ${artifact.artifactId} ---`,
            `candidateId: ${artifact.candidateId}`,
            `sha256: ${artifact.sha256}`,
            `mediaType: ${artifact.mediaType}`,
            "--- BEGIN BOUNDED ARTIFACT CONTEXT ---",
            "",
          ].join("\n"),
          content: active
            ? sanitizeResearchText(
                (
                  await readFile(resolveContained(capsuleProject, artifact.locator), "utf8")
                ).trimEnd(),
              )
            : "[Binary artifact is hash-bound but omitted from producer context. It is not counted as producer-visible full text.]",
          suffix: "\n--- END BOUNDED ARTIFACT CONTEXT ---",
          active,
        };
      }),
  );
  const fixed = `${header}\n\n${views
    .map((view) => `${view.prefix}${view.active ? "" : view.content}${view.suffix}`)
    .join("\n\n")}\n`;
  const fixedBytes = Buffer.byteLength(fixed, "utf8");
  if (fixedBytes > maxBytes) {
    throw new CliError("Producer artifact metadata exceeds the configured context budget.", {
      code: "RESEARCH_INPUT_CONTEXT_BUDGET_EXCEEDED",
      exitCode: 3,
      details: { fixedBytes, maxBytes, artifacts: views.length },
    });
  }
  const activeViews = views.filter((view) => view.active).length;
  const perView = activeViews ? Math.floor((maxBytes - fixedBytes) / activeViews) : 0;
  const content = `${header}\n\n${views
    .map(
      (view) =>
        `${view.prefix}${
          view.active ? boundedUtf8ReviewExcerpt(view.content, perView) : view.content
        }${view.suffix}`,
    )
    .join("\n\n")}\n`;
  const logicalPath = "inputs/evidence-artifact-context.txt";
  const path = resolveContained(capsuleProject, logicalPath);
  await writeTextAtomic(path, content);
  return fileRecord(path, logicalPath);
}

interface BrokerReviewReference {
  sourceId: string;
  title: string;
  jsonPointer: string | null;
  excerpt: string | null;
}

async function loadBrokerReviewReferences(
  capsuleProject: string,
): Promise<Map<string, BrokerReviewReference[]>> {
  const evidencePath = resolveContained(capsuleProject, "outputs/evidence.json");
  if (!(await pathExists(evidencePath))) return new Map();
  const evidence = await readJsonFile<Record<string, unknown>>(evidencePath, "Research evidence");
  const references = new Map<string, BrokerReviewReference[]>();
  if (!Array.isArray(evidence.sources)) return references;
  for (const source of evidence.sources) {
    if (!isObject(source) || !isObject(source.provenance)) continue;
    if (source.provenance.kind !== "broker" || typeof source.provenance.id !== "string") continue;
    if (typeof source.id !== "string" || typeof source.title !== "string") continue;
    const current = references.get(source.provenance.id) ?? [];
    current.push({
      sourceId: source.id,
      title: source.title,
      jsonPointer: typeof source.jsonPointer === "string" ? source.jsonPointer : null,
      excerpt: typeof source.excerpt === "string" ? source.excerpt : null,
    });
    references.set(source.provenance.id, current);
  }
  for (const values of references.values()) {
    values.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  }
  return references;
}

async function citedBrokerReviewContent(
  capsuleProject: string,
  receipt: Awaited<ReturnType<typeof loadProjectEvidenceReceipts>>[number],
  references: BrokerReviewReference[],
): Promise<string> {
  let rawValue: unknown;
  if (jsonReviewContentType(receipt.contentType)) {
    try {
      rawValue = JSON.parse(
        await readFile(resolveContained(capsuleProject, receipt.locator), "utf8"),
      ) as unknown;
    } catch {
      rawValue = undefined;
    }
  }
  let needsFallback = false;
  const sections = [
    "The following items are deterministic, sanitized projections selected from the hash-bound raw broker object by the JSON Pointers declared in admitted evidence.",
  ];
  for (const reference of references) {
    const lines = [
      `--- CITED EVIDENCE SOURCE ${reference.sourceId} ---`,
      `title: ${reference.title}`,
      `jsonPointer: ${reference.jsonPointer ?? "unavailable"}`,
    ];
    if (rawValue !== undefined && reference.jsonPointer !== null) {
      try {
        const selected = resolveReviewJsonPointer(rawValue, reference.jsonPointer);
        lines.push("exactItem:", JSON.stringify(selected, null, 2));
      } catch {
        needsFallback = true;
        lines.push("exactItem: [JSON Pointer did not resolve; bounded-context fallback follows.] ");
      }
    } else {
      needsFallback = true;
      lines.push("exactItem: [Exact JSON item unavailable; bounded-context fallback follows.] ");
    }
    if (reference.excerpt !== null) lines.push(`declaredExcerpt: ${reference.excerpt}`);
    sections.push(lines.join("\n"));
  }
  if (needsFallback) {
    const fallback = reviewableTextContentType(receipt.contentType)
      ? await readFile(resolveContained(capsuleProject, receipt.contextLocator), "utf8")
      : "[Binary bounded view omitted from model context; verify the bound file mechanically.]";
    sections.push(`--- BOUNDED CONTEXT FALLBACK ---\n${fallback.trimEnd()}`);
  }
  return sanitizeResearchText(sections.join("\n\n"));
}

function jsonReviewContentType(contentType: string): boolean {
  return /^application\/(?:[^;]+\+)?json(?:;|$)/i.test(contentType);
}

function resolveReviewJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) {
    throw new Error("invalid JSON Pointer");
  }
  let selected = value;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      Array.isArray(selected) &&
      /^(0|[1-9][0-9]*)$/.test(part) &&
      Number(part) < selected.length
    ) {
      selected = selected[Number(part)];
    } else if (isObject(selected) && Object.hasOwn(selected, part)) {
      selected = selected[part];
    } else {
      throw new Error("JSON Pointer does not resolve");
    }
  }
  return selected;
}

function reviewableTextContentType(contentType: string): boolean {
  return /^(?:text\/[^;]+|application\/(?:[^;]+\+)?(?:json|xml|javascript|xhtml\+xml|csv))(?:;|$)/i.test(
    contentType,
  );
}

function boundedUtf8ReviewExcerpt(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix =
    "\n[TRUNCATED: the full object and original bounded context remain hash-bound in the persistent review packet.]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxBytes <= suffixBytes) return utf8Prefix(suffix, maxBytes);
  return `${utf8Prefix(value, maxBytes - suffixBytes)}${suffix}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
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
  const snapshotChain = packet.snapshotChain;
  if (!Array.isArray(snapshotChain)) {
    throw new CliError("Persistent review packet has no evidence snapshot chain.", {
      code: "RESEARCH_REVIEW_PACKET_DRIFT",
      exitCode: 3,
    });
  }
  for (const record of snapshotChain) {
    if (
      !isObject(record) ||
      typeof record.path !== "string" ||
      typeof record.sha256 !== "string" ||
      !Number.isInteger(record.bytes) ||
      !/^evidence\/snapshots\/[0-9a-f]{64}\.json$/.test(record.path)
    ) {
      throw new CliError("Persistent review packet has an invalid snapshot-chain record.", {
        code: "RESEARCH_REVIEW_PACKET_DRIFT",
        exitCode: 3,
      });
    }
    let actual: OutputRecord;
    try {
      actual = await fileRecord(
        resolveContained(projectRoot(root, projectId), record.path),
        record.path,
      );
    } catch {
      throw new CliError("Persistent review snapshot chain is missing.", {
        code: "RESEARCH_REVIEW_PACKET_DRIFT",
        exitCode: 3,
      });
    }
    if (actual.sha256 !== record.sha256 || actual.bytes !== record.bytes) {
      throw new CliError("Persistent review snapshot chain failed hash verification.", {
        code: "RESEARCH_REVIEW_PACKET_DRIFT",
        exitCode: 3,
      });
    }
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
  brokerCallBudget?: number;
  maxCostUsd: number;
  maxWallSeconds?: number;
  expectedRuntime?: WorkspaceDoctorAttestation["runtimes"][number] | undefined;
}): AgentExecutionRequest {
  const toolPolicy = "none" as const;
  const maxTurns =
    input.purpose === "repair"
      ? RESEARCH_REPAIR_MAX_TURNS
      : input.brokerUrl
        ? RESEARCH_BROKER_MAX_TURNS
        : researchStructuredOutputMaxTurns(input.route);
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
    maxTurns,
    maxOutputTokens: input.maxOutputTokens,
    maxToolContextTokens: input.brokerUrl
      ? input.config.budget.maxBrokerContextTokens *
        (input.brokerCallBudget ?? input.config.budget.maxBrokerCalls)
      : 0,
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
      ? `${JSON.stringify(
          normalizeEvidenceCoverage(
            project,
            await materializeDiscoveryEvidence(root, project, parsed.value),
          ),
          null,
          2,
        )}\n`
      : workPackage.stage === "acquire"
        ? `${JSON.stringify(
            await materializeAcquisitionAudit(root, project, parsed.value),
            null,
            2,
          )}\n`
        : parsed.fileContent;
  await writeTextAtomic(destination, fileContent);
  await validateOutputShape(root, project, workPackage, destination, reviewPacketSha256);
  if (parsed.normalizations.length > 0) {
    await appendJournalEvent(
      workspacePaths(root).journal,
      "package.output.normalized",
      project.id,
      {
        projectId: project.id,
        packageId: workPackage.id,
        stage: workPackage.stage,
        normalizations: parsed.normalizations,
      },
    );
  }
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
  if (workPackage.stage === "synthesize") {
    await validateSynthesisDocument(path, content);
    return;
  }
  if (workPackage.stage === "discover") {
    const value = parseEvidenceRecord(content);
    await validateEvidenceSources(root, project, value.sources as unknown[]);
    return;
  }
  if (workPackage.stage === "acquire") {
    parseMaterializedAcquisitionAudit(JSON.parse(content));
    return;
  }
  const { value } = parseStructuredStageOutput(
    workPackage.stage as AgentPackageStage,
    content,
    reviewPacketSha256,
  );
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
  const evidencePath = join(dirname(path), "evidence-snapshot.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as unknown;
  if (!isObject(evidence) || !Array.isArray(evidence.sources)) {
    throw deterministicError("Analysis requires a frozen evidence-snapshot.json.");
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

async function validateSynthesisDocument(path: string, content: string): Promise<void> {
  const validation: string[] = [];
  if ([...content.matchAll(/`([^`\n]*)`/g)].some((match) => /https?:\/\//i.test(match[1] ?? ""))) {
    validation.push("URLs must be real Markdown links or bare links, not inline-code literals");
  }
  if (/%(?:60|0a|0d)|\\u0060|https?:\/\/[^\s<>"'`)\]]*`/i.test(content)) {
    validation.push("URLs contain encoded or literal backtick/newline contamination");
  }
  const markdownTargets: string[] = [];
  for (const match of content.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    if (match[1]) markdownTargets.push(stripMarkdownDestination(match[1]));
  }
  const referenceIds = new Set<string>();
  for (const match of content.matchAll(/^\s*\[([^\]\n]+)\]:\s*(\S+)/gm)) {
    const id = match[1]!.trim().toLowerCase().replace(/\s+/g, " ");
    if (referenceIds.has(id)) validation.push(`duplicate Markdown reference ID: ${id}`);
    referenceIds.add(id);
    markdownTargets.push(stripMarkdownDestination(match[2]!));
  }
  for (const target of markdownTargets) {
    await validateReportTarget(path, target, validation);
  }
  const urls = new Set(
    [...content.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)]
      .map((match) => stripTrailingUrlPunctuation(match[0]))
      .filter(Boolean),
  );
  for (const value of urls) validateReportHttpsUrl(value, validation);
  if (validation.length) {
    throw new StructuredOutputError("Synthesis output failed mechanical link QA.", {
      validation: [...new Set(validation)].slice(0, 20),
    });
  }
}

async function validateReportTarget(
  reportPath: string,
  target: string,
  validation: string[],
): Promise<void> {
  if (!target || target.startsWith("#")) return;
  if (/^https?:\/\//i.test(target)) {
    validateReportHttpsUrl(target, validation);
    return;
  }
  if (/^mailto:/i.test(target)) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    validation.push(`unsupported Markdown link scheme: ${target.split(":", 1)[0]}`);
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? "");
  } catch {
    validation.push("Markdown link contains invalid percent encoding");
    return;
  }
  if (!decoded || isAbsolute(decoded)) {
    validation.push("Markdown local links must be relative files inside the research capsule");
    return;
  }
  const capsuleProject = dirname(dirname(reportPath));
  const selected = resolve(dirname(reportPath), decoded);
  if (relative(capsuleProject, selected).startsWith("..")) {
    validation.push("Markdown local link escapes the research capsule");
    return;
  }
  const info = await lstat(selected).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    validation.push(`Markdown local link does not resolve to a regular file: ${decoded}`);
  }
}

function validateReportHttpsUrl(value: string, validation: string[]): void {
  if (/%(?:60|0a|0d)|`/i.test(value)) {
    validation.push("URL contains encoded or literal backtick/newline contamination");
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    validation.push("report contains an invalid URL");
    return;
  }
  if (url.protocol !== "https:") validation.push(`report URL must use HTTPS: ${url.host}`);
  if (url.username || url.password) validation.push("report URL contains embedded credentials");
  const sensitive =
    /^(access_token|api[_-]?key|apikey|auth|authorization|code|cookie|key|password|secret|session|sig|signature|token)$/i;
  if ([...url.searchParams.keys()].some((key) => sensitive.test(key))) {
    validation.push("report URL contains sensitive query parameters");
  }
}

function stripMarkdownDestination(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

function stripTrailingUrlPunctuation(value: string): string {
  return value.replace(/[),.;!?`]+$/g, "");
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

async function assertDiscoveryCoverage(
  root: string,
  project: ProjectState,
  evidencePath?: string,
): Promise<void> {
  const path =
    evidencePath ?? resolveContained(projectRoot(root, project.id), "outputs/evidence.json");
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const sources = value.sources as Array<Record<string, unknown>>;
  const declared = value.coverage as Record<string, unknown>;
  const computed = computeEvidenceCoverage(project, sources, declared);
  // Full-text acquisition is intentionally the next phase. Discovery must
  // establish breadth, dates, source types and dimensions, but cannot claim
  // that a search-result receipt is already acquired full text.
  const gaps = computed.mechanicalGaps.filter((gap) => !/full-text source\(s\)/.test(gap));
  const requiredCapabilities = requiredDiscoveryCapabilityIds(
    await loadCapabilityDeclarations(root),
  );
  const exercisedCapabilities = new Set(
    (await loadProjectEvidenceReceipts(root, project.id)).map((receipt) => receipt.capabilityId),
  );
  const journalEvents = await readJournal(workspacePaths(root).journal);
  const attemptedCapabilities = new Map<string, { attempts: number; failureKinds: Set<string> }>();
  for (const event of journalEvents) {
    if (event.scope !== project.id || event.type !== "capability.fetch.attempted") continue;
    const capabilityId = event.payload.capabilityId;
    if (typeof capabilityId !== "string") continue;
    const current = attemptedCapabilities.get(capabilityId) ?? {
      attempts: 0,
      failureKinds: new Set<string>(),
    };
    current.attempts += 1;
    attemptedCapabilities.set(capabilityId, current);
  }
  for (const event of journalEvents) {
    if (event.scope !== project.id || event.type !== "capability.fetch.failed") continue;
    const capabilityId = event.payload.capabilityId;
    const failureKind = event.payload.failureKind;
    if (typeof capabilityId !== "string" || typeof failureKind !== "string") continue;
    attemptedCapabilities.get(capabilityId)?.failureKinds.add(failureKind);
  }
  for (const capabilityId of requiredCapabilities) {
    if (exercisedCapabilities.has(capabilityId)) continue;
    const attempted = attemptedCapabilities.get(capabilityId);
    if (!attempted) {
      gaps.push(`required discovery capability was not exercised: ${capabilityId}`);
      continue;
    }
    const failureKinds = [...attempted.failureKinds].sort();
    const detail = failureKinds.length ? `; failure kinds: ${failureKinds.join(", ")}` : "";
    gaps.push(
      `required discovery capability produced no admissible receipt after ${attempted.attempts} attempt(s): ${capabilityId}${detail}`,
    );
  }
  if (
    canonicalJson(declared.dimensions) !== canonicalJson(computed.dimensions) ||
    canonicalJson(declared.sourceTypes) !== canonicalJson(computed.sourceTypes) ||
    declared.fullTextSources !== computed.fullTextSources ||
    declared.datedSources !== computed.datedSources ||
    canonicalJson(declared.publicationDateRange) !== canonicalJson(computed.publicationDateRange)
  ) {
    gaps.push("coverage summary does not match admitted sources");
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
  const snapshot = await loadCurrentEvidenceSnapshot(root, project.id);
  project.evidenceState.currentSnapshotId = snapshot.snapshotId;
  project.evidenceState.currentSnapshotSha256 = snapshot.snapshotSha256;
  project.evidenceState.closureSnapshotId = snapshot.snapshotId;
  const required = [
    "outputs/evidence.json",
    "outputs/acquisition.json",
    "outputs/evidence-snapshot.json",
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
  await verifyReviewLedgerBinding(root, project.id, snapshot.snapshotId, review.packetSha256);
  const evidenceReceipts = await loadProjectEvidenceReceipts(root, project.id);
  const journal = await verifyJournal(workspacePaths(root).journal);
  const closure = {
    schemaVersion: 1,
    projectId: project.id,
    status: "complete",
    closedAt: new Date().toISOString(),
    questionSha256: sha256Text(project.question),
    evidenceRequirements: project.evidenceRequirements,
    evidenceSnapshot: {
      snapshotId: snapshot.snapshotId,
      snapshotSha256: snapshot.snapshotSha256,
      parentSnapshotId: snapshot.parentSnapshotId,
      parentSnapshotSha256: snapshot.parentSnapshotSha256,
    },
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

async function commitStageEvidenceBindings(
  root: string,
  project: ProjectState,
  workPackage: WorkPackage,
): Promise<void> {
  if (workPackage.stage !== "analyze" && workPackage.stage !== "review") return;
  const snapshot = await loadCurrentEvidenceSnapshot(root, project.id);
  const events = await readJournal(evidenceLedgerPath(root, project.id));
  if (workPackage.stage === "analyze") {
    const path = join(projectRoot(root, project.id), "outputs", "analysis.json");
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isObject(value) || !Array.isArray(value.findings)) {
      throw deterministicError("Analysis claim bindings require a valid analysis output.");
    }
    const committed = new Set(
      events
        .filter((event) => event.type === "claim.used")
        .map((event) => String(event.payload.bindingSha256)),
    );
    for (const finding of value.findings) {
      if (
        !isObject(finding) ||
        typeof finding.id !== "string" ||
        !Array.isArray(finding.evidence) ||
        finding.evidence.some((sourceId) => typeof sourceId !== "string")
      ) {
        throw deterministicError("Analysis contains an invalid claim binding.");
      }
      const binding = {
        claimId: finding.id,
        snapshotId: snapshot.snapshotId,
        sourceIds: [...finding.evidence].sort(),
        claimSha256: sha256Text(canonicalJson(finding)),
      };
      const bindingSha256 = sha256Text(canonicalJson(binding));
      if (committed.has(bindingSha256)) continue;
      await appendEvidenceLedgerEvent(root, project.id, "claim.used", {
        ...binding,
        bindingSha256,
      });
    }
    return;
  }
  const path = join(projectRoot(root, project.id), "outputs", "review.json");
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isObject(value) || value.decision !== "pass" || typeof value.packetSha256 !== "string") {
    throw deterministicError("Review binding requires a passing schema-valid review.");
  }
  const binding = {
    snapshotId: snapshot.snapshotId,
    packetSha256: value.packetSha256,
    reviewSha256: await sha256File(path),
    decision: value.decision,
  };
  const bindingSha256 = sha256Text(canonicalJson(binding));
  if (
    events.some(
      (event) => event.type === "review.bound" && event.payload.bindingSha256 === bindingSha256,
    )
  ) {
    return;
  }
  await appendEvidenceLedgerEvent(root, project.id, "review.bound", {
    ...binding,
    bindingSha256,
  });
}

async function verifyReviewLedgerBinding(
  root: string,
  projectId: string,
  snapshotId: string,
  packetSha256: string,
): Promise<void> {
  const reviewPath = join(projectRoot(root, projectId), "outputs", "review.json");
  const reviewSha256 = await sha256File(reviewPath);
  const events = await readJournal(evidenceLedgerPath(root, projectId));
  const bound = events.some(
    (event) =>
      event.type === "review.bound" &&
      event.payload.snapshotId === snapshotId &&
      event.payload.packetSha256 === packetSha256 &&
      event.payload.reviewSha256 === reviewSha256,
  );
  if (!bound) {
    throw deterministicError(
      "Project review is not bound to the current evidence snapshot ledger.",
    );
  }
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
  project: ProjectState,
  workPackage: WorkPackage,
  config: WorkspaceConfig,
): Promise<string> {
  const logicalPaths =
    workPackage.stage === "discover" && project.lineage.kind === "addendum"
      ? ["outputs/base-evidence-snapshot.json"]
      : workPackage.stage === "acquire"
        ? [
            "outputs/evidence.json",
            ...(project.lineage.kind === "addendum" ? ["outputs/base-evidence-snapshot.json"] : []),
          ]
        : workPackage.stage === "analyze"
          ? [
              "outputs/evidence-snapshot.json",
              ...((await pathExists(
                resolveContained(capsuleProject, "inputs/evidence-artifact-context.txt"),
              ))
                ? ["inputs/evidence-artifact-context.txt"]
                : []),
            ]
          : workPackage.stage === "synthesize"
            ? [
                "outputs/evidence-snapshot.json",
                "outputs/analysis.json",
                ...((await pathExists(
                  resolveContained(capsuleProject, "inputs/evidence-artifact-context.txt"),
                ))
                  ? ["inputs/evidence-artifact-context.txt"]
                  : []),
              ]
            : workPackage.stage === "review"
              ? [
                  "inputs/review-evidence-context.txt",
                  "outputs/evidence-snapshot.json",
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
  const estimatedTokens = Math.ceil(
    Buffer.byteLength(bundled, "utf8") / RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
  );
  const maxStageContextTokens =
    workPackage.stage === "discover" && project.lineage.kind === "addendum"
      ? config.budget.maxInputContextTokens
      : workPackage.stage === "review"
        ? config.budget.maxInputContextTokens + config.budget.maxOutputTokens * 4
        : workPackage.stage === "synthesize"
          ? config.budget.maxInputContextTokens
          : workPackage.stage === "analyze"
            ? config.budget.maxInputContextTokens
            : workPackage.stage === "acquire"
              ? config.budget.maxOutputTokens
              : 0;
  if (estimatedTokens > maxStageContextTokens) {
    throw new CliError(
      `Admitted stage context exceeds the configured input context limit for ${workPackage.id}.`,
      {
        code: "RESEARCH_INPUT_CONTEXT_BUDGET_EXCEEDED",
        exitCode: 3,
        details: {
          packageId: workPackage.id,
          estimatedTokens,
          maxStageContextTokens,
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
  capabilityDocumentation: string,
  reviewPacketSha256: string | null,
  contextBundle: OutputRecord,
  contextBundleContent: string,
  stageContextContent: string,
  discovery: DiscoveryProgress | null,
  evidenceCandidates: Awaited<ReturnType<typeof listEvidenceCandidates>>,
): string {
  const stageInstructions: Record<WorkPackage["stage"], string> = {
    discover:
      "Assess candidates incrementally through the packet's recordAssessment command; do not accumulate a source-sized final response. The control plane has already assigned every immutable input and broker result a candidateId and retains its title, URL, DOI, dates, receipt, locator, JSON Pointer, hashes, and retrieval metadata. Reference candidateId; never repeat or invent those deterministic fields. Give each admitted candidate a concise sourceId plus source type, relevance, quality, applicability, coverage dimensions, and limitations. Record meaningful explicit rejections; omitted candidates remain unassessed for later gap filling. Native Web or Browser discoveries are supplemental candidates only and cannot be admitted until an immutable broker receipt is attached to the same canonical URL or DOI. After broad search, strict assessment, and focused gap filling, return only the small closeout object with one judgment for every reviewed dimension plus limitations and remaining gaps. The CLI mechanically joins the latest recorded assessments to provenance, derives counts/date range/coverage, and rejects unknown or unformalized candidates.",
    acquire:
      "Audit every provisionally admitted source exactly once. For each source, bind its ledger candidateId, list only artifactIds returned by the exact artifact registration command, and choose accepted, limited, or rejected with a concise rationale and explicit limitations. A broker receipt is an immutable discovery record but is not full text. Use an empty artifactIds array only when intentionally retaining a source as metadata/abstract evidence or when the source is an already registered local input. Put unresolved blocking acquisition or coverage deficiencies in gaps; put honest non-blocking scope constraints in limitations. Do not invent file paths, hashes, URLs, artifact IDs, or successful downloads.",
    analyze:
      "Use only the complete embedded frozen evidence snapshot below and return the schema-defined analysis object. Every finding must cite source IDs present in that snapshot and state uncertainty and applicability. When the snapshot has a parent, use its mechanical delta to focus re-analysis on added, changed, and removed evidence while still returning one complete current analysis.",
    synthesize:
      "Use only the complete embedded admitted evidence and findings below. Return the schema-defined object whose reportMarkdown separates supported conclusions, uncertainty, limitations, and next actions. Use real Markdown line breaks encoded exactly once for JSON; never place literal /n or double-escaped \\n markers in reportMarkdown. When the admitted publication-date range is narrower than the requested range, state the exact admitted range and missing interval prominently in the opening summary.",
    review: `Independently inspect the complete embedded artifacts and globally bounded evidence excerpts. The CLI has already verified every bound full evidence object's size and SHA-256 and persistently stored the complete review packet; its hash is schema-bound even though the packet metadata is not duplicated in model context. Do not claim to have read beyond the embedded excerpts. Return the schema-defined review bound to packetSha256 ${reviewPacketSha256 ?? "unavailable"}. Use pass only when every material claim is traceable within the admitted evidence and clearly scoped to its limitations.`,
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
      ? "The exact capability manifest and each staged external SKILL.md are embedded below. Use this documentation directly; filesystem tools are disabled."
      : workPackage.stage === "acquire"
        ? "Use the installed external acquisition/document Skills in the current native host, but treat the CLI artifact registry and acquisition schema as the only authority for durable evidence."
        : "Capability files are provenance-bound but are not available as execution tools in this stage.",
    workPackage.stage === "discover"
      ? `Follow the reviewed discovery plan: ${JSON.stringify(discovery)}. The plan's max broker-view count is a hard working ceiling, not a target to exhaust. Execute required first-pass channels before supplemental channels, prefer broad high-yield queries, assess registered candidates between batches, and use the next gap-fill batch only for explicit uncovered dimensions, source types, date ranges, full text, limitations, or counterevidence. Stop fetching as soon as the declared coverage minimums are supportable. Use the broker only. Do not execute a staged Skill's curl/CLI examples or read provider environment variables. Invoke fetch_candidate_source with the manifest capability ID and obey its exact declared HTTP method. GET capabilities use only declared query parameters; POST capabilities require request_body containing only the documented non-secret request JSON. Never place API keys, tokens, authorization data, cookies, or other credential-like fields in request_body. The broker injects the sole declared logical credential, disables caching for credentialed requests, and never persists the POST body (only its hash). The tool result includes exact bounded context, registered candidate IDs, its receipt, whether a network call was avoided, and remaining view budget. Exercise every manifest capability with requiredForDiscovery=true, or the mechanical coverage gate will stop downstream work.`
      : "Use only the complete embedded stage context; no tools or additional source reads are allowed.",
    stageInstructions[workPackage.stage],
    "Do not write stage output files directly. Your final response must be only the JSON object required by the supplied output schema; the CLI will validate and atomically materialize it.",
    "Do not edit project.json, input manifests, prior outputs, evidence objects, or staged capability files.",
  ];
  if (workPackage.stage === "discover") {
    prompt.push(
      `Candidate index already registered at stage start: ${JSON.stringify(
        evidenceCandidates.map((candidate) => ({
          candidateId: candidate.id,
          title: candidate.title,
          url: candidate.url,
          doi: candidate.doi,
          publicationDate: candidate.publicationDate,
          excerpt: candidate.excerpt,
          originKind: candidate.origin.kind,
        })),
      )}`,
      "The complete external capability documentation bundle is embedded below:",
      capabilityDocumentation,
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
  const reservation = calculateAgentCallTokenReservation({
    route: request.route,
    primaryPayloadTokens: Math.ceil(
      (schemaBytes + promptBytes) / RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
    ),
    repairPayloadTokens: Math.ceil(
      (schemaBytes + RESEARCH_MAX_REPAIR_SOURCE_BYTES + 2_048) / RESEARCH_ESTIMATED_BYTES_PER_TOKEN,
    ),
    maxTurns: request.maxTurns,
    maxOutputTokens: request.maxOutputTokens,
    maxToolContextTokens: request.maxToolContextTokens ?? 0,
    maxRepairTokens: config.budget.maxRepairTokens,
    reserveRepair,
    alreadyUsedTokens,
  });
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
  requestedTokens?: number,
): { tokens: number; costUsd: number } {
  if (workPackage.stage === "close") return { tokens: 0, costUsd: 0 };
  const route = workPackage.executor === "reviewer" ? config.reviewer : config.producer;
  const packageMaximum = config.budget.packageMaxTokens[workPackage.stage];
  const tokens = Math.min(packageMaximum, requestedTokens ?? packageMaximum);
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
  if (
    config.producer.executionMode !== "native-host" ||
    config.reviewer.executionMode !== "headless-cli"
  ) {
    throw new CliError(
      "Research requires a native-host producer and a separate headless-CLI reviewer.",
      { code: "RESEARCH_EXECUTION_MODE_INVALID", exitCode: 3 },
    );
  }
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
  const nativeStageRequired = projects.some((project) =>
    project.packages.some(
      (workPackage) =>
        workPackage.executor === "producer" &&
        (workPackage.status === "ready" || workPackage.status === "running"),
    ),
  );
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
          : nativeStageRequired
            ? "native-stage-required"
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
  if (url.protocol !== "https:") {
    throw deterministicError(`Evidence source ${sourceId} URL must use HTTPS.`);
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

function nativeStageSessionPath(root: string, projectId: string): string {
  return join(projectRoot(root, projectId), "native", "active.json");
}

async function readNativeStageSession(
  root: string,
  projectId: string,
): Promise<NativeStageSession> {
  const path = nativeStageSessionPath(root, projectId);
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new CliError("No valid native stage session is active for this project.", {
      code: "RESEARCH_NATIVE_STAGE_SESSION_REQUIRED",
      exitCode: 3,
    });
  }
  const value = await readJsonFile<unknown>(path, "Native research stage session");
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-native-research-stage-session" ||
    !isObject(value.packet) ||
    typeof value.capsuleRoot !== "string" ||
    typeof value.capsuleProject !== "string" ||
    typeof value.sessionSha256 !== "string"
  ) {
    throw new CliError("Native stage session has an unsupported shape.", {
      code: "RESEARCH_NATIVE_STAGE_SESSION_INVALID",
      exitCode: 3,
    });
  }
  const { sessionSha256, ...core } = value;
  if (sha256Text(canonicalJson(core)) !== sessionSha256) {
    throw new CliError("Native stage session failed its content hash.", {
      code: "RESEARCH_NATIVE_STAGE_SESSION_INVALID",
      exitCode: 3,
    });
  }
  const packet = value.packet as unknown as NativeStagePacket;
  const { packetSha256, ...packetCore } = packet;
  if (
    packet.schemaVersion !== 1 ||
    packet.kind !== "tiangong-native-research-stage" ||
    packet.projectId !== projectId ||
    typeof packetSha256 !== "string" ||
    sha256Text(canonicalJson(packetCore)) !== packetSha256
  ) {
    throw new CliError("Native stage packet failed its content hash or project binding.", {
      code: "RESEARCH_NATIVE_STAGE_SESSION_INVALID",
      exitCode: 3,
    });
  }
  const runtimeRoot = resolve(workspacePaths(root).runtime);
  const capsuleRoot = resolve(value.capsuleRoot);
  const capsuleProject = resolve(value.capsuleProject);
  if (
    relative(runtimeRoot, capsuleRoot).startsWith("..") ||
    relative(capsuleRoot, capsuleProject).startsWith("..") ||
    !(await lstat(capsuleRoot).catch(() => undefined))?.isDirectory() ||
    !(await lstat(capsuleProject).catch(() => undefined))?.isDirectory()
  ) {
    throw new CliError("Native stage capsule is missing or outside the workspace runtime.", {
      code: "RESEARCH_NATIVE_STAGE_SESSION_INVALID",
      exitCode: 3,
    });
  }
  return value as unknown as NativeStageSession;
}

async function nativeStageBinding(
  root: string,
  project: ProjectState,
  workPackage: WorkPackage,
): Promise<string> {
  const paths = workspacePaths(root);
  const outputRoot = join(projectRoot(root, project.id), "outputs");
  const outputs: OutputRecord[] = [];
  if (await pathExists(outputRoot)) {
    for (const path of await regularTreeFiles(outputRoot)) {
      outputs.push(
        await fileRecord(path, relative(projectRoot(root, project.id), path).replaceAll("\\", "/")),
      );
    }
  }
  return sha256Text(
    canonicalJson({
      projectId: project.id,
      questionSha256: sha256Text(project.question),
      evidenceRequirements: project.evidenceRequirements,
      inputs: project.inputs.map((record) => ({
        id: record.id,
        role: record.role,
        sha256: record.sha256,
        bytes: record.bytes,
        contextSha256: record.contextSha256 ?? null,
        contextBytes: record.contextBytes ?? null,
      })),
      package: {
        id: workPackage.id,
        stage: workPackage.stage,
        dependencies: workPackage.dependencies,
        expectedOutputs: workPackage.expectedOutputs,
      },
      outputs,
      configSha256: await sha256File(paths.config),
      runtimeLockSha256: await sha256File(paths.runtimeLock),
      capabilityDeclarationsSha256: await sha256File(paths.capabilityDeclarations),
      capabilityLockSha256: (await pathExists(paths.capabilityLock))
        ? await sha256File(paths.capabilityLock)
        : null,
    }),
  );
}

async function assertNativeStageBinding(
  root: string,
  project: ProjectState,
  packet: NativeStagePacket,
): Promise<void> {
  const workPackage = packageById(project, packet.packageId);
  const actual = await nativeStageBinding(root, project, workPackage);
  if (actual !== packet.bindingSha256) {
    throw new CliError("Native stage inputs, configuration, or admitted outputs drifted.", {
      code: "RESEARCH_NATIVE_STAGE_BINDING_DRIFT",
      exitCode: 3,
      details: { expectedSha256: packet.bindingSha256, actualSha256: actual },
    });
  }
}

function requireNativeOutputPath(value: string): string {
  if (!value || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new CliError("Native stage output requires an explicit absolute file path.", {
      code: "RESEARCH_NATIVE_STAGE_OUTPUT_INVALID",
      exitCode: 2,
    });
  }
  return resolve(value);
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
