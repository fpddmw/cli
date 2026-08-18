import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CliError } from "../../errors.js";
import { loadBoundAcquisitionDesign } from "./acquisition-routes.js";
import { loadCurrentEvidenceSnapshot } from "./acquisition.js";
import { loadCurrentEvidenceContentSnapshot, type EvidenceAtomRecord } from "./content-evidence.js";
import { appendEvidenceLedgerEvent, evidenceLedgerPath } from "./evidence-ledger.js";
import { readJournal } from "./journal.js";
import { loadProject } from "./projects.js";
import {
  canonicalJson,
  ensureDirectory,
  isObject,
  pathExists,
  resolveContained,
  sha256File,
  sha256Text,
  workspacePaths,
  writeTextAtomic,
} from "./storage.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface InferenceSnapshot {
  schemaVersion: 1;
  kind: "tiangong-inference-snapshot";
  snapshotId: string;
  snapshotSha256: string;
  projectId: string;
  createdAt: string;
  ledgerHead: string;
  acquisitionSnapshot: { snapshotId: string; snapshotSha256: string };
  contentSnapshot: { snapshotId: string; snapshotSha256: string } | null;
  scientificReview: {
    designSha256: string;
    packetSha256: string;
    assessmentSha256: string;
    reviewSha256: string;
  } | null;
  policySha256: string | null;
  sources: Array<{
    id: string;
    title: string;
    sourceType: string | null;
    publicationDate: string | null;
    acquisitionStatus: string | null;
  }>;
  atoms: EvidenceAtomRecord[];
  claims: Array<Record<string, unknown>>;
  designEdges: Array<Record<string, unknown>>;
  artifactSha256s: string[];
  implementationArtifactSha256s: string[];
  environmentLockSha256s: string[];
  gate: { decision: "pass"; reasons: [] };
}

export interface ClaimEvidenceGraph {
  schemaVersion: 1;
  kind: "tiangong-claim-evidence-graph";
  graphId: string;
  graphSha256: string;
  projectId: string;
  createdAt: string;
  inferenceSnapshotSha256: string;
  analysisSha256: string;
  analysisRunId: string;
  nodes: Array<{
    id: string;
    type: "source" | "atom" | "design-claim" | "finding" | "analysis-run";
    label: string;
    sha256: string | null;
  }>;
  edges: Array<{
    id: string;
    type:
      | "finding-supported-by-atom"
      | "atom-derived-from-source"
      | "finding-addresses-design-claim"
      | "finding-produced-by-analysis-run";
    from: string;
    to: string;
  }>;
}

export async function freezeInferenceSnapshot(
  root: string,
  projectId: string,
): Promise<InferenceSnapshot> {
  const currentPath = join(
    workspacePaths(root).projects,
    projectId,
    "outputs",
    "inference-snapshot.json",
  );
  if (await pathExists(currentPath)) {
    const current = await loadCurrentInferenceSnapshot(root, projectId).catch(() => null);
    if (current) return current;
  }
  const [project, acquisition, ledgerEvents] = await Promise.all([
    loadProject(root, projectId),
    loadCurrentEvidenceSnapshot(root, projectId),
    readJournal(evidenceLedgerPath(root, projectId)),
  ]);
  if (acquisition.inferenceGate.decision !== "pass") {
    throw inferenceBlocked(acquisition.inferenceGate.reasons);
  }
  const contentPath = join(
    workspacePaths(root).projects,
    projectId,
    "outputs",
    "content-snapshot.json",
  );
  const content = (await pathExists(contentPath))
    ? await loadCurrentEvidenceContentSnapshot(root, projectId)
    : null;
  if (project.scientificDesign && !content) {
    throw inferenceError(
      "Top-journal inference requires a frozen typed-content snapshot.",
      "RESEARCH_EVIDENCE_CONTENT_SNAPSHOT_REQUIRED",
    );
  }
  if (content?.gate.decision === "stop") throw inferenceBlocked(content.gate.reasons);
  let scientificReview: InferenceSnapshot["scientificReview"] = null;
  let claims: Array<Record<string, unknown>> = [];
  let designEdges: Array<Record<string, unknown>> = [];
  let implementationArtifactSha256s: string[] = [];
  let environmentLockSha256s: string[] = [];
  if (project.scientificDesign) {
    const gate = project.scientificDesign.gates["evidence-construct"];
    if (
      gate.status !== "passed" ||
      !gate.packetSha256 ||
      !gate.assessmentSha256 ||
      !gate.reviewSha256
    ) {
      throw inferenceError(
        "Top-journal inference requires a passing evidence-construct review.",
        "RESEARCH_SCIENTIFIC_GATE_REQUIRED",
      );
    }
    const design = await loadBoundAcquisitionDesign(root, project);
    scientificReview = {
      designSha256: project.scientificDesign.designSha256,
      packetSha256: gate.packetSha256,
      assessmentSha256: gate.assessmentSha256,
      reviewSha256: gate.reviewSha256,
    };
    claims = design.claims as Array<Record<string, unknown>>;
    designEdges = design.edges as Array<Record<string, unknown>>;
    implementationArtifactSha256s = sortedUnique(
      design.identity.modelStructures.map((model) => model.implementationArtifactSha256),
    );
    environmentLockSha256s = sortedUnique(
      design.identity.modelStructures.map((model) => model.environmentLockSha256),
    );
  }
  const core = {
    schemaVersion: 1 as const,
    kind: "tiangong-inference-snapshot" as const,
    projectId,
    createdAt: new Date().toISOString(),
    ledgerHead: ledgerEvents.at(-1)?.hash ?? "0".repeat(64),
    acquisitionSnapshot: {
      snapshotId: acquisition.snapshotId,
      snapshotSha256: acquisition.snapshotSha256,
    },
    contentSnapshot: content
      ? { snapshotId: content.snapshotId, snapshotSha256: content.snapshotSha256 }
      : null,
    scientificReview,
    policySha256: project.publicationPolicy?.resolvedPolicySha256 ?? null,
    sources: acquisition.sources.map((source) => ({
      id: String(source.id),
      title: typeof source.title === "string" ? source.title : String(source.id),
      sourceType: typeof source.sourceType === "string" ? source.sourceType : null,
      publicationDate: typeof source.publicationDate === "string" ? source.publicationDate : null,
      acquisitionStatus:
        typeof source.acquisitionStatus === "string" ? source.acquisitionStatus : null,
    })),
    atoms: content?.atoms ?? [],
    claims,
    designEdges,
    artifactSha256s: sortedUnique(acquisition.artifacts.map((artifact) => artifact.sha256)),
    implementationArtifactSha256s,
    environmentLockSha256s,
    gate: { decision: "pass" as const, reasons: [] as [] },
  };
  const snapshotId = `inference-snapshot-${sha256Text(canonicalJson(core)).slice(0, 24)}`;
  const withoutHash = { ...core, snapshotId };
  const snapshot: InferenceSnapshot = {
    ...withoutHash,
    snapshotSha256: sha256Text(canonicalJson(withoutHash)),
  };
  const projectRoot = join(workspacePaths(root).projects, projectId);
  const logicalPath = `evidence/inference-snapshots/${snapshot.snapshotSha256}.json`;
  await persistSnapshot(root, projectId, logicalPath, snapshot);
  await writeTextAtomic(currentPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await appendEvidenceLedgerEvent(root, projectId, "inference.snapshot.frozen", {
    snapshotId,
    snapshotSha256: snapshot.snapshotSha256,
    acquisitionSnapshotSha256: snapshot.acquisitionSnapshot.snapshotSha256,
    contentSnapshotSha256: snapshot.contentSnapshot?.snapshotSha256 ?? null,
    scientificReview: snapshot.scientificReview,
    path: logicalPath,
    atomCount: snapshot.atoms.length,
    claimCount: snapshot.claims.length,
  });
  return snapshot;
}

export async function loadCurrentInferenceSnapshot(
  root: string,
  projectId: string,
): Promise<InferenceSnapshot> {
  const projectRoot = join(workspacePaths(root).projects, projectId);
  const currentPath = join(projectRoot, "outputs", "inference-snapshot.json");
  if (!(await pathExists(currentPath))) {
    throw inferenceError(
      "Inference snapshot has not been frozen.",
      "RESEARCH_INFERENCE_SNAPSHOT_REQUIRED",
    );
  }
  const snapshot = parseInferenceSnapshot(JSON.parse(await readFile(currentPath, "utf8")));
  const { snapshotSha256, ...withoutHash } = snapshot;
  if (sha256Text(canonicalJson(withoutHash)) !== snapshotSha256) {
    throw inferenceError(
      "Inference snapshot hash binding is invalid.",
      "RESEARCH_INFERENCE_SNAPSHOT_INVALID",
    );
  }
  const immutablePath = resolveContained(
    projectRoot,
    `evidence/inference-snapshots/${snapshotSha256}.json`,
  );
  if (
    !(await pathExists(immutablePath)) ||
    (await sha256File(immutablePath)) !== (await sha256File(currentPath))
  ) {
    throw inferenceError(
      "Inference snapshot is not bound to its immutable copy.",
      "RESEARCH_INFERENCE_SNAPSHOT_INVALID",
    );
  }
  const acquisition = await loadCurrentEvidenceSnapshot(root, projectId);
  if (
    acquisition.snapshotId !== snapshot.acquisitionSnapshot.snapshotId ||
    acquisition.snapshotSha256 !== snapshot.acquisitionSnapshot.snapshotSha256
  ) {
    throw inferenceError(
      "Inference snapshot acquisition binding is stale.",
      "RESEARCH_INFERENCE_SNAPSHOT_STALE",
    );
  }
  if (snapshot.contentSnapshot) {
    const content = await loadCurrentEvidenceContentSnapshot(root, projectId);
    if (
      content.snapshotId !== snapshot.contentSnapshot.snapshotId ||
      content.snapshotSha256 !== snapshot.contentSnapshot.snapshotSha256
    ) {
      throw inferenceError(
        "Inference snapshot content binding is stale.",
        "RESEARCH_INFERENCE_SNAPSHOT_STALE",
      );
    }
  }
  const project = await loadProject(root, projectId);
  if (
    snapshot.scientificReview &&
    (project.scientificDesign?.designSha256 !== snapshot.scientificReview.designSha256 ||
      project.scientificDesign.gates["evidence-construct"].reviewSha256 !==
        snapshot.scientificReview.reviewSha256)
  ) {
    throw inferenceError(
      "Inference snapshot scientific-review binding is stale.",
      "RESEARCH_INFERENCE_SNAPSHOT_STALE",
    );
  }
  return snapshot;
}

export async function freezeClaimEvidenceGraph(
  root: string,
  projectId: string,
  analysis: Record<string, unknown>,
): Promise<ClaimEvidenceGraph> {
  const inference = await loadCurrentInferenceSnapshot(root, projectId);
  const findings = analysis.findings as Array<Record<string, unknown>>;
  const analysisRun = analysis.analysisRun as Record<string, unknown>;
  const atomById = new Map(inference.atoms.map((atom) => [atom.atomId, atom]));
  const sourceById = new Map(inference.sources.map((source) => [source.id, source]));
  const claimById = new Map(
    inference.claims.flatMap((claim) =>
      typeof claim.id === "string" ? [[claim.id, claim] as const] : [],
    ),
  );
  const nodes = new Map<string, ClaimEvidenceGraph["nodes"][number]>();
  const edges = new Map<string, ClaimEvidenceGraph["edges"][number]>();
  const addNode = (node: ClaimEvidenceGraph["nodes"][number]) => nodes.set(node.id, node);
  const addEdge = (type: ClaimEvidenceGraph["edges"][number]["type"], from: string, to: string) => {
    const id = `edge-${sha256Text(`${type}:${from}:${to}`).slice(0, 24)}`;
    edges.set(id, { id, type, from, to });
  };
  const runId = String(analysisRun.id);
  addNode({ id: `analysis-run:${runId}`, type: "analysis-run", label: runId, sha256: null });
  for (const finding of findings) {
    const findingId = String(finding.id);
    const findingNodeId = `finding:${findingId}`;
    addNode({
      id: findingNodeId,
      type: "finding",
      label: String(finding.statement),
      sha256: sha256Text(canonicalJson(finding)),
    });
    addEdge("finding-produced-by-analysis-run", findingNodeId, `analysis-run:${runId}`);
    for (const atomId of finding.evidenceAtomIds as string[]) {
      const atom = atomById.get(atomId)!;
      const atomNodeId = `atom:${atomId}`;
      const sourceNodeId = `source:${atom.sourceId}`;
      addNode({ id: atomNodeId, type: "atom", label: atom.statement, sha256: atom.atomSha256 });
      addNode({
        id: sourceNodeId,
        type: "source",
        label: atom.sourceId,
        sha256: sourceById.has(atom.sourceId)
          ? sha256Text(canonicalJson(sourceById.get(atom.sourceId)))
          : null,
      });
      addEdge("finding-supported-by-atom", findingNodeId, atomNodeId);
      addEdge("atom-derived-from-source", atomNodeId, sourceNodeId);
    }
    for (const claimId of finding.claimIds as string[]) {
      const claim = claimById.get(claimId)!;
      const claimNodeId = `design-claim:${claimId}`;
      addNode({
        id: claimNodeId,
        type: "design-claim",
        label: typeof claim.statement === "string" ? claim.statement : claimId,
        sha256: sha256Text(canonicalJson(claim)),
      });
      addEdge("finding-addresses-design-claim", findingNodeId, claimNodeId);
    }
  }
  const analysisPath = join(workspacePaths(root).projects, projectId, "outputs", "analysis.json");
  const core = {
    schemaVersion: 1 as const,
    kind: "tiangong-claim-evidence-graph" as const,
    projectId,
    createdAt: new Date().toISOString(),
    inferenceSnapshotSha256: inference.snapshotSha256,
    analysisSha256: await sha256File(analysisPath),
    analysisRunId: runId,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
  const graphId = `claim-graph-${sha256Text(canonicalJson(core)).slice(0, 24)}`;
  const withoutHash = { ...core, graphId };
  const graph: ClaimEvidenceGraph = {
    ...withoutHash,
    graphSha256: sha256Text(canonicalJson(withoutHash)),
  };
  const projectRoot = join(workspacePaths(root).projects, projectId);
  const logicalPath = `evidence/claim-graphs/${graph.graphSha256}.json`;
  await persistSnapshot(root, projectId, logicalPath, graph);
  await writeTextAtomic(
    join(projectRoot, "outputs", "claim-evidence-graph.json"),
    `${JSON.stringify(graph, null, 2)}\n`,
  );
  await appendEvidenceLedgerEvent(root, projectId, "claim-graph.frozen", {
    graphId,
    graphSha256: graph.graphSha256,
    inferenceSnapshotSha256: graph.inferenceSnapshotSha256,
    analysisSha256: graph.analysisSha256,
    path: logicalPath,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  });
  return graph;
}

async function persistSnapshot(
  root: string,
  projectId: string,
  logicalPath: string,
  value: unknown,
): Promise<void> {
  const projectRoot = join(workspacePaths(root).projects, projectId);
  const destination = resolveContained(projectRoot, logicalPath);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (await pathExists(destination)) {
    if ((await sha256File(destination)) !== sha256Text(content)) {
      throw inferenceError(
        "Content-addressed inference object drifted.",
        "RESEARCH_INFERENCE_SNAPSHOT_INVALID",
      );
    }
    return;
  }
  await ensureDirectory(dirname(destination));
  await writeTextAtomic(destination, content, 0o444);
  await chmod(destination, 0o444).catch(() => undefined);
}

function parseInferenceSnapshot(value: unknown): InferenceSnapshot {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-inference-snapshot" ||
    typeof value.snapshotId !== "string" ||
    typeof value.snapshotSha256 !== "string" ||
    !SHA256.test(value.snapshotSha256) ||
    typeof value.projectId !== "string" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.ledgerHead !== "string" ||
    !SHA256.test(value.ledgerHead) ||
    !isObject(value.acquisitionSnapshot) ||
    typeof value.acquisitionSnapshot.snapshotId !== "string" ||
    typeof value.acquisitionSnapshot.snapshotSha256 !== "string" ||
    !SHA256.test(value.acquisitionSnapshot.snapshotSha256) ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.atoms) ||
    !Array.isArray(value.claims) ||
    !Array.isArray(value.designEdges) ||
    !shaArray(value.artifactSha256s) ||
    !shaArray(value.implementationArtifactSha256s) ||
    !shaArray(value.environmentLockSha256s) ||
    !isObject(value.gate) ||
    value.gate.decision !== "pass" ||
    !Array.isArray(value.gate.reasons) ||
    value.gate.reasons.length !== 0
  ) {
    throw inferenceError("Inference snapshot is malformed.", "RESEARCH_INFERENCE_SNAPSHOT_INVALID");
  }
  return value as unknown as InferenceSnapshot;
}

function shaArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string" && SHA256.test(item))
  );
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function inferenceBlocked(reasons: string[]): CliError {
  return new CliError("Formal inference is blocked by frozen evidence or content gaps.", {
    code: "RESEARCH_INFERENCE_GATE_BLOCKED",
    exitCode: 3,
    details: { reasons },
  });
}

function inferenceError(message: string, code: string): CliError {
  return new CliError(message, { code, exitCode: 3 });
}
