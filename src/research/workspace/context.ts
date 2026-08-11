import { lstat, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import {
  INVALID_OPERATIONS,
  RESEARCH_PACKAGE_NAME,
  RESEARCH_CONTROL_DIRECTORY,
  SETUP_OPERATIONS,
  UNMANAGED_OPERATIONS,
  WORKSPACE_OPERATIONS,
} from "./constants.js";
import {
  exactResearchCliCommand,
  researchSetupApplyCommand,
  researchSetupRetryCommand,
} from "./setup-invocation.js";
import { isObject, pathExists, readJsonFile } from "./storage.js";
import type { ContextInspection, WorkspaceMarker } from "./types.js";

export async function inspectResearchContext(selectedPath: string): Promise<ContextInspection> {
  const canonical = resolve(selectedPath);
  const info = await lstat(canonical).catch(() => undefined);
  let cursor = info?.isFile() ? dirname(canonical) : canonical;

  while (true) {
    const control = join(cursor, RESEARCH_CONTROL_DIRECTORY);
    if (await pathExists(control)) {
      const workspaceRoot = await realpath(cursor).catch(() => cursor);
      const workspaceControl = join(workspaceRoot, RESEARCH_CONTROL_DIRECTORY);
      const setup = await inspectManagedSetup(workspaceControl, workspaceRoot);
      const markerPath = join(control, "workspace.json");
      if (!(await pathExists(markerPath))) {
        if (setup) {
          return {
            role: "setup",
            selectedPath: canonical,
            root: cursor,
            allowedOperations: [...SETUP_OPERATIONS],
            violations: [],
            setup,
          };
        }
        return {
          role: "invalid",
          selectedPath: canonical,
          root: cursor,
          allowedOperations: [...INVALID_OPERATIONS],
          violations: [
            {
              code: "WORKSPACE_MARKER_MISSING",
              message: `${RESEARCH_CONTROL_DIRECTORY} exists without workspace.json.`,
            },
          ],
        };
      }
      try {
        const marker = await readJsonFile<unknown>(markerPath, "Research workspace marker");
        if (!isWorkspaceMarker(marker)) {
          return invalidMarker(canonical, cursor, "workspace.json has an unsupported shape.");
        }
        return {
          role: "workspace",
          selectedPath: canonical,
          root: cursor,
          allowedOperations: [...WORKSPACE_OPERATIONS],
          violations: [],
          ...(setup ? { setup } : {}),
        };
      } catch (error) {
        return invalidMarker(canonical, cursor, String(error));
      }
    }
    const parent = dirname(cursor);
    if (cursor === parent || cursor === parse(cursor).root) break;
    cursor = parent;
  }

  return {
    role: "unmanaged",
    selectedPath: canonical,
    root: null,
    allowedOperations: [...UNMANAGED_OPERATIONS],
    violations: [],
  };
}

async function inspectManagedSetup(
  control: string,
  root: string,
): Promise<NonNullable<ContextInspection["setup"]> | null> {
  const planPath = join(control, "setup-plan.json");
  if (!(await pathExists(planPath))) return null;
  try {
    const plan = await readJsonFile<unknown>(planPath, "Research setup plan");
    if (
      !isObject(plan) ||
      plan.schemaVersion !== 1 ||
      plan.kind !== "tiangong-research-setup-plan" ||
      !isObject(plan.cli) ||
      plan.cli.package !== RESEARCH_PACKAGE_NAME ||
      typeof plan.cli.version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(plan.cli.version) ||
      typeof plan.planSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(plan.planSha256)
    ) {
      return null;
    }
    const state = await readSetupStateSummary(control);
    const runtimeSource = (await hasMatchingRuntimeLock(control, plan.cli.version))
      ? "runtime-lock"
      : "setup-plan";
    const blocker = state.lastError
      ? {
          ...state.lastError,
          retryCommand: researchSetupRetryCommand({
            version: plan.cli.version,
            workspace: root,
            step: state.lastError.step,
          }),
        }
      : null;
    const next =
      state.status === "ready"
        ? null
        : state.status === "pending"
          ? {
              action: "apply" as const,
              retryCommand: researchSetupApplyCommand({
                version: plan.cli.version,
                planPath,
              }),
            }
          : state.status === "blocked" && blocker
            ? { action: "retry" as const, retryCommand: blocker.retryCommand }
            : state.status === "applying"
              ? {
                  action: "inspect" as const,
                  retryCommand: exactResearchCliCommand(
                    ["research", "setup", "status", "--workspace", root, "--json"],
                    plan.cli.version,
                  ),
                }
              : {
                  action: "doctor" as const,
                  retryCommand: exactResearchCliCommand(
                    ["research", "setup", "doctor", "--workspace", root, "--json"],
                    plan.cli.version,
                  ),
                };
    return {
      status: state.status,
      currentStep: state.currentStep,
      blocker,
      runtime: {
        packageName: RESEARCH_PACKAGE_NAME,
        packageVersion: plan.cli.version,
        source: runtimeSource,
      },
      next,
    };
  } catch {
    return null;
  }
}

async function readSetupStateSummary(control: string): Promise<{
  status: NonNullable<ContextInspection["setup"]>["status"];
  currentStep: string | null;
  lastError: NonNullable<ContextInspection["setup"]>["blocker"];
}> {
  const statePath = join(control, "setup-state.json");
  if (!(await pathExists(statePath))) {
    return { status: "pending", currentStep: null, lastError: null };
  }
  const state = await readJsonFile<unknown>(statePath, "Research setup state");
  if (
    !isObject(state) ||
    !["pending", "applying", "partially-ready", "ready", "blocked"].includes(String(state.status))
  ) {
    return { status: "pending", currentStep: null, lastError: null };
  }
  const lastError = isSetupBlocker(state.lastError) ? state.lastError : null;
  return {
    status: state.status as NonNullable<ContextInspection["setup"]>["status"],
    currentStep: typeof state.currentStep === "string" ? state.currentStep : null,
    lastError,
  };
}

async function hasMatchingRuntimeLock(control: string, version: string): Promise<boolean> {
  const path = join(control, "runtime-lock.json");
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  const lock = await readJsonFile<unknown>(path, "Research runtime lock").catch(() => null);
  return (
    isObject(lock) &&
    lock.schemaVersion === 1 &&
    lock.packageName === RESEARCH_PACKAGE_NAME &&
    lock.packageVersion === version
  );
}

function isSetupBlocker(
  value: unknown,
): value is NonNullable<NonNullable<ContextInspection["setup"]>["blocker"]> {
  return (
    isObject(value) &&
    typeof value.code === "string" &&
    typeof value.step === "string" &&
    typeof value.reason === "string" &&
    typeof value.minimumAction === "string" &&
    typeof value.retryCommand === "string" &&
    (value.diagnostics === undefined || isObject(value.diagnostics))
  );
}

export function isWorkspaceMarker(value: unknown): value is WorkspaceMarker {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    value.kind === "tiangong-research-workspace" &&
    typeof value.workspaceId === "string" &&
    value.workspaceId.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.createdAt === "string" &&
    value.createdAt.length > 0
  );
}

function invalidMarker(selectedPath: string, root: string, message: string): ContextInspection {
  return {
    role: "invalid",
    selectedPath,
    root,
    allowedOperations: [...INVALID_OPERATIONS],
    violations: [{ code: "WORKSPACE_MARKER_INVALID", message }],
  };
}
