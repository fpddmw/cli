import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import {
  computeSnapshotCoverage,
  inputCanProvideReadableArtifact,
  materializeAcquisitionAudit,
  projectAcquisitionSources,
} from "./acquisition.js";
import { loadBoundAcquisitionDesign } from "./acquisition-routes.js";
import { verifyEvidenceLedger } from "./evidence-ledger.js";
import { computeRoleCoverage, type EvidenceRoleRequirement } from "./evidence-role-coverage.js";
import { loadProject } from "./projects.js";
import { configuredResearchSecrets, sanitizeResearchValue } from "./sanitization.js";
import { parseEvidenceRecord, parseStructuredStageOutput } from "./schemas.js";
import { canonicalJson, isObject, sha256File, sha256Text, workspacePaths } from "./storage.js";

/** Optimistic eligibility only: source metadata cannot prove actual atom assignments. */
export function forecastRoleEligibility(
  roles: EvidenceRoleRequirement[],
  sources: Array<Record<string, unknown>>,
) {
  const dimensionRoles = new Map<string, Set<string>>();
  for (const role of roles.filter((item) => item.required)) {
    for (const dimension of role.coverageDimensionIds) {
      const ids = dimensionRoles.get(dimension) ?? new Set<string>();
      ids.add(role.id);
      dimensionRoles.set(dimension, ids);
    }
  }
  // Projection derives this from verified readable artifacts or a hash-verified
  // full-input source that will be materialized at submit. Metadata-only and
  // unparsed binary files cannot supply atoms merely by sharing a dimension.
  const potentialAtoms = sources
    .filter((source) => source.fullTextAvailable === true)
    .map((source) => {
      const dimensions = Array.isArray(source.coverageDimensions)
        ? source.coverageDimensions.filter((item): item is string => typeof item === "string")
        : [];
      return {
        sourceId: String(source.id),
        coverageDimensionIds: dimensions,
        evidenceRoleIds: [
          ...new Set(dimensions.flatMap((dimension) => [...(dimensionRoles.get(dimension) ?? [])])),
        ],
      };
    });
  return computeRoleCoverage(roles, sources, potentialAtoms).map(({ decision, ...coverage }) => ({
    ...coverage,
    eligibility:
      decision === "pass" ? ("potentially-sufficient" as const) : ("insufficient" as const),
  }));
}

export async function inspectAcquisitionForecast(
  root: string,
  projectId: string,
  value: Record<string, unknown>,
) {
  const parsed = parseStructuredStageOutput("acquire", JSON.stringify(value));
  const project = await loadProject(root, projectId);
  if (project.packages.find((item) => item.stage === "discover")?.status !== "complete") {
    throw new CliError("Acquisition forecast requires completed discovery.", {
      code: "RESEARCH_ACQUISITION_FORECAST_UNAVAILABLE",
      exitCode: 3,
    });
  }
  const evidencePath = join(workspacePaths(root).projects, projectId, "outputs/evidence.json");
  const [evidenceBytes, ledger] = await Promise.all([
    readFile(evidencePath, "utf8"),
    verifyEvidenceLedger(root, projectId),
  ]);
  const evidence = parseEvidenceRecord(evidenceBytes);
  const audit = await materializeAcquisitionAudit(root, project, parsed.value, { readOnly: true });
  // Accepted input hashes were already verified by materializeAcquisitionAudit.
  // Reuse registration's media classification; do not reread large files.
  const inputsById = new Map(project.inputs.map((input) => [input.id, input]));
  const inputReadability = new Map<string, boolean>();
  for (const source of evidence.sources as Array<Record<string, unknown>>) {
    const provenance = isObject(source.provenance) ? source.provenance : {};
    if (provenance.kind !== "input") continue;
    const input = inputsById.get(String(provenance.id));
    inputReadability.set(
      String(source.id),
      Boolean(input && inputCanProvideReadableArtifact(input)),
    );
  }
  const sources = projectAcquisitionSources(
    evidence.sources as Array<Record<string, unknown>>,
    audit,
    inputReadability,
  );
  const coverage = computeSnapshotCoverage(
    project,
    sources,
    isObject(evidence.coverage) ? evidence.coverage : {},
  );
  const design = project.scientificDesign ? await loadBoundAcquisitionDesign(root, project) : null;
  const roleEligibility = forecastRoleEligibility(design?.evidenceRoles ?? [], sources);
  const acquisitionReasons = [...new Set([...audit.gaps, ...coverage.gaps])];
  const decisions = new Map(audit.decisions.map((decision) => [decision.sourceId, decision]));
  const sourceRecords = new Map(
    (evidence.sources as Array<Record<string, unknown>>).map((source) => [
      String(source.id),
      source,
    ]),
  );
  const submissionBlockers = sources
    .filter(
      (source) =>
        decisions.get(String(source.id))?.status === "accepted" &&
        sourceRecords.get(String(source.id))?.fullTextAvailable === true &&
        source.fullTextAvailable !== true,
    )
    .map((source) => ({ code: "RESEARCH_INPUT_ATOMIZATION_REQUIRED", sourceId: source.id }));
  // A read-only inspection has no lease mutations. Refuse a mixed concurrent view.
  const [latestLedger, latestProject, latestEvidenceHash] = await Promise.all([
    verifyEvidenceLedger(root, projectId),
    loadProject(root, projectId),
    sha256File(evidencePath),
  ]);
  if (
    ledger.head !== latestLedger.head ||
    canonicalJson(project) !== canonicalJson(latestProject) ||
    latestEvidenceHash !== sha256Text(evidenceBytes)
  ) {
    throw new CliError("Acquisition changed during forecast; rerun the read-only inspection.", {
      code: "RESEARCH_ACQUISITION_FORECAST_DRIFT",
      exitCode: 3,
    });
  }
  return sanitizeResearchValue(
    {
      schemaVersion: 1,
      kind: "tiangong-acquisition-forecast",
      projectId,
      auditSha256: sha256Text(canonicalJson(value)),
      evidenceSha256: latestEvidenceHash,
      designSha256: project.scientificDesign?.designSha256 ?? null,
      ledgerHead: ledger.head,
      certifiesContentGate: false,
      certifiesAcquisitionSubmission: false,
      submissionGate: {
        decision: submissionBlockers.length ? "stop" : "potentially-ready",
        blockers: submissionBlockers,
      },
      acquisitionGate: {
        decision: acquisitionReasons.length ? "stop" : "pass",
        reasons: acquisitionReasons,
      },
      coverage,
      roleEligibility,
      knownRoleDeficits: roleEligibility.flatMap((role) => role.gaps),
      sourcesNeedingReadableArtifacts: sources
        .filter((source) => source.fullTextAvailable !== true)
        .map((source) => ({
          sourceId: source.id,
          sourceType: source.sourceType,
          artifactIds: source.artifactIds,
          producerContextLevel: source.producerContextLevel,
        })),
      pendingChecks: [
        "Register or materialize exact readable artifacts before acquisition commits.",
        "Decompose acquired containers, assign exact evidence atoms to roles, and freeze typed content after acquisition.",
        "Potential eligibility is not evidence support, independence certification, or an independent-review pass.",
      ],
      pendingInputArtifactSourceIds: audit.decisions
        .filter((decision) => decision.status === "accepted" && !decision.artifactIds.length)
        .map((decision) => decision.sourceId),
      limitations: audit.limitations,
      recovery:
        "Before submission, repair exact submission blockers or retain an honest limited/stopped audit. After completed acquisition and before analysis, use evidence acquisition revise with the exact current snapshot hash; retain the existing fork/new-generation path for changed design or post-analysis work.",
    },
    configuredResearchSecrets(process.env),
  ) as {
    acquisitionGate: { decision: "pass" | "stop" };
    submissionGate: { decision: "stop" | "potentially-ready" };
    knownRoleDeficits: string[];
  } & Record<string, unknown>;
}
