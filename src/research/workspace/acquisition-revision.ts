import { join } from "node:path";

import { CliError } from "../../errors.js";
import { loadCurrentEvidenceSnapshot } from "./acquisition.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import { assertProjectAuthority, projectAuthorityIndex } from "./project-authority.js";
import {
  beginProjectMutation,
  prepareProjectMutation,
  projectMutationBinding,
  settleProjectMutation,
} from "./project-mutations.js";
import { loadProject } from "./projects.js";
import { configuredResearchSecrets, sanitizeResearchText } from "./sanitization.js";
import { canonicalJson, isObject, pathExists, sha256Text, workspacePaths } from "./storage.js";
import { withWorkspaceLock } from "./workspace.js";

/** Reopen only acquisition; scientific-design changes still require a new generation. */
export async function reviseProjectAcquisition(input: {
  root: string;
  projectId: string;
  expectedSnapshotSha256: string;
  reason: string;
}) {
  const reason = input.reason.trim();
  if (
    !/^[a-f0-9]{64}$/.test(input.expectedSnapshotSha256) ||
    reason.length < 8 ||
    reason.length > 2000 ||
    sanitizeResearchText(reason, configuredResearchSecrets(process.env)) !== reason
  ) {
    throw new CliError(
      "Acquisition revision requires an exact snapshot SHA-256 and a safe 8-2000 character reason.",
      {
        code: "RESEARCH_ACQUISITION_REVISION_INVALID",
        exitCode: 2,
      },
    );
  }
  return withWorkspaceLock(input.root, "research.acquisition.revise", async () => {
    const paths = workspacePaths(input.root);
    const project = await loadProject(input.root, input.projectId);
    const events = await readVerifiedJournal(paths.journal);
    assertProjectAuthority(project, projectAuthorityIndex(events));
    const requestSha256 = sha256Text(
      canonicalJson({
        projectId: project.id,
        expectedSnapshotSha256: input.expectedSnapshotSha256,
        reason,
      }),
    );
    const prior = events.findLast(
      (event) =>
        event.scope === project.id &&
        event.type === "project.acquisition.revision.requested" &&
        event.payload.parentSnapshotSha256 === input.expectedSnapshotSha256,
    );
    if (prior) {
      if (
        !isObject(prior.payload.mutation) ||
        prior.payload.mutation.requestSha256 !== requestSha256
      ) {
        throw conflict();
      }
      return {
        projectId: project.id,
        parentSnapshotSha256: input.expectedSnapshotSha256,
        operationId: prior.payload.mutation.operationId,
        replayed: true,
      };
    }
    if (project.evidenceState.currentSnapshotSha256 !== input.expectedSnapshotSha256)
      throw conflict();
    const acquireIndex = project.packages.findIndex((item) => item.stage === "acquire");
    const acquire = project.packages[acquireIndex];
    const projectRoot = join(paths.projects, project.id);
    if (
      !acquire ||
      acquire.status !== "complete" ||
      project.handoff.state !== "agent-actionable" ||
      project.status === "complete" ||
      project.packages
        .slice(acquireIndex + 1)
        .some(
          (item) =>
            item.attempts > 0 ||
            item.startedAt !== null ||
            !["pending", "ready"].includes(item.status),
        ) ||
      (await pathExists(join(projectRoot, "native", "active.json"))) ||
      (await pathExists(join(projectRoot, "outputs", "inference-snapshot.json")))
    ) {
      throw new CliError(
        "Acquisition can be revised only before analysis, without an active session or unresolved handoff. Use the existing abort, handoff or new-generation workflow as appropriate.",
        {
          code: "RESEARCH_ACQUISITION_REVISION_UNAVAILABLE",
          exitCode: 3,
        },
      );
    }
    const snapshot = await loadCurrentEvidenceSnapshot(input.root, project.id);
    if (snapshot.snapshotSha256 !== input.expectedSnapshotSha256) throw conflict();
    if (
      [snapshot.evidenceRecord, snapshot.acquisitionRecord].some(
        (record) => record.path !== `evidence/records/${record.sha256}.json`,
      )
    ) {
      throw new CliError(
        "This snapshot predates immutable acquisition records. Preserve it and use the existing new-generation recovery path; in-place migration is not supported.",
        {
          code: "RESEARCH_ACQUISITION_REVISION_UNAVAILABLE",
          exitCode: 3,
        },
      );
    }
    let mutation = await beginProjectMutation(
      input.root,
      "acquisition-revision",
      project,
      requestSha256,
    );
    try {
      for (const [index, item] of project.packages.entries()) {
        if (index < acquireIndex) continue;
        item.status = index === acquireIndex ? "ready" : "pending";
        if (index === acquireIndex)
          item.maxAttempts = Math.max(item.maxAttempts, item.attempts + 1);
        item.startedAt = null;
        item.completedAt = null;
        item.lastError = null;
        item.lastFailureKind = null;
        item.retryNotBefore = null;
      }
      if (project.scientificDesign) {
        for (const role of ["evidence-construct", "pilot-methods"] as const) {
          project.scientificDesign.gates[role] = {
            status: "pending",
            packetSha256: null,
            assessmentSha256: null,
            reviewSha256: null,
            reviewerSessionSha256: null,
          };
        }
      }
      project.status = "ready";
      project.updatedAt = new Date().toISOString();
      mutation = await prepareProjectMutation(input.root, mutation, project);
      await appendJournalEvent(
        paths.journal,
        "project.acquisition.revision.requested",
        project.id,
        {
          projectId: project.id,
          parentSnapshotId: snapshot.snapshotId,
          parentSnapshotSha256: snapshot.snapshotSha256,
          reasonSha256: sha256Text(reason),
          preservedArtifacts: snapshot.artifacts.length,
          invalidatedScientificRoles: project.scientificDesign
            ? ["evidence-construct", "pilot-methods"]
            : [],
          mutation: projectMutationBinding(mutation),
        },
      );
      await settleProjectMutation(input.root, mutation);
    } catch (error) {
      if (!(await settleProjectMutation(input.root, mutation))) throw error;
    }
    return {
      projectId: project.id,
      parentSnapshotSha256: snapshot.snapshotSha256,
      operationId: mutation.identity.operationId,
      replayed: false,
    };
  });
}

function conflict(): CliError {
  return new CliError(
    "Acquisition revision does not match the current snapshot or its committed request. Inspect status and use the exact intended parent; do not retry against an assumed latest version.",
    {
      code: "RESEARCH_ACQUISITION_REVISION_CONFLICT",
      exitCode: 3,
    },
  );
}
