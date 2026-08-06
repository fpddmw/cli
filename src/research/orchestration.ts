import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { CliError } from "../errors.js";
import type { CliIO } from "../io.js";
import { stringifyJson, write } from "../io.js";
import { parseStrictArgs, strictBoolean, strictString } from "../strict-args.js";
import { lockCapabilities, verifyCapabilities } from "./workspace/capabilities.js";
import { inspectResearchContext } from "./workspace/context.js";
import { appendJournalEvent } from "./workspace/journal.js";
import { readAndVerifyProjectInputPlan } from "./workspace/input-plan.js";
import {
  addProjectInput,
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
import { runResearchWorkspace } from "./workspace/runtime.js";
import { schemaForStage } from "./workspace/schemas.js";
import { workspacePaths } from "./workspace/storage.js";
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
  tiangong-ai research context inspect [--path <absolute-path>] [--json]
  tiangong-ai research workspace init <absolute-path> [--name <name>] [--mode smoke-test|production-research] [--json]
  tiangong-ai research workspace doctor [--workspace <absolute-path>] [--agent-smoke] [--json]
  tiangong-ai research capability lock [--workspace <absolute-path>] [--json]
  tiangong-ai research capability verify [--workspace <absolute-path>] [--json]
  tiangong-ai research project init <project-id> --question <question> [--requirements <absolute-json>] [--input-plan <absolute-json>] [--confirm-budget] [--workspace <path>] [--json]
  tiangong-ai research project preflight --question <question> [--requirements <absolute-json>] [--input-plan <absolute-json>] [--workspace <path>] [--json]
  tiangong-ai research project input add <project-id> --path <absolute-file> [--role primary|reference|replication] [--workspace <path>] [--json]
  tiangong-ai research project retry <project-id> [--package <package-id>] [--workspace <path>] [--json]
  tiangong-ai research project fork <source-project-id> --to <target-project-id> [--resume-through discover|analyze|synthesize] [--workspace <path>] [--json]
  tiangong-ai research schema show <discover|analyze|synthesize|review|doctor> [--json]
  tiangong-ai research status [--project <project-id>] [--workspace <absolute-path>] [--json]
  tiangong-ai research run [--project <project-id>] [--max-parallel <1-8>] [--max-cycles <1-100>] [--dry-run] [--progress-jsonl] [--workspace <absolute-path>] [--json]
`;
}

async function runSchema(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") return writeHelp(io);
  if (action !== "show") throw unknownAction("research schema", action);
  const args = parseStrictArgs(rest, COMMON_OPTIONS, "research schema show");
  const stage = onePositional(args.positionals, "research schema show");
  if (
    stage !== "discover" &&
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
      { ...WORKSPACE_OPTIONS, "agent-smoke": "boolean" },
      "research workspace doctor",
    );
    rejectPositionals(args.positionals, "research workspace doctor");
    const result = await doctorResearchWorkspace(strictString(args, "workspace") ?? process.cwd(), {
      agentSmoke: strictBoolean(args, "agent-smoke"),
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
  if (action !== "lock" && action !== "verify") throw unknownAction("research capability", action);
  const args = parseStrictArgs(rest, WORKSPACE_OPTIONS, `research capability ${action}`);
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
    if (inputAction !== "add") throw unknownAction("research project input", inputAction ?? "");
    const args = parseStrictArgs(
      inputRest,
      { ...WORKSPACE_OPTIONS, path: "string", role: "string" },
      "research project input add",
    );
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
  throw unknownAction("research project", action);
}

async function runStatus(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    { ...WORKSPACE_OPTIONS, project: "string" },
    "research status",
  );
  rejectPositionals(args.positionals, "research status");
  const root = await workspaceFromArgs(args);
  const selectedProject = strictString(args, "project");
  const projects = selectedProject
    ? [await loadProject(root, selectedProject)]
    : await listProjects(root);
  const result = {
    workspace: root,
    projects: projects.map((project) => ({
      id: project.id,
      question: project.question,
      status: refreshProject(project).status,
      readyPackage: nextReadyPackage(project)?.id ?? null,
      usage: project.usage,
      inputs: project.inputs,
      packages: project.packages,
    })),
  };
  writeJson(io, result, args);
  return 0;
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
  return normalizeEvidenceRequirements(value as ProjectEvidenceRequirements);
}

function researchMode(value: string | undefined): ResearchMode {
  if (!value || value === "smoke-test") return "smoke-test";
  if (value === "production-research") return value;
  throw new CliError(`Unsupported research mode: ${value}`, {
    code: "RESEARCH_MODE_INVALID",
    exitCode: 2,
  });
}

function resumeStage(value: string | undefined): "discover" | "analyze" | "synthesize" | undefined {
  if (!value) return undefined;
  if (value === "discover" || value === "analyze" || value === "synthesize") return value;
  throw new CliError(`Unsupported --resume-through stage: ${value}`, {
    code: "RESEARCH_PROJECT_FORK_INVALID",
    exitCode: 2,
  });
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
