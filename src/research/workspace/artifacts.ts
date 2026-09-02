import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

import { PDFDocument } from "pdf-lib";

import { CliError } from "../../errors.js";
import {
  loadAndVerifyDownloadBinding,
  parseEvidenceDownloadBinding,
  type EvidenceDownloadBinding,
} from "./downloads.js";
import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  listEvidenceCandidates,
} from "./evidence-ledger.js";
import { readJournal } from "./journal.js";
import { sanitizeResearchText } from "./sanitization.js";
import {
  canonicalJson,
  ensureDirectory,
  isObject,
  pathExists,
  readJsonFile,
  resolveContained,
  sha256Bytes,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import { loadWorkspaceConfig } from "./workspace.js";

const SENSITIVE_QUERY_KEY =
  /^(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|code|cookie|credential|key|password|secret|session(?:[_-]?id)?|sig|signature|token|x[_-]amz[_-](?:credential|security[_-]?token|signature)|x[_-]goog[_-](?:credential|signature))$/i;
const TRACKING_QUERY_KEY = /^(?:utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

export interface EvidenceArtifactRecord {
  schemaVersion: 1;
  artifactId: string;
  projectId: string;
  candidateId: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  originalFilename: string;
  sourceUrl: string | null;
  license: string | null;
  licenseUrl: string | null;
  hostType: string | null;
  articleVersion: string | null;
  downloadBinding: EvidenceDownloadBinding | null;
  derivedFromArtifactId: string | null;
  locator: string;
  registeredAt: string;
  validation: {
    kind: string;
    checks: string[];
    details: Record<string, string | number | boolean | string[]>;
  };
}

/** Read-only metadata preflight; performs no download, content read, or registration. */
export async function preflightEvidenceArtifact(input: {
  root: string;
  bytes?: number;
  path?: string;
}) {
  if ((input.bytes === undefined) === (input.path === undefined)) {
    throw artifactError(
      "Artifact preflight requires exactly one of --bytes or --path.",
      "RESEARCH_ARTIFACT_SIZE_INVALID",
    );
  }
  let bytes = input.bytes;
  if (input.path !== undefined) {
    const path = requireExactAbsolutePath(input.path);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw artifactError(
        "Artifact preflight path must be one explicit regular non-symlink file.",
        "RESEARCH_ARTIFACT_PATH_INVALID",
      );
    }
    bytes = info.size;
  }
  if (!Number.isSafeInteger(bytes) || bytes! < 1) {
    throw artifactError(
      "Known artifact bytes must be a positive safe integer.",
      "RESEARCH_ARTIFACT_SIZE_INVALID",
    );
  }
  const { budget } = await loadWorkspaceConfig(input.root);
  const allowed = bytes! <= budget.maxBytesPerArtifact;
  return {
    schemaVersion: 1,
    kind: "tiangong-artifact-preflight",
    decision: allowed ? "pass" : "stop",
    knownBytes: bytes!,
    limits: {
      maxBytesPerArtifact: budget.maxBytesPerArtifact,
      maxBytesPerPackage: budget.maxBytesPerPackage,
    },
    checksPerformed: [
      input.path === undefined ? "caller-declared-byte-count" : "regular-file-stat",
      "single-artifact-byte-limit",
    ],
    contentValidated: false,
    recommendedAction: allowed
      ? "Size is admissible only; exact download binding, format, hash, and acquisition checks remain required. maxBytesPerPackage limits aggregate generated package outputs separately."
      : "Stop before download. Request a provider-side subset/filter or a smaller official export preserving required variables and provenance. If unavailable, record the acquisition limitation and request a scope/access decision; do not register unverified references or blindly raise memory limits.",
  };
}

export async function registerEvidenceArtifact(input: {
  root: string;
  projectId: string;
  candidateId: string;
  path: string;
  mediaType?: string;
  sourceUrl?: string;
  license?: string;
  licenseUrl?: string;
  hostType?: string;
  articleVersion?: string;
  downloadBindingId?: string;
  derivedFromArtifactId?: string;
}): Promise<EvidenceArtifactRecord> {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(input.projectId)) {
    throw artifactError("Artifact project ID is invalid.", "RESEARCH_ARTIFACT_PATH_INVALID");
  }
  const sourcePath = requireExactAbsolutePath(input.path);
  const controlRoot = resolve(workspacePaths(input.root).control);
  if (!relative(controlRoot, sourcePath).startsWith(`..${sep}`) && sourcePath !== controlRoot) {
    throw artifactError(
      "Artifact input must be outside .tiangong-research; register the exact external download/staging file.",
      "RESEARCH_ARTIFACT_PATH_INVALID",
    );
  }
  const info = await lstat(sourcePath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw artifactError(
      "Artifact path must be one explicit regular file and cannot be a symbolic link.",
      "RESEARCH_ARTIFACT_PATH_INVALID",
    );
  }
  const [project, config, candidates] = await Promise.all([
    readJsonFile<unknown>(
      resolveContained(workspacePaths(input.root).projects, `${input.projectId}/project.json`),
      `Research project ${input.projectId}`,
    ),
    loadWorkspaceConfig(input.root),
    listEvidenceCandidates(input.root, input.projectId),
  ]);
  const acquire =
    isObject(project) && Array.isArray(project.packages)
      ? project.packages.find(
          (workPackage) => isObject(workPackage) && workPackage.stage === "acquire",
        )
      : undefined;
  if (!isObject(acquire) || acquire.status !== "running" || acquire.executor !== "producer") {
    throw artifactError(
      "Artifact registration is allowed only during the active native acquisition stage.",
      "RESEARCH_ACQUISITION_STAGE_REQUIRED",
    );
  }
  if (!candidates.some((candidate) => candidate.id === input.candidateId)) {
    throw artifactError(
      `Artifact refers to unknown candidate ${input.candidateId}.`,
      "RESEARCH_ARTIFACT_CANDIDATE_INVALID",
    );
  }
  if (info.size < 1 || info.size > config.budget.maxBytesPerArtifact) {
    throw artifactError(
      `Artifact size must be 1-${config.budget.maxBytesPerArtifact} bytes (maxBytesPerArtifact); request a provider-side subset/filter before download for larger files.`,
      "RESEARCH_ARTIFACT_SIZE_INVALID",
    );
  }
  const downloadBinding = input.downloadBindingId
    ? await loadAndVerifyDownloadBinding({
        root: input.root,
        projectId: input.projectId,
        candidateId: input.candidateId,
        bindingId: input.downloadBindingId,
        path: sourcePath,
      })
    : null;
  if (downloadBinding && input.derivedFromArtifactId) {
    throw artifactError(
      "An artifact cannot be both an exact download and a derived file.",
      "RESEARCH_ARTIFACT_BINDING_INVALID",
    );
  }
  let derivedFromArtifactId: string | null = null;
  let derivedFromArtifact: EvidenceArtifactRecord | null = null;
  if (input.derivedFromArtifactId) {
    const registered = await loadEvidenceArtifactRecords(input.root, input.projectId);
    const parent = registered.find(
      (artifact) => artifact.artifactId === input.derivedFromArtifactId,
    );
    if (!parent || parent.candidateId !== input.candidateId) {
      throw artifactError(
        "Derived artifact parent is missing or bound to a different candidate.",
        "RESEARCH_ARTIFACT_BINDING_INVALID",
      );
    }
    derivedFromArtifactId = parent.artifactId;
    derivedFromArtifact = parent;
  }
  const declaredSourceUrl = canonicalSourceUrl(input.sourceUrl);
  if (declaredSourceUrl && !downloadBinding && !derivedFromArtifact) {
    throw artifactError(
      "Network-derived artifacts require an exact completed download binding.",
      "RESEARCH_DOWNLOAD_BINDING_REQUIRED",
    );
  }
  if (downloadBinding && declaredSourceUrl && declaredSourceUrl !== downloadBinding.downloadUrl) {
    throw artifactError(
      "Artifact source URL does not match its exact download binding.",
      "RESEARCH_DOWNLOAD_BINDING_INVALID",
    );
  }
  if (
    derivedFromArtifact &&
    declaredSourceUrl &&
    declaredSourceUrl !== derivedFromArtifact.sourceUrl
  ) {
    throw artifactError(
      "Derived artifact source URL does not match its registered parent artifact.",
      "RESEARCH_ARTIFACT_BINDING_INVALID",
    );
  }
  const bytes = await readFile(sourcePath);
  const mediaType = normalizeMediaType(input.mediaType ?? inferMediaType(sourcePath));
  const validation = await validateArtifactBytes(bytes, mediaType);
  const sha256 = sha256Bytes(bytes);
  const artifactId = `artifact-${sha256Text(`${input.candidateId}:${sha256}`).slice(0, 24)}`;
  const locator = `evidence/artifacts/${sha256.slice(0, 2)}/${sha256}`;
  const destination = resolveContained(workspacePaths(input.root).control, locator);
  await persistImmutableArtifact(destination, bytes, sha256);
  const record: EvidenceArtifactRecord = {
    schemaVersion: 1,
    artifactId,
    projectId: input.projectId,
    candidateId: input.candidateId,
    sha256,
    bytes: bytes.byteLength,
    mediaType,
    originalFilename: sanitizeFilename(basename(sourcePath)),
    sourceUrl: downloadBinding?.downloadUrl ?? derivedFromArtifact?.sourceUrl ?? declaredSourceUrl,
    license: boundedOptionalMetadata(input.license, "license"),
    licenseUrl: canonicalSourceUrl(input.licenseUrl),
    hostType: boundedOptionalMetadata(input.hostType, "host type"),
    articleVersion: boundedOptionalMetadata(input.articleVersion, "article version"),
    downloadBinding,
    derivedFromArtifactId,
    locator,
    registeredAt: new Date().toISOString(),
    validation,
  };
  const recordPath = artifactRecordPath(input.root, input.projectId, artifactId);
  if (await pathExists(recordPath)) {
    const existing = parseArtifactRecord(JSON.parse(await readFile(recordPath, "utf8")));
    const stableExisting = { ...existing, registeredAt: record.registeredAt };
    if (canonicalJson(stableExisting) !== canonicalJson(record)) {
      throw artifactError(
        "Artifact identity already exists with different metadata.",
        "RESEARCH_ARTIFACT_STORE_INVALID",
      );
    }
    return existing;
  }
  await writeJsonAtomic(recordPath, record, 0o444);
  await chmod(recordPath, 0o444).catch(() => undefined);
  await appendEvidenceLedgerEvent(input.root, input.projectId, "artifact.registered", {
    artifactId,
    candidateId: input.candidateId,
    sha256,
    bytes: record.bytes,
    mediaType,
    locator,
    sourceUrl: record.sourceUrl,
    downloadBindingId: downloadBinding?.bindingId ?? null,
    derivedFromArtifactId,
    validation,
  });
  return record;
}

export async function loadEvidenceArtifactRecords(
  root: string,
  projectId: string,
): Promise<EvidenceArtifactRecord[]> {
  const directory = resolveContained(
    workspacePaths(root).projects,
    `${projectId}/evidence/artifacts`,
  );
  if (!(await pathExists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const records: EvidenceArtifactRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const record = parseArtifactRecord(
      JSON.parse(await readFile(resolve(directory, entry.name), "utf8")),
    );
    if (record.projectId !== projectId || entry.name !== `${record.artifactId}.json`) {
      throw artifactError(
        "Artifact record identity does not match its path.",
        "RESEARCH_ARTIFACT_STORE_INVALID",
      );
    }
    await verifyEvidenceArtifact(root, record);
    records.push(record);
  }
  return records;
}

export async function verifyEvidenceArtifact(
  root: string,
  record: EvidenceArtifactRecord,
): Promise<void> {
  const expectedLocator = `evidence/artifacts/${record.sha256.slice(0, 2)}/${record.sha256}`;
  const path = resolveContained(workspacePaths(root).control, record.locator);
  const info = await lstat(path).catch(() => undefined);
  if (
    record.locator !== expectedLocator ||
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.size !== record.bytes ||
    (await sha256File(path)) !== record.sha256
  ) {
    throw artifactError(
      `Registered artifact is missing or drifted: ${record.artifactId}.`,
      "RESEARCH_ARTIFACT_DRIFT",
    );
  }
  await validateArtifactBytes(await readFile(path), record.mediaType);
  if (record.downloadBinding) {
    const events = await readJournal(evidenceLedgerPath(root, record.projectId));
    const bound = events.some(
      (event) =>
        event.type === "download.bound" &&
        event.payload.bindingId === record.downloadBinding?.bindingId &&
        event.payload.bindingSha256 === record.downloadBinding?.bindingSha256 &&
        event.payload.fileSha256 === record.sha256 &&
        event.payload.candidateId === record.candidateId,
    );
    if (!bound) {
      throw artifactError(
        `Artifact download binding is absent from the evidence ledger: ${record.artifactId}.`,
        "RESEARCH_ARTIFACT_DRIFT",
      );
    }
  }
}

export async function stageEvidenceArtifacts(
  root: string,
  projectId: string,
  capsuleProject: string,
  selectedArtifactIds?: ReadonlySet<string>,
): Promise<EvidenceArtifactRecord[]> {
  const registered = await loadEvidenceArtifactRecords(root, projectId);
  const records = selectedArtifactIds
    ? registered.filter((record) => selectedArtifactIds.has(record.artifactId))
    : registered;
  if (selectedArtifactIds && records.length !== selectedArtifactIds.size) {
    const registeredIds = new Set(registered.map((record) => record.artifactId));
    const missing = [...selectedArtifactIds].filter((artifactId) => !registeredIds.has(artifactId));
    throw artifactError(
      `Frozen evidence snapshot refers to missing registered artifacts: ${missing.join(", ")}.`,
      "RESEARCH_ARTIFACT_DRIFT",
    );
  }
  const copied = new Set<string>();
  for (const record of records) {
    await verifyEvidenceArtifact(root, record);
    if (copied.has(record.sha256)) continue;
    const source = resolveContained(workspacePaths(root).control, record.locator);
    const destination = resolveContained(capsuleProject, record.locator);
    await ensureDirectory(dirname(destination));
    await cp(source, destination, { errorOnExist: true, force: false });
    copied.add(record.sha256);
  }
  return records;
}

export async function cloneProjectArtifactRecords(
  root: string,
  sourceProjectId: string,
  targetProjectId: string,
): Promise<EvidenceArtifactRecord[]> {
  const records = await loadEvidenceArtifactRecords(root, sourceProjectId);
  const cloned: EvidenceArtifactRecord[] = [];
  for (const record of records) {
    const value = { ...record, projectId: targetProjectId };
    const destination = artifactRecordPath(root, targetProjectId, record.artifactId);
    await writeJsonAtomic(destination, value, 0o444);
    await chmod(destination, 0o444).catch(() => undefined);
    cloned.push(value);
  }
  return cloned;
}

function artifactRecordPath(root: string, projectId: string, artifactId: string): string {
  return resolveContained(
    workspacePaths(root).projects,
    `${projectId}/evidence/artifacts/${artifactId}.json`,
  );
}

async function persistImmutableArtifact(
  destination: string,
  bytes: Buffer,
  expectedSha256: string,
): Promise<void> {
  await ensureDirectory(dirname(destination));
  if (await pathExists(destination)) {
    if ((await sha256File(destination)) !== expectedSha256) {
      throw artifactError(
        "Content-addressed artifact collision or drift detected.",
        "RESEARCH_ARTIFACT_STORE_INVALID",
      );
    }
    return;
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o444, flag: "wx" });
  await chmod(temporary, 0o444).catch(() => undefined);
  try {
    await rename(temporary, destination);
  } catch (error) {
    if (!(await pathExists(destination)) || (await sha256File(destination)) !== expectedSha256) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function validateArtifactBytes(
  bytes: Buffer,
  mediaType: string,
): Promise<EvidenceArtifactRecord["validation"]> {
  const checks = ["non-empty"];
  if (mediaType === "application/pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw invalidFormat("PDF header is missing.");
    }
    if (!bytes.subarray(Math.max(0, bytes.length - 4096)).includes(Buffer.from("%%EOF"))) {
      throw invalidFormat("PDF EOF marker is missing.");
    }
    let pageCount: number;
    try {
      const document = await PDFDocument.load(bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
        throwOnInvalidObject: true,
      });
      pageCount = document.getPageCount();
    } catch {
      throw invalidFormat("PDF structure cannot be parsed.");
    }
    if (pageCount < 1) throw invalidFormat("PDF contains no pages.");
    checks.push("pdf-header", "pdf-eof", "pdf-parse", "pdf-page-count");
    return { kind: "pdf", checks, details: { pageCount } };
  }
  if (mediaType === "application/json") {
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw invalidFormat("JSON artifact is not valid UTF-8 JSON.");
    }
    checks.push("utf8", "json-parse");
    return { kind: "json", checks, details: {} };
  }
  if (["text/plain", "text/markdown", "text/csv", "text/html"].includes(mediaType)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalidFormat("Text artifact is not valid UTF-8.");
    }
    checks.push("utf8");
    if (mediaType === "text/html") {
      if (!/<(?:!doctype\s+html|html|head|body)\b/i.test(text)) {
        throw invalidFormat("HTML artifact does not contain an HTML document marker.");
      }
      checks.push("html-document-marker");
    }
    return { kind: mediaType.slice(5), checks, details: {} };
  }
  const officeMarkers: Record<string, string[]> = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
      "[Content_Types].xml",
      "xl/workbook.xml",
    ],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
      "[Content_Types].xml",
      "word/document.xml",
    ],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
      "[Content_Types].xml",
      "ppt/presentation.xml",
    ],
    "application/zip": [],
  };
  const markers = officeMarkers[mediaType];
  if (markers) {
    const entries = inspectZipEntries(bytes);
    const names = new Set(entries.map((entry) => entry.name));
    if (markers.some((marker) => !names.has(marker))) {
      throw invalidFormat("Office archive is missing required package members.");
    }
    const details: Record<string, string | number | boolean | string[]> = {
      entryCount: entries.length,
      crcVerifiedEntries: entries.length,
    };
    if (mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      const workbook = entries.find((entry) => entry.name === "xl/workbook.xml");
      const workbookText = workbook?.data.toString("utf8") ?? "";
      const sheetNames = [...workbookText.matchAll(/<sheet\b[^>]*\bname=["']([^"']+)["']/gi)]
        .map((match) => sanitizeResearchText(match[1] ?? "").trim())
        .filter(Boolean)
        .slice(0, 1_000);
      if (!sheetNames.length) throw invalidFormat("XLSX workbook contains no declared worksheets.");
      checks.push("xlsx-workbook", "xlsx-sheet-list");
      details.sheetNames = sheetNames;
    }
    checks.push(
      "zip-header",
      "zip-eocd",
      "zip-central-directory",
      "zip-crc",
      ...markers.map((marker) => `member:${marker}`),
    );
    return {
      kind: mediaType === "application/zip" ? "zip" : "openxml",
      checks,
      details,
    };
  }
  throw artifactError(
    `Unsupported evidence artifact media type: ${mediaType}.`,
    "RESEARCH_ARTIFACT_MEDIA_TYPE_UNSUPPORTED",
  );
}

function parseArtifactRecord(value: unknown): EvidenceArtifactRecord {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.artifactId !== "string" ||
    !/^artifact-[0-9a-f]{24}$/.test(value.artifactId) ||
    typeof value.projectId !== "string" ||
    typeof value.candidateId !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !Number.isInteger(value.bytes) ||
    typeof value.mediaType !== "string" ||
    typeof value.originalFilename !== "string" ||
    (value.sourceUrl !== null && typeof value.sourceUrl !== "string") ||
    (value.license !== null && typeof value.license !== "string") ||
    (value.licenseUrl !== null && typeof value.licenseUrl !== "string") ||
    (value.hostType !== null && typeof value.hostType !== "string") ||
    (value.articleVersion !== null && typeof value.articleVersion !== "string") ||
    (value.downloadBinding !== null && !isObject(value.downloadBinding)) ||
    (value.derivedFromArtifactId !== null &&
      (typeof value.derivedFromArtifactId !== "string" ||
        !/^artifact-[0-9a-f]{24}$/.test(value.derivedFromArtifactId))) ||
    typeof value.locator !== "string" ||
    typeof value.registeredAt !== "string" ||
    !Number.isFinite(Date.parse(value.registeredAt)) ||
    !isObject(value.validation) ||
    typeof value.validation.kind !== "string" ||
    !Array.isArray(value.validation.checks) ||
    value.validation.checks.some((check) => typeof check !== "string") ||
    !isObject(value.validation.details) ||
    Object.values(value.validation.details).some(
      (detail) =>
        !["string", "number", "boolean"].includes(typeof detail) &&
        !(Array.isArray(detail) && detail.every((item) => typeof item === "string")),
    )
  ) {
    throw artifactError(
      "Evidence artifact record is malformed.",
      "RESEARCH_ARTIFACT_STORE_INVALID",
    );
  }
  if (value.downloadBinding !== null) parseEvidenceDownloadBinding(value.downloadBinding);
  return value as unknown as EvidenceArtifactRecord;
}

interface ValidatedZipEntry {
  name: string;
  data: Buffer;
}

function inspectZipEntries(bytes: Buffer): ValidatedZipEntry[] {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw invalidFormat("ZIP header is missing.");
  const eocd = findZipEocd(bytes);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (
    entryCount < 1 ||
    centralOffset + centralSize > eocd ||
    centralOffset < 0 ||
    centralSize < 0
  ) {
    throw invalidFormat("ZIP central directory is invalid.");
  }
  const entries: ValidatedZipEntry[] = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw invalidFormat("ZIP central directory entry is invalid.");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const compression = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > bytes.length || flags & 0x1) {
      throw invalidFormat("Encrypted or truncated ZIP entries are unsupported.");
    }
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (!name || name.includes("\0") || name.startsWith("/") || name.split("/").includes("..")) {
      throw invalidFormat("ZIP entry path is unsafe.");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw invalidFormat("ZIP uncompressed size exceeds the validation limit.");
    }
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw invalidFormat("ZIP local entry header is invalid.");
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.length) {
      throw invalidFormat("ZIP entry data is truncated.");
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    let data: Buffer;
    if (compression === 0) data = Buffer.from(compressed);
    else if (compression === 8) {
      try {
        data = inflateRawSync(compressed, {
          maxOutputLength: Math.min(MAX_ARCHIVE_UNCOMPRESSED_BYTES, Math.max(1, uncompressedSize)),
        });
      } catch {
        throw invalidFormat("ZIP deflate stream is invalid.");
      }
    } else {
      throw invalidFormat(`Unsupported ZIP compression method: ${compression}.`);
    }
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) {
      throw invalidFormat("ZIP entry size or CRC check failed.");
    }
    entries.push({ name, data });
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) {
    throw invalidFormat("ZIP central directory size does not match its entries.");
  }
  return entries;
}

function findZipEocd(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let cursor = bytes.length - 22; cursor >= minimum; cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50) return cursor;
  }
  throw invalidFormat("ZIP end-of-central-directory marker is missing.");
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function boundedOptionalMetadata(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  const normalized = sanitizeResearchText(value).replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 500) {
    throw artifactError(
      `Artifact ${label} must contain 1-500 safe characters when provided.`,
      "RESEARCH_ARTIFACT_METADATA_INVALID",
    );
  }
  return normalized;
}

function canonicalSourceUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw artifactError("Artifact source URL is invalid.", "RESEARCH_ARTIFACT_SOURCE_INVALID");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw artifactError(
      "Artifact source URL must be public HTTPS without embedded credentials.",
      "RESEARCH_ARTIFACT_SOURCE_INVALID",
    );
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      throw artifactError(
        "Artifact source URL contains a sensitive query parameter.",
        "RESEARCH_ARTIFACT_SOURCE_INVALID",
      );
    }
    if (TRACKING_QUERY_KEY.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function inferMediaType(path: string): string {
  const extension = extname(path).toLowerCase();
  const byExtension: Record<string, string> = {
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".html": "text/html",
    ".htm": "text/html",
    ".zip": "application/zip",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  const mediaType = byExtension[extension];
  if (!mediaType) {
    throw artifactError(
      "Cannot infer artifact media type; provide --media-type using a supported format.",
      "RESEARCH_ARTIFACT_MEDIA_TYPE_UNSUPPORTED",
    );
  }
  return mediaType;
}

function normalizeMediaType(value: string): string {
  return value.trim().toLowerCase().split(";", 1)[0] ?? "";
}

function sanitizeFilename(value: string): string {
  const safe = sanitizeResearchText(value)
    .replace(/[\r\n/\\]/g, "_")
    .trim();
  return (safe || "artifact").slice(0, 255);
}

function requireExactAbsolutePath(value: string): string {
  if (!value || /[\0\r\n]/.test(value) || resolve(value) !== value) {
    throw artifactError(
      "Artifact path must be an explicit canonical absolute file path.",
      "RESEARCH_ARTIFACT_PATH_INVALID",
    );
  }
  return value;
}

function invalidFormat(message: string): CliError {
  return artifactError(message, "RESEARCH_ARTIFACT_FORMAT_INVALID");
}

function artifactError(message: string, code: string): CliError {
  return new CliError(message, { code, exitCode: 3 });
}
