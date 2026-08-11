import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { CliError } from "../errors.js";
import type { CliIO } from "../io.js";
import { stringifyJson, write } from "../io.js";
import { parseStrictArgs, strictBoolean, strictString } from "../strict-args.js";
import { researchSetupHelp, runResearchSetupCommand } from "./setup-command.js";
import {
  loadCapabilityDeclarations,
  lockCapabilities,
  verifyCapabilities,
} from "./workspace/capabilities.js";
import { inspectResearchContext } from "./workspace/context.js";
import { setCapabilityCredentialFromEnvironment } from "./workspace/credentials.js";
import {
  configureExternalSkillProfile,
  doctorExternalCapabilities,
  EXTERNAL_SKILL_CONTEXT_PROFILE,
  EXTERNAL_SKILL_MEDIA_PROFILE,
  EXTERNAL_SKILL_PROFILE,
  importExternalCapability,
  inspectExternalSkillCatalog,
} from "./workspace/external-skills.js";
import { appendJournalEvent } from "./workspace/journal.js";
import { fetchNativeCandidateSource } from "./workspace/broker.js";
import { registerEvidenceArtifact } from "./workspace/artifacts.js";
import { loadCurrentEvidenceSnapshot } from "./workspace/acquisition.js";
import { inspectDiscoveryProgress } from "./workspace/discovery-status.js";
import { registerNativeDiscoveryCandidate } from "./workspace/evidence-ledger.js";
import { readAndVerifyProjectInputPlan } from "./workspace/input-plan.js";
import {
  addProjectInput,
  createProjectAddendum,
  initializeProject,
  forkProject,
  listProjects,
  loadProject,
  nextReadyPackage,
  normalizeEvidenceRequirements,
  refreshProject,
  retryProjectPackage,
} from "./workspace/projects.js";
import { evaluateProjectPreflight } from "./workspace/preflight.js";
import {
  abortNativeResearchStage,
  inspectNativeResearchStage,
  prepareNativeResearchStage,
  runResearchWorkspace,
  submitNativeResearchStage,
} from "./workspace/runtime.js";
import { schemaForStage } from "./workspace/schemas.js";
import { pathExists, sha256Text, workspacePaths } from "./workspace/storage.js";
import type { ProjectEvidenceRequirements, ProjectInput, ResearchMode } from "./workspace/types.js";
import {
  doctorResearchWorkspace,
  initializeResearchWorkspace,
  requireResearchWorkspace,
  withWorkspaceLock,
} from "./workspace/workspace.js";

const COMMON_OPTIONS = { help: "boolean", json: "boolean" } as const;
const WORKSPACE_OPTIONS = { ...COMMON_OPTIONS, workspace: "string" } as const;

export async function runResearchOrchestrationCommand(
  subcommand: string,
  argv: string[],
  io: CliIO,
): Promise<number | undefined> {
  if (subcommand === "context") return runContext(argv, io);
  if (subcommand === "setup") return runResearchSetupCommand(argv, io);
  if (subcommand === "workspace") return runWorkspace(argv, io);
  if (subcommand === "capability") return runCapability(argv, io);
  if (subcommand === "project") return runProject(argv, io);
  if (subcommand === "schema") return runSchema(argv, io);
  if (subcommand === "status") return runStatus(argv, io);
  if (subcommand === "run") return runWorkspaceExecution(argv, io);
  return undefined;
}

export function researchOrchestrationHelp(): string {
  return `Research workspace commands:
  tiangong-ai research setup
  tiangong-ai research setup --help
  tiangong-ai research context inspect [--path <absolute-path>] [--json]
  tiangong-ai research workspace init <absolute-path> [--name <name>] [--mode smoke-test|production-research] [--json]
  tiangong-ai research workspace doctor [--workspace <absolute-path>] [--agent-smoke] [--capability-smoke] [--json]
  tiangong-ai research capability catalog [--path <absolute-path>] [--workspace <absolute-path>] [--skill-root <absolute-path>] [--json]
  tiangong-ai research capability configure [--profile ${EXTERNAL_SKILL_PROFILE}|${EXTERNAL_SKILL_CONTEXT_PROFILE}|${EXTERNAL_SKILL_MEDIA_PROFILE}] [--skill-root <absolute-path>] [--workspace <absolute-path>] [--json]
  tiangong-ai research capability import --definition <absolute-json> [--workspace <absolute-path>] [--json]
  tiangong-ai research capability doctor [--live] [--workspace <absolute-path>] [--json]
  tiangong-ai research capability credential set --id <logical-id> --from-env <name> [--workspace <absolute-path>] [--json]
  tiangong-ai research capability lock [--workspace <absolute-path>] [--json]
  tiangong-ai research capability verify [--workspace <absolute-path>] [--json]
  tiangong-ai research project init <project-id> --question <question> [--requirements <absolute-json>] [--input-plan <absolute-json>] [--confirm-budget] [--workspace <path>] [--json]
  tiangong-ai research project preflight --question <question> [--requirements <absolute-json>] [--input-plan <absolute-json>] [--workspace <path>] [--json]
  tiangong-ai research project input add <project-id> --path <absolute-file> [--role primary|reference|replication] [--workspace <path>] [--json]
  tiangong-ai research project retry <project-id> [--package <package-id>] [--workspace <path>] [--json]
  tiangong-ai research project fork <source-project-id> --to <target-project-id> [--resume-through discover|acquire|analyze|synthesize] [--workspace <path>] [--json]
  tiangong-ai research project addendum <closed-project-id> --to <target-project-id> [--workspace <path>] [--json]
  tiangong-ai research project stage prepare <project-id> --stage discover|acquire|analyze|synthesize --host-agent codex|claude [--workspace <path>] [--json]
  tiangong-ai research project stage submit <project-id> --session <id> --output <absolute-json> [--confirm-model <id>] [--workspace <path>] [--json]
  tiangong-ai research project stage abort <project-id> --session <id> [--workspace <path>] [--json]
  tiangong-ai research project evidence fetch <project-id> --request <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project evidence candidate register <project-id> --record <absolute-json> [--workspace <path>] [--json]
  tiangong-ai research project evidence artifact register <project-id> --candidate <id> --path <absolute-file> [--media-type <type>] [--source-url <https-url>] [--license <declared-license>] [--license-url <https-url>] [--host-type <type>] [--article-version <version>] [--workspace <path>] [--json]
  tiangong-ai research schema show <discover|acquire|analyze|synthesize|review|doctor> [--json]
  tiangong-ai research status [--project <project-id>] [--all] [--workspace <absolute-path>] [--json]
  tiangong-ai research run [--project <project-id>] [--max-parallel <1-8>] [--max-cycles <1-100>] [--dry-run] [--progress-jsonl] [--workspace <absolute-path>] [--json]

${researchSetupHelp()}
`;
}

async function runSchema(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action !== "show") throw unknownAction("research schema", action);
  const args = parseStrictArgs(rest, COMMON_OPTIONS, "research schema show");
  if (strictBoolean(args, "help")) return writeHelp(io);
  const stage = onePositional(args.positionals, "research schema show");
  if (
    stage !== "discover" &&
    stage !== "acquire" &&
    stage !== "analyze" &&
    stage !== "synthesize" &&
    stage !== "review" &&
    stage !== "doctor"
  ) {
    throw new CliError(`Unsupported research schema stage: ${stage}`, {
      code: "RESEARCH_SCHEMA_INVALID",
      exitCode: 2,
    });
  }
  writeJson(io, schemaForStage(stage), args);
  return 0;
}

async function runContext(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action !== "inspect") throw unknownAction("research context", action);
  const args = parseStrictArgs(
    rest,
    { ...COMMON_OPTIONS, path: "string" },
    "research context inspect",
  );
  if (strictBoolean(args, "help")) return writeHelp(io);
  rejectPositionals(args.positionals, "research context inspect");
  const result = await inspectResearchContext(strictString(args, "path") ?? process.cwd());
  writeJson(io, result, args);
  return 0;
}

async function runWorkspace(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action === "init") {
    const args = parseStrictArgs(
      rest,
      { ...COMMON_OPTIONS, name: "string", mode: "string" },
      "research workspace init",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const target = onePositional(args.positionals, "research workspace init");
    const result = await initializeResearchWorkspace(
      target,
      strictString(args, "name"),
      researchMode(strictString(args, "mode")),
    );
    writeJson(io, result, args);
    return 0;
  }
  if (action === "doctor") {
    const args = parseStrictArgs(
      rest,
      {
        ...WORKSPACE_OPTIONS,
        "agent-smoke": "boolean",
        "capability-smoke": "boolean",
      },
      "research workspace doctor",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research workspace doctor");
    const result = await doctorResearchWorkspace(strictString(args, "workspace") ?? process.cwd(), {
      agentSmoke: strictBoolean(args, "agent-smoke"),
      capabilitySmoke: strictBoolean(args, "capability-smoke"),
      environment: io.env,
    });
    writeJson(io, result, args);
    return result.status === "ready" ? 0 : 3;
  }
  throw unknownAction("research workspace", action);
}

async function runCapability(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action === "credential") {
    const [credentialAction, ...credentialRest] = rest;
    if (credentialAction === "--help" || credentialAction === "-h") return writeHelp(io);
    if (credentialAction !== "set") {
      throw unknownAction("research capability credential", credentialAction ?? "missing");
    }
    const args = parseStrictArgs(
      credentialRest,
      { ...WORKSPACE_OPTIONS, id: "string", "from-env": "string" },
      "research capability credential set",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research capability credential set");
    const credentialId = strictString(args, "id");
    const environmentName = strictString(args, "from-env");
    if (!credentialId || !environmentName) {
      throw new CliError("research capability credential set requires --id and --from-env.", {
        code: "RESEARCH_CAPABILITY_CREDENTIAL_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const result = await withWorkspaceLock(root, "capability.credential.set", async () => {
      const declarations = await loadCapabilityDeclarations(root);
      const value = await setCapabilityCredentialFromEnvironment({
        root,
        capabilities: declarations.capabilities,
        credentialId,
        environmentName,
        environment: io.env,
      });
      await appendJournalEvent(
        workspacePaths(root).journal,
        "capability.credential.configured",
        "workspace",
        {
          credentialId: value.credentialId,
          sourceEnvironmentNameSha256: sha256Text(value.sourceEnvironmentName),
          configuredCredentialIds: value.configuredCredentialIds,
        },
      );
      return value;
    });
    writeJson(io, result, args);
    return 0;
  }
  if (action === "catalog") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, path: "string", "skill-root": "string" },
      "research capability catalog",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research capability catalog");
    const workspaceArgument = strictString(args, "workspace");
    const workspace = workspaceArgument ? await requireResearchWorkspace(workspaceArgument) : null;
    const selectedPath = strictString(args, "path") ?? workspace ?? process.cwd();
    const result = await inspectExternalSkillCatalog({
      selectedPath,
      workspace,
      skillRoot: strictString(args, "skill-root") ?? null,
    });
    writeJson(io, result, args);
    return 0;
  }
  if (action === "configure") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, profile: "string", "skill-root": "string" },
      "research capability configure",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research capability configure");
    const root = await workspaceFromArgs(args);
    const result = await withWorkspaceLock(root, "capability.configure", async () => {
      const value = await configureExternalSkillProfile({
        workspace: root,
        profile: strictString(args, "profile") ?? EXTERNAL_SKILL_PROFILE,
        skillRoot: strictString(args, "skill-root") ?? null,
      });
      await appendJournalEvent(
        workspacePaths(root).journal,
        "capability.profile.configured",
        "workspace",
        {
          profile: value.profile,
          capabilities: value.configured.map((capability) => ({
            id: capability.id,
            treeSha256: capability.treeSha256,
            requiredForDiscovery: capability.requiredForDiscovery,
          })),
        },
      );
      return value;
    });
    writeJson(io, result, args);
    return 0;
  }
  if (action === "import") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, definition: "string" },
      "research capability import",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research capability import");
    const definitionPath = strictString(args, "definition");
    if (!definitionPath) {
      throw new CliError("research capability import requires --definition.", {
        code: "RESEARCH_CAPABILITY_IMPORT_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const result = await withWorkspaceLock(root, "capability.import", async () => {
      const value = await importExternalCapability({ workspace: root, definitionPath });
      await appendJournalEvent(workspacePaths(root).journal, "capability.imported", "workspace", {
        ...value.imported,
      });
      return value;
    });
    writeJson(io, result, args);
    return 0;
  }
  if (action === "doctor") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, live: "boolean" },
      "research capability doctor",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research capability doctor");
    const root = await workspaceFromArgs(args);
    const result = await doctorExternalCapabilities(root, { live: strictBoolean(args, "live") });
    writeJson(io, result, args);
    return result.status === "ready" ? 0 : 3;
  }
  if (action !== "lock" && action !== "verify") throw unknownAction("research capability", action);
  const args = parseStrictArgs(rest, WORKSPACE_OPTIONS, `research capability ${action}`);
  if (strictBoolean(args, "help")) return writeHelp(io);
  rejectPositionals(args.positionals, `research capability ${action}`);
  const root = await workspaceFromArgs(args);
  if (action === "lock") {
    const lock = await withWorkspaceLock(root, "capability.lock", async () => {
      const value = await lockCapabilities(root);
      await appendJournalEvent(workspacePaths(root).journal, "capability.locked", "workspace", {
        count: value.capabilities.length,
        treeHashes: value.capabilities.map((item) => ({ id: item.id, sha256: item.treeSha256 })),
      });
      return value;
    });
    writeJson(io, lock, args);
    return 0;
  }
  const verification = await verifyCapabilities(root);
  writeJson(io, verification, args);
  return verification.status === "verified" ? 0 : 3;
}

async function runProject(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action === "stage") {
    const [stageAction, ...stageRest] = rest;
    if (stageAction === "prepare") {
      const args = parseStrictArgs(
        stageRest,
        { ...WORKSPACE_OPTIONS, stage: "string", "host-agent": "string" },
        "research project stage prepare",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project stage prepare");
      const stage = nativeProducerStage(strictString(args, "stage"));
      const hostAgent = nativeHostAgent(strictString(args, "host-agent"));
      const root = await workspaceFromArgs(args);
      const result = await prepareNativeResearchStage({ root, projectId, stage, hostAgent });
      writeJson(io, result, args);
      return 0;
    }
    if (stageAction === "submit") {
      const args = parseStrictArgs(
        stageRest,
        {
          ...WORKSPACE_OPTIONS,
          session: "string",
          output: "string",
          "confirm-model": "string",
        },
        "research project stage submit",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project stage submit");
      const sessionId = strictString(args, "session");
      const outputPath = strictString(args, "output");
      if (!sessionId || !outputPath) {
        throw new CliError("stage submit requires --session and --output.", {
          code: "RESEARCH_NATIVE_STAGE_OUTPUT_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const result = await submitNativeResearchStage({
        root,
        projectId,
        sessionId,
        outputPath,
        confirmedModel: strictString(args, "confirm-model") ?? null,
      });
      writeJson(io, result, args);
      return 0;
    }
    if (stageAction === "abort") {
      const args = parseStrictArgs(
        stageRest,
        { ...WORKSPACE_OPTIONS, session: "string" },
        "research project stage abort",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(args.positionals, "research project stage abort");
      const sessionId = strictString(args, "session");
      if (!sessionId) {
        throw new CliError("stage abort requires --session.", {
          code: "RESEARCH_NATIVE_STAGE_SESSION_REQUIRED",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const result = await abortNativeResearchStage({ root, projectId, sessionId });
      writeJson(io, result, args);
      return 0;
    }
    throw unknownAction("research project stage", stageAction ?? "");
  }
  if (action === "evidence") {
    const [evidenceAction, ...evidenceRest] = rest;
    if (evidenceAction === "candidate") {
      const [candidateAction, ...candidateRest] = evidenceRest;
      if (candidateAction !== "register") {
        throw unknownAction("research project evidence candidate", candidateAction ?? "");
      }
      const args = parseStrictArgs(
        candidateRest,
        { ...WORKSPACE_OPTIONS, record: "string" },
        "research project evidence candidate register",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        "research project evidence candidate register",
      );
      const recordPath = strictString(args, "record");
      if (!recordPath) {
        throw new CliError("candidate register requires --record.", {
          code: "RESEARCH_NATIVE_CANDIDATE_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const record = await readBoundedJsonRecord(
        recordPath,
        "--record",
        "RESEARCH_NATIVE_CANDIDATE_INVALID",
      );
      const result = await withWorkspaceLock(root, "research.native-candidate.register", () =>
        registerNativeDiscoveryCandidate({ root, projectId, value: record }),
      );
      writeJson(io, result, args);
      return 0;
    }
    if (evidenceAction === "artifact") {
      const [artifactAction, ...artifactRest] = evidenceRest;
      if (artifactAction !== "register") {
        throw unknownAction("research project evidence artifact", artifactAction ?? "");
      }
      const args = parseStrictArgs(
        artifactRest,
        {
          ...WORKSPACE_OPTIONS,
          candidate: "string",
          path: "string",
          "media-type": "string",
          "source-url": "string",
          license: "string",
          "license-url": "string",
          "host-type": "string",
          "article-version": "string",
        },
        "research project evidence artifact register",
      );
      if (strictBoolean(args, "help")) return writeHelp(io);
      const projectId = onePositional(
        args.positionals,
        "research project evidence artifact register",
      );
      const candidateId = strictString(args, "candidate");
      const path = strictString(args, "path");
      if (!candidateId || !path) {
        throw new CliError("artifact register requires --candidate and --path.", {
          code: "RESEARCH_ARTIFACT_PATH_INVALID",
          exitCode: 2,
        });
      }
      const root = await workspaceFromArgs(args);
      const result = await withWorkspaceLock(root, "research.artifact.register", () =>
        registerEvidenceArtifact({
          root,
          projectId,
          candidateId,
          path,
          ...(strictString(args, "media-type")
            ? { mediaType: strictString(args, "media-type")! }
            : {}),
          ...(strictString(args, "source-url")
            ? { sourceUrl: strictString(args, "source-url")! }
            : {}),
          ...(strictString(args, "license") ? { license: strictString(args, "license")! } : {}),
          ...(strictString(args, "license-url")
            ? { licenseUrl: strictString(args, "license-url")! }
            : {}),
          ...(strictString(args, "host-type")
            ? { hostType: strictString(args, "host-type")! }
            : {}),
          ...(strictString(args, "article-version")
            ? { articleVersion: strictString(args, "article-version")! }
            : {}),
        }),
      );
      writeJson(io, result, args);
      return 0;
    }
    if (evidenceAction !== "fetch") {
      throw unknownAction("research project evidence", evidenceAction ?? "");
    }
    const args = parseStrictArgs(
      evidenceRest,
      { ...WORKSPACE_OPTIONS, request: "string" },
      "research project evidence fetch",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research project evidence fetch");
    const requestPath = strictString(args, "request");
    if (!requestPath) {
      throw new CliError("evidence fetch requires --request.", {
        code: "RESEARCH_BROKER_REQUEST_INVALID",
        exitCode: 2,
      });
    }
    const request = await readNativeEvidenceRequest(requestPath);
    const root = await workspaceFromArgs(args);
    const result = await withWorkspaceLock(root, "research.native-evidence.fetch", () =>
      fetchNativeCandidateSource({ root, projectId, request }),
    );
    writeJson(io, result, args);
    return 0;
  }
  if (action === "init") {
    const args = parseStrictArgs(
      rest,
      {
        ...WORKSPACE_OPTIONS,
        question: "string",
        requirements: "string",
        "input-plan": "string",
        "confirm-budget": "boolean",
      },
      "research project init",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research project init");
    const question = strictString(args, "question");
    if (!question) {
      throw new CliError("research project init requires --question.", {
        code: "RESEARCH_QUESTION_REQUIRED",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const requirementsPath = strictString(args, "requirements");
    const inputPlanPath = strictString(args, "input-plan");
    const project = await initializeProject(
      root,
      projectId,
      question,
      requirementsPath ? await readEvidenceRequirements(requirementsPath) : undefined,
      strictBoolean(args, "confirm-budget"),
      inputPlanPath ? await readAndVerifyProjectInputPlan(inputPlanPath) : undefined,
    );
    writeJson(io, project, args);
    return 0;
  }
  if (action === "preflight") {
    const args = parseStrictArgs(
      rest,
      {
        ...WORKSPACE_OPTIONS,
        question: "string",
        requirements: "string",
        "input-plan": "string",
      },
      "research project preflight",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    rejectPositionals(args.positionals, "research project preflight");
    const question = strictString(args, "question")?.trim();
    if (!question) {
      throw new CliError("research project preflight requires --question.", {
        code: "RESEARCH_QUESTION_REQUIRED",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const requirementsPath = strictString(args, "requirements");
    const requirements = requirementsPath ? await readEvidenceRequirements(requirementsPath) : null;
    const inputPlanPath = strictString(args, "input-plan");
    const inputPlan = inputPlanPath ? await readAndVerifyProjectInputPlan(inputPlanPath) : null;
    const result = await evaluateProjectPreflight(root, question, requirements, inputPlan);
    writeJson(io, result, args);
    return result.readyToInitialize ? 0 : 3;
  }
  if (action === "input") {
    const [inputAction, ...inputRest] = rest;
    if (inputAction === "--help" || inputAction === "-h") return writeHelp(io);
    if (inputAction !== "add") throw unknownAction("research project input", inputAction ?? "");
    const args = parseStrictArgs(
      inputRest,
      { ...WORKSPACE_OPTIONS, path: "string", role: "string" },
      "research project input add",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research project input add");
    const inputPath = strictString(args, "path");
    if (!inputPath) {
      throw new CliError("research project input add requires --path.", {
        code: "RESEARCH_INPUT_REQUIRED",
        exitCode: 2,
      });
    }
    const role = inputRole(strictString(args, "role"));
    const root = await workspaceFromArgs(args);
    const input = await addProjectInput(root, projectId, inputPath, role);
    writeJson(io, input, args);
    return 0;
  }
  if (action === "retry") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, package: "string" },
      "research project retry",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const projectId = onePositional(args.positionals, "research project retry");
    const root = await workspaceFromArgs(args);
    const project = await retryProjectPackage(root, projectId, strictString(args, "package"));
    writeJson(io, project, args);
    return 0;
  }
  if (action === "fork") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, to: "string", "resume-through": "string" },
      "research project fork",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const sourceProjectId = onePositional(args.positionals, "research project fork");
    const targetProjectId = strictString(args, "to");
    if (!targetProjectId) {
      throw new CliError("research project fork requires --to.", {
        code: "RESEARCH_PROJECT_FORK_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const project = await forkProject(
      root,
      sourceProjectId,
      targetProjectId,
      resumeStage(strictString(args, "resume-through")),
    );
    writeJson(io, project, args);
    return 0;
  }
  if (action === "addendum") {
    const args = parseStrictArgs(
      rest,
      { ...WORKSPACE_OPTIONS, to: "string" },
      "research project addendum",
    );
    if (strictBoolean(args, "help")) return writeHelp(io);
    const sourceProjectId = onePositional(args.positionals, "research project addendum");
    const targetProjectId = strictString(args, "to");
    if (!targetProjectId) {
      throw new CliError("research project addendum requires --to.", {
        code: "RESEARCH_PROJECT_ADDENDUM_INVALID",
        exitCode: 2,
      });
    }
    const root = await workspaceFromArgs(args);
    const project = await createProjectAddendum(root, sourceProjectId, targetProjectId);
    writeJson(io, project, args);
    return 0;
  }
  throw unknownAction("research project", action);
}

async function runStatus(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    { ...WORKSPACE_OPTIONS, project: "string", all: "boolean" },
    "research status",
  );
  if (strictBoolean(args, "help")) return writeHelp(io);
  rejectPositionals(args.positionals, "research status");
  const root = await workspaceFromArgs(args);
  const selectedProject = strictString(args, "project");
  const allProjects = selectedProject
    ? [await loadProject(root, selectedProject)]
    : await listProjects(root);
  const projects =
    selectedProject || strictBoolean(args, "all")
      ? allProjects
      : allProjects.filter((project) => project.lineage.supersededBy === null);
  const result = {
    workspace: root,
    hiddenSupersededProjects: allProjects.length - projects.length,
    projects: await Promise.all(
      projects.map(async (project) => {
        const current = refreshProject(project);
        const nativeStage = await inspectNativeResearchStage(root, current);
        const snapshot = await inspectSnapshotForStatus(root, current.id);
        const readyPackage = nextReadyPackage(current)?.id ?? null;
        return {
          id: current.id,
          question: current.question,
          status: current.status,
          lineage: current.lineage,
          evidenceState: current.evidenceState,
          snapshot,
          nativeStage,
          readyPackage,
          recommendedAction: projectRecommendedAction(root, current, readyPackage, nativeStage),
          usage: current.usage,
          inputs: current.inputs,
          packages: current.packages,
          discovery: await inspectDiscoveryProgress(root, current),
        };
      }),
    ),
  };
  writeJson(io, result, args);
  return 0;
}

async function inspectSnapshotForStatus(
  root: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  const currentPath = join(
    workspacePaths(root).projects,
    projectId,
    "outputs",
    "evidence-snapshot.json",
  );
  if (!(await pathExists(currentPath))) return { status: "absent" };
  try {
    const snapshot = await loadCurrentEvidenceSnapshot(root, projectId);
    return {
      status: "verified",
      snapshotId: snapshot.snapshotId,
      snapshotSha256: snapshot.snapshotSha256,
      parentSnapshotId: snapshot.parentSnapshotId,
      sourceCount: snapshot.sources.length,
      artifactCount: snapshot.artifacts.length,
      delta: snapshot.delta,
    };
  } catch (error) {
    const code = error instanceof CliError ? error.code : "RESEARCH_EVIDENCE_SNAPSHOT_INVALID";
    return {
      status: "invalid",
      code,
    };
  }
}

function projectRecommendedAction(
  root: string,
  project: Awaited<ReturnType<typeof loadProject>>,
  readyPackage: string | null,
  nativeStage: Awaited<ReturnType<typeof inspectNativeResearchStage>>,
): string {
  if (project.lineage.supersededBy) {
    return `Continue with superseding project ${project.lineage.supersededBy}.`;
  }
  if (nativeStage.status === "stale" || nativeStage.status === "invalid") {
    return nativeStage.recommendedAction ?? "Recover the stale native session explicitly.";
  }
  if (nativeStage.status === "active") {
    return nativeStage.recommendedAction ?? "Resume the active native stage.";
  }
  if (project.status === "complete") {
    return `Create an immutable evidence addendum only when new evidence exists: tiangong-ai research project addendum ${project.id} --to <new-project-id> --workspace ${root}`;
  }
  if (project.status === "blocked") {
    const failed = project.packages.find((workPackage) => workPackage.status === "failed");
    return failed
      ? `Review ${failed.lastFailureKind ?? "deterministic"} failure for ${failed.id}, then run the explicit project retry command if corrected.`
      : "Inspect the blocking package and use explicit retry or fork recovery.";
  }
  if (readyPackage && ["discover", "acquire", "analyze", "synthesize"].includes(readyPackage)) {
    return `Prepare native ${readyPackage}: tiangong-ai research project stage prepare ${project.id} --stage ${readyPackage} --host-agent <codex|claude> --workspace ${root}`;
  }
  return readyPackage === "review"
    ? `Run the independent reviewer package: tiangong-ai research run --project ${project.id} --workspace ${root}`
    : "Continue the next ready package.";
}

async function runWorkspaceExecution(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    {
      ...WORKSPACE_OPTIONS,
      "max-parallel": "string",
      "max-cycles": "string",
      project: "string",
      "dry-run": "boolean",
      "progress-jsonl": "boolean",
    },
    "research run",
  );
  if (strictBoolean(args, "help")) return writeHelp(io);
  rejectPositionals(args.positionals, "research run");
  const root = await workspaceFromArgs(args);
  const progressJsonl = strictBoolean(args, "progress-jsonl");
  const projectId = strictString(args, "project");
  const result = await runResearchWorkspace(root, {
    maxParallel: integerOption(strictString(args, "max-parallel"), 1, "--max-parallel"),
    maxCycles: integerOption(strictString(args, "max-cycles"), 20, "--max-cycles"),
    dryRun: strictBoolean(args, "dry-run"),
    environment: io.env,
    ...(projectId ? { projectId } : {}),
    ...(progressJsonl
      ? { onProgress: (event: unknown) => write(io.stderr, `${JSON.stringify(event)}\n`) }
      : {}),
  });
  writeJson(io, result, args);
  return result.status === "blocked" ? 3 : 0;
}

async function readEvidenceRequirements(path: string): Promise<ProjectEvidenceRequirements> {
  if (!isAbsolute(path)) {
    throw new CliError("--requirements must be an absolute JSON file path.", {
      code: "RESEARCH_EVIDENCE_REQUIREMENTS_INVALID",
      exitCode: 2,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new CliError("Evidence requirements file is missing or invalid JSON.", {
      code: "RESEARCH_EVIDENCE_REQUIREMENTS_INVALID",
      exitCode: 2,
      details: { error: String(error) },
    });
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray((value as ProjectEvidenceRequirements).dimensions) ||
    !Array.isArray((value as ProjectEvidenceRequirements).sourceTypes) ||
    ((value as ProjectEvidenceRequirements).requiredCapabilityIds !== undefined &&
      !Array.isArray((value as ProjectEvidenceRequirements).requiredCapabilityIds)) ||
    ((value as ProjectEvidenceRequirements).requiredCompanionIds !== undefined &&
      !Array.isArray((value as ProjectEvidenceRequirements).requiredCompanionIds)) ||
    ((value as ProjectEvidenceRequirements).requiredDiscoveryScopes !== undefined &&
      !Array.isArray((value as ProjectEvidenceRequirements).requiredDiscoveryScopes)) ||
    typeof (value as ProjectEvidenceRequirements).minSources !== "number" ||
    typeof (value as ProjectEvidenceRequirements).minFullTextSources !== "number" ||
    typeof (value as ProjectEvidenceRequirements).minDatedSources !== "number" ||
    !(
      (value as ProjectEvidenceRequirements).publicationDateFrom === null ||
      typeof (value as ProjectEvidenceRequirements).publicationDateFrom === "string"
    ) ||
    !(
      (value as ProjectEvidenceRequirements).publicationDateTo === null ||
      typeof (value as ProjectEvidenceRequirements).publicationDateTo === "string"
    )
  ) {
    throw new CliError("Evidence requirements file has an unsupported shape.", {
      code: "RESEARCH_EVIDENCE_REQUIREMENTS_INVALID",
      exitCode: 2,
    });
  }
  return normalizeEvidenceRequirements({
    ...(value as ProjectEvidenceRequirements),
    requiredCapabilityIds: (value as ProjectEvidenceRequirements).requiredCapabilityIds ?? [],
    requiredCompanionIds: (value as ProjectEvidenceRequirements).requiredCompanionIds ?? [],
    requiredDiscoveryScopes: (value as ProjectEvidenceRequirements).requiredDiscoveryScopes ?? [],
  });
}

function researchMode(value: string | undefined): ResearchMode {
  if (!value || value === "smoke-test") return "smoke-test";
  if (value === "production-research") return value;
  throw new CliError(`Unsupported research mode: ${value}`, {
    code: "RESEARCH_MODE_INVALID",
    exitCode: 2,
  });
}

function resumeStage(
  value: string | undefined,
): "discover" | "acquire" | "analyze" | "synthesize" | undefined {
  if (!value) return undefined;
  if (value === "discover" || value === "acquire" || value === "analyze" || value === "synthesize")
    return value;
  throw new CliError(`Unsupported --resume-through stage: ${value}`, {
    code: "RESEARCH_PROJECT_FORK_INVALID",
    exitCode: 2,
  });
}

function nativeProducerStage(
  value: string | undefined,
): "discover" | "acquire" | "analyze" | "synthesize" {
  if (value === "discover" || value === "acquire" || value === "analyze" || value === "synthesize")
    return value;
  throw new CliError("--stage must be discover, acquire, analyze, or synthesize.", {
    code: "RESEARCH_NATIVE_STAGE_INVALID",
    exitCode: 2,
  });
}

function nativeHostAgent(value: string | undefined): "codex" | "claude" {
  if (value === "codex" || value === "claude") return value;
  throw new CliError("--host-agent must be codex or claude.", {
    code: "RESEARCH_NATIVE_HOST_INVALID",
    exitCode: 2,
  });
}

async function readNativeEvidenceRequest(path: string): Promise<Record<string, unknown>> {
  return readBoundedJsonRecord(path, "--request", "RESEARCH_BROKER_REQUEST_INVALID");
}

async function readBoundedJsonRecord(
  path: string,
  label: string,
  code: string,
): Promise<Record<string, unknown>> {
  if (!isAbsolute(path)) {
    throw new CliError(`${label} must be an absolute JSON file path.`, {
      code,
      exitCode: 2,
    });
  }
  const selected = resolve(path);
  const info = await lstat(selected).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
    throw new CliError(`${label} must be a bounded regular non-symlink JSON file.`, {
      code,
      exitCode: 2,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(selected, "utf8")) as unknown;
  } catch {
    throw new CliError(`${label} contains invalid JSON.`, {
      code,
      exitCode: 2,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`${label} must contain one JSON object.`, {
      code,
      exitCode: 2,
    });
  }
  return value as Record<string, unknown>;
}

async function workspaceFromArgs(args: ReturnType<typeof parseStrictArgs>): Promise<string> {
  return requireResearchWorkspace(strictString(args, "workspace") ?? process.cwd());
}

function writeJson(io: CliIO, value: unknown, args: ReturnType<typeof parseStrictArgs>): void {
  write(io.stdout, stringifyJson(value, strictBoolean(args, "json")));
}

function writeHelp(io: CliIO): number {
  write(io.stdout, researchOrchestrationHelp());
  return 0;
}

function onePositional(positionals: string[], command: string): string {
  if (positionals.length !== 1) {
    throw new CliError(`${command} requires exactly one positional argument.`, {
      code: "INVALID_ARGS",
      exitCode: 2,
      details: { positionals },
    });
  }
  return positionals[0]!;
}

function rejectPositionals(positionals: string[], command: string): void {
  if (positionals.length) {
    throw new CliError(`${command} does not accept positional arguments.`, {
      code: "INVALID_ARGS",
      exitCode: 2,
      details: { positionals },
    });
  }
}

function inputRole(value: string | undefined): ProjectInput["role"] {
  if (!value || value === "primary") return "primary";
  if (value === "reference" || value === "replication") return value;
  throw new CliError(`Unsupported research input role: ${value}`, {
    code: "RESEARCH_INPUT_ROLE_INVALID",
    exitCode: 2,
  });
}

function integerOption(value: string | undefined, fallback: number, label: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new CliError(`${label} must be an integer.`, {
      code: "RESEARCH_RUN_OPTION_INVALID",
      exitCode: 2,
    });
  }
  return parsed;
}

function unknownAction(command: string, action: string): CliError {
  return new CliError(`Unknown ${command} action: ${action}`, {
    code: "INVALID_ARGS",
    exitCode: 2,
  });
}
