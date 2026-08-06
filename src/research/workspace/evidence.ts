import { constants as fsConstants } from "node:fs";
import { cp, lstat, open, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CliError } from "../../errors.js";
import {
  ensureDirectory,
  pathExists,
  resolveContained,
  sha256Bytes,
  sha256File,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";

export interface BrokerEvidenceReceipt {
  schemaVersion: 1;
  attemptId: string;
  projectId: string;
  capabilityId: string;
  credentialId: string | null;
  status: number;
  contentType: string;
  bytes: number;
  sha256: string;
  sourceSha256: string;
  locator: string;
  contextLocator: string;
  contextSha256: string;
  contextBytes: number;
  contextEstimatedTokens: number;
  contextItems: number | null;
  contextOffset?: number;
  contextTotalItems?: number | null;
  contextNextOffset?: number | null;
  contextTruncated: boolean;
  retrievedAt: string;
  servedAt: string;
  cacheHit: boolean;
}

export async function persistBrokerEvidence(
  root: string,
  receipt: Omit<
    BrokerEvidenceReceipt,
    | "schemaVersion"
    | "bytes"
    | "sha256"
    | "locator"
    | "contextLocator"
    | "contextSha256"
    | "contextBytes"
    | "contextEstimatedTokens"
    | "servedAt"
  >,
  bytes: Uint8Array,
  contextBytes: Uint8Array = bytes,
): Promise<BrokerEvidenceReceipt> {
  const digest = sha256Bytes(bytes);
  const locator = `evidence/objects/${digest.slice(0, 2)}/${digest}`;
  const contextDigest = sha256Bytes(contextBytes);
  const contextLocator = `evidence/objects/${contextDigest.slice(0, 2)}/${contextDigest}`;
  const paths = workspacePaths(root);
  const objectPath = resolveContained(paths.control, locator);
  await ensureDirectory(dirname(objectPath));
  await writeImmutableObject(objectPath, bytes, digest);
  if (contextDigest !== digest) {
    const contextPath = resolveContained(paths.control, contextLocator);
    await ensureDirectory(dirname(contextPath));
    await writeImmutableObject(contextPath, contextBytes, contextDigest);
  }
  const value: BrokerEvidenceReceipt = {
    schemaVersion: 1,
    ...receipt,
    bytes: bytes.byteLength,
    sha256: digest,
    locator,
    contextLocator,
    contextSha256: contextDigest,
    contextBytes: contextBytes.byteLength,
    contextEstimatedTokens: estimateBrokerContextTokens(contextBytes.byteLength),
    servedAt: new Date().toISOString(),
  };
  const receiptPath = join(
    paths.projects,
    receipt.projectId,
    "evidence",
    "receipts",
    `${receipt.attemptId}.json`,
  );
  if (await pathExists(receiptPath)) {
    const existing = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
    if (JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new CliError("Broker evidence receipt already exists with different content.", {
        code: "RESEARCH_EVIDENCE_STORE_INVALID",
        exitCode: 3,
      });
    }
  } else {
    await writeJsonAtomic(receiptPath, value, 0o444);
  }
  return value;
}

export async function loadProjectEvidenceReceipts(
  root: string,
  projectId: string,
): Promise<BrokerEvidenceReceipt[]> {
  const directory = join(workspacePaths(root).projects, projectId, "evidence", "receipts");
  if (!(await pathExists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const receipts: BrokerEvidenceReceipt[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const value = JSON.parse(await readFile(join(directory, entry.name), "utf8")) as unknown;
    const receipt = parseReceipt(value);
    if (receipt.projectId !== projectId || `${receipt.attemptId}.json` !== entry.name) {
      throw evidenceStoreError("Broker evidence receipt identity does not match its path.");
    }
    await verifyEvidenceReceipt(root, receipt);
    receipts.push(receipt);
  }
  return receipts;
}

export async function verifyEvidenceReceipt(
  root: string,
  receipt: BrokerEvidenceReceipt,
): Promise<string> {
  const objectPath = resolveContained(workspacePaths(root).control, receipt.locator);
  const info = await lstat(objectPath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size !== receipt.bytes) {
    throw evidenceStoreError(`Broker evidence object is missing or invalid: ${receipt.attemptId}`);
  }
  if ((await sha256File(objectPath)) !== receipt.sha256) {
    throw evidenceStoreError(`Broker evidence object hash mismatch: ${receipt.attemptId}`);
  }
  const expectedLocator = `evidence/objects/${receipt.sha256.slice(0, 2)}/${receipt.sha256}`;
  if (receipt.locator !== expectedLocator) {
    throw evidenceStoreError(
      `Broker evidence locator is not content-addressed: ${receipt.attemptId}`,
    );
  }
  const contextPath = resolveContained(workspacePaths(root).control, receipt.contextLocator);
  const contextInfo = await lstat(contextPath).catch(() => undefined);
  if (
    !contextInfo?.isFile() ||
    contextInfo.isSymbolicLink() ||
    contextInfo.size !== receipt.contextBytes ||
    receipt.contextEstimatedTokens !== estimateBrokerContextTokens(receipt.contextBytes) ||
    (await sha256File(contextPath)) !== receipt.contextSha256 ||
    receipt.contextLocator !==
      `evidence/objects/${receipt.contextSha256.slice(0, 2)}/${receipt.contextSha256}`
  ) {
    throw evidenceStoreError(`Broker evidence context object is invalid: ${receipt.attemptId}`);
  }
  return objectPath;
}

export async function stageProjectEvidence(
  root: string,
  projectId: string,
  capsuleProject: string,
): Promise<BrokerEvidenceReceipt[]> {
  const receipts = await loadProjectEvidenceReceipts(root, projectId);
  const copied = new Set<string>();
  for (const receipt of receipts) {
    await verifyEvidenceReceipt(root, receipt);
    for (const [digest, locator] of [
      [receipt.sha256, receipt.locator],
      [receipt.contextSha256, receipt.contextLocator],
    ] as const) {
      if (copied.has(digest)) continue;
      const source = resolveContained(workspacePaths(root).control, locator);
      const destination = resolveContained(capsuleProject, locator);
      await ensureDirectory(dirname(destination));
      await cp(source, destination, { errorOnExist: true, force: false });
      copied.add(digest);
    }
  }
  return receipts;
}

export async function cloneProjectEvidenceReceipts(
  root: string,
  sourceProjectId: string,
  targetProjectId: string,
): Promise<BrokerEvidenceReceipt[]> {
  const receipts = await loadProjectEvidenceReceipts(root, sourceProjectId);
  const destination = join(workspacePaths(root).projects, targetProjectId, "evidence", "receipts");
  await ensureDirectory(destination);
  const cloned: BrokerEvidenceReceipt[] = [];
  for (const receipt of receipts) {
    const value = { ...receipt, projectId: targetProjectId };
    await writeJsonAtomic(join(destination, `${receipt.attemptId}.json`), value, 0o444);
    cloned.push(value);
  }
  return cloned;
}

export async function loadBrokerEvidenceCache(
  root: string,
  cacheKeySha256: string,
): Promise<BrokerEvidenceReceipt | null> {
  const path = brokerCachePath(root, cacheKeySha256);
  if (!(await pathExists(path))) return null;
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw evidenceStoreError("Broker evidence cache entry is not a regular file.");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { cacheKeySha256?: unknown }).cacheKeySha256 !== cacheKeySha256
  ) {
    throw evidenceStoreError("Broker evidence cache entry has an unsupported shape.");
  }
  const receipt = parseReceipt((value as { receipt?: unknown }).receipt);
  await verifyEvidenceReceipt(root, receipt);
  return receipt;
}

export async function storeBrokerEvidenceCache(
  root: string,
  cacheKeySha256: string,
  receipt: BrokerEvidenceReceipt,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(cacheKeySha256)) {
    throw evidenceStoreError("Broker evidence cache key is invalid.");
  }
  await verifyEvidenceReceipt(root, receipt);
  const path = brokerCachePath(root, cacheKeySha256);
  if (await pathExists(path)) return;
  await writeJsonAtomic(path, { schemaVersion: 1, cacheKeySha256, receipt }, 0o444);
}

function parseReceipt(value: unknown): BrokerEvidenceReceipt {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as BrokerEvidenceReceipt).schemaVersion !== 1 ||
    typeof (value as BrokerEvidenceReceipt).attemptId !== "string" ||
    typeof (value as BrokerEvidenceReceipt).projectId !== "string" ||
    typeof (value as BrokerEvidenceReceipt).capabilityId !== "string" ||
    !["string", "object"].includes(typeof (value as BrokerEvidenceReceipt).credentialId) ||
    typeof (value as BrokerEvidenceReceipt).status !== "number" ||
    typeof (value as BrokerEvidenceReceipt).contentType !== "string" ||
    !Number.isInteger((value as BrokerEvidenceReceipt).bytes) ||
    typeof (value as BrokerEvidenceReceipt).sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test((value as BrokerEvidenceReceipt).sha256) ||
    typeof (value as BrokerEvidenceReceipt).sourceSha256 !== "string" ||
    typeof (value as BrokerEvidenceReceipt).locator !== "string" ||
    typeof (value as BrokerEvidenceReceipt).contextLocator !== "string" ||
    typeof (value as BrokerEvidenceReceipt).contextSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test((value as BrokerEvidenceReceipt).contextSha256) ||
    !Number.isInteger((value as BrokerEvidenceReceipt).contextBytes) ||
    !Number.isInteger((value as BrokerEvidenceReceipt).contextEstimatedTokens) ||
    (value as BrokerEvidenceReceipt).contextEstimatedTokens < 0 ||
    ((value as BrokerEvidenceReceipt).contextItems !== null &&
      !Number.isInteger((value as BrokerEvidenceReceipt).contextItems)) ||
    ((value as BrokerEvidenceReceipt).contextOffset !== undefined &&
      (!Number.isInteger((value as BrokerEvidenceReceipt).contextOffset) ||
        (value as BrokerEvidenceReceipt).contextOffset! < 0)) ||
    ((value as BrokerEvidenceReceipt).contextTotalItems !== undefined &&
      (value as BrokerEvidenceReceipt).contextTotalItems !== null &&
      (!Number.isInteger((value as BrokerEvidenceReceipt).contextTotalItems) ||
        (value as BrokerEvidenceReceipt).contextTotalItems! < 0)) ||
    ((value as BrokerEvidenceReceipt).contextNextOffset !== undefined &&
      (value as BrokerEvidenceReceipt).contextNextOffset !== null &&
      (!Number.isInteger((value as BrokerEvidenceReceipt).contextNextOffset) ||
        (value as BrokerEvidenceReceipt).contextNextOffset! < 0)) ||
    typeof (value as BrokerEvidenceReceipt).contextTruncated !== "boolean" ||
    typeof (value as BrokerEvidenceReceipt).retrievedAt !== "string" ||
    typeof (value as BrokerEvidenceReceipt).servedAt !== "string" ||
    typeof (value as BrokerEvidenceReceipt).cacheHit !== "boolean"
  ) {
    throw evidenceStoreError("Broker evidence receipt has an unsupported shape.");
  }
  const receipt = value as BrokerEvidenceReceipt;
  if (receipt.credentialId !== null && typeof receipt.credentialId !== "string") {
    throw evidenceStoreError("Broker evidence credential identity is invalid.");
  }
  return receipt;
}

function brokerCachePath(root: string, cacheKeySha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(cacheKeySha256)) {
    throw evidenceStoreError("Broker evidence cache key is invalid.");
  }
  return join(
    workspacePaths(root).evidenceCache,
    cacheKeySha256.slice(0, 2),
    `${cacheKeySha256}.json`,
  );
}

async function writeImmutableObject(
  path: string,
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<void> {
  try {
    const handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o444,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || (await sha256File(path)) !== expectedSha256) {
      throw evidenceStoreError("Content-addressed evidence object failed its integrity check.");
    }
  }
}

function evidenceStoreError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_EVIDENCE_STORE_INVALID",
    exitCode: 3,
  });
}

function estimateBrokerContextTokens(bytes: number): number {
  return Math.ceil(bytes / 3);
}
