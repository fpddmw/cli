import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import { readVerifiedJournal } from "./journal.js";
import { isObject, workspacePaths } from "./storage.js";
import type { JournalEvent, ProjectState } from "./types.js";

export interface ProjectAuthorityIndex {
  forks: Map<string, JournalEvent>;
  addenda: Set<string>;
  successors: Map<string, string>;
  pendingTargets: Set<string>;
  registered: Set<string>;
}

/** One verified journal view per inspection/admission, never a per-project artifact scan. */
export async function readProjectAuthorityIndex(root: string): Promise<ProjectAuthorityIndex> {
  return projectAuthorityIndex(await readVerifiedJournal(workspacePaths(root).journal));
}

export function projectAuthorityIndex(events: JournalEvent[]): ProjectAuthorityIndex {
  const result: ProjectAuthorityIndex = {
    forks: new Map(),
    addenda: new Set(),
    successors: new Map(),
    pendingTargets: new Set(),
    registered: new Set(),
  };
  const pending = new Map<string, string>();
  for (const event of events) {
    if (event.type === "project.initialized") result.registered.add(event.scope);
    if (
      event.type === "project.mutation.started" &&
      event.payload.kind === "fork" &&
      typeof event.payload.operationId === "string" &&
      typeof event.payload.targetProjectId === "string"
    ) {
      pending.set(event.payload.operationId, event.payload.targetProjectId);
    }
    if (
      event.type === "project.mutation.aborted" &&
      typeof event.payload.operationId === "string"
    ) {
      pending.delete(event.payload.operationId);
    }
    if (event.type !== "project.forked" && event.type !== "project.addendum.created") continue;
    const source = event.payload.sourceProjectId;
    const target = event.payload.targetProjectId;
    if (typeof source !== "string" || typeof target !== "string" || event.scope !== target)
      continue;
    result.registered.add(target);
    result.successors.set(source, target);
    if (event.type === "project.forked") result.forks.set(target, event);
    else result.addenda.add(target);
    if (
      isObject(event.payload.mutation) &&
      typeof event.payload.mutation.operationId === "string"
    ) {
      pending.delete(event.payload.mutation.operationId);
    }
  }
  for (const target of pending.values()) {
    if (!result.registered.has(target)) result.pendingTargets.add(target);
  }
  return result;
}

export function projectAuthority(
  project: ProjectState,
  index: ProjectAuthorityIndex,
): {
  state: "authoritative" | "superseded" | "archived" | "abandoned" | "invalid";
  projectId: string;
} {
  if (
    (project.lineage.kind === "fork" && !index.forks.has(project.id)) ||
    (project.lineage.kind === "addendum" && !index.addenda.has(project.id))
  ) {
    return { state: "invalid", projectId: project.id };
  }
  let current = project.id;
  const visited = new Set<string>();
  while (index.successors.has(current)) {
    if (visited.has(current)) return { state: "invalid", projectId: project.id };
    visited.add(current);
    current = index.successors.get(current)!;
  }
  if (project.status === "archived" || project.status === "abandoned") {
    return { state: project.status, projectId: current };
  }
  return { state: current === project.id ? "authoritative" : "superseded", projectId: current };
}

export function assertProjectAuthority(project: ProjectState, index: ProjectAuthorityIndex): void {
  const authority = projectAuthority(project, index);
  if (authority.state !== "authoritative") {
    throw new CliError("Research project is not a committed authoritative project.", {
      code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE",
      exitCode: 3,
      details: {
        projectId: project.id,
        authority: authority.state,
        authoritativeProjectId: authority.projectId,
      },
    });
  }
}

/** Mutable files mirror the journal; ignore only uncommitted derived supersession. */
export function projectWithEffectiveAuthority(
  project: ProjectState,
  index: ProjectAuthorityIndex,
): ProjectState {
  const next = index.successors.get(project.id) ?? null;
  if (project.lineage.supersededBy === next) return project;
  const result = structuredClone(project);
  const old = result.lineage.supersededBy;
  result.lineage.supersededBy = next;
  if (next) {
    result.evidenceState.staleReason = "Superseded by committed project " + next + ".";
    if (result.status !== "archived" && result.status !== "abandoned") result.status = "stale";
  } else if (
    old &&
    [
      "Superseded by recovery fork " + old + ".",
      "Superseded by evidence addendum " + old + ".",
    ].includes(result.evidenceState.staleReason ?? "")
  ) {
    result.evidenceState.staleReason = null;
  }
  return result;
}

export async function visibleProjectIds(
  root: string,
  index: ProjectAuthorityIndex,
): Promise<string[]> {
  const paths = workspacePaths(root);
  const entries = await readdir(paths.projects, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || index.pendingTargets.has(entry.name))
      continue;
    const info = await lstat(join(paths.projects, entry.name, "project.json")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    // A never-committed directory is not a project. Do not hide damage to a committed one.
    if (!info && !index.registered.has(entry.name)) continue;
    result.push(entry.name);
  }
  return result;
}
