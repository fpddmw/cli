import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  projectAuthority,
  projectAuthorityIndex,
  projectWithEffectiveAuthority,
} from "../src/research/workspace/project-authority.js";
import type { JournalEvent, ProjectState } from "../src/research/workspace/types.js";

function event(type: string, scope: string, payload: Record<string, unknown>): JournalEvent {
  return {
    schemaVersion: 1,
    sequence: 1,
    timestamp: "2026-09-02T00:00:00.000Z",
    type,
    scope,
    payload,
    previousHash: "0".repeat(64),
    hash: "1".repeat(64),
  };
}

function project(id: string, parent: string | null = null): ProjectState {
  // The pure authority projection reads identity/disposition only, not evidence.
  return {
    id,
    status: "ready",
    lineage: {
      kind: parent ? "fork" : "primary",
      derivedFrom: parent,
      supersedes: parent,
      supersededBy: null,
      baseSnapshotId: null,
      baseSnapshotSha256: null,
    },
    evidenceState: {
      currentSnapshotId: null,
      currentSnapshotSha256: null,
      closureSnapshotId: null,
      staleReason: null,
    },
  } as ProjectState;
}

describe("operation-local project authority index", () => {
  it("resolves a long history with linear successor lookups across repeated queries", () => {
    const count = 400;
    const records = Array.from({ length: count - 1 }, (_, i) =>
      event("project.forked", "node-" + (i + 1), {
        sourceProjectId: "node-" + i,
        targetProjectId: "node-" + (i + 1),
      }),
    );
    const index = projectAuthorityIndex(records);
    const get = index.successors.get.bind(index.successors);
    let lookups = 0;
    index.successors.get = (key) => {
      lookups += 1;
      return get(key);
    };
    for (let i = 0; i < count; i += 1) {
      const state = project("node-" + i, i ? "node-" + (i - 1) : null);
      for (let repeat = 0; repeat < 3; repeat += 1) {
        assert.equal(projectAuthority(state, index).projectId, "node-" + (count - 1));
      }
    }
    assert.ok(
      lookups <= count * 3,
      "A verified history must not be walked again for every project.",
    );
  });

  it("does not authenticate a committed target whose parent identity was replaced", () => {
    const index = projectAuthorityIndex([
      event("project.forked", "target", {
        sourceProjectId: "source",
        targetProjectId: "target",
      }),
    ]);
    assert.equal(projectAuthority(project("target", "other-parent"), index).state, "invalid");
  });

  it("keeps interrupted targets private and rejects cyclic authoritative lineage", () => {
    const index = projectAuthorityIndex([
      event("project.initialized", "source", {}),
      event("project.mutation.started", "source", {
        kind: "fork",
        operationId: "attempt-one",
        targetProjectId: "target",
      }),
    ]);
    assert.deepEqual([...index.pendingTargets], ["target"]);
    assert.equal(projectAuthority(project("source"), index).state, "authoritative");
    assert.equal(projectAuthority(project("target", "source"), index).state, "invalid");
    const cycle = projectAuthorityIndex([
      event("project.forked", "node-b", { sourceProjectId: "node-a", targetProjectId: "node-b" }),
      event("project.forked", "node-a", { sourceProjectId: "node-b", targetProjectId: "node-a" }),
    ]);
    assert.equal(projectAuthority(project("node-a", "node-b"), cycle).state, "invalid");
  });

  it("does not clear independent evidence staleness when projecting an interrupted fork", () => {
    const state = project("source");
    state.lineage.supersededBy = "uncommitted";
    state.evidenceState.staleReason = "Independent artifact drift.";
    const view = projectWithEffectiveAuthority(state, projectAuthorityIndex([]));
    assert.equal(view.lineage.supersededBy, null);
    assert.equal(view.evidenceState.staleReason, "Independent artifact drift.");
    assert.equal(state.lineage.supersededBy, "uncommitted");
  });
});
