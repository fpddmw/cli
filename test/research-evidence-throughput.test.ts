import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { registerEvidenceArtifact } from "../src/research/workspace/artifacts.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import {
  loadDecompositionRecords,
  loadEvidenceAtomRecords,
  registerEvidenceAtom,
} from "../src/research/workspace/content-evidence.js";
import { recordDiscoveryAssessmentBatch } from "../src/research/workspace/discovery.js";
import {
  evidenceLedgerPath,
  listEvidenceCandidates,
} from "../src/research/workspace/evidence-ledger.js";
import { readJournal } from "../src/research/workspace/journal.js";
import { addProjectInput, initializeProject } from "../src/research/workspace/projects.js";
import {
  prepareNativeResearchStage,
  submitNativeResearchStage,
} from "../src/research/workspace/runtime.js";
import { workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

describe("bounded evidence throughput", () => {
  it("atomically registers bounded batches with shared verification and exact idempotent replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "research-content-batch-"));
    try {
      const fixture = await acquired(root);
      const decomposition = {
        schemaVersion: 1,
        sourceArtifactId: fixture.artifact.artifactId,
        status: "complete",
        parser: { id: "test.lines", version: "1" },
        outputArtifactIds: [fixture.derived.artifactId],
        contentClasses: ["fulltext"],
        limitations: [],
      };
      const records = Array.from({ length: 40 }, (_, index) => ({
        schemaVersion: 1,
        atomId: `source.fact.${index}`,
        sourceId: "source-1",
        candidateId: fixture.candidateId,
        artifactId: fixture.derived.artifactId,
        locator: { kind: "line-range", startLine: 1, endLine: 1 },
        statement: `Precisely bound evidence statement number ${index}.`,
        evidenceRoleIds: [],
        coverageDimensionIds: ["research-question"],
        evidenceFunction: "support",
        scope: "Synthetic offline batch performance regression.",
        limitations: [],
      }));
      const before = (await readJournal(evidenceLedgerPath(root, "batch-project"))).length;
      const bad = await batch(root, "atom", [
        ...records,
        { ...records[0], atomId: "bad", artifactId: "absent" },
      ]);
      assert.equal(bad.exitCode, 2);
      assert.match(bad.stderr, /RESEARCH_EVIDENCE_ATOM_SOURCE_INVALID/);
      assert.deepEqual(await loadEvidenceAtomRecords(root, "batch-project"), []);
      assert.equal((await readJournal(evidenceLedgerPath(root, "batch-project"))).length, before);

      const decomp = await batch(root, "decomposition", [decomposition]);
      assert.equal(decomp.exitCode, 0, decomp.stderr);
      assert.equal((await loadDecompositionRecords(root, "batch-project")).length, 1);
      const good = await batch(root, "atom", records);
      assert.equal(good.exitCode, 0, good.stderr);
      const result = JSON.parse(good.stdout);
      assert.equal(result.records.length, 40);
      assert.equal(result.work.acquisitionVerifications, 1);
      assert.equal(result.work.artifactStoreScans, 1);
      assert.equal(result.work.excerptFileReads, 1);
      assert.equal(result.work.ledgerAppends, 1);
      assert.equal((await loadEvidenceAtomRecords(root, "batch-project")).length, 40);
      assert.equal(
        (await readJournal(evidenceLedgerPath(root, "batch-project"))).length,
        before + 2,
      );
      const replay = await batch(root, "atom", records);
      assert.equal(replay.exitCode, 0, replay.stderr);
      assert.equal(JSON.parse(replay.stdout).batchSha256, result.batchSha256);
      assert.equal(JSON.parse(replay.stdout).work.ledgerAppends, 0);
      assert.equal(
        (await readJournal(evidenceLedgerPath(root, "batch-project"))).length,
        before + 2,
      );
      const single = await registerEvidenceAtom({
        root,
        projectId: "batch-project",
        value: records[0]!,
      });
      assert.equal(single.atomSha256, result.records[0].atomSha256);
      const conflict = await batch(root, "atom", [
        { ...records[0], statement: "A conflicting changed statement is never accepted." },
      ]);
      assert.equal(conflict.exitCode, 2);
      assert.match(conflict.stderr, /RESEARCH_EVIDENCE_ATOM_CONFLICT/);
      assert.equal((await loadEvidenceAtomRecords(root, "batch-project")).length, 40);
      const bound = await batch(
        root,
        "atom",
        Array.from({ length: 501 }, () => records[0]!),
      );
      assert.equal(bound.exitCode, 2);
      assert.match(bound.stderr, /RESEARCH_EVIDENCE_BATCH_INVALID/);
      const batchPath = join(
        workspacePaths(root).projects,
        "batch-project",
        "evidence",
        "content-batches",
        `${result.batchSha256}.json`,
      );
      await chmod(batchPath, 0o600);
      await writeFile(batchPath, "{}\n");
      await assert.rejects(loadEvidenceAtomRecords(root, "batch-project"), /batch/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preflights known artifact bytes offline independently of the package-output limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "research-artifact-budget-"));
    try {
      const config = await initializeResearchWorkspace(root, undefined);
      const configPath = workspacePaths(root).config;
      const value = JSON.parse(await readFile(configPath, "utf8"));
      value.budget.maxBytesPerArtifact = 1024;
      value.budget.maxBytesPerPackage = 64;
      await writeFile(configPath, JSON.stringify(value));
      void config;
      const ok = await invoke([
        "research",
        "project",
        "evidence",
        "artifact",
        "preflight",
        "--bytes",
        "512",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(ok.exitCode, 0, ok.stderr);
      const preflight = JSON.parse(ok.stdout);
      assert.equal(preflight.decision, "pass");
      assert.equal(preflight.limits.maxBytesPerArtifact, 1024);
      assert.equal(preflight.limits.maxBytesPerPackage, 64);
      const stop = await invoke([
        "research",
        "project",
        "evidence",
        "artifact",
        "preflight",
        "--bytes",
        "749735424",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(stop.exitCode, 3, stop.stderr);
      assert.equal(JSON.parse(stop.stdout).decision, "stop");
      assert.match(JSON.parse(stop.stdout).recommendedAction, /subset|filter/i);
      const source = join(root, "size-only.txt");
      await writeFile(source, "not read as content by preflight");
      const local = await invoke([
        "research",
        "project",
        "evidence",
        "artifact",
        "preflight",
        "--path",
        source,
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(local.exitCode, 0, local.stderr);
      assert.equal(JSON.parse(local.stdout).knownBytes, 31);
      assert.equal(local.stdout.includes(source), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function acquired(root: string) {
  await initializeResearchWorkspace(root, undefined);
  await lockCapabilities(root);
  const projectId = "batch-project";
  await initializeProject(root, projectId, "Test precise bounded evidence batch throughput.");
  const path = join(root, "source.txt");
  await writeFile(path, "A synthetic measured source fact.\n");
  await addProjectInput(root, projectId, path, "primary");
  const discover = await prepareNativeResearchStage({
    root,
    projectId,
    stage: "discover",
    hostAgent: "codex",
  });
  const [candidate] = await listEvidenceCandidates(root, projectId);
  assert.ok(candidate);
  await recordDiscoveryAssessmentBatch({
    root,
    projectId,
    value: {
      schemaVersion: 1,
      assessments: [
        {
          decision: "admit",
          candidateId: candidate.id,
          sourceId: "source-1",
          sourceType: "primary",
          relevance: "Direct test evidence.",
          quality: { level: "primary", rationale: "Immutable test input." },
          applicability: "Directly applicable.",
          coverageDimensions: ["research-question"],
          limitations: [],
        },
      ],
    },
  });
  const output = join(root, "submit.json");
  await writeFile(
    output,
    JSON.stringify({
      schemaVersion: 2,
      limitations: [],
      dimensionJudgments: [{ id: "research-question", status: "covered" }],
      gaps: [],
    }),
  );
  await submitNativeResearchStage({
    root,
    projectId,
    sessionId: discover.sessionId,
    outputPath: output,
    confirmedModel: discover.expectedModel,
  });
  const acquire = await prepareNativeResearchStage({
    root,
    projectId,
    stage: "acquire",
    hostAgent: "codex",
  });
  const artifact = await registerEvidenceArtifact({
    root,
    projectId,
    candidateId: candidate.id,
    path,
  });
  const derivedPath = join(root, "derived.txt");
  await writeFile(derivedPath, "A precisely extracted source fact.\n");
  const derived = await registerEvidenceArtifact({
    root,
    projectId,
    candidateId: candidate.id,
    path: derivedPath,
    derivedFromArtifactId: artifact.artifactId,
  });
  await writeFile(
    output,
    JSON.stringify({
      schemaVersion: 1,
      decisions: [
        {
          sourceId: "source-1",
          candidateId: candidate.id,
          artifactIds: [artifact.artifactId, derived.artifactId],
          status: "accepted",
          rationale: "Exact readable evidence is registered.",
          limitations: [],
        },
      ],
      limitations: [],
      gaps: [],
    }),
  );
  await submitNativeResearchStage({
    root,
    projectId,
    sessionId: acquire.sessionId,
    outputPath: output,
    confirmedModel: acquire.expectedModel,
  });
  return { artifact, derived, candidateId: candidate.id };
}

async function batch(root: string, kind: string, records: Record<string, unknown>[]) {
  const path = join(root, "batch.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, records }));
  return invoke([
    "research",
    "project",
    "evidence",
    kind,
    "batch",
    "batch-project",
    "--record",
    path,
    "--workspace",
    root,
    "--json",
  ]);
}

async function invoke(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env: {},
    stdout: { write: (chunk) => ((stdout += chunk), true) },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
  });
  return { exitCode, stdout, stderr };
}
