import { lstat, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import type { ResearchSetupAgent, ResearchSetupScope } from "./setup-catalog.js";
import {
  isObject,
  pathExists,
  readJsonFile,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "./storage.js";

export const AUTO_RESEARCH_ROUTING_SENTENCE =
  "For every research request, load the project-installed `tiangong-auto-research` Skill and complete its research-question gate before using any tool.";
export const AUTO_RESEARCH_CODEX_ROUTING_START = "<!-- tiangong-auto-research:routing:start -->";
export const AUTO_RESEARCH_CODEX_ROUTING_END = "<!-- tiangong-auto-research:routing:end -->";
export const AUTO_RESEARCH_CODEX_ROUTING_BLOCK = [
  AUTO_RESEARCH_CODEX_ROUTING_START,
  AUTO_RESEARCH_ROUTING_SENTENCE,
  AUTO_RESEARCH_CODEX_ROUTING_END,
].join("\n");
export const AUTO_RESEARCH_CLAUDE_ROUTING_RULE = [
  "# Tiangong Auto Research routing",
  "",
  AUTO_RESEARCH_ROUTING_SENTENCE,
  "",
].join("\n");

const INSTRUCTION_OWNERSHIP_FILE = "setup-instruction-routing.json";
const MAX_INSTRUCTION_BYTES = 1024 * 1024;

export interface ResearchSetupInstructionRoutingTarget {
  agent: ResearchSetupAgent;
  strategy: "managed-block" | "owned-file";
  path: string;
  managedContent: string;
  managedContentSha256: string;
}

export interface ResearchSetupInstructionRoutingPlan {
  policy: "project-only";
  restartRequired: boolean;
  targets: ResearchSetupInstructionRoutingTarget[];
}

export interface ResearchSetupInstructionRoutingStatus {
  status: "not-required" | "installed" | "missing" | "drifted" | "blocked";
  restartRequired: boolean;
  targets: Array<
    ResearchSetupInstructionRoutingTarget & {
      status: "installed" | "missing" | "drifted" | "blocked";
      detail: string;
    }
  >;
}

interface InstructionOwnershipTarget extends ResearchSetupInstructionRoutingTarget {
  ownedBySetup: boolean;
  createdFile: boolean;
  insertedPrefix: string;
  insertedSuffix: string;
  installedDocumentSha256: string;
}

interface InstructionOwnershipRecord {
  schemaVersion: 1;
  planSha256: string;
  targets: InstructionOwnershipTarget[];
}

interface DetailedInspection {
  target: ResearchSetupInstructionRoutingTarget;
  status: "installed" | "missing" | "drifted" | "blocked";
  detail: string;
  document: string | null;
  documentMode: number | null;
  managedContentSha256: string | null;
  managedStart: number | null;
  managedEnd: number | null;
}

export function planResearchSetupInstructionRouting(input: {
  workspace: string;
  scope: ResearchSetupScope;
  agents: ResearchSetupAgent[];
  selectedSkillIds: string[];
}): ResearchSetupInstructionRoutingPlan {
  const enabled =
    input.scope === "project" && input.selectedSkillIds.includes("tiangong.auto-research");
  const root = resolve(input.workspace);
  const targets = enabled
    ? [...new Set(input.agents)]
        .map(
          (agent): ResearchSetupInstructionRoutingTarget =>
            agent === "codex"
              ? {
                  agent,
                  strategy: "managed-block",
                  path: join(root, "AGENTS.md"),
                  managedContent: AUTO_RESEARCH_CODEX_ROUTING_BLOCK,
                  managedContentSha256: sha256Text(AUTO_RESEARCH_CODEX_ROUTING_BLOCK),
                }
              : {
                  agent,
                  strategy: "owned-file",
                  path: join(root, ".claude", "rules", "tiangong-auto-research.md"),
                  managedContent: AUTO_RESEARCH_CLAUDE_ROUTING_RULE,
                  managedContentSha256: sha256Text(AUTO_RESEARCH_CLAUDE_ROUTING_RULE),
                },
        )
        .sort((left, right) => left.agent.localeCompare(right.agent))
    : [];
  return {
    policy: "project-only",
    restartRequired: targets.length > 0,
    targets,
  };
}

export function isResearchSetupInstructionRoutingPlan(
  value: unknown,
): value is ResearchSetupInstructionRoutingPlan {
  if (
    !isObject(value) ||
    value.policy !== "project-only" ||
    typeof value.restartRequired !== "boolean" ||
    !Array.isArray(value.targets)
  ) {
    return false;
  }
  const targets = value.targets;
  if (
    targets.some(
      (target) =>
        !isObject(target) ||
        (target.agent !== "codex" && target.agent !== "claude-code") ||
        (target.strategy !== "managed-block" && target.strategy !== "owned-file") ||
        typeof target.path !== "string" ||
        !isAbsolute(target.path) ||
        typeof target.managedContent !== "string" ||
        target.managedContent.length === 0 ||
        target.managedContent.length > 4096 ||
        typeof target.managedContentSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(target.managedContentSha256) ||
        sha256Text(target.managedContent) !== target.managedContentSha256,
    ) ||
    new Set(targets.map((target) => (isObject(target) ? target.agent : null))).size !==
      targets.length ||
    value.restartRequired !== targets.length > 0
  ) {
    return false;
  }
  return true;
}

export async function inspectResearchSetupInstructionRouting(input: {
  workspace: string;
  routing: ResearchSetupInstructionRoutingPlan;
}): Promise<ResearchSetupInstructionRoutingStatus> {
  if (input.routing.targets.length === 0) {
    return { status: "not-required", restartRequired: false, targets: [] };
  }
  const targets = await Promise.all(
    input.routing.targets.map((target) => inspectTarget(input.workspace, target)),
  );
  const status = targets.some((target) => target.status === "blocked")
    ? "blocked"
    : targets.some((target) => target.status === "drifted")
      ? "drifted"
      : targets.some((target) => target.status === "missing")
        ? "missing"
        : "installed";
  return {
    status,
    restartRequired: true,
    targets: targets.map(({ document: _document, documentMode: _mode, ...target }) => ({
      agent: target.target.agent,
      strategy: target.target.strategy,
      path: target.target.path,
      managedContent: target.target.managedContent,
      managedContentSha256: target.target.managedContentSha256,
      status: target.status,
      detail: target.detail,
    })),
  };
}

export async function reconcileResearchSetupInstructionRouting(input: {
  workspace: string;
  planSha256: string;
  routing: ResearchSetupInstructionRoutingPlan;
}): Promise<ResearchSetupInstructionRoutingStatus> {
  const ownership = await loadOwnership(input.workspace);
  const priorByPath = new Map(ownership?.targets.map((target) => [target.path, target]) ?? []);
  const desiredByPath = new Map(input.routing.targets.map((target) => [target.path, target]));
  const desiredInspections = await Promise.all(
    input.routing.targets.map((target) => inspectTarget(input.workspace, target)),
  );
  const retiredTargets = (ownership?.targets ?? []).filter(
    (target) => !desiredByPath.has(target.path),
  );
  const retiredInspections = await Promise.all(
    retiredTargets.map((target) => inspectTarget(input.workspace, target)),
  );

  for (const inspection of [...desiredInspections, ...retiredInspections]) {
    if (inspection.status === "blocked") {
      throw routingConflict(
        inspection.detail,
        inspection.detail.includes("symbolic link")
          ? "RESEARCH_SETUP_SYMLINK_BLOCKED"
          : "RESEARCH_SETUP_INSTRUCTION_ROUTING_CONFLICT",
      );
    }
  }
  for (const inspection of desiredInspections) {
    if (inspection.status !== "drifted") continue;
    const prior = priorByPath.get(inspection.target.path);
    if (!prior?.ownedBySetup || inspection.managedContentSha256 !== prior.managedContentSha256) {
      throw routingConflict(
        `Project instruction bytes are owner-controlled or changed: ${inspection.target.agent}.`,
      );
    }
  }
  for (const inspection of retiredInspections) {
    const prior = priorByPath.get(inspection.target.path)!;
    if (
      prior.ownedBySetup &&
      inspection.status !== "missing" &&
      inspection.managedContentSha256 !== prior.managedContentSha256
    ) {
      throw routingConflict(
        `Setup will not remove a user-modified project instruction: ${inspection.target.agent}.`,
      );
    }
  }

  const nextOwnership: InstructionOwnershipTarget[] = [];
  for (const inspection of desiredInspections) {
    nextOwnership.push(
      await installTarget(input.workspace, inspection, priorByPath.get(inspection.target.path)),
    );
  }
  for (const inspection of retiredInspections) {
    const prior = priorByPath.get(inspection.target.path)!;
    if (prior.ownedBySetup) await removeTarget(input.workspace, inspection, prior);
  }

  const ownershipPath = instructionOwnershipPath(input.workspace);
  if (nextOwnership.length === 0) {
    await rm(ownershipPath, { force: true });
  } else {
    await writeJsonAtomic(ownershipPath, {
      schemaVersion: 1,
      planSha256: input.planSha256,
      targets: nextOwnership.sort((left, right) => left.agent.localeCompare(right.agent)),
    } satisfies InstructionOwnershipRecord);
  }
  return inspectResearchSetupInstructionRouting({
    workspace: input.workspace,
    routing: input.routing,
  });
}

async function installTarget(
  workspace: string,
  inspection: DetailedInspection,
  prior: InstructionOwnershipTarget | undefined,
): Promise<InstructionOwnershipTarget> {
  const target = inspection.target;
  const desired = desiredContent(target);
  if (inspection.status === "installed") {
    return {
      ...target,
      ownedBySetup: prior?.ownedBySetup ?? false,
      createdFile: prior?.createdFile ?? false,
      insertedPrefix: prior?.insertedPrefix ?? "",
      insertedSuffix: prior?.insertedSuffix ?? "",
      installedDocumentSha256: sha256Text(inspection.document ?? desired),
    };
  }
  if (target.strategy === "owned-file") {
    await assertSafeInstructionPath(workspace, target.path);
    await writeTextAtomic(target.path, desired, 0o644);
    return {
      ...target,
      ownedBySetup: true,
      createdFile: inspection.status === "missing",
      insertedPrefix: "",
      insertedSuffix: "",
      installedDocumentSha256: sha256Text(desired),
    };
  }

  const existing = inspection.document ?? "";
  const createdFile = inspection.status === "missing" && !(await pathExists(target.path));
  let next: string;
  let insertedPrefix = prior?.insertedPrefix ?? "";
  let insertedSuffix = prior?.insertedSuffix ?? "";
  if (inspection.status === "drifted" && inspection.managedStart !== null) {
    next =
      existing.slice(0, inspection.managedStart) + desired + existing.slice(inspection.managedEnd!);
  } else {
    insertedPrefix = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    insertedSuffix = "\n";
    next = `${existing}${insertedPrefix}${desired}${insertedSuffix}`;
  }
  await assertSafeInstructionPath(workspace, target.path);
  await writeTextAtomic(target.path, next, inspection.documentMode ?? 0o644);
  return {
    ...target,
    ownedBySetup: true,
    createdFile,
    insertedPrefix,
    insertedSuffix,
    installedDocumentSha256: sha256Text(next),
  };
}

async function removeTarget(
  workspace: string,
  inspection: DetailedInspection,
  ownership: InstructionOwnershipTarget,
): Promise<void> {
  if (inspection.status === "missing") return;
  await assertSafeInstructionPath(workspace, ownership.path);
  if (ownership.strategy === "owned-file") {
    await rm(ownership.path, { force: true });
    return;
  }
  const document = inspection.document!;
  const unchanged = sha256Text(document) === ownership.installedDocumentSha256;
  let start = inspection.managedStart!;
  let end = inspection.managedEnd!;
  if (
    unchanged &&
    ownership.insertedPrefix &&
    document.slice(start - ownership.insertedPrefix.length, start) === ownership.insertedPrefix
  ) {
    start -= ownership.insertedPrefix.length;
  }
  if (
    unchanged &&
    ownership.insertedSuffix &&
    document.slice(end, end + ownership.insertedSuffix.length) === ownership.insertedSuffix
  ) {
    end += ownership.insertedSuffix.length;
  }
  const next = document.slice(0, start) + document.slice(end);
  if (unchanged && ownership.createdFile && next.length === 0) {
    await rm(ownership.path, { force: true });
    return;
  }
  await writeTextAtomic(ownership.path, next, inspection.documentMode ?? 0o644);
}

async function inspectTarget(
  workspace: string,
  target: ResearchSetupInstructionRoutingTarget,
): Promise<DetailedInspection> {
  try {
    await assertSafeInstructionPath(workspace, target.path);
    const info = await lstat(target.path).catch(() => undefined);
    if (!info) return inspection(target, "missing", "Project instruction is not installed.");
    if (!info.isFile() || info.isSymbolicLink()) {
      return inspection(
        target,
        "blocked",
        "Project instruction target is not a regular non-symbolic-link file.",
      );
    }
    if (info.size > MAX_INSTRUCTION_BYTES) {
      return inspection(target, "blocked", "Project instruction target exceeds the byte limit.");
    }
    const document = await readFile(target.path, "utf8");
    if (target.strategy === "owned-file") {
      const observed = sha256Text(document);
      return {
        ...inspection(
          target,
          observed === target.managedContentSha256 ? "installed" : "drifted",
          observed === target.managedContentSha256
            ? "Owned project instruction bytes match the reviewed content."
            : "Owned project instruction bytes differ from the reviewed content.",
        ),
        document,
        documentMode: info.mode & 0o777,
        managedContentSha256: observed,
        managedStart: 0,
        managedEnd: document.length,
      };
    }
    const managed = locateManagedBlock(document);
    if (managed.kind === "missing") {
      return {
        ...inspection(target, "missing", "The managed Codex routing block is absent."),
        document,
        documentMode: info.mode & 0o777,
      };
    }
    if (managed.kind === "blocked") {
      return {
        ...inspection(target, "blocked", managed.detail),
        document,
        documentMode: info.mode & 0o777,
      };
    }
    const observed = sha256Text(managed.content);
    return {
      ...inspection(
        target,
        observed === target.managedContentSha256 ? "installed" : "drifted",
        observed === target.managedContentSha256
          ? "Managed Codex routing bytes match the reviewed content."
          : "Managed Codex routing bytes differ from the reviewed content.",
      ),
      document,
      documentMode: info.mode & 0o777,
      managedContentSha256: observed,
      managedStart: managed.start,
      managedEnd: managed.end,
    };
  } catch (error) {
    return inspection(
      target,
      "blocked",
      error instanceof Error ? error.message : "Project instruction inspection failed.",
    );
  }
}

function inspection(
  target: ResearchSetupInstructionRoutingTarget,
  status: DetailedInspection["status"],
  detail: string,
): DetailedInspection {
  return {
    target,
    status,
    detail,
    document: null,
    documentMode: null,
    managedContentSha256: null,
    managedStart: null,
    managedEnd: null,
  };
}

function locateManagedBlock(
  document: string,
):
  | { kind: "missing" }
  | { kind: "blocked"; detail: string }
  | { kind: "found"; content: string; start: number; end: number } {
  const starts = markerOffsets(document, AUTO_RESEARCH_CODEX_ROUTING_START);
  const ends = markerOffsets(document, AUTO_RESEARCH_CODEX_ROUTING_END);
  if (starts.length === 0 && ends.length === 0) return { kind: "missing" };
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) {
    return {
      kind: "blocked",
      detail: "Managed Codex routing markers are duplicated, incomplete, or out of order.",
    };
  }
  const start = starts[0]!;
  const end = ends[0]! + AUTO_RESEARCH_CODEX_ROUTING_END.length;
  return { kind: "found", content: document.slice(start, end), start, end };
}

function markerOffsets(document: string, marker: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while (offset <= document.length) {
    const found = document.indexOf(marker, offset);
    if (found < 0) break;
    offsets.push(found);
    offset = found + marker.length;
  }
  return offsets;
}

function desiredContent(target: ResearchSetupInstructionRoutingTarget): string {
  return target.managedContent;
}

async function assertSafeInstructionPath(workspace: string, path: string): Promise<void> {
  const root = resolve(workspace);
  const target = resolve(path);
  const portable = relative(root, target);
  if (!portable || portable === ".." || portable.startsWith(`..${sep}`) || isAbsolute(portable)) {
    throw routingConflict(
      "Project instruction target escapes the selected workspace.",
      "RESEARCH_SETUP_INSTRUCTION_ROUTING_INVALID",
    );
  }
  let current = root;
  const parts = portable.split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    const info = await lstat(current).catch(() => undefined);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      throw routingConflict(
        "Project instruction mutation path contains a symbolic link.",
        "RESEARCH_SETUP_SYMLINK_BLOCKED",
      );
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw routingConflict(
        "Project instruction mutation path has a non-directory parent.",
        "RESEARCH_SETUP_INSTRUCTION_ROUTING_INVALID",
      );
    }
  }
}

async function loadOwnership(workspace: string): Promise<InstructionOwnershipRecord | null> {
  const path = instructionOwnershipPath(workspace);
  if (!(await pathExists(path))) return null;
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_INSTRUCTION_BYTES) {
    throw routingConflict(
      "Setup instruction routing ownership is linked, oversized, or not a regular file.",
      "RESEARCH_SETUP_INSTRUCTION_ROUTING_INVALID",
    );
  }
  const value = await readJsonFile<unknown>(path, "Setup instruction routing ownership");
  if (!isInstructionOwnershipRecord(value, workspace)) {
    throw routingConflict(
      "Setup instruction routing ownership is invalid or escaped its workspace.",
      "RESEARCH_SETUP_INSTRUCTION_ROUTING_INVALID",
    );
  }
  return value;
}

function isInstructionOwnershipRecord(
  value: unknown,
  workspace: string,
): value is InstructionOwnershipRecord {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.planSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.planSha256) ||
    !Array.isArray(value.targets)
  ) {
    return false;
  }
  const expectedPaths = new Map([
    ["codex", join(resolve(workspace), "AGENTS.md")],
    ["claude-code", join(resolve(workspace), ".claude", "rules", "tiangong-auto-research.md")],
  ]);
  return (
    new Set(value.targets.map((target) => (isObject(target) ? target.agent : null))).size ===
      value.targets.length &&
    value.targets.every(
      (target) =>
        isObject(target) &&
        (target.agent === "codex" || target.agent === "claude-code") &&
        expectedPaths.get(target.agent) === target.path &&
        ((target.agent === "codex" && target.strategy === "managed-block") ||
          (target.agent === "claude-code" && target.strategy === "owned-file")) &&
        typeof target.managedContent === "string" &&
        typeof target.managedContentSha256 === "string" &&
        sha256Text(target.managedContent) === target.managedContentSha256 &&
        /^[0-9a-f]{64}$/.test(target.managedContentSha256) &&
        typeof target.ownedBySetup === "boolean" &&
        typeof target.createdFile === "boolean" &&
        typeof target.insertedPrefix === "string" &&
        typeof target.insertedSuffix === "string" &&
        typeof target.installedDocumentSha256 === "string" &&
        /^[0-9a-f]{64}$/.test(target.installedDocumentSha256),
    )
  );
}

function instructionOwnershipPath(workspace: string): string {
  return join(workspacePaths(workspace).control, INSTRUCTION_OWNERSHIP_FILE);
}

function routingConflict(
  reason: string,
  code = "RESEARCH_SETUP_INSTRUCTION_ROUTING_CONFLICT",
): CliError {
  return new CliError(reason, {
    code,
    exitCode: 3,
    details: {
      step: "project-instruction-routing",
      minimumAction:
        "Review the reported project instruction file. Preserve owner content, resolve the conflict explicitly, then retry the exact setup plan.",
    },
  });
}
