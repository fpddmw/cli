import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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
    env: join(control, ".env"),
    envExample: join(control, ".env.example"),
    journal: join(control, "journal.jsonl"),
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
  await rename(temporary, path);
}

export async function writeTextAtomic(path: string, value: string, mode = 0o600): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode });
  await chmod(temporary, mode).catch(() => undefined);
  await rename(temporary, path);
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
    const logicalPath = relative(root, path).split(sep).join("/");
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
    entries.sort((left, right) => left.name.localeCompare(right.name));
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

export async function acquireFileLock(
  path: string,
  payload: unknown,
): Promise<() => Promise<void>> {
  await ensureDirectory(dirname(path));
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
    await handle.close();
  } catch (error) {
    throw new CliError(`Research workspace is locked: ${path}`, {
      code: "RESEARCH_WORKSPACE_LOCKED",
      exitCode: 3,
      details: { error: String(error) },
    });
  }
  return async () => rm(path, { force: true });
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
