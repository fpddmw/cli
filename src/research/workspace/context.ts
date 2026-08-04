import { lstat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import {
  INVALID_OPERATIONS,
  RESEARCH_CONTROL_DIRECTORY,
  UNMANAGED_OPERATIONS,
  WORKSPACE_OPERATIONS,
} from "./constants.js";
import { isObject, pathExists, readJsonFile } from "./storage.js";
import type { ContextInspection, WorkspaceMarker } from "./types.js";

export async function inspectResearchContext(selectedPath: string): Promise<ContextInspection> {
  const canonical = resolve(selectedPath);
  const info = await lstat(canonical).catch(() => undefined);
  let cursor = info?.isFile() ? dirname(canonical) : canonical;

  while (true) {
    const control = join(cursor, RESEARCH_CONTROL_DIRECTORY);
    if (await pathExists(control)) {
      const markerPath = join(control, "workspace.json");
      if (!(await pathExists(markerPath))) {
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
