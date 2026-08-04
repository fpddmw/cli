import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CliError } from "../../errors.js";
import { ALLOWED_CAPABILITY_PERMISSIONS } from "./constants.js";
import {
  canonicalJson,
  ensureDirectory,
  hashRegularTree,
  isObject,
  pathExists,
  readJsonFile,
  regularTreeFiles,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type {
  CapabilityDeclaration,
  CapabilityDeclarations,
  CapabilityLock,
  CapabilityLockRecord,
} from "./types.js";

export async function loadCapabilityDeclarations(root: string): Promise<CapabilityDeclarations> {
  const value = await readJsonFile<unknown>(
    workspacePaths(root).capabilityDeclarations,
    "Research capability declarations",
  );
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.capabilities)) {
    throw new CliError("Research capability declarations have an unsupported shape.", {
      code: "RESEARCH_CAPABILITY_INVALID",
      exitCode: 2,
    });
  }
  const capabilities = value.capabilities.map((item, index) => parseCapability(item, index));
  assertUnique(
    capabilities.map((item) => item.id),
    "capability ID",
  );
  assertUnique(
    capabilities.flatMap((item) => item.credentials.map((credential) => credential.id)),
    "credential ID",
  );
  return { schemaVersion: 1, capabilities };
}

export async function lockCapabilities(root: string): Promise<CapabilityLock> {
  const declarations = await loadCapabilityDeclarations(root);
  const records = await Promise.all(
    declarations.capabilities.map(async (declaration) => lockCapability(declaration)),
  );
  records.sort((left, right) => left.id.localeCompare(right.id));
  assertUnique(
    records.map((record) => record.skillName),
    "capability skill name",
  );
  const lock: CapabilityLock = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    capabilities: records,
  };
  await writeJsonAtomic(workspacePaths(root).capabilityLock, lock, 0o444);
  return lock;
}

export async function verifyCapabilities(root: string): Promise<{
  status: "verified" | "drifted";
  checked: number;
  errors: string[];
}> {
  const declarations = await loadCapabilityDeclarations(root);
  const lockPath = workspacePaths(root).capabilityLock;
  if (!(await pathExists(lockPath))) {
    if (declarations.capabilities.length === 0) {
      return { status: "verified", checked: 0, errors: [] };
    }
    return { status: "drifted", checked: 0, errors: ["capability lock is missing"] };
  }
  const lock = await readJsonFile<unknown>(lockPath, "Research capability lock");
  if (!isCapabilityLock(lock)) {
    return { status: "drifted", checked: 0, errors: ["capability lock shape is invalid"] };
  }
  const lockedById = new Map(lock.capabilities.map((record) => [record.id, record]));
  const errors: string[] = [];
  for (const declaration of declarations.capabilities) {
    const record = lockedById.get(declaration.id);
    if (!record) {
      errors.push(`${declaration.id}: missing lock record`);
      continue;
    }
    try {
      const current = await lockCapability(declaration);
      if (JSON.stringify(current) !== JSON.stringify(record)) {
        errors.push(`${declaration.id}: installed skill differs from its lock`);
      }
    } catch (error) {
      errors.push(`${declaration.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const record of lock.capabilities) {
    if (!declarations.capabilities.some((item) => item.id === record.id)) {
      errors.push(`${record.id}: lock record has no declaration`);
    }
  }
  return {
    status: errors.length ? "drifted" : "verified",
    checked: declarations.capabilities.length,
    errors,
  };
}

export async function stageLockedCapabilities(
  root: string,
  destination: string,
): Promise<string[]> {
  const declarations = await loadCapabilityDeclarations(root);
  if (declarations.capabilities.length === 0) return [];
  const verification = await verifyCapabilities(root);
  if (verification.status !== "verified") {
    throw new CliError("Research capabilities must be locked and verified before execution.", {
      code: "RESEARCH_CAPABILITY_DRIFT",
      exitCode: 3,
      details: verification,
    });
  }
  const lock = await readJsonFile<CapabilityLock>(
    workspacePaths(root).capabilityLock,
    "Research capability lock",
  );
  const staged: string[] = [];
  for (const record of lock.capabilities) {
    const target = join(destination, record.skillName);
    await copyRegularTree(record.skillPath, target);
    staged.push(target);
  }
  return staged;
}

export async function declaredCredentialIds(root: string): Promise<Set<string>> {
  const declarations = await loadCapabilityDeclarations(root);
  return new Set(
    declarations.capabilities.flatMap((capability) =>
      capability.credentials.map((credential) => credential.id),
    ),
  );
}

async function lockCapability(declaration: CapabilityDeclaration): Promise<CapabilityLockRecord> {
  const skillPath = resolve(declaration.skillPath);
  if (skillPath !== declaration.skillPath) {
    throw new CliError(`Capability skill path must be absolute: ${declaration.skillPath}`, {
      code: "RESEARCH_CAPABILITY_INVALID",
      exitCode: 2,
    });
  }
  const skillEntry = join(skillPath, "SKILL.md");
  const skillText = await readFile(skillEntry, "utf8").catch(() => {
    throw new CliError(`Capability is missing SKILL.md: ${skillPath}`, {
      code: "RESEARCH_CAPABILITY_INVALID",
      exitCode: 2,
    });
  });
  const skillName = skillFrontmatterName(skillText);
  if (basename(skillPath) !== skillName) {
    throw new CliError(`Capability directory and skill name differ: ${skillPath}`, {
      code: "RESEARCH_CAPABILITY_INVALID",
      exitCode: 2,
    });
  }
  return {
    id: declaration.id,
    skillName,
    skillPath,
    treeSha256: await hashRegularTree(skillPath),
    policySha256: policyHash(declaration),
    permissions: [...declaration.permissions].sort(),
    credentialIds: declaration.credentials.map((item) => item.id).sort(),
  };
}

function parseCapability(value: unknown, index: number): CapabilityDeclaration {
  if (!isObject(value)) invalid(index, "must be an object");
  const id = value.id;
  const skillPath = value.skillPath;
  const permissions = value.permissions;
  const allowedHosts = value.allowedHosts ?? [];
  const credentials = value.credentials ?? [];
  if (typeof id !== "string" || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(id)) {
    invalid(index, "id must be a namespaced logical identifier");
  }
  if (typeof skillPath !== "string" || !isAbsolute(skillPath)) {
    invalid(index, "skillPath must be absolute");
  }
  if (
    !Array.isArray(permissions) ||
    permissions.some(
      (permission) =>
        typeof permission !== "string" || !ALLOWED_CAPABILITY_PERMISSIONS.has(permission),
    )
  ) {
    invalid(index, "permissions contain an unsupported value");
  }
  if (!Array.isArray(credentials)) invalid(index, "credentials must be an array");
  if (!Array.isArray(allowedHosts) || allowedHosts.some((host) => typeof host !== "string")) {
    invalid(index, "allowedHosts must be an array of exact host names");
  }
  const parsedAllowedHosts = [
    ...new Set(allowedHosts.map((host) => normalizeAllowedHost(host, index))),
  ].sort();
  const brokeredNetwork = permissions.includes("brokered-network");
  if (brokeredNetwork && parsedAllowedHosts.length === 0) {
    invalid(index, "must declare allowedHosts for brokered-network");
  }
  if (!brokeredNetwork && parsedAllowedHosts.length > 0) {
    invalid(index, "cannot declare allowedHosts without brokered-network");
  }
  const parsedCredentials = credentials.map((credential, credentialIndex) => {
    if (!isObject(credential)) invalid(index, `credential ${credentialIndex} must be an object`);
    if (
      typeof credential.id !== "string" ||
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(credential.id) ||
      !Array.isArray(credential.allowedHosts) ||
      credential.allowedHosts.length === 0 ||
      credential.allowedHosts.some((host) => typeof host !== "string") ||
      typeof credential.headerName !== "string" ||
      !/^[A-Za-z][A-Za-z0-9-]*$/.test(credential.headerName) ||
      typeof credential.prefix !== "string"
    ) {
      invalid(index, `credential ${credentialIndex} is malformed`);
    }
    const credentialHosts = [
      ...new Set(
        credential.allowedHosts.map((host) => normalizeAllowedHost(host, index, credentialIndex)),
      ),
    ].sort();
    if (!brokeredNetwork || credentialHosts.some((host) => !parsedAllowedHosts.includes(host))) {
      invalid(index, `credential ${credentialIndex} hosts must be within capability allowedHosts`);
    }
    return {
      id: credential.id,
      allowedHosts: credentialHosts,
      headerName: credential.headerName,
      prefix: credential.prefix,
    };
  });
  assertUnique(
    parsedCredentials.map((item) => item.id),
    `credential ID in ${id}`,
  );
  return {
    id,
    skillPath,
    permissions: [...new Set(permissions)],
    allowedHosts: parsedAllowedHosts,
    credentials: parsedCredentials,
  };
}

function isCapabilityLock(value: unknown): value is CapabilityLock {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    typeof value.generatedAt === "string" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(
      (record) =>
        isObject(record) &&
        typeof record.id === "string" &&
        typeof record.skillName === "string" &&
        typeof record.skillPath === "string" &&
        typeof record.treeSha256 === "string" &&
        typeof record.policySha256 === "string" &&
        Array.isArray(record.permissions) &&
        Array.isArray(record.credentialIds),
    )
  );
}

function policyHash(declaration: CapabilityDeclaration): string {
  return hashText(
    canonicalJson({
      permissions: [...declaration.permissions].sort(),
      allowedHosts: [...declaration.allowedHosts].sort(),
      credentials: declaration.credentials
        .map((credential) => ({
          id: credential.id,
          allowedHosts: [...credential.allowedHosts].sort(),
          headerName: credential.headerName.toLowerCase(),
          prefix: credential.prefix,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    }),
  );
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeAllowedHost(value: string, index: number, credentialIndex?: number): string {
  const label =
    credentialIndex === undefined ? "allowedHosts" : `credential ${credentialIndex} host`;
  const candidate = value.trim().toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(`https://${candidate}`);
  } catch {
    invalid(index, `${label} contains an invalid host`);
  }
  if (
    !candidate ||
    candidate.includes("*") ||
    parsed.username ||
    parsed.password ||
    parsed.hostname.endsWith(".") ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    invalid(index, `${label} must contain exact HTTPS host names without paths or wildcards`);
  }
  return parsed.host;
}

function skillFrontmatterName(content: string): string {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  const name = match?.[1]?.match(/^name:\s*["']?([a-z0-9-]+)["']?\s*$/m)?.[1];
  if (!name) {
    throw new CliError("Capability SKILL.md has no valid name frontmatter.", {
      code: "RESEARCH_CAPABILITY_INVALID",
      exitCode: 2,
    });
  }
  return name;
}

async function copyRegularTree(source: string, target: string): Promise<void> {
  const files = await regularTreeFiles(source);
  for (const path of files) {
    const logical = relative(source, path);
    const destination = join(target, logical);
    await ensureDirectory(dirname(destination));
    await writeFile(destination, await readFile(path), { mode: 0o600 });
  }
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new CliError(`Duplicate ${label}: ${value}`, {
        code: "RESEARCH_CAPABILITY_INVALID",
        exitCode: 2,
      });
    }
    seen.add(value);
  }
}

function invalid(index: number, detail: string): never {
  throw new CliError(`Capability declaration ${index} ${detail}.`, {
    code: "RESEARCH_CAPABILITY_INVALID",
    exitCode: 2,
  });
}
