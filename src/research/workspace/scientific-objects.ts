import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

import { CliError } from "../../errors.js";
import { classifyPlatformPathRelation } from "./platform-capabilities.js";
import type { ScientificDesignContract } from "./scientific-design.js";
import {
  canonicalJson,
  isObject,
  pathExists,
  resolveContained,
  sha256Bytes,
  sha256File,
  sha256Text,
  workspacePaths,
  writeBytesAtomic,
  writeJsonAtomic,
} from "./storage.js";

export const SCIENTIFIC_OBJECT_KINDS = ["model-implementation", "environment-lock"] as const;

export type ScientificObjectKind = (typeof SCIENTIFIC_OBJECT_KINDS)[number];

export interface ScientificObjectRecord {
  schemaVersion: 1;
  kind: "tiangong-scientific-object";
  objectKind: ScientificObjectKind;
  sha256: string;
  bytes: number;
  mediaType: string;
  hashBasis: "raw-file-bytes";
  objectLocator: string;
  recordLocator: string;
  recordSha256: string;
}

export type ScientificObjectBindingReason =
  | "source-not-registered"
  | "object-missing"
  | "source-object-unsafe"
  | "content-hash-mismatch"
  | "record-invalid"
  | "kind-mismatch"
  | "media-type-unsupported"
  | "not-reviewable-json"
  | "oversized";

export interface ScientificObjectBindingIssue {
  modelId: string;
  artifactKind: "implementation" | "environment-lock";
  objectKind: ScientificObjectKind;
  reason: ScientificObjectBindingReason;
}

export interface ResolvedScientificObject {
  sourcePath: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  objectKind: ScientificObjectKind;
  sourceLocator: string;
  record: ScientificObjectRecord;
}

const MAX_SCIENTIFIC_OBJECT_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const REGISTERED_OBJECT_LOCATOR = /^lineage\/objects\/([a-f0-9]{64})\/blob$/;
const REVIEWABLE_MEDIA_TYPE = /^(?:text\/[a-z0-9.+-]+|application\/(?:json|toml|yaml|x-yaml))$/;

export function parseScientificObjectKind(value: string | undefined): ScientificObjectKind {
  if (SCIENTIFIC_OBJECT_KINDS.includes(value as ScientificObjectKind)) {
    return value as ScientificObjectKind;
  }
  throw scientificObjectInputError(
    "Scientific object kind must be model-implementation or environment-lock.",
    "kind-invalid",
  );
}

export async function registerScientificObject(input: {
  root: string;
  objectKind: ScientificObjectKind;
  path: string;
  mediaType?: string;
}): Promise<ScientificObjectRecord> {
  const sourcePath = await exactExternalFile(input.root, input.path);
  const info = await lstat(sourcePath);
  if (info.size < 1 || info.size > MAX_SCIENTIFIC_OBJECT_BYTES) {
    throw scientificObjectInputError(
      `Scientific object size must be 1-${MAX_SCIENTIFIC_OBJECT_BYTES} bytes.`,
      "size-invalid",
    );
  }
  const bytes = await readFile(sourcePath);
  const mediaType = normalizeScientificMediaType(
    input.mediaType ?? inferScientificMediaType(sourcePath),
  );
  validateReviewableBytes(bytes, mediaType);
  const sha256 = sha256Bytes(bytes);
  const objectLocator = scientificObjectLocator(sha256);
  const recordLocator = scientificObjectRecordLocator(sha256, input.objectKind);
  const objectPath = resolveContained(workspacePaths(input.root).control, objectLocator);
  const recordPath = resolveContained(workspacePaths(input.root).control, recordLocator);

  if (await pathExists(objectPath)) {
    await assertImmutableBlob(objectPath, input.objectKind, sha256, bytes.byteLength);
  } else {
    await writeBytesAtomic(objectPath, bytes, 0o444);
  }

  if (await pathExists(recordPath)) {
    const existing = await readAndVerifyScientificObjectRecord(input.root, {
      objectKind: input.objectKind,
      objectLocator,
      expectedSha256: sha256,
    });
    if (existing.mediaType !== mediaType) {
      throw scientificObjectBindingError("Scientific object metadata has drifted.", [
        {
          modelId: "unbound",
          artifactKind:
            input.objectKind === "model-implementation" ? "implementation" : "environment-lock",
          objectKind: input.objectKind,
          reason: "media-type-unsupported",
        },
      ]);
    }
    return existing;
  }

  const core = {
    schemaVersion: 1 as const,
    kind: "tiangong-scientific-object" as const,
    objectKind: input.objectKind,
    sha256,
    bytes: bytes.byteLength,
    mediaType,
    hashBasis: "raw-file-bytes" as const,
    objectLocator,
    recordLocator,
  };
  const record: ScientificObjectRecord = {
    ...core,
    recordSha256: sha256Text(canonicalJson(core)),
  };
  await writeJsonAtomic(recordPath, record, 0o444);
  return record;
}

export async function inspectScientificObject(input: {
  root: string;
  objectKind: ScientificObjectKind;
  objectLocator: string;
}): Promise<ScientificObjectRecord> {
  const match = REGISTERED_OBJECT_LOCATOR.exec(input.objectLocator);
  if (!match) {
    throw scientificObjectBindingError("Scientific object locator is not registered.", [
      {
        modelId: "unbound",
        artifactKind:
          input.objectKind === "model-implementation" ? "implementation" : "environment-lock",
        objectKind: input.objectKind,
        reason: "source-not-registered",
      },
    ]);
  }
  return readAndVerifyScientificObjectRecord(input.root, {
    objectKind: input.objectKind,
    objectLocator: input.objectLocator,
    expectedSha256: match[1]!,
  });
}

export async function resolveScientificObjectBinding(input: {
  root: string;
  objectKind: ScientificObjectKind;
  objectLocator: string;
  expectedSha256: string;
}): Promise<ResolvedScientificObject> {
  const registered = REGISTERED_OBJECT_LOCATOR.exec(input.objectLocator);
  if (registered) {
    if (registered[1] !== input.expectedSha256) {
      throw bindingFailure(input.objectKind, "content-hash-mismatch");
    }
    const record = await readAndVerifyScientificObjectRecord(input.root, input);
    return {
      sourcePath: resolveContained(workspacePaths(input.root).control, record.objectLocator),
      sha256: record.sha256,
      bytes: record.bytes,
      mediaType: record.mediaType,
      objectKind: record.objectKind,
      sourceLocator: record.objectLocator,
      record,
    };
  }
  throw bindingFailure(input.objectKind, "source-not-registered");
}

export async function inspectScientificDesignObjectBindings(
  root: string,
  design: ScientificDesignContract,
): Promise<ScientificObjectBindingIssue[]> {
  const issues: ScientificObjectBindingIssue[] = [];
  for (const model of design.identity.modelStructures) {
    if (model.implementationStatus === "executable-frozen") {
      await inspectOne({
        root,
        modelId: model.id,
        artifactKind: "implementation",
        objectKind: "model-implementation",
        objectLocator: model.implementationArtifactLocator,
        expectedSha256: model.implementationArtifactSha256,
        issues,
      });
    }
    if (model.environmentLockStatus === "exact-frozen") {
      await inspectOne({
        root,
        modelId: model.id,
        artifactKind: "environment-lock",
        objectKind: "environment-lock",
        objectLocator: model.environmentLockLocator,
        expectedSha256: model.environmentLockSha256,
        issues,
      });
    }
  }
  return issues;
}

export async function assertScientificDesignObjectBindings(
  root: string,
  design: ScientificDesignContract,
): Promise<void> {
  const issues = await inspectScientificDesignObjectBindings(root, design);
  if (issues.length) {
    throw scientificObjectBindingError(
      "Scientific design contains an unregistered or invalid frozen object.",
      issues,
    );
  }
}

export function scientificObjectLocator(sha256: string): string {
  if (!SHA256.test(sha256)) {
    throw scientificObjectInputError("Scientific object SHA-256 is invalid.", "sha256-invalid");
  }
  return `lineage/objects/${sha256}/blob`;
}

function scientificObjectRecordLocator(sha256: string, objectKind: ScientificObjectKind): string {
  return `lineage/objects/${sha256}/${objectKind}.json`;
}

async function inspectOne(input: {
  root: string;
  modelId: string;
  artifactKind: "implementation" | "environment-lock";
  objectKind: ScientificObjectKind;
  objectLocator: string | null;
  expectedSha256: string | null;
  issues: ScientificObjectBindingIssue[];
}): Promise<void> {
  if (!input.objectLocator || !input.expectedSha256) {
    input.issues.push({
      modelId: input.modelId,
      artifactKind: input.artifactKind,
      objectKind: input.objectKind,
      reason: "source-not-registered",
    });
    return;
  }
  try {
    await resolveScientificObjectBinding({
      root: input.root,
      objectKind: input.objectKind,
      objectLocator: input.objectLocator,
      expectedSha256: input.expectedSha256,
    });
  } catch (error) {
    input.issues.push({
      modelId: input.modelId,
      artifactKind: input.artifactKind,
      objectKind: input.objectKind,
      reason: bindingReason(error),
    });
  }
}

async function readAndVerifyScientificObjectRecord(
  root: string,
  input: {
    objectKind: ScientificObjectKind;
    objectLocator: string;
    expectedSha256: string;
  },
): Promise<ScientificObjectRecord> {
  const recordLocator = scientificObjectRecordLocator(input.expectedSha256, input.objectKind);
  const recordPath = resolveContained(workspacePaths(root).control, recordLocator);
  const recordInfo = await lstat(recordPath).catch(() => undefined);
  if (recordInfo && (!recordInfo.isFile() || recordInfo.isSymbolicLink())) {
    throw bindingFailure(input.objectKind, "source-object-unsafe");
  }
  if (!recordInfo) {
    const alternateKind: ScientificObjectKind =
      input.objectKind === "model-implementation" ? "environment-lock" : "model-implementation";
    const alternate = resolveContained(
      workspacePaths(root).control,
      scientificObjectRecordLocator(input.expectedSha256, alternateKind),
    );
    if (await pathExists(alternate)) throw bindingFailure(input.objectKind, "kind-mismatch");
    throw bindingFailure(input.objectKind, "source-not-registered");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(recordPath, "utf8")) as unknown;
  } catch {
    throw bindingFailure(input.objectKind, "record-invalid");
  }
  if (!isScientificObjectRecord(value)) {
    throw bindingFailure(input.objectKind, "record-invalid");
  }
  const { recordSha256, ...core } = value;
  if (
    value.objectKind !== input.objectKind ||
    value.objectLocator !== input.objectLocator ||
    value.recordLocator !== recordLocator ||
    value.sha256 !== input.expectedSha256 ||
    recordSha256 !== sha256Text(canonicalJson(core))
  ) {
    throw bindingFailure(
      input.objectKind,
      value.objectKind !== input.objectKind ? "kind-mismatch" : "record-invalid",
    );
  }
  const objectPath = resolveContained(workspacePaths(root).control, value.objectLocator);
  await assertImmutableBlob(objectPath, input.objectKind, value.sha256, value.bytes);
  return value;
}

function isScientificObjectRecord(value: unknown): value is ScientificObjectRecord {
  if (!isObject(value)) return false;
  const allowed = new Set([
    "schemaVersion",
    "kind",
    "objectKind",
    "sha256",
    "bytes",
    "mediaType",
    "hashBasis",
    "objectLocator",
    "recordLocator",
    "recordSha256",
  ]);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    value.schemaVersion === 1 &&
    value.kind === "tiangong-scientific-object" &&
    SCIENTIFIC_OBJECT_KINDS.includes(value.objectKind as ScientificObjectKind) &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.bytes) >= 1 &&
    Number(value.bytes) <= MAX_SCIENTIFIC_OBJECT_BYTES &&
    typeof value.mediaType === "string" &&
    REVIEWABLE_MEDIA_TYPE.test(value.mediaType) &&
    value.hashBasis === "raw-file-bytes" &&
    typeof value.objectLocator === "string" &&
    typeof value.recordLocator === "string" &&
    typeof value.recordSha256 === "string" &&
    SHA256.test(value.recordSha256)
  );
}

async function exactExternalFile(root: string, path: string): Promise<string> {
  if (!path || !isAbsolute(path) || resolve(path) !== path || path.includes("\0")) {
    throw scientificObjectInputError(
      "Scientific object path must be an explicit canonical absolute path.",
      "path-invalid",
    );
  }
  const selectedInfo = await lstat(path).catch(() => undefined);
  if (!selectedInfo?.isFile() || selectedInfo.isSymbolicLink()) {
    throw scientificObjectInputError(
      "Scientific object path must name one regular non-symlink file.",
      "path-unsafe",
    );
  }
  const canonical = await realpath(path).catch(() => null);
  if (!canonical) {
    throw scientificObjectInputError(
      "Scientific object path must be one regular non-symlink file.",
      "path-unsafe",
    );
  }
  const lexicalControl = resolve(workspacePaths(root).control);
  const control = await realpath(lexicalControl).catch(() => lexicalControl);
  const relation = classifyPlatformPathRelation({
    platform: process.platform,
    root: control,
    candidate: canonical,
  });
  if (relation !== "outside") {
    throw scientificObjectInputError(
      "Scientific object source must originate outside the research control directory.",
      "path-inside-control",
    );
  }
  return canonical;
}

export function isContainedRelativePath(value: string): boolean {
  return (
    value !== ".." &&
    !value.startsWith(`..${sep}`) &&
    !value.startsWith("../") &&
    !value.startsWith("..\\") &&
    !isAbsolute(value) &&
    !win32.isAbsolute(value)
  );
}

async function assertImmutableBlob(
  path: string,
  objectKind: ScientificObjectKind,
  sha256: string,
  bytes: number,
): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) {
    throw bindingFailure(objectKind, "object-missing");
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw bindingFailure(objectKind, "source-object-unsafe");
  }
  if (info.size !== bytes || (await sha256File(path)) !== sha256) {
    throw bindingFailure(objectKind, "content-hash-mismatch");
  }
}

function normalizeScientificMediaType(value: string): string {
  const normalized = value.trim().toLowerCase().split(";", 1)[0] ?? "";
  if (!REVIEWABLE_MEDIA_TYPE.test(normalized)) {
    throw scientificObjectInputError(
      "Scientific objects require a reviewable UTF-8 text, JSON, TOML, or YAML media type.",
      "media-type-unsupported",
    );
  }
  return normalized;
}

function inferScientificMediaType(path: string): string {
  const extension = extname(path).toLowerCase();
  const mediaTypes: Record<string, string> = {
    ".py": "text/x-python",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".cjs": "text/javascript",
    ".ts": "text/typescript",
    ".mts": "text/typescript",
    ".cts": "text/typescript",
    ".r": "text/x-r-source",
    ".jl": "text/x-julia",
    ".sh": "text/x-shellscript",
    ".lock": "text/plain",
    ".txt": "text/plain",
    ".json": "application/json",
    ".toml": "application/toml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
  };
  const mediaType = mediaTypes[extension];
  if (!mediaType) {
    throw scientificObjectInputError(
      "Cannot infer a reviewable scientific object media type; provide --media-type.",
      "media-type-unsupported",
    );
  }
  return mediaType;
}

function validateReviewableBytes(bytes: Uint8Array, mediaType: string): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw scientificObjectInputError(
      "Scientific object bytes must be valid UTF-8 for independent review.",
      "content-not-utf8",
    );
  }
  if (text.includes("\0")) {
    throw scientificObjectInputError(
      "Scientific object text cannot contain NUL bytes.",
      "content-invalid",
    );
  }
  if (mediaType === "application/json") {
    try {
      JSON.parse(text);
    } catch {
      throw scientificObjectInputError(
        "A scientific object declared as application/json must contain valid JSON.",
        "json-invalid",
      );
    }
  }
}

function bindingReason(error: unknown): ScientificObjectBindingReason {
  if (error instanceof CliError && isObject(error.details)) {
    const reason = error.details.reason;
    if (
      [
        "source-not-registered",
        "object-missing",
        "source-object-unsafe",
        "content-hash-mismatch",
        "record-invalid",
        "kind-mismatch",
        "media-type-unsupported",
        "not-reviewable-json",
        "oversized",
      ].includes(String(reason))
    ) {
      return reason as ScientificObjectBindingReason;
    }
  }
  return "record-invalid";
}

function bindingFailure(objectKind: ScientificObjectKind, reason: ScientificObjectBindingReason) {
  return new CliError("A scientific object failed its immutable binding.", {
    code: "RESEARCH_SCIENTIFIC_OBJECT_BINDING_INVALID",
    exitCode: 3,
    details: { objectKind, reason, minimumAction: scientificObjectBindingAction(reason) },
  });
}

function scientificObjectBindingError(
  message: string,
  issues: ScientificObjectBindingIssue[],
): CliError {
  return new CliError(message, {
    code: "RESEARCH_SCIENTIFIC_OBJECT_BINDING_INVALID",
    exitCode: 3,
    details: {
      issues,
      minimumAction:
        "Register each frozen external file with research scientific object register, copy its returned kind, SHA-256, and locator into a new design generation, then rerun preflight.",
    },
  });
}

function scientificObjectInputError(message: string, reason: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_SCIENTIFIC_OBJECT_INVALID",
    exitCode: 2,
    details: {
      reason,
      minimumAction:
        "Select one canonical regular non-symlink UTF-8 file outside .tiangong-research and register it with an explicit supported kind and media type.",
    },
  });
}

function scientificObjectBindingAction(reason: ScientificObjectBindingReason): string {
  if (reason === "object-missing" || reason === "content-hash-mismatch") {
    return "Restore the exact registered bytes from a trusted source or create a new authoritative design generation bound to a newly registered object.";
  }
  if (reason === "kind-mismatch") {
    return "Register the source under the design field's exact object kind and bind the returned locator in a new authoritative design generation.";
  }
  return "Register the external source through research scientific object register and bind the exact returned record in a new authoritative design generation.";
}
