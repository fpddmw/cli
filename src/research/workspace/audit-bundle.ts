import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import { loadEvidenceArtifactRecords } from "./artifacts.js";
import { verifyCapabilities } from "./capabilities.js";
import { loadProjectEvidenceReceipts } from "./evidence.js";
import { readJournal, verifyJournal } from "./journal.js";
import { loadProject } from "./projects.js";
import { sanitizeResearchText } from "./sanitization.js";
import {
  canonicalJson,
  ensureDirectory,
  isObject,
  pathExists,
  readJsonFile,
  regularTreeFiles,
  resolveContained,
  safeRelativePath,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type { AgentRoute, ProjectState, RuntimeLock } from "./types.js";
import { loadWorkspaceConfig, withWorkspaceLock } from "./workspace.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TEXT_SCAN_BYTES = 16 * 1024 * 1024;

export interface ProjectAuditManifest {
  schemaVersion: 1;
  kind: "tiangong-project-audit-bundle";
  projectId: string;
  createdAt: string;
  authority: {
    status: ProjectState["status"];
    lineageKind: ProjectState["lineage"]["kind"];
    derivedFrom: string | null;
    supersedes: string | null;
    supersededBy: string | null;
  };
  sourceBindings: {
    projectStateSha256: string;
    workspaceJournalHead: string;
    workspaceRuntimeLockSha256: string;
    capabilityLockSha256: string | null;
    sourceWorkspacePathSha256: string;
  };
  locatorRoots: {
    project: "project";
    workspaceObjects: "workspace-objects";
    inputs: "inputs";
  };
  exclusions: string[];
  files: Array<{ path: string; sha256: string; bytes: number }>;
  manifestSha256: string;
}

export async function exportProjectAuditBundle(input: {
  root: string;
  projectId: string;
  destination: string;
}): Promise<ProjectAuditManifest> {
  return withWorkspaceLock(input.root, "research.audit.export", async () => {
    const destination = await validateNewDestination(input.destination);
    const paths = workspacePaths(input.root);
    const project = await loadProject(input.root, input.projectId);
    const journal = await verifyJournal(paths.journal);
    const temporary = join(
      dirname(destination),
      `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await mkdir(temporary, { mode: 0o700 });
    try {
      const staged = new Set<string>();
      const stageFile = async (source: string, logicalPath: string): Promise<void> => {
        const logical = safeRelativePath(logicalPath, "Audit bundle file");
        if (staged.has(logical)) return;
        const info = await lstat(source).catch(() => undefined);
        if (!info?.isFile() || info.isSymbolicLink()) {
          throw auditError(`Audit source is not an exact regular file: ${logical}`);
        }
        const target = resolveContained(temporary, logical);
        await ensureDirectory(dirname(target));
        await copyFile(source, target, fsConstants.COPYFILE_EXCL);
        await chmod(target, 0o444).catch(() => undefined);
        staged.add(logical);
      };

      const projectRoot = join(paths.projects, project.id);
      const projectFiles = await regularTreeFiles(projectRoot).catch((error) => {
        throw auditError("Project tree contains a non-portable entry.", error);
      });
      for (const source of projectFiles) {
        const logical = relative(projectRoot, source).split(sep).join("/");
        if (
          logical === "project.json" ||
          logical.startsWith("runs/") ||
          logical.startsWith("native/")
        ) {
          continue;
        }
        await stageFile(source, `project/${logical}`);
      }

      const portableProject = portableProjectState(project);
      await writeJsonAtomic(join(temporary, "state", "project.json"), portableProject, 0o444);
      staged.add("state/project.json");

      for (const inputRecord of project.inputs) {
        await assertSourceBinding(inputRecord.path, inputRecord.sha256, inputRecord.bytes);
        await stageFile(inputRecord.path, `inputs/${inputRecord.sha256}`);
        if (inputRecord.contextPath && inputRecord.contextSha256 && inputRecord.contextBytes) {
          await assertSourceBinding(
            inputRecord.contextPath,
            inputRecord.contextSha256,
            inputRecord.contextBytes,
          );
          await stageFile(inputRecord.contextPath, `inputs/${inputRecord.contextSha256}`);
        }
      }

      for (const document of project.publicationPolicy?.documents ?? []) {
        const source = resolveContained(paths.control, document.objectLocator);
        await assertSourceBinding(source, document.sha256);
        await stageFile(source, `workspace-objects/${document.objectLocator}`);
      }

      const receipts = await loadProjectEvidenceReceipts(input.root, project.id);
      for (const receipt of receipts) {
        await stageFile(
          resolveContained(paths.control, receipt.locator),
          `workspace-objects/${receipt.locator}`,
        );
        await stageFile(
          resolveContained(paths.control, receipt.contextLocator),
          `workspace-objects/${receipt.contextLocator}`,
        );
      }
      const artifacts = await loadEvidenceArtifactRecords(input.root, project.id);
      for (const artifact of artifacts) {
        await assertSourceBinding(
          resolveContained(paths.control, artifact.locator),
          artifact.sha256,
          artifact.bytes,
        );
        await stageFile(
          resolveContained(paths.control, artifact.locator),
          `workspace-objects/${artifact.locator}`,
        );
      }

      const [config, runtimeLock, capabilityVerification, journalEvents] = await Promise.all([
        loadWorkspaceConfig(input.root),
        readJsonFile<RuntimeLock>(paths.runtimeLock, "Research runtime lock"),
        verifyCapabilities(input.root),
        readJournal(paths.journal),
      ]);
      await writeJsonAtomic(
        join(temporary, "state", "environment.json"),
        {
          schemaVersion: 1,
          mode: config.mode,
          producer: portableAgentRoute(config.producer),
          reviewer: portableAgentRoute(config.reviewer),
          budget: config.budget,
          runtimeLock,
          capabilityVerification,
        },
        0o444,
      );
      staged.add("state/environment.json");
      await writeJsonAtomic(
        join(temporary, "state", "journal-event-proofs.json"),
        {
          schemaVersion: 1,
          workspaceJournalHead: journal.head,
          events: journalEvents.filter(
            (event) => event.scope === project.id || containsExactString(event.payload, project.id),
          ),
        },
        0o444,
      );
      staged.add("state/journal-event-proofs.json");

      await assertPortableTextFiles(temporary, resolve(input.root));
      const files = await bundleFileRecords(temporary);
      const projectStatePath = join(projectRoot, "project.json");
      const capabilityLockSha256 = (await pathExists(paths.capabilityLock))
        ? await sha256File(paths.capabilityLock)
        : null;
      const manifestCore = {
        schemaVersion: 1 as const,
        kind: "tiangong-project-audit-bundle" as const,
        projectId: project.id,
        createdAt: new Date().toISOString(),
        authority: {
          status: project.status,
          lineageKind: project.lineage.kind,
          derivedFrom: project.lineage.derivedFrom,
          supersedes: project.lineage.supersedes,
          supersededBy: project.lineage.supersededBy,
        },
        sourceBindings: {
          projectStateSha256: await sha256File(projectStatePath),
          workspaceJournalHead: journal.head,
          workspaceRuntimeLockSha256: await sha256File(paths.runtimeLock),
          capabilityLockSha256,
          sourceWorkspacePathSha256: sha256Text(resolve(input.root)),
        },
        locatorRoots: {
          project: "project" as const,
          workspaceObjects: "workspace-objects" as const,
          inputs: "inputs" as const,
        },
        exclusions: [
          "credentials and environment secrets",
          "setup sources and browser profiles",
          "active native-stage state",
          "ephemeral run capsules and raw agent authentication",
          "unrelated workspace projects and files",
        ],
        files,
      };
      const manifest: ProjectAuditManifest = {
        ...manifestCore,
        manifestSha256: sha256Text(canonicalJson(manifestCore)),
      };
      await writeJsonAtomic(join(temporary, "manifest.json"), manifest, 0o444);
      await verifyProjectAuditBundle(temporary);
      await rename(temporary, destination);
      return manifest;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function verifyProjectAuditBundle(
  bundlePath: string,
): Promise<{ status: "verified"; projectId: string; manifestSha256: string; files: number }> {
  if (!isAbsolute(bundlePath) || resolve(bundlePath) !== bundlePath) {
    throw auditPathError("Audit bundle path must be absolute and normalized.");
  }
  const info = await lstat(bundlePath).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw auditPathError("Audit bundle must be a regular directory and not a symbolic link.");
  }
  const manifestPath = join(bundlePath, "manifest.json");
  const manifestInfo = await lstat(manifestPath).catch(() => undefined);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) {
    throw auditError("Audit manifest is missing or is not a regular file.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch {
    throw auditError("Audit manifest is not valid JSON.");
  }
  const manifest = parseManifest(value);
  const { manifestSha256, ...core } = manifest;
  if (sha256Text(canonicalJson(core)) !== manifestSha256) {
    throw auditError("Audit manifest failed its hash binding.");
  }
  const actualFiles = (await regularTreeFiles(bundlePath))
    .map((path) => relative(bundlePath, path).split(sep).join("/"))
    .filter((path) => path !== "manifest.json");
  const expectedPaths = manifest.files.map((file) => file.path);
  if (
    actualFiles.length !== expectedPaths.length ||
    actualFiles.some((path, index) => path !== expectedPaths[index])
  ) {
    throw auditError("Audit bundle contains missing, extra, or unordered files.");
  }
  for (const record of manifest.files) {
    const path = resolveContained(bundlePath, record.path);
    const fileInfo = await lstat(path).catch(() => undefined);
    if (
      !fileInfo?.isFile() ||
      fileInfo.isSymbolicLink() ||
      fileInfo.size !== record.bytes ||
      (await sha256File(path)) !== record.sha256
    ) {
      throw auditError(`Audit file failed its exact binding: ${record.path}`);
    }
  }
  await assertPortableTextFiles(bundlePath);
  return {
    status: "verified",
    projectId: manifest.projectId,
    manifestSha256,
    files: manifest.files.length,
  };
}

function portableProjectState(project: ProjectState): ProjectState {
  const portable = structuredClone(project);
  portable.inputs = portable.inputs.map((input) => ({
    ...input,
    path: `inputs/${input.sha256}`,
    ...(input.contextPath && input.contextSha256
      ? { contextPath: `inputs/${input.contextSha256}` }
      : {}),
  }));
  return portable;
}

function portableAgentRoute(route: AgentRoute) {
  return {
    agent: route.agent,
    executionMode: route.executionMode,
    binaryName: basename(route.binary),
    model: route.model,
    effort: route.effort ?? null,
    verbosity: route.verbosity ?? null,
  };
}

async function bundleFileRecords(
  root: string,
): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const files = await regularTreeFiles(root);
  return Promise.all(
    files
      .map((path) => ({ path, logical: relative(root, path).split(sep).join("/") }))
      .filter((item) => item.logical !== "manifest.json")
      .map(async ({ path, logical }) => {
        const info = await lstat(path);
        return { path: logical, sha256: await sha256File(path), bytes: info.size };
      }),
  );
}

async function assertSourceBinding(
  path: string,
  expectedSha256: string,
  expectedBytes?: number,
): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    (expectedBytes !== undefined && info.size !== expectedBytes) ||
    (await sha256File(path)) !== expectedSha256
  ) {
    throw auditError("An audit source no longer matches its recorded hash and size.");
  }
}

async function assertPortableTextFiles(root: string, forbiddenRoot?: string): Promise<void> {
  for (const path of await regularTreeFiles(root)) {
    const info = await lstat(path);
    if (info.size > MAX_TEXT_SCAN_BYTES) continue;
    const bytes = await readFile(path);
    if (!looksTextual(path, bytes)) continue;
    const text = bytes.toString("utf8");
    if (forbiddenRoot && text.includes(forbiddenRoot)) {
      throw new CliError("Audit bundle contains a host-specific workspace path.", {
        code: "RESEARCH_AUDIT_BUNDLE_NONPORTABLE",
        exitCode: 3,
      });
    }
    if (sanitizeResearchText(text) !== text) {
      throw new CliError("Audit bundle contains credential-like or sensitive text.", {
        code: "RESEARCH_AUDIT_BUNDLE_SENSITIVE",
        exitCode: 3,
      });
    }
  }
}

function looksTextual(path: string, bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  if (/\.(?:csv|json|jsonl|md|txt|tsv|ya?ml)$/iu.test(path)) return true;
  const start = bytes.subarray(0, 64).toString("utf8").trimStart();
  return start.startsWith("{") || start.startsWith("[");
}

async function validateNewDestination(value: string): Promise<string> {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw auditPathError("Audit export destination must be absolute and normalized.");
  }
  if (await pathExists(value)) {
    throw auditPathError("Audit export destination must not already exist.");
  }
  const parent = dirname(value);
  const parentInfo = await lstat(parent).catch(() => undefined);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    throw auditPathError("Audit export parent must be an existing regular directory.");
  }
  return value;
}

function parseManifest(value: unknown): ProjectAuditManifest {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-project-audit-bundle" ||
    typeof value.projectId !== "string" ||
    typeof value.createdAt !== "string" ||
    !isObject(value.authority) ||
    !isObject(value.sourceBindings) ||
    !isObject(value.locatorRoots) ||
    value.locatorRoots.project !== "project" ||
    value.locatorRoots.workspaceObjects !== "workspace-objects" ||
    value.locatorRoots.inputs !== "inputs" ||
    !Array.isArray(value.exclusions) ||
    value.exclusions.some((item) => typeof item !== "string") ||
    !Array.isArray(value.files) ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256.test(value.manifestSha256)
  ) {
    throw auditError("Audit manifest shape is invalid.");
  }
  const files = value.files as unknown[];
  if (
    files.some(
      (file) =>
        !isObject(file) ||
        typeof file.path !== "string" ||
        safePathOrNull(file.path) === null ||
        typeof file.sha256 !== "string" ||
        !SHA256.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        Number(file.bytes) < 0,
    )
  ) {
    throw auditError("Audit manifest file records are invalid.");
  }
  const paths = files.map((file) => String((file as Record<string, unknown>).path));
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => index > 0 && paths[index - 1]! >= path)
  ) {
    throw auditError("Audit manifest file paths must be unique and byte-order sorted.");
  }
  return value as unknown as ProjectAuditManifest;
}

function safePathOrNull(value: string): string | null {
  try {
    return safeRelativePath(value, "Audit manifest path");
  } catch {
    return null;
  }
}

function containsExactString(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, target));
  if (!isObject(value)) return false;
  return Object.values(value).some((item) => containsExactString(item, target));
}

function auditError(message: string, cause?: unknown): CliError {
  return new CliError(message, {
    code: "RESEARCH_AUDIT_BUNDLE_INVALID",
    exitCode: 3,
    details: cause ? { cause: cause instanceof Error ? cause.message : String(cause) } : undefined,
  });
}

function auditPathError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_AUDIT_BUNDLE_PATH_INVALID",
    exitCode: 2,
  });
}
