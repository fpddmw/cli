import { lstat, readFile } from "node:fs/promises";

import { CliError } from "../../errors.js";
import { isObject, pathExists, workspacePaths, writeTextAtomic } from "./storage.js";
import type { CapabilityDeclaration } from "./types.js";

const CREDENTIAL_ENV_KEY = "TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON";
const MAX_CREDENTIAL_ENV_BYTES = 64 * 1024;

export async function loadCapabilityCredentialMap(
  root: string,
  capabilities: CapabilityDeclaration[],
): Promise<Map<string, string>> {
  const path = workspacePaths(root).env;
  if (!(await pathExists(path))) return new Map();
  const info = await lstat(path).catch(() => {
    throw credentialEnvironmentError("credential environment cannot be inspected");
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw credentialEnvironmentError("credential environment must be a regular non-symlink file");
  }
  if (info.size > MAX_CREDENTIAL_ENV_BYTES) {
    throw credentialEnvironmentError("credential environment exceeds the maximum supported size");
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw credentialEnvironmentError("credential environment must have owner-only permissions");
  }
  const declared = new Set(
    capabilities.flatMap((capability) => capability.credentials.map((credential) => credential.id)),
  );
  const configured = new Map<string, string>();
  let foundConfiguration = false;
  const content = await readFile(path, "utf8").catch(() => {
    throw credentialEnvironmentError("credential environment cannot be read");
  });
  for (const sourceLine of content.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    const key = equals > 0 ? line.slice(0, equals).trim() : "";
    if (key !== CREDENTIAL_ENV_KEY) {
      throw credentialEnvironmentError(`unsupported research environment key: ${key || "missing"}`);
    }
    if (foundConfiguration) {
      throw credentialEnvironmentError("research credential configuration is duplicated");
    }
    foundConfiguration = true;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(equals + 1).trim() || "{}") as unknown;
    } catch {
      throw credentialEnvironmentError("capability credential JSON is invalid");
    }
    if (!isObject(value)) {
      throw credentialEnvironmentError("capability credentials must be a JSON object");
    }
    for (const [credentialId, credentialValue] of Object.entries(value)) {
      if (!declared.has(credentialId))
        throw credentialEnvironmentError(`credential is not declared: ${credentialId}`);
      if (typeof credentialValue !== "string" || Buffer.byteLength(credentialValue, "utf8") < 8) {
        throw credentialEnvironmentError(`credential value is invalid: ${credentialId}`);
      }
      configured.set(credentialId, credentialValue);
    }
  }
  return configured;
}

export async function inspectCapabilityCredentialEnvironment(
  root: string,
  capabilities: CapabilityDeclaration[],
): Promise<{
  detail: string;
  configuredIds: string[];
  missingIds: string[];
}> {
  const declaredIds = [
    ...new Set(
      capabilities.flatMap((capability) =>
        capability.credentials.map((credential) => credential.id),
      ),
    ),
  ].sort();
  const configured = await loadCapabilityCredentialMap(root, capabilities);
  const configuredIds = [...configured.keys()].sort();
  const missingIds = declaredIds.filter((credentialId) => !configured.has(credentialId));
  const detail =
    declaredIds.length === 0
      ? "not configured; no credentials declared"
      : missingIds.length === 0
        ? `${configuredIds.length} declared credential value(s) configured with owner-only permissions`
        : `${missingIds.length}/${declaredIds.length} declared credential value(s) missing`;
  return { detail, configuredIds, missingIds };
}

export async function setCapabilityCredentialFromEnvironment(input: {
  root: string;
  capabilities: CapabilityDeclaration[];
  credentialId: string;
  environmentName: string;
  environment: NodeJS.ProcessEnv;
}): Promise<{
  credentialId: string;
  sourceEnvironmentName: string;
  configured: true;
  configuredCredentialIds: string[];
}> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.environmentName)) {
    throw credentialConfigurationError("credential source environment name is invalid");
  }
  const declared = new Set(
    input.capabilities.flatMap((capability) =>
      capability.credentials.map((credential) => credential.id),
    ),
  );
  if (!declared.has(input.credentialId)) {
    throw credentialConfigurationError(`credential is not declared: ${input.credentialId}`);
  }
  const value = input.environment[input.environmentName];
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 8) {
    throw credentialConfigurationError(
      `credential source environment variable is missing or too short: ${input.environmentName}`,
    );
  }
  const configured = await loadCapabilityCredentialMap(input.root, input.capabilities);
  configured.set(input.credentialId, value);
  const serialized = Object.fromEntries(
    [...configured.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeTextAtomic(
    workspacePaths(input.root).env,
    `${CREDENTIAL_ENV_KEY}=${JSON.stringify(serialized)}\n`,
    0o600,
  );
  return {
    credentialId: input.credentialId,
    sourceEnvironmentName: input.environmentName,
    configured: true,
    configuredCredentialIds: [...configured.keys()].sort(),
  };
}

function credentialConfigurationError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_CAPABILITY_CREDENTIAL_INVALID",
    exitCode: 3,
  });
}

function credentialEnvironmentError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_CAPABILITY_CREDENTIAL_ENV_INVALID",
    exitCode: 3,
  });
}
