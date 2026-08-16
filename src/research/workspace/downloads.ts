import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import { resolveAgentAcquisitionRoute } from "./acquisition-routes.js";
import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  listEvidenceCandidates,
} from "./evidence-ledger.js";
import { readJournal } from "./journal.js";
import { loadProject } from "./projects.js";
import { sanitizeResearchText, sanitizeResearchValue } from "./sanitization.js";
import {
  canonicalJson,
  isObject,
  pathExists,
  resolveContained,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import { loadWorkspaceConfig } from "./workspace.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SENSITIVE_QUERY_KEY =
  /^(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|awsaccesskeyid|code|cookie|credential|key|password|secret|session(?:[_-]?id)?|sig|signature|token|x[_-]amz[_-](?:credential|security[_-]?token|signature)|x[_-]goog[_-](?:credential|signature))$/i;
const TRACKING_QUERY_KEY = /^(?:utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i;

export const downloadBindingRecordSchema = {
  $id: "https://schemas.tiangong.ai/research/download-binding-input-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "backend", "status", "downloadUrl"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    acquisitionRouteId: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      description:
        "Required for a project with a frozen scientific design; binds this event to one exact planned agent route.",
    },
    backend: {
      type: "string",
      enum: ["native-browser", "chrome", "cloakbrowser", "skill-adapter", "direct-http"],
    },
    status: { type: "string", enum: ["completed", "failed", "cancelled"] },
    path: { type: "string" },
    downloadUrl: { type: "string", format: "uri" },
    suggestedFilename: { type: "string", maxLength: 500 },
    downloadIdentifier: { type: "string", maxLength: 1_000 },
    failureCode: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
  },
} as const;

export interface EvidenceDownloadBinding {
  schemaVersion: 1;
  bindingId: string;
  projectId: string;
  candidateId: string;
  acquisitionRouteId: string | null;
  backend: "native-browser" | "chrome" | "cloakbrowser" | "skill-adapter" | "direct-http";
  status: "completed";
  fileSha256: string;
  fileBytes: number;
  filePathSha256: string;
  downloadUrl: string;
  suggestedFilename: string | null;
  downloadIdentifierSha256: string | null;
  boundAt: string;
  bindingSha256: string;
}

export async function bindEvidenceDownload(input: {
  root: string;
  projectId: string;
  candidateId: string;
  value: Record<string, unknown>;
}): Promise<
  | { status: "completed"; binding: EvidenceDownloadBinding }
  | { status: "failed" | "cancelled"; binding: null; nextAction: string }
> {
  const value = sanitizeResearchValue(input.value);
  if (!isObject(value)) throw downloadError("Download binding input must be a JSON object.");
  const allowed = new Set([
    "schemaVersion",
    "acquisitionRouteId",
    "backend",
    "status",
    "path",
    "downloadUrl",
    "suggestedFilename",
    "downloadIdentifier",
    "failureCode",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const backends = [
    "native-browser",
    "chrome",
    "cloakbrowser",
    "skill-adapter",
    "direct-http",
  ] as const;
  const statuses = ["completed", "failed", "cancelled"] as const;
  if (
    unknown.length ||
    value.schemaVersion !== 1 ||
    (value.acquisitionRouteId !== undefined &&
      (typeof value.acquisitionRouteId !== "string" ||
        !IDENTIFIER.test(value.acquisitionRouteId))) ||
    !backends.includes(value.backend as (typeof backends)[number]) ||
    !statuses.includes(value.status as (typeof statuses)[number]) ||
    typeof value.downloadUrl !== "string" ||
    (value.suggestedFilename !== undefined &&
      (typeof value.suggestedFilename !== "string" || value.suggestedFilename.length > 500)) ||
    (value.downloadIdentifier !== undefined &&
      (typeof value.downloadIdentifier !== "string" || value.downloadIdentifier.length > 1_000)) ||
    (value.failureCode !== undefined &&
      (typeof value.failureCode !== "string" || !IDENTIFIER.test(value.failureCode)))
  ) {
    throw downloadError("Download binding input failed validation.");
  }
  const backend = value.backend as EvidenceDownloadBinding["backend"];
  const status = value.status as "completed" | "failed" | "cancelled";
  const downloadUrl = safeDownloadUrl(value.downloadUrl);
  const project = await requireActiveAcquisition(input.root, input.projectId, input.candidateId);
  const acquisitionRoute = await resolveAgentAcquisitionRoute({
    root: input.root,
    project,
    routeId: value.acquisitionRouteId,
    routeClasses: ["open-access-download", "authorized-browser"],
    downloadBackend: backend,
  });
  const acquisitionRouteId = acquisitionRoute?.id ?? null;
  if (status !== "completed") {
    if (value.path !== undefined) {
      throw downloadError("Failed or cancelled downloads must not claim a completed file path.");
    }
    const failureCode =
      typeof value.failureCode === "string" ? value.failureCode : `download-${status}`;
    await appendEvidenceLedgerEvent(input.root, input.projectId, "download.failed", {
      eventId: `download-event-${randomUUID()}`,
      candidateId: input.candidateId,
      acquisitionRouteId,
      backend,
      status,
      downloadUrl,
      failureCode,
      recordedAt: new Date().toISOString(),
    });
    return {
      status,
      binding: null,
      nextAction:
        "Stop acquisition for this attempt, report the failure, and do not register an artifact or submit a successful acquisition decision.",
    };
  }
  if (typeof value.path !== "string") {
    throw downloadError("A completed download requires one explicit absolute file path.");
  }
  const sourcePath = requireExactExternalPath(input.root, value.path);
  const [info, config] = await Promise.all([
    lstat(sourcePath).catch(() => undefined),
    loadWorkspaceConfig(input.root),
  ]);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw downloadError("Downloaded file must be one existing regular non-symlink file.");
  }
  if (info.size < 1 || info.size > config.budget.maxBytesPerPackage) {
    throw downloadError(
      `Downloaded file size must be 1-${config.budget.maxBytesPerPackage} bytes.`,
    );
  }
  const fileSha256 = await sha256File(sourcePath);
  const core = {
    schemaVersion: 1 as const,
    bindingId: `download-${sha256Text(
      canonicalJson({ candidateId: input.candidateId, acquisitionRouteId, backend, fileSha256 }),
    ).slice(0, 24)}`,
    projectId: input.projectId,
    candidateId: input.candidateId,
    acquisitionRouteId,
    backend,
    status: "completed" as const,
    fileSha256,
    fileBytes: info.size,
    filePathSha256: sha256Text(sourcePath),
    downloadUrl,
    suggestedFilename:
      typeof value.suggestedFilename === "string"
        ? safeFilename(value.suggestedFilename)
        : safeFilename(basename(sourcePath)),
    downloadIdentifierSha256:
      typeof value.downloadIdentifier === "string"
        ? sha256Text(sanitizeResearchText(value.downloadIdentifier))
        : null,
    boundAt: new Date().toISOString(),
  };
  const binding: EvidenceDownloadBinding = {
    ...core,
    bindingSha256: sha256Text(canonicalJson(core)),
  };
  const recordPath = downloadBindingPath(input.root, input.projectId, binding.bindingId);
  if (await pathExists(recordPath)) {
    const existing = parseEvidenceDownloadBinding(JSON.parse(await readFile(recordPath, "utf8")));
    if (
      existing.fileSha256 !== binding.fileSha256 ||
      existing.filePathSha256 !== binding.filePathSha256 ||
      existing.candidateId !== binding.candidateId
    ) {
      throw downloadError("Download binding identity collides with different file provenance.");
    }
    await ensureBoundEvent(input.root, input.projectId, existing);
    return { status: "completed", binding: existing };
  }
  await writeJsonAtomic(recordPath, binding, 0o444);
  await chmod(recordPath, 0o444).catch(() => undefined);
  await ensureBoundEvent(input.root, input.projectId, binding);
  return { status: "completed", binding };
}

async function ensureBoundEvent(
  root: string,
  projectId: string,
  binding: EvidenceDownloadBinding,
): Promise<void> {
  const events = await readJournal(evidenceLedgerPath(root, projectId));
  if (
    events.some(
      (event) =>
        event.type === "download.bound" &&
        event.payload.bindingId === binding.bindingId &&
        event.payload.bindingSha256 === binding.bindingSha256,
    )
  ) {
    return;
  }
  await appendEvidenceLedgerEvent(root, projectId, "download.bound", {
    bindingId: binding.bindingId,
    bindingSha256: binding.bindingSha256,
    candidateId: binding.candidateId,
    acquisitionRouteId: binding.acquisitionRouteId,
    backend: binding.backend,
    fileSha256: binding.fileSha256,
    fileBytes: binding.fileBytes,
    downloadUrl: binding.downloadUrl,
    suggestedFilename: binding.suggestedFilename,
    downloadIdentifierSha256: binding.downloadIdentifierSha256,
    boundAt: binding.boundAt,
  });
}

export async function loadAndVerifyDownloadBinding(input: {
  root: string;
  projectId: string;
  candidateId: string;
  bindingId: string;
  path: string;
}): Promise<EvidenceDownloadBinding> {
  if (!/^download-[0-9a-f]{24}$/.test(input.bindingId)) {
    throw downloadError("Download binding ID is invalid.");
  }
  const sourcePath = requireExactExternalPath(input.root, input.path);
  const binding = parseEvidenceDownloadBinding(
    JSON.parse(
      await readFile(downloadBindingPath(input.root, input.projectId, input.bindingId), "utf8"),
    ),
  );
  const info = await lstat(sourcePath).catch(() => undefined);
  if (
    binding.projectId !== input.projectId ||
    binding.candidateId !== input.candidateId ||
    binding.filePathSha256 !== sha256Text(sourcePath) ||
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.size !== binding.fileBytes ||
    (await sha256File(sourcePath)) !== binding.fileSha256
  ) {
    throw downloadError("Downloaded file no longer matches its exact event binding.");
  }
  return binding;
}

export function parseEvidenceDownloadBinding(value: unknown): EvidenceDownloadBinding {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.bindingId !== "string" ||
    !/^download-[0-9a-f]{24}$/.test(value.bindingId) ||
    typeof value.projectId !== "string" ||
    typeof value.candidateId !== "string" ||
    (value.acquisitionRouteId !== null &&
      (typeof value.acquisitionRouteId !== "string" ||
        !IDENTIFIER.test(value.acquisitionRouteId))) ||
    !["native-browser", "chrome", "cloakbrowser", "skill-adapter", "direct-http"].includes(
      String(value.backend),
    ) ||
    value.status !== "completed" ||
    typeof value.fileSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.fileSha256) ||
    !Number.isInteger(value.fileBytes) ||
    typeof value.filePathSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.filePathSha256) ||
    typeof value.downloadUrl !== "string" ||
    (value.suggestedFilename !== null && typeof value.suggestedFilename !== "string") ||
    (value.downloadIdentifierSha256 !== null &&
      (typeof value.downloadIdentifierSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.downloadIdentifierSha256))) ||
    typeof value.boundAt !== "string" ||
    typeof value.bindingSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.bindingSha256)
  ) {
    throw downloadError("Download binding record is malformed.");
  }
  const { bindingSha256, ...core } = value;
  if (sha256Text(canonicalJson(core)) !== bindingSha256) {
    throw downloadError("Download binding record failed its hash binding.");
  }
  return value as unknown as EvidenceDownloadBinding;
}

async function requireActiveAcquisition(
  root: string,
  projectId: string,
  candidateId: string,
): Promise<Awaited<ReturnType<typeof loadProject>>> {
  const [project, candidates] = await Promise.all([
    loadProject(root, projectId),
    listEvidenceCandidates(root, projectId),
  ]);
  const acquire = project.packages.find(
    (workPackage) =>
      workPackage.stage === "acquire" &&
      workPackage.status === "running" &&
      workPackage.executor === "producer",
  );
  if (!acquire) {
    throw downloadError("Download binding is allowed only during active native acquisition.");
  }
  if (!candidates.some((candidate) => candidate.id === candidateId)) {
    throw downloadError(`Download binding refers to unknown candidate ${candidateId}.`);
  }
  return project;
}

function requireExactExternalPath(root: string, path: string): string {
  const selected = resolve(path);
  if (selected !== path)
    throw downloadError("Downloaded file path must be absolute and normalized.");
  const controlRoot = resolve(workspacePaths(root).control);
  if (!relative(controlRoot, selected).startsWith(`..${sep}`) && selected !== controlRoot) {
    throw downloadError("Downloaded file must be an explicit staging file outside control state.");
  }
  return selected;
}

function safeDownloadUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw downloadError("Download URL is invalid.");
  }
  if (url.protocol !== "https:") throw downloadError("Download URL must use HTTPS.");
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key) || TRACKING_QUERY_KEY.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}

function safeFilename(value: string): string | null {
  const filename = sanitizeResearchText(basename(value))
    .replace(/[\r\n\0]/g, "")
    .trim();
  return filename ? filename.slice(0, 500) : null;
}

function downloadBindingPath(root: string, projectId: string, bindingId: string): string {
  return resolveContained(
    workspacePaths(root).projects,
    `${projectId}/evidence/downloads/${bindingId}.json`,
  );
}

function downloadError(message: string): CliError {
  return new CliError(message, { code: "RESEARCH_DOWNLOAD_BINDING_INVALID", exitCode: 3 });
}
