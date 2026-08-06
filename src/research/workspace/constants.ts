import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RESEARCH_CONTROL_DIRECTORY = ".tiangong-research";
export const RESEARCH_PROTOCOL_VERSION = 1 as const;
export const RESEARCH_PACKAGE_NAME = "@tiangong-ai/cli" as const;

export const ALLOWED_CAPABILITY_PERMISSIONS = new Set([
  "project-read",
  "candidate-write",
  "brokered-network",
  "controlled-command",
]);

export const WORKSPACE_OPERATIONS = [
  "research.context.inspect",
  "research.workspace.doctor",
  "research.capability.lock",
  "research.capability.verify",
  "research.project.init",
  "research.project.preflight",
  "research.project.input.add",
  "research.project.retry",
  "research.project.fork",
  "research.schema.show",
  "research.status",
  "research.run",
] as const;

export const UNMANAGED_OPERATIONS = [
  "research.context.inspect",
  "research.workspace.init",
] as const;

export const INVALID_OPERATIONS = ["research.context.inspect"] as const;

export function packageVersion(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packagePath = resolve(moduleDirectory, "../../../package.json");
  const value = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !value.version.trim()) {
    throw new Error("Package version is unavailable.");
  }
  return value.version;
}
