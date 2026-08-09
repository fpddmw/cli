import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
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

const MAX_CAPABILITY_FILES = 512;
const MAX_CAPABILITY_BYTES = 32 * 1024 * 1024;
const MAX_CAPABILITY_FILE_BYTES = 8 * 1024 * 1024;

export async function loadCapabilityDeclarations(root: string): Promise<CapabilityDeclarations> {
  const value = await readJsonFile<unknown>(
    workspacePaths(root).capabilityDeclarations,
    "Research capability declarations",
  );
  return parseCapabilityDeclarations(value);
}

export function parseCapabilityDeclarations(value: unknown): CapabilityDeclarations {
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
  assertConsistentCredentials(capabilities);
  return { schemaVersion: 1, capabilities };
}

export async function lockCapabilities(root: string): Promise<CapabilityLock> {
  const declarations = await loadCapabilityDeclarations(root);
  const lock = await buildCapabilityLock(declarations);
  await writeJsonAtomic(workspacePaths(root).capabilityLock, lock, 0o444);
  return lock;
}

export async function buildCapabilityLock(
  declarations: CapabilityDeclarations,
): Promise<CapabilityLock> {
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
  await ensureDirectory(destination);
  if (declarations.capabilities.length === 0) {
    await writeJsonAtomic(join(destination, "manifest.json"), {
      schemaVersion: 1,
      capabilities: [],
    });
    return [];
  }
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
  const byId = new Map(declarations.capabilities.map((capability) => [capability.id, capability]));
  await writeJsonAtomic(join(destination, "manifest.json"), {
    schemaVersion: 1,
    capabilities: lock.capabilities.map((record) => {
      const declaration = byId.get(record.id)!;
      return {
        id: record.id,
        skillName: record.skillName,
        path: `skills/${record.skillName}`,
        treeSha256: record.treeSha256,
        policySha256: record.policySha256,
        catalogId: declaration.source?.catalogId ?? null,
        requiredForDiscovery: declaration.requiredForDiscovery,
        permissions: record.permissions,
        allowedHosts: declaration.allowedHosts,
        http: declaration.http,
        coverage: declaration.coverage,
        credentialIds: record.credentialIds,
      };
    }),
  });
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
  const treeSha256 = await hashCapabilityTree(skillPath);
  if (declaration.source && declaration.source.expectedTreeSha256 !== treeSha256) {
    throw new CliError(`Capability source tree hash does not match installed bytes: ${skillPath}`, {
      code: "RESEARCH_CAPABILITY_INVALID",
      exitCode: 2,
    });
  }
  if (
    declaration.source?.type === "local" &&
    declaration.source.immutableRef !== `sha256:${treeSha256}`
  ) {
    throw new CliError(
      `Local capability source hash does not match installed bytes: ${skillPath}`,
      {
        code: "RESEARCH_CAPABILITY_INVALID",
        exitCode: 2,
      },
    );
  }
  return {
    id: declaration.id,
    skillName,
    skillPath,
    treeSha256,
    policySha256: policyHash(declaration),
    source: declaration.source,
    requiredForDiscovery: declaration.requiredForDiscovery,
    permissions: [...declaration.permissions].sort(),
    credentialIds: declaration.credentials.map((item) => item.id).sort(),
    discoveryScopes: declaration.coverage?.discoveryScopes ?? [],
    healthTargetSha256: declaration.healthCheck ? hashText(declaration.healthCheck.url) : null,
  };
}

function parseCapability(value: unknown, index: number): CapabilityDeclaration {
  if (!isObject(value)) invalid(index, "must be an object");
  const id = value.id;
  const skillPath = value.skillPath;
  const source = value.source;
  const requiredForDiscovery = value.requiredForDiscovery ?? false;
  const permissions = value.permissions;
  const allowedHosts = value.allowedHosts ?? [];
  const http = value.http;
  const coverage = value.coverage;
  const credentials = value.credentials ?? [];
  const healthCheck = value.healthCheck;
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
  if (typeof requiredForDiscovery !== "boolean") {
    invalid(index, "requiredForDiscovery must be a boolean");
  }
  if (requiredForDiscovery && !brokeredNetwork) {
    invalid(index, "cannot require discovery without brokered-network");
  }
  if (brokeredNetwork && parsedAllowedHosts.length === 0) {
    invalid(index, "must declare allowedHosts for brokered-network");
  }
  if (!brokeredNetwork && parsedAllowedHosts.length > 0) {
    invalid(index, "cannot declare allowedHosts without brokered-network");
  }
  const parsedHttp = brokeredNetwork ? parseHttpPolicy(http, index, parsedAllowedHosts) : null;
  if (!brokeredNetwork && http !== undefined && http !== null) {
    invalid(index, "cannot declare http policy without brokered-network");
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
  const parsedHealthCheck = parseHealthCheck(
    healthCheck,
    index,
    brokeredNetwork,
    parsedAllowedHosts,
    parsedHttp,
    parsedCredentials.map((credential) => credential.id),
  );
  return {
    id,
    skillPath,
    source: parseSource(source, index),
    requiredForDiscovery,
    permissions: [...new Set(permissions)],
    allowedHosts: parsedAllowedHosts,
    http: parsedHttp,
    coverage: parseCoverage(coverage, index),
    credentials: parsedCredentials,
    healthCheck: parsedHealthCheck,
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
        (record.source === null || isObject(record.source)) &&
        typeof record.requiredForDiscovery === "boolean" &&
        Array.isArray(record.permissions) &&
        Array.isArray(record.credentialIds) &&
        Array.isArray(record.discoveryScopes) &&
        (record.healthTargetSha256 === null || typeof record.healthTargetSha256 === "string"),
    )
  );
}

function policyHash(declaration: CapabilityDeclaration): string {
  return hashText(
    canonicalJson({
      source: declaration.source,
      requiredForDiscovery: declaration.requiredForDiscovery,
      permissions: [...declaration.permissions].sort(),
      allowedHosts: [...declaration.allowedHosts].sort(),
      http: declaration.http,
      coverage: declaration.coverage,
      healthCheck: declaration.healthCheck
        ? {
            ...declaration.healthCheck,
            expectedContentTypes: [...declaration.healthCheck.expectedContentTypes].sort(),
          }
        : null,
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

function parseSource(value: unknown, index: number): CapabilityDeclaration["source"] {
  if (value === undefined || value === null) return null;
  if (
    !isObject(value) ||
    (value.type !== "git" && value.type !== "registry" && value.type !== "local") ||
    typeof value.locator !== "string" ||
    !value.locator.trim() ||
    value.locator.length > 500 ||
    /[\u0000-\u001f]/.test(value.locator) ||
    /(^|[?&#;\s])(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|cookie|credential|password|secret|session|sig|signature|token)=/i.test(
      value.locator,
    ) ||
    typeof value.immutableRef !== "string" ||
    !value.immutableRef.trim() ||
    value.immutableRef.length > 128 ||
    /[\u0000-\u0020]/.test(value.immutableRef) ||
    typeof value.expectedTreeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.expectedTreeSha256) ||
    typeof value.license !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$/.test(value.license) ||
    !(
      value.catalogId === undefined ||
      value.catalogId === null ||
      (typeof value.catalogId === "string" &&
        /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value.catalogId))
    )
  ) {
    invalid(index, "source declaration is malformed");
  }
  if (value.type === "git") {
    let locator: URL;
    try {
      locator = new URL(value.locator);
    } catch {
      invalid(index, "git source locator must be an HTTPS URL");
    }
    if (locator.protocol !== "https:" || locator.username || locator.password) {
      invalid(index, "git source locator must be credential-free HTTPS");
    }
    if (!/^[0-9a-f]{40}$/i.test(value.immutableRef)) {
      invalid(index, "git source immutableRef must be a full 40-character commit SHA");
    }
  }
  if (
    value.type === "registry" &&
    !/^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.immutableRef)
  ) {
    invalid(index, "registry source immutableRef must be an exact version");
  }
  if (value.type === "local" && !/^sha256:[0-9a-f]{64}$/i.test(value.immutableRef)) {
    invalid(index, "local source immutableRef must be a SHA-256 content identity");
  }
  return {
    type: value.type,
    locator: value.locator.trim(),
    immutableRef:
      value.type === "git" || value.type === "local"
        ? value.immutableRef.trim().toLowerCase()
        : value.immutableRef.trim(),
    expectedTreeSha256: value.expectedTreeSha256.toLowerCase(),
    license: value.license,
    catalogId: value.catalogId ?? null,
  };
}

function parseHealthCheck(
  value: unknown,
  index: number,
  brokeredNetwork: boolean,
  allowedHosts: string[],
  http: CapabilityDeclaration["http"],
  credentialIds: string[],
): CapabilityDeclaration["healthCheck"] {
  if (value === undefined || value === null) return null;
  if (
    !brokeredNetwork ||
    !http ||
    !isObject(value) ||
    typeof value.url !== "string" ||
    !Array.isArray(value.expectedContentTypes) ||
    value.expectedContentTypes.length === 0 ||
    value.expectedContentTypes.some(
      (item) => typeof item !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i.test(item),
    ) ||
    !(
      value.credentialId === undefined ||
      value.credentialId === null ||
      (typeof value.credentialId === "string" && credentialIds.includes(value.credentialId))
    )
  ) {
    invalid(index, "healthCheck declaration is malformed");
  }
  let target: URL;
  try {
    target = new URL(value.url);
  } catch {
    invalid(index, "healthCheck URL is invalid");
  }
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    !allowedHosts.includes(target.host.toLowerCase())
  ) {
    invalid(index, "healthCheck URL must use an allowed credential-free HTTPS host");
  }
  if (!endpointAllowsUrl(target, new URL(http.endpoint))) {
    invalid(index, "healthCheck URL must stay within the declared http endpoint scope");
  }
  const sensitiveParameter = [...target.searchParams.keys()].find((key) =>
    /(^|[-_])(api[-_]?key|authorization|cookie|credential|password|secret|session|token)($|[-_])/i.test(
      key,
    ),
  );
  if (sensitiveParameter) {
    invalid(index, "healthCheck URL cannot contain sensitive query parameters");
  }
  const expectedContentTypes = [
    ...new Set(value.expectedContentTypes.map((item) => item.toLowerCase())),
  ].sort();
  if (
    expectedContentTypes.some(
      (contentType) => !contentTypeAllowedByPolicy(contentType, http.allowedContentTypes),
    )
  ) {
    invalid(index, "healthCheck content types must be allowed by the HTTP policy");
  }
  const method = parseHttpMethod(value.method ?? http.method, index, "healthCheck");
  if (method !== http.method) invalid(index, "healthCheck method must match the HTTP policy");
  return {
    url: target.toString(),
    credentialId: value.credentialId ?? null,
    expectedContentTypes,
    method,
    body: parseRequestBody(value.body, method, http.maxRequestBytes, index),
  };
}

function parseCoverage(value: unknown, index: number): CapabilityDeclaration["coverage"] {
  if (value === undefined || value === null) return null;
  const discoveryScopes = isObject(value) ? (value.discoveryScopes ?? []) : [];
  if (
    !isObject(value) ||
    !Array.isArray(value.dimensions) ||
    value.dimensions.some((item) => !validCoverageId(item)) ||
    !Array.isArray(value.sourceTypes) ||
    value.sourceTypes.some((item) => !validCoverageId(item)) ||
    !Array.isArray(discoveryScopes) ||
    discoveryScopes.some((item) => !validCoverageId(item) || item === "*") ||
    typeof value.fullText !== "boolean" ||
    typeof value.publicationDates !== "boolean"
  ) {
    invalid(index, "coverage declaration is malformed");
  }
  return {
    dimensions: [...new Set(value.dimensions)].sort(),
    sourceTypes: [...new Set(value.sourceTypes)].sort(),
    discoveryScopes: [...new Set(discoveryScopes)].sort(),
    fullText: value.fullText,
    publicationDates: value.publicationDates,
  };
}

function validCoverageId(value: unknown): value is string {
  return (
    value === "*" || (typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value))
  );
}

function contentTypeAllowedByPolicy(value: string, allowed: string[]): boolean {
  return allowed.some((candidate) => {
    if (candidate === value || candidate === "*/*") return true;
    if (candidate.endsWith("/*")) return value.startsWith(candidate.slice(0, -1));
    return false;
  });
}

function parseHttpPolicy(
  value: unknown,
  index: number,
  allowedHosts: string[],
): CapabilityDeclaration["http"] {
  if (value === undefined || value === null) {
    invalid(index, "brokered-network requires an explicit http endpoint policy");
  }
  if (
    !isObject(value) ||
    typeof value.endpoint !== "string" ||
    (value.method !== undefined && value.method !== "GET" && value.method !== "POST") ||
    typeof value.accept !== "string" ||
    !value.accept.trim() ||
    /[\r\n]/.test(value.accept) ||
    !Array.isArray(value.allowedContentTypes) ||
    value.allowedContentTypes.length === 0 ||
    value.allowedContentTypes.some(
      (item) => typeof item !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i.test(item),
    ) ||
    (value.maxRequestBytes !== undefined &&
      (typeof value.maxRequestBytes !== "number" ||
        !Number.isInteger(value.maxRequestBytes) ||
        value.maxRequestBytes < 1 ||
        value.maxRequestBytes > 1024 * 1024)) ||
    typeof value.maxResponseBytes !== "number" ||
    !Number.isInteger(value.maxResponseBytes) ||
    value.maxResponseBytes < 1 ||
    value.maxResponseBytes > 20 * 1024 * 1024 ||
    typeof value.maxItems !== "number" ||
    !Number.isInteger(value.maxItems) ||
    value.maxItems < 1 ||
    value.maxItems > 10_000
  ) {
    invalid(index, "http policy is malformed");
  }
  const endpoint = parseCapabilityEndpoint(value.endpoint, allowedHosts, index);
  const staticHeaders = parseStaticHeaders(value.staticHeaders, index);
  return {
    endpoint,
    method: parseHttpMethod(value.method ?? "GET", index, "http"),
    accept: value.accept.trim(),
    allowedContentTypes: [...new Set(value.allowedContentTypes.map((item) => item.toLowerCase()))],
    staticHeaders,
    maxRequestBytes: value.maxRequestBytes ?? 64 * 1024,
    maxResponseBytes: value.maxResponseBytes,
    maxItems: value.maxItems,
  };
}

function parseCapabilityEndpoint(value: string, allowedHosts: string[], index: number): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    invalid(index, "http endpoint must be an exact HTTPS URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !allowedHosts.includes(endpoint.host.toLowerCase())
  ) {
    invalid(
      index,
      "http endpoint must be credential-free HTTPS on an allowed host without query or fragment",
    );
  }
  return endpoint.toString();
}

function parseHttpMethod(value: unknown, index: number, label: string): "GET" | "POST" {
  if (value !== "GET" && value !== "POST") invalid(index, `${label} method is unsupported`);
  return value;
}

function parseStaticHeaders(value: unknown, index: number): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isObject(value) || Object.keys(value).length > 16) {
    invalid(index, "http staticHeaders must be a bounded object");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (
      !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) ||
      /^(authorization|cookie|proxy-authorization|set-cookie|x-api-key)$/i.test(name) ||
      typeof headerValue !== "string" ||
      headerValue.length > 256 ||
      /[\r\n\0]/.test(headerValue)
    ) {
      invalid(index, "http staticHeaders contain an unsafe value");
    }
    headers[name.toLowerCase()] = headerValue;
  }
  return Object.fromEntries(
    Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseRequestBody(
  value: unknown,
  method: unknown,
  maxRequestBytes: number,
  index: number,
): Record<string, unknown> | null {
  const parsedMethod = parseHttpMethod(method, index, "healthCheck");
  if (parsedMethod === "GET") {
    if (value !== undefined && value !== null)
      invalid(index, "GET healthCheck cannot declare a body");
    return null;
  }
  if (!isObject(value)) invalid(index, "POST healthCheck requires an object body");
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes < 2 || bytes > maxRequestBytes || containsSensitiveBodyField(value)) {
    invalid(index, "healthCheck body is too large or contains credential-like fields");
  }
  return value;
}

function containsSensitiveBodyField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveBodyField);
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      /^(access[_-]?token|api[_-]?key|apikey|authorization|cookie|credential|password|secret|session|token)$/i.test(
        key,
      ) || containsSensitiveBodyField(item),
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

function endpointAllowsUrl(target: URL, endpoint: URL): boolean {
  return (
    target.protocol === endpoint.protocol &&
    target.host.toLowerCase() === endpoint.host.toLowerCase() &&
    (endpoint.pathname === "/" || target.pathname === endpoint.pathname)
  );
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

async function hashCapabilityTree(root: string): Promise<string> {
  const files = await regularTreeFiles(root);
  if (files.length > MAX_CAPABILITY_FILES) {
    throw new CliError(`Capability tree contains too many files: ${root}`, {
      code: "RESEARCH_CAPABILITY_INVALID",
      exitCode: 2,
    });
  }
  let totalBytes = 0;
  for (const path of files) {
    const bytes = (await lstat(path)).size;
    if (bytes > MAX_CAPABILITY_FILE_BYTES) {
      throw new CliError(`Capability tree contains an oversized file: ${path}`, {
        code: "RESEARCH_CAPABILITY_INVALID",
        exitCode: 2,
      });
    }
    totalBytes += bytes;
    if (totalBytes > MAX_CAPABILITY_BYTES) {
      throw new CliError(`Capability tree exceeds the total size limit: ${root}`, {
        code: "RESEARCH_CAPABILITY_INVALID",
        exitCode: 2,
      });
    }
  }
  return hashRegularTree(root);
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

function assertConsistentCredentials(capabilities: CapabilityDeclaration[]): void {
  const seen = new Map<string, string>();
  for (const credential of capabilities.flatMap((capability) => capability.credentials)) {
    const identity = canonicalJson({
      allowedHosts: credential.allowedHosts,
      headerName: credential.headerName.toLowerCase(),
      prefix: credential.prefix,
    });
    const previous = seen.get(credential.id);
    if (previous !== undefined && previous !== identity) {
      throw new CliError(`Credential ID has conflicting declarations: ${credential.id}`, {
        code: "RESEARCH_CAPABILITY_INVALID",
        exitCode: 2,
      });
    }
    seen.set(credential.id, identity);
  }
}

function invalid(index: number, detail: string): never {
  throw new CliError(`Capability declaration ${index} ${detail}.`, {
    code: "RESEARCH_CAPABILITY_INVALID",
    exitCode: 2,
  });
}
