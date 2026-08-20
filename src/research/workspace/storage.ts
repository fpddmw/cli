import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";

import { CliError } from "../../errors.js";
import { RESEARCH_CONTROL_DIRECTORY } from "./constants.js";
import type { WorkspacePaths } from "./types.js";

const IGNORED_TREE_NAMES = new Set([
  ".DS_Store",
  ".git",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "node_modules",
]);

export const REGULAR_TREE_HASH_ALGORITHM = "sha256-nfc-path-size-content-v2";

const FILE_LOCK_STALE_MS = 120_000;
const FILE_LOCK_UPDATE_MS = 10_000;
const FILE_LOCK_TRANSITION_STALE_MS = 10_000;
const FILE_LOCK_OWNER_MAX_BYTES = 16 * 1024;
const LOCK_OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface FileLockRecovery {
  reason: "dead-owner" | "expired-lease" | "legacy-dead-owner";
  previousOperation: string;
  previousAcquiredAt: string | null;
  previousLockIdSha256: string;
  previousOwnerState: "dead" | "expired";
}

export interface FileLockOwnerRecord {
  schemaVersion: 2;
  kind: "tiangong-file-lock-owner";
  lockId: string;
  pid: number;
  hostname: string;
  operation: string;
  acquiredAt: string;
  staleAfterMs: number;
  planSha256: string | null;
  recordSha256: string;
}

export type FileLockRelease = (() => Promise<void>) & {
  owner: FileLockOwnerRecord;
  recovery: FileLockRecovery | null;
};

export function workspacePaths(root: string): WorkspacePaths {
  const canonicalRoot = resolve(root);
  const control = join(canonicalRoot, RESEARCH_CONTROL_DIRECTORY);
  return {
    root: canonicalRoot,
    control,
    marker: join(control, "workspace.json"),
    config: join(control, "config.json"),
    runtimeLock: join(control, "runtime-lock.json"),
    capabilityDeclarations: join(control, "capabilities.json"),
    capabilityLock: join(control, "capabilities.lock.json"),
    doctorAttestation: join(control, "doctor-attestation.json"),
    setupPlan: join(control, "setup-plan.json"),
    setupState: join(control, "setup-state.json"),
    setupReport: join(control, "setup-report.json"),
    setupDeclaration: join(control, "setup.yaml"),
    setupDeclarationEnv: join(control, "setup.env"),
    setupDeclarationEnvExample: join(control, "setup.env.example"),
    setupDeclarationBinding: join(control, "setup-declaration.json"),
    setupConfig: join(control, "setup-config.json"),
    setupAdapterEnv: join(control, "setup-adapters.env"),
    setupSources: join(control, "setup-sources"),
    setupLock: join(control, "setup.lock"),
    env: join(control, ".env"),
    envExample: join(control, ".env.example"),
    journal: join(control, "journal.jsonl"),
    evidence: join(control, "evidence"),
    evidenceCache: join(control, "evidence", "cache"),
    evidenceObjects: join(control, "evidence", "objects"),
    projects: join(control, "projects"),
    runtime: join(control, "runtime"),
    locks: join(control, "locks"),
  };
}

export async function ensureDirectory(path: string, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode).catch(() => undefined);
}

export async function readJsonFile<T>(path: string, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    throw new CliError(`${label} is missing or invalid: ${path}`, {
      code: "RESEARCH_STATE_INVALID",
      exitCode: 2,
      details: { path, error: String(error) },
    });
  }
}

export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await chmod(temporary, mode).catch(() => undefined);
  await replaceAtomicFile(temporary, path);
}

export async function writeTextAtomic(path: string, value: string, mode = 0o600): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode });
  await chmod(temporary, mode).catch(() => undefined);
  await replaceAtomicFile(temporary, path);
}

export async function writeBytesAtomic(
  path: string,
  value: Uint8Array,
  mode = 0o600,
): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode });
  await chmod(temporary, mode).catch(() => undefined);
  await replaceAtomicFile(temporary, path);
}

async function replaceAtomicFile(temporary: string, destination: string): Promise<void> {
  let previousMode: number | undefined;
  let destinationWasMadeWritable = false;
  try {
    const destinationInfo = await lstat(destination);
    if (destinationInfo.isFile() && !destinationInfo.isSymbolicLink()) {
      previousMode = destinationInfo.mode & 0o7777;
      if ((previousMode & 0o200) === 0) {
        // Windows refuses to replace a read-only destination even though POSIX
        // rename(2) permits it. Change only the file metadata; the content
        // replacement remains one atomic rename.
        await chmod(destination, previousMode | 0o200);
        destinationWasMadeWritable = true;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  try {
    await rename(temporary, destination);
  } catch (error) {
    if (destinationWasMadeWritable && previousMode !== undefined) {
      await chmod(destination, previousMode).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolvePromise);
  });
  return hash.digest("hex");
}

export async function hashRegularTree(root: string): Promise<string> {
  const rootInfo = await lstat(root).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new CliError(`Capability path must be a regular directory: ${root}`, {
      code: "RESEARCH_CAPABILITY_INVALID",
      exitCode: 2,
    });
  }
  const files = await regularTreeFiles(root);
  const hash = createHash("sha256");
  for (const path of files) {
    const logicalPath = relative(root, path).split(sep).join("/").normalize("NFC");
    const info = await lstat(path);
    hash.update(`${logicalPath}\0${info.size}\0`, "utf8");
    hash.update(await readFile(path));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export async function regularTreeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    const canonicalNames = new Map<string, string>();
    for (const entry of entries) {
      const canonicalName = entry.name.normalize("NFC");
      const previous = canonicalNames.get(canonicalName);
      if (previous !== undefined && previous !== entry.name) {
        throw new CliError(
          `Canonically equivalent names are not allowed in capability trees: ${join(
            directory,
            previous,
          )} and ${join(directory, entry.name)}`,
          {
            code: "RESEARCH_CAPABILITY_INVALID",
            exitCode: 2,
          },
        );
      }
      canonicalNames.set(canonicalName, entry.name);
    }
    entries.sort((left, right) => compareTreeNames(left.name, right.name));
    for (const entry of entries) {
      if (IGNORED_TREE_NAMES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new CliError(`Symbolic links are not allowed in capability trees: ${path}`, {
          code: "RESEARCH_CAPABILITY_INVALID",
          exitCode: 2,
        });
      }
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push(path);
      else {
        throw new CliError(`Unsupported capability tree entry: ${path}`, {
          code: "RESEARCH_CAPABILITY_INVALID",
          exitCode: 2,
        });
      }
    }
  }
  await visit(root);
  return files;
}

function compareTreeNames(left: string, right: string): number {
  const canonicalDifference = Buffer.compare(
    Buffer.from(left.normalize("NFC"), "utf8"),
    Buffer.from(right.normalize("NFC"), "utf8"),
  );
  if (canonicalDifference !== 0) return canonicalDifference;
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export async function fileRecord(
  path: string,
  logicalPath: string,
): Promise<{
  path: string;
  sha256: string;
  bytes: number;
}> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CliError(`Expected a regular output file: ${path}`, {
      code: "RESEARCH_OUTPUT_INVALID",
      exitCode: 2,
    });
  }
  return { path: logicalPath, sha256: await sha256File(path), bytes: info.size };
}

export function safeRelativePath(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new CliError(`${label} must be a safe relative path.`, {
      code: "RESEARCH_PATH_INVALID",
      exitCode: 2,
      details: { value },
    });
  }
  return normalized;
}

export function resolveContained(root: string, logicalPath: string): string {
  const safe = safeRelativePath(logicalPath, "Output path");
  const candidate = resolve(root, safe);
  const prefix = `${resolve(root)}${sep}`;
  if (!candidate.startsWith(prefix)) {
    throw new CliError(`Path escapes its root: ${logicalPath}`, {
      code: "RESEARCH_PATH_INVALID",
      exitCode: 2,
    });
  }
  return candidate;
}

export async function acquireFileLock(path: string, payload: unknown): Promise<FileLockRelease> {
  await ensureDirectory(dirname(path));
  const releaseTransition = await acquireLockTransition(path);
  let releaseLease: (() => Promise<void>) | null = null;
  try {
    const recovery = await recoverExistingLock(path);
    try {
      releaseLease = await lockfile.lock(path, {
        realpath: false,
        lockfilePath: path,
        stale: FILE_LOCK_STALE_MS,
        update: FILE_LOCK_UPDATE_MS,
        retries: 0,
        onCompromised: () => {
          throw lockCompromisedError();
        },
      });
    } catch (error) {
      throw await classifyLockAcquireError(path, error);
    }
    const owner = createFileLockOwner(payload);
    try {
      await writeJsonAtomic(fileLockOwnerPath(path), owner, 0o600);
    } catch {
      await releaseLease().catch(() => undefined);
      releaseLease = null;
      throw new CliError("Research operation lock metadata could not be persisted.", {
        code: "RESEARCH_WORKSPACE_LOCK_INVALID",
        exitCode: 3,
        details: {
          ownerState: "unknown",
          operation: owner.operation,
          minimumAction:
            "Inspect workspace filesystem health and retry; do not delete lock state manually.",
        },
      });
    }
    let released = false;
    const release = async () => {
      if (released) return;
      const releaseTransitionLease = await acquireLockTransition(path);
      try {
        const current = await readFileLockOwner(path);
        if (!current || current.lockId !== owner.lockId) {
          throw lockCompromisedError();
        }
        await releaseLease!();
        released = true;
        await rm(fileLockOwnerPath(path), { force: true });
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw lockCompromisedError();
      } finally {
        await releaseTransitionLease();
      }
    };
    return Object.assign(release, { owner, recovery });
  } catch (error) {
    if (releaseLease) await releaseLease().catch(() => undefined);
    throw error;
  } finally {
    await releaseTransition();
  }
}

async function acquireLockTransition(path: string): Promise<() => Promise<void>> {
  try {
    const release = await lockfile.lock(`${path}.transition-target`, {
      realpath: false,
      lockfilePath: `${path}.transition`,
      stale: FILE_LOCK_TRANSITION_STALE_MS,
      update: 2_000,
      retries: {
        retries: 50,
        factor: 1,
        minTimeout: 100,
        maxTimeout: 100,
        randomize: false,
      },
      onCompromised: () => {
        throw lockCompromisedError();
      },
    });
    return async () => {
      try {
        await release();
      } catch {
        throw lockCompromisedError();
      }
    };
  } catch (error) {
    if (!isLockContentionError(error)) throw lockStateInvalidError();
    throw new CliError("Research lock transition is busy or unavailable.", {
      code: "RESEARCH_WORKSPACE_LOCKED",
      exitCode: 3,
      details: {
        ownerState: "unknown",
        operation: null,
        acquiredAt: null,
        ageSeconds: null,
        retryAfterSeconds: 1,
        minimumAction:
          "Retry once after the current lock transition completes; do not delete lock state manually.",
      },
    });
  }
}

async function recoverExistingLock(path: string): Promise<FileLockRecovery | null> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) {
    try {
      await rm(fileLockOwnerPath(path), { force: true });
    } catch {
      throw lockStateInvalidError();
    }
    return null;
  }
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw lockUnknownError(null, null, null);
  }

  if (info.isFile()) {
    const legacy = await readLegacyLock(path);
    if (!legacy) throw lockUnknownError(null, null, ageSeconds(info.mtimeMs));
    const ownerState = probeProcess(legacy.pid, legacy.hostname);
    if (ownerState !== "dead") {
      throw lockBusyObservationError({
        ownerState,
        operation: legacy.operation,
        acquiredAt: legacy.acquiredAt,
        ageSeconds: ageSeconds(Date.parse(legacy.acquiredAt)),
      });
    }
    const quarantine = `${path}.stale-${randomUUID()}`;
    try {
      await rename(path, quarantine);
      await rm(quarantine, { force: true });
    } catch {
      throw lockStateInvalidError();
    }
    return {
      reason: "legacy-dead-owner",
      previousOperation: legacy.operation,
      previousAcquiredAt: legacy.acquiredAt,
      previousLockIdSha256: sha256Text(canonicalJson(legacy)),
      previousOwnerState: "dead",
    };
  }

  const owner = await readFileLockOwner(path);
  const ownerState = owner ? probeProcess(owner.pid, owner.hostname) : "unknown";
  const leaseAgeSeconds = ageSeconds(info.mtimeMs);
  if (ownerState === "alive") {
    throw lockBusyObservationError({
      ownerState,
      operation: owner?.operation ?? null,
      acquiredAt: owner?.acquiredAt ?? null,
      ageSeconds: owner ? ageSeconds(Date.parse(owner.acquiredAt)) : leaseAgeSeconds,
    });
  }
  if (ownerState !== "dead" && leaseAgeSeconds < Math.ceil(FILE_LOCK_STALE_MS / 1_000)) {
    throw lockBusyObservationError({
      ownerState,
      operation: owner?.operation ?? null,
      acquiredAt: owner?.acquiredAt ?? null,
      ageSeconds: leaseAgeSeconds,
    });
  }

  try {
    await rmdir(path);
    await rm(fileLockOwnerPath(path), { force: true });
  } catch {
    throw lockStateInvalidError();
  }
  return {
    reason: ownerState === "dead" ? "dead-owner" : "expired-lease",
    previousOperation: owner?.operation ?? "unknown",
    previousAcquiredAt: owner?.acquiredAt ?? null,
    previousLockIdSha256: owner ? sha256Text(owner.lockId) : sha256Text("unknown-lock-owner"),
    previousOwnerState: ownerState === "dead" ? "dead" : "expired",
  };
}

async function classifyLockAcquireError(path: string, error: unknown): Promise<CliError> {
  if (!isLockContentionError(error)) return lockStateInvalidError();
  const info = await lstat(path).catch(() => undefined);
  if (!info) return lockUnknownError(null, null, null);
  if (info.isFile()) {
    const legacy = await readLegacyLock(path);
    if (!legacy) return lockUnknownError(null, null, ageSeconds(info.mtimeMs));
    return lockBusyObservationError({
      ownerState: probeProcess(legacy.pid, legacy.hostname),
      operation: legacy.operation,
      acquiredAt: legacy.acquiredAt,
      ageSeconds: ageSeconds(Date.parse(legacy.acquiredAt)),
    });
  }
  const owner = await readFileLockOwner(path);
  const ownerState = owner ? probeProcess(owner.pid, owner.hostname) : "unknown";
  return lockBusyObservationError({
    ownerState,
    operation: owner?.operation ?? null,
    acquiredAt: owner?.acquiredAt ?? null,
    ageSeconds: owner ? ageSeconds(Date.parse(owner.acquiredAt)) : ageSeconds(info.mtimeMs),
  });
}

function isLockContentionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ELOCKED" || code === "EEXIST";
}

function createFileLockOwner(payload: unknown): FileLockOwnerRecord {
  const source = isObject(payload) ? payload : {};
  const operation = safeLockOperation(source.operation);
  const planSha256 =
    typeof source.planSha256 === "string" && /^[a-f0-9]{64}$/u.test(source.planSha256)
      ? source.planSha256
      : null;
  const core = {
    schemaVersion: 2 as const,
    kind: "tiangong-file-lock-owner" as const,
    lockId: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    operation,
    acquiredAt: new Date().toISOString(),
    staleAfterMs: FILE_LOCK_STALE_MS,
    planSha256,
  };
  return { ...core, recordSha256: sha256Text(canonicalJson(core)) };
}

async function readFileLockOwner(path: string): Promise<FileLockOwnerRecord | null> {
  const ownerPath = fileLockOwnerPath(path);
  const info = await lstat(ownerPath).catch(() => undefined);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > FILE_LOCK_OWNER_MAX_BYTES
  ) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isFileLockOwnerRecord(value)) return null;
  const { recordSha256, ...core } = value;
  return recordSha256 === sha256Text(canonicalJson(core)) ? value : null;
}

function isFileLockOwnerRecord(value: unknown): value is FileLockOwnerRecord {
  if (!isObject(value)) return false;
  const allowed = new Set([
    "schemaVersion",
    "kind",
    "lockId",
    "pid",
    "hostname",
    "operation",
    "acquiredAt",
    "staleAfterMs",
    "planSha256",
    "recordSha256",
  ]);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    value.schemaVersion === 2 &&
    value.kind === "tiangong-file-lock-owner" &&
    typeof value.lockId === "string" &&
    /^[a-f0-9-]{36}$/u.test(value.lockId) &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    typeof value.hostname === "string" &&
    value.hostname.length >= 1 &&
    value.hostname.length <= 255 &&
    typeof value.operation === "string" &&
    LOCK_OPERATION.test(value.operation) &&
    typeof value.acquiredAt === "string" &&
    Number.isFinite(Date.parse(value.acquiredAt)) &&
    value.staleAfterMs === FILE_LOCK_STALE_MS &&
    (value.planSha256 === null ||
      (typeof value.planSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.planSha256))) &&
    typeof value.recordSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.recordSha256)
  );
}

async function readLegacyLock(path: string): Promise<{
  pid: number;
  hostname: string | null;
  operation: string;
  acquiredAt: string;
} | null> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 16 * 1024) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    typeof value.operation !== "string" ||
    !LOCK_OPERATION.test(value.operation) ||
    typeof value.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(value.acquiredAt)) ||
    (value.hostname !== undefined &&
      (typeof value.hostname !== "string" || value.hostname.length > 255))
  ) {
    return null;
  }
  return {
    pid: Number(value.pid),
    hostname: typeof value.hostname === "string" ? value.hostname : null,
    operation: value.operation,
    acquiredAt: value.acquiredAt,
  };
}

function probeProcess(pid: number, ownerHostname: string | null): "alive" | "dead" | "unknown" {
  if (ownerHostname && ownerHostname !== hostname()) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

function safeLockOperation(value: unknown): string {
  return typeof value === "string" && LOCK_OPERATION.test(value) ? value : "research.operation";
}

function fileLockOwnerPath(path: string): string {
  return `${path}.owner.json`;
}

function ageSeconds(timestampMs: number): number {
  if (!Number.isFinite(timestampMs)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestampMs) / 1_000));
}

function lockBusyObservationError(input: {
  ownerState: "alive" | "dead" | "unknown";
  operation: string | null;
  acquiredAt: string | null;
  ageSeconds: number | null;
}): CliError {
  return new CliError("Research workspace has another active or unverifiable writer.", {
    code: "RESEARCH_WORKSPACE_LOCKED",
    exitCode: 3,
    details: {
      ownerState: input.ownerState,
      operation: input.operation,
      acquiredAt: input.acquiredAt,
      ageSeconds: input.ageSeconds,
      leaseStaleAfterSeconds: Math.ceil(FILE_LOCK_STALE_MS / 1_000),
      retryAfterSeconds:
        input.ownerState === "alive"
          ? 1
          : input.ageSeconds === null
            ? Math.ceil(FILE_LOCK_STALE_MS / 1_000)
            : Math.max(1, Math.ceil(FILE_LOCK_STALE_MS / 1_000) - input.ageSeconds),
      minimumAction:
        input.ownerState === "alive"
          ? "Wait for the named operation to finish, then retry; do not delete lock state manually."
          : "Inspect the owning host or wait for the heartbeat lease to expire; do not delete lock state manually.",
    },
  });
}

function lockStateInvalidError(): CliError {
  return new CliError("Research workspace lock state is unreadable or unsafe.", {
    code: "RESEARCH_WORKSPACE_LOCK_INVALID",
    exitCode: 3,
    details: {
      ownerState: "unknown",
      minimumAction:
        "Inspect workspace filesystem permissions and lock-state integrity; do not delete lock state manually.",
    },
  });
}

function lockUnknownError(
  operation: string | null,
  acquiredAt: string | null,
  lockAgeSeconds: number | null,
): CliError {
  return lockBusyObservationError({
    ownerState: "unknown",
    operation,
    acquiredAt,
    ageSeconds: lockAgeSeconds,
  });
}

function lockCompromisedError(): CliError {
  return new CliError("Research workspace lock ownership changed unexpectedly.", {
    code: "RESEARCH_WORKSPACE_LOCK_COMPROMISED",
    exitCode: 3,
    details: {
      ownerState: "compromised",
      minimumAction:
        "Stop mutation, inspect workspace status from a separate read-only command, and do not delete lock state manually.",
    },
  });
}

export async function pathExists(path: string): Promise<boolean> {
  return existsSync(path);
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function requireAbsolutePath(value: string, label: string): string {
  const canonical = resolve(value);
  if (canonical !== value) {
    throw new CliError(`${label} must be absolute: ${value}`, {
      code: "RESEARCH_PATH_NOT_ABSOLUTE",
      exitCode: 2,
    });
  }
  return canonical;
}

export function basenameWithoutExtension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
