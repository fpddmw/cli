import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import {
  computeSnapshotCoverage,
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
  const potentialAtoms = sources.map((source) => {
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
  const sources = projectAcquisitionSources(
    evidence.sources as Array<Record<string, unknown>>,
    audit,
  );
  const coverage = computeSnapshotCoverage(
    project,
    sources,
    isObject(evidence.coverage) ? evidence.coverage : {},
  );
  const design = project.scientificDesign ? await loadBoundAcquisitionDesign(root, project) : null;
  const roleEligibility = forecastRoleEligibility(design?.evidenceRoles ?? [], sources);
  const acquisitionReasons = [...new Set([...audit.gaps, ...coverage.gaps])];
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
      acquisitionGate: {
        decision: acquisitionReasons.length ? "stop" : "pass",
        reasons: acquisitionReasons,
      },
      coverage,
      roleEligibility,
      knownRoleDeficits: roleEligibility.flatMap((role) => role.gaps),
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
        "Before submission, repair known deficits or retain an honest stopped audit. After completed acquisition, use project fork --resume-through discover to reuse verified discovery and artifacts; top-journal targets still require their own approved Policy/design.",
    },
    configuredResearchSecrets(process.env),
  ) as {
    acquisitionGate: { decision: "pass" | "stop" };
    knownRoleDeficits: string[];
  } & Record<string, unknown>;
}
