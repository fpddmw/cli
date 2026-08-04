import { resolve } from "node:path";

import { CliError } from "../errors.js";
import type { CliIO } from "../io.js";
import { stringifyJson, write } from "../io.js";
import { parseStrictArgs, strictBoolean, strictString } from "../strict-args.js";
import { lockCapabilities, verifyCapabilities } from "./workspace/capabilities.js";
import { inspectResearchContext } from "./workspace/context.js";
import { appendJournalEvent } from "./workspace/journal.js";
import {
  addProjectInput,
  initializeProject,
  listProjects,
  loadProject,
  nextReadyPackage,
  refreshProject,
} from "./workspace/projects.js";
import { runResearchWorkspace } from "./workspace/runtime.js";
import { workspacePaths } from "./workspace/storage.js";
import type { ProjectInput } from "./workspace/types.js";
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
  if (subcommand === "status") return runStatus(argv, io);
  if (subcommand === "run") return runWorkspaceExecution(argv, io);
  return undefined;
}

export function researchOrchestrationHelp(): string {
  return `Research workspace commands:
  tiangong-ai research context inspect [--path <absolute-path>] [--json]
  tiangong-ai research workspace init <absolute-path> [--name <name>] [--json]
  tiangong-ai research workspace doctor [--workspace <absolute-path>] [--json]
  tiangong-ai research capability lock [--workspace <absolute-path>] [--json]
  tiangong-ai research capability verify [--workspace <absolute-path>] [--json]
  tiangong-ai research project init <project-id> --question <question> [--workspace <path>] [--json]
  tiangong-ai research project input add <project-id> --path <absolute-file> [--role primary|reference|replication] [--workspace <path>] [--json]
  tiangong-ai research status [--project <project-id>] [--workspace <absolute-path>] [--json]
  tiangong-ai research run [--max-parallel <1-8>] [--max-cycles <1-100>] [--dry-run] [--workspace <absolute-path>] [--json]
`;
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
      { ...COMMON_OPTIONS, name: "string" },
      "research workspace init",
    );
    const target = onePositional(args.positionals, "research workspace init");
    const result = await initializeResearchWorkspace(target, strictString(args, "name"));
    writeJson(io, result, args);
    return 0;
  }
  if (action === "doctor") {
    const args = parseStrictArgs(rest, WORKSPACE_OPTIONS, "research workspace doctor");
    rejectPositionals(args.positionals, "research workspace doctor");
    const result = await doctorResearchWorkspace(strictString(args, "workspace") ?? process.cwd());
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
      { ...WORKSPACE_OPTIONS, question: "string" },
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
    const project = await initializeProject(root, projectId, question);
    writeJson(io, project, args);
    return 0;
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
      "dry-run": "boolean",
    },
    "research run",
  );
  rejectPositionals(args.positionals, "research run");
  const root = await workspaceFromArgs(args);
  const result = await runResearchWorkspace(root, {
    maxParallel: integerOption(strictString(args, "max-parallel"), 1, "--max-parallel"),
    maxCycles: integerOption(strictString(args, "max-cycles"), 20, "--max-cycles"),
    dryRun: strictBoolean(args, "dry-run"),
    environment: io.env,
  });
  writeJson(io, result, args);
  return result.status === "blocked" ? 3 : 0;
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
