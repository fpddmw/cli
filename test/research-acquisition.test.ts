import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PDFDocument } from "pdf-lib";

import { CliError } from "../src/errors.js";
import {
  loadCurrentEvidenceSnapshot,
  loadImmutableEvidenceSnapshotChain,
} from "../src/research/workspace/acquisition.js";
import { registerEvidenceArtifact } from "../src/research/workspace/artifacts.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import { persistBrokerEvidence } from "../src/research/workspace/evidence.js";
import { recordDiscoveryAssessmentBatch } from "../src/research/workspace/discovery.js";
import { inspectDiscoveryProgress } from "../src/research/workspace/discovery-status.js";
import { bindEvidenceDownload } from "../src/research/workspace/downloads.js";
import {
  evidenceLedgerPath,
  listEvidenceCandidates,
  registerBrokerCandidates,
  registerNativeDiscoveryCandidate,
} from "../src/research/workspace/evidence-ledger.js";
import {
  addProjectInput,
  createProjectAddendum,
  initializeProject,
  loadProject,
  saveProject,
} from "../src/research/workspace/projects.js";
import { recordNativeResearchActivity } from "../src/research/workspace/native-activity.js";
import {
  abortNativeResearchStage,
  prepareNativeResearchStage,
  submitNativeResearchStage,
} from "../src/research/workspace/runtime.js";
import { resolveContained, sha256File, workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

describe("research acquisition and evidence snapshots", () => {
  it("registers one exact artifact, ignores concurrent files, and freezes a verified snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-acquisition-test-"));
    const staging = await mkdtemp(join(tmpdir(), "tiangong-acquisition-files-"));
    try {
      await initializeResearchWorkspace(root, undefined);
      await lockCapabilities(root);
      await initializeProject(root, "artifact-project", "Evaluate exact artifact acquisition.");
      const source = join(staging, "source.txt");
      await writeFile(source, "registered source input\n");
      await addProjectInput(root, "artifact-project", source, "primary");

      const discover = await prepareNativeResearchStage({
        root,
        projectId: "artifact-project",
        stage: "discover",
        hostAgent: "codex",
      });
      const [candidate] = await listEvidenceCandidates(root, "artifact-project");
      assert.ok(candidate);
      await recordAdmission(root, "artifact-project", candidate.id, "exact-source");
      const discoverOutput = join(staging, "discover.json");
      await writeFile(
        discoverOutput,
        JSON.stringify({
          schemaVersion: 2,
          limitations: [],
          dimensionJudgments: [{ id: "research-question", status: "covered" }],
          gaps: [],
        }),
      );
      await submitNativeResearchStage({
        root,
        projectId: "artifact-project",
        sessionId: discover.sessionId,
        outputPath: discoverOutput,
        confirmedModel: discover.expectedModel,
      });

      const acquire = await prepareNativeResearchStage({
        root,
        projectId: "artifact-project",
        stage: "acquire",
        hostAgent: "codex",
      });
      assert.ok(acquire.commands.registerArtifact);
      const selected = join(staging, "selected.pdf");
      const selectedText = join(staging, "selected.txt");
      const concurrent = join(staging, "concurrent.pdf");
      const selectedBytes = await validPdf("selected exact bytes");
      const concurrentBytes = await validPdf("other concurrent bytes");
      await writeFile(selected, selectedBytes);
      await writeFile(selectedText, "selected exact text derivative\n");
      await writeFile(concurrent, concurrentBytes);
      const selectedDownload = await completedDownload(
        root,
        "artifact-project",
        candidate.id,
        selected,
        "https://example.test/paper?utm_source=browser&token=must-not-persist",
      );
      const artifact = await registerEvidenceArtifact({
        root,
        projectId: "artifact-project",
        candidateId: candidate.id,
        path: selected,
        sourceUrl: "https://example.test/paper?utm_source=search",
        downloadBindingId: selectedDownload.binding.bindingId,
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        hostType: "publisher",
        articleVersion: "version-of-record",
      });
      const textArtifact = await registerEvidenceArtifact({
        root,
        projectId: "artifact-project",
        candidateId: candidate.id,
        path: selectedText,
        derivedFromArtifactId: artifact.artifactId,
      });
      const workbookPath = join(staging, "supporting.xlsx");
      const workbookBytes = storedZip([
        ["[Content_Types].xml", Buffer.from("<Types/>")],
        [
          "xl/workbook.xml",
          Buffer.from('<workbook><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>'),
        ],
        ["xl/worksheets/sheet1.xml", Buffer.from("<worksheet/>")],
      ]);
      await writeFile(workbookPath, workbookBytes);
      const workbookArtifact = await registerEvidenceArtifact({
        root,
        projectId: "artifact-project",
        candidateId: candidate.id,
        path: workbookPath,
      });
      assert.deepEqual(workbookArtifact.validation.details.sheetNames, ["Sheet1"]);
      const corruptWorkbookPath = join(staging, "corrupt.xlsx");
      const corruptWorkbook = Buffer.from(workbookBytes);
      const sheetNameOffset = corruptWorkbook.indexOf("Sheet1");
      assert.ok(sheetNameOffset > 0);
      corruptWorkbook[sheetNameOffset] = corruptWorkbook[sheetNameOffset]! ^ 0x01;
      await writeFile(corruptWorkbookPath, corruptWorkbook);
      await assert.rejects(
        registerEvidenceArtifact({
          root,
          projectId: "artifact-project",
          candidateId: candidate.id,
          path: corruptWorkbookPath,
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_ARTIFACT_FORMAT_INVALID",
      );
      const masqueradingPdf = join(staging, "publisher-error.pdf");
      await writeFile(masqueradingPdf, "<!doctype html><html><body>Access denied</body></html>");
      const masqueradingDownload = await completedDownload(
        root,
        "artifact-project",
        candidate.id,
        masqueradingPdf,
        "https://example.test/publisher-error.pdf",
      );
      await assert.rejects(
        registerEvidenceArtifact({
          root,
          projectId: "artifact-project",
          candidateId: candidate.id,
          path: masqueradingPdf,
          sourceUrl: "https://example.test/publisher-error.pdf",
          downloadBindingId: masqueradingDownload.binding.bindingId,
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_ARTIFACT_FORMAT_INVALID",
      );
      assert.equal(artifact.sourceUrl, "https://example.test/paper");
      assert.equal(artifact.downloadBinding?.bindingId, selectedDownload.binding.bindingId);
      assert.equal(artifact.license, "CC-BY-4.0");
      assert.equal(artifact.validation.details.pageCount, 1);
      assert.deepEqual(
        await readFile(resolveContained(workspacePaths(root).control, artifact.locator)),
        selectedBytes,
      );
      assert.notDeepEqual(
        await readFile(resolveContained(workspacePaths(root).control, artifact.locator)),
        await readFile(concurrent),
      );

      const acquireOutput = join(staging, "acquire.json");
      await writeFile(
        acquireOutput,
        JSON.stringify({
          schemaVersion: 1,
          decisions: [
            {
              sourceId: "exact-source",
              candidateId: candidate.id,
              artifactIds: [artifact.artifactId, textArtifact.artifactId],
              status: "accepted",
              rationale: "Exact structurally valid PDF registered.",
              limitations: [],
            },
          ],
          limitations: [],
          gaps: [],
        }),
      );
      await submitNativeResearchStage({
        root,
        projectId: "artifact-project",
        sessionId: acquire.sessionId,
        outputPath: acquireOutput,
        confirmedModel: acquire.expectedModel,
      });
      const snapshot = await loadCurrentEvidenceSnapshot(root, "artifact-project");
      assert.equal(snapshot.sources.length, 1);
      assert.equal(snapshot.artifacts.length, 2);
      assert.equal(snapshot.coverage.decision, "pass");
      assert.equal(snapshot.parentSnapshotId, null);
      const evidencePath = join(
        workspacePaths(root).projects,
        "artifact-project",
        "outputs",
        "evidence.json",
      );
      const originalEvidence = await readFile(evidencePath);
      await writeFile(evidencePath, '{"tampered":true}\n');
      await assert.rejects(
        loadCurrentEvidenceSnapshot(root, "artifact-project"),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_EVIDENCE_SNAPSHOT_INVALID",
      );
      await writeFile(evidencePath, originalEvidence);
      const analyze = await prepareNativeResearchStage({
        root,
        projectId: "artifact-project",
        stage: "analyze",
        hostAgent: "codex",
      });
      assert.match(analyze.prompt, /selected exact text derivative/);
      assert.match(analyze.prompt, new RegExp(textArtifact.sha256));
      await abortNativeResearchStage({
        root,
        projectId: "artifact-project",
        sessionId: analyze.sessionId,
      });

      const objectPath = resolveContained(workspacePaths(root).control, artifact.locator);
      await chmod(objectPath, 0o600);
      await writeFile(objectPath, "%PDF-1.4\ntampered\n%%EOF\n");
      await assert.rejects(
        loadCurrentEvidenceSnapshot(root, "artifact-project"),
        (error: unknown) => error instanceof CliError && error.code === "RESEARCH_ARTIFACT_DRIFT",
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(staging, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects symlink artifacts and sensitive source URLs during acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-acquisition-safety-"));
    const staging = await mkdtemp(join(tmpdir(), "tiangong-acquisition-safety-files-"));
    try {
      await initializeResearchWorkspace(root, undefined);
      await lockCapabilities(root);
      await initializeProject(root, "artifact-safety", "Evaluate acquisition safety checks.");
      const source = join(staging, "source.txt");
      await writeFile(source, "source\n");
      await addProjectInput(root, "artifact-safety", source, "primary");
      const discover = await prepareNativeResearchStage({
        root,
        projectId: "artifact-safety",
        stage: "discover",
        hostAgent: "codex",
      });
      const [candidate] = await listEvidenceCandidates(root, "artifact-safety");
      assert.ok(candidate);
      await recordAdmission(root, "artifact-safety", candidate.id, "source-1");
      const discoverOutput = join(staging, "discover.json");
      await writeFile(
        discoverOutput,
        JSON.stringify({
          schemaVersion: 2,
          limitations: [],
          dimensionJudgments: [{ id: "research-question", status: "covered" }],
          gaps: [],
        }),
      );
      await submitNativeResearchStage({
        root,
        projectId: "artifact-safety",
        sessionId: discover.sessionId,
        outputPath: discoverOutput,
        confirmedModel: discover.expectedModel,
      });
      await prepareNativeResearchStage({
        root,
        projectId: "artifact-safety",
        stage: "acquire",
        hostAgent: "codex",
      });
      const pdf = join(staging, "source.pdf");
      const linked = join(staging, "source-link.pdf");
      await writeFile(pdf, await validPdf("source"));
      await symlink(pdf, linked);
      await assert.rejects(
        registerEvidenceArtifact({
          root,
          projectId: "artifact-safety",
          candidateId: candidate.id,
          path: linked,
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_ARTIFACT_PATH_INVALID",
      );
      const download = await completedDownload(
        root,
        "artifact-safety",
        candidate.id,
        pdf,
        "https://example.test/paper",
      );
      const cancelled = await bindEvidenceDownload({
        root,
        projectId: "artifact-safety",
        candidateId: candidate.id,
        value: {
          schemaVersion: 1,
          backend: "native-browser",
          status: "cancelled",
          downloadUrl: "https://example.test/cancelled?token=must-not-persist",
          failureCode: "user-cancelled",
        },
      });
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.binding, null);
      await assert.rejects(
        registerEvidenceArtifact({
          root,
          projectId: "artifact-safety",
          candidateId: candidate.id,
          path: pdf,
          sourceUrl: "https://example.test/paper",
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_DOWNLOAD_BINDING_REQUIRED",
      );
      await assert.rejects(
        registerEvidenceArtifact({
          root,
          projectId: "artifact-safety",
          candidateId: candidate.id,
          path: pdf,
          sourceUrl: "https://example.test/paper?token=must-not-persist",
          downloadBindingId: download.binding.bindingId,
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_ARTIFACT_SOURCE_INVALID",
      );
      const projectFiles = await readFile(workspacePaths(root).journal, "utf8");
      assert.doesNotMatch(projectFiles, /must-not-persist/);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(staging, { recursive: true, force: true }),
      ]);
    }
  });

  it("creates a non-destructive addendum and freezes an incremental child snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-addendum-test-"));
    const staging = await mkdtemp(join(tmpdir(), "tiangong-addendum-files-"));
    try {
      await initializeResearchWorkspace(root, undefined);
      await lockCapabilities(root);
      const { snapshot: sourceSnapshot } = await freezeInputOnlyProject(
        root,
        staging,
        "closed-source",
      );
      const source = await loadProject(root, "closed-source");
      for (const workPackage of source.packages) {
        workPackage.status = "complete";
        workPackage.completedAt = new Date().toISOString();
      }
      source.status = "complete";
      source.evidenceState.closureSnapshotId = sourceSnapshot.snapshotId;
      await saveProject(root, source);
      const closurePath = join(
        workspacePaths(root).projects,
        "closed-source",
        "outputs",
        "closure.json",
      );
      await writeFile(
        closurePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            projectId: "closed-source",
            status: "complete",
            evidenceSnapshot: {
              snapshotId: sourceSnapshot.snapshotId,
              snapshotSha256: sourceSnapshot.snapshotSha256,
            },
          },
          null,
          2,
        )}\n`,
      );
      const closureSha256 = await sha256File(closurePath);

      const addendum = await createProjectAddendum(root, "closed-source", "source-addendum");
      assert.equal(addendum.lineage.kind, "addendum");
      assert.equal(addendum.lineage.supersedes, "closed-source");
      assert.equal(addendum.lineage.baseSnapshotId, sourceSnapshot.snapshotId);
      assert.equal(addendum.packages[0]?.status, "ready");
      assert.equal(addendum.packages[1]?.status, "pending");
      const staleSource = await loadProject(root, "closed-source");
      assert.equal(staleSource.status, "stale");
      assert.equal(staleSource.lineage.supersededBy, "source-addendum");
      assert.equal(await sha256File(closurePath), closureSha256);

      const discover = await prepareNativeResearchStage({
        root,
        projectId: "source-addendum",
        stage: "discover",
        hostAgent: "codex",
      });
      const [candidate] = await listEvidenceCandidates(root, "source-addendum");
      assert.ok(candidate);
      await recordAdmission(root, "source-addendum", candidate.id, "source-1");
      const discoverOutput = join(staging, "addendum-discover.json");
      await writeFile(discoverOutput, JSON.stringify(discoveryValue(candidate.id, "source-1")));
      await submitNativeResearchStage({
        root,
        projectId: "source-addendum",
        sessionId: discover.sessionId,
        outputPath: discoverOutput,
        confirmedModel: discover.expectedModel,
      });
      const acquire = await prepareNativeResearchStage({
        root,
        projectId: "source-addendum",
        stage: "acquire",
        hostAgent: "codex",
      });
      const acquireOutput = join(staging, "addendum-acquire.json");
      await writeFile(acquireOutput, JSON.stringify(acquisitionValue(candidate.id, "source-1")));
      await submitNativeResearchStage({
        root,
        projectId: "source-addendum",
        sessionId: acquire.sessionId,
        outputPath: acquireOutput,
        confirmedModel: acquire.expectedModel,
      });
      const childSnapshot = await loadCurrentEvidenceSnapshot(root, "source-addendum");
      assert.equal(childSnapshot.parentSnapshotId, sourceSnapshot.snapshotId);
      assert.equal(childSnapshot.parentSnapshotSha256, sourceSnapshot.snapshotSha256);
      assert.deepEqual(childSnapshot.delta.addedSourceIds, []);
      assert.deepEqual(childSnapshot.delta.changedSourceIds, []);
      assert.deepEqual(childSnapshot.delta.removedSourceIds, []);
      assert.deepEqual(childSnapshot.delta.unchangedSourceIds, ["source-1"]);

      const closedChild = await loadProject(root, "source-addendum");
      for (const workPackage of closedChild.packages) {
        workPackage.status = "complete";
        workPackage.completedAt = new Date().toISOString();
      }
      closedChild.status = "complete";
      closedChild.evidenceState.closureSnapshotId = childSnapshot.snapshotId;
      await saveProject(root, closedChild);
      await writeFile(
        join(workspacePaths(root).projects, "source-addendum", "outputs", "closure.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            projectId: "source-addendum",
            status: "complete",
            evidenceSnapshot: {
              snapshotId: childSnapshot.snapshotId,
              snapshotSha256: childSnapshot.snapshotSha256,
            },
          },
          null,
          2,
        )}\n`,
      );
      await createProjectAddendum(root, "source-addendum", "source-addendum-two");
      const inheritedChain = await loadImmutableEvidenceSnapshotChain(
        root,
        "source-addendum-two",
        childSnapshot.snapshotSha256,
      );
      assert.deepEqual(
        inheritedChain.map((item) => item.snapshotSha256),
        [childSnapshot.snapshotSha256, sourceSnapshot.snapshotSha256],
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(staging, { recursive: true, force: true }),
      ]);
    }
  });

  it("keeps native Web discoveries supplemental until immutable provenance exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-native-candidate-"));
    const staging = await mkdtemp(join(tmpdir(), "tiangong-native-candidate-files-"));
    try {
      await initializeResearchWorkspace(root, undefined);
      await lockCapabilities(root);
      await initializeProject(root, "native-candidate", "Evaluate a native Web discovery bridge.");
      const discover = await prepareNativeResearchStage({
        root,
        projectId: "native-candidate",
        stage: "discover",
        hostAgent: "codex",
      });
      assert.ok(discover.commands.registerCandidate);
      const registered = await registerNativeDiscoveryCandidate({
        root,
        projectId: "native-candidate",
        value: {
          title: "Official source discovered in native Web",
          url: "https://example.test/official?utm_source=native",
          publicationDate: "2026-08-11",
          excerpt: "Discovery-only snippet.",
        },
      });
      assert.equal(registered.admissionStatus, "supplemental-not-admitted");
      assert.equal(registered.candidate.url, "https://example.test/official");
      const activity = await recordNativeResearchActivity({
        root,
        projectId: "native-candidate",
        value: {
          schemaVersion: 1,
          kind: "web-search",
          channel: "codex.web-search",
          input: "official source https://example.test/?api_key=must-not-persist",
          candidateIds: [registered.candidate.id],
          resultCount: 10,
          status: "completed",
          challenge: "none",
        },
      });
      assert.match(activity.inputSha256, /^[0-9a-f]{64}$/);
      assert.equal("input" in activity, false);
      const progress = await inspectDiscoveryProgress(
        root,
        await loadProject(root, "native-candidate"),
      );
      assert.equal(progress.nativeActivities.total, 1);
      assert.equal(progress.nativeActivities.byKind["web-search"], 1);
      assert.equal(progress.nativeActivities.unformalizedNativeCandidates, 1);
      await assert.rejects(
        registerNativeDiscoveryCandidate({
          root,
          projectId: "native-candidate",
          value: {
            title: "Sensitive URL",
            url: "https://example.test/private?api_key=must-not-persist",
          },
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_EVIDENCE_LEDGER_INVALID",
      );
      await assert.rejects(
        recordAdmission(root, "native-candidate", registered.candidate.id, "native-source"),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_STRUCTURED_OUTPUT_INVALID",
      );
      const ledger = await readFile(evidenceLedgerPath(root, "native-candidate"), "utf8");
      assert.doesNotMatch(ledger, /must-not-persist|api_key|official source/);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(staging, { recursive: true, force: true }),
      ]);
    }
  });

  it("formalizes a native candidate through a broker receipt without calling a PDF full text", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-native-formalization-"));
    const staging = await mkdtemp(join(tmpdir(), "tiangong-native-formalization-files-"));
    try {
      await initializeResearchWorkspace(root, undefined);
      await lockCapabilities(root);
      await initializeProject(
        root,
        "native-formalized",
        "Evaluate formal native candidate provenance.",
      );
      const discover = await prepareNativeResearchStage({
        root,
        projectId: "native-formalized",
        stage: "discover",
        hostAgent: "codex",
      });
      const native = await registerNativeDiscoveryCandidate({
        root,
        projectId: "native-formalized",
        value: {
          title: "Official native discovery",
          url: "https://example.test/formal-source?utm_source=native",
          publicationDate: "2026-08-11",
        },
      });
      await recordNativeResearchActivity({
        root,
        projectId: "native-formalized",
        value: {
          schemaVersion: 1,
          kind: "web-search",
          channel: "codex.web-search",
          input: "official native source",
          candidateIds: [native.candidate.id],
          resultCount: 1,
          status: "completed",
          challenge: "none",
        },
      });
      const contextBytes = Buffer.from(
        JSON.stringify([
          {
            title: "Official broker result",
            url: "https://example.test/formal-source",
            publicationDate: "2026-08-11",
          },
        ]),
      );
      const receipt = await persistBrokerEvidence(
        root,
        {
          attemptId: "formalization-attempt",
          projectId: "native-formalized",
          capabilityId: "method.test-search",
          credentialId: null,
          status: 200,
          contentType: "application/json",
          sourceSha256: "a".repeat(64),
          contextItems: 1,
          contextOffset: 0,
          contextTotalItems: 1,
          contextNextOffset: null,
          contextTruncated: false,
          redactions: 0,
          retrievedAt: "2026-08-11T00:00:00.000Z",
          cacheHit: false,
        },
        contextBytes,
        contextBytes,
      );
      await registerBrokerCandidates({
        root,
        projectId: "native-formalized",
        receipt,
        contextBytes,
      });
      const [formalized] = await listEvidenceCandidates(root, "native-formalized");
      assert.equal(formalized?.id, native.candidate.id);
      assert.deepEqual(
        formalized?.occurrences.map((occurrence) => occurrence.kind),
        ["native", "broker"],
      );

      const discoverOutput = join(staging, "formalized-discover.json");
      await recordAdmission(root, "native-formalized", native.candidate.id, "formal-source");
      await writeFile(
        discoverOutput,
        JSON.stringify(discoveryValue(native.candidate.id, "formal-source")),
      );
      await submitNativeResearchStage({
        root,
        projectId: "native-formalized",
        sessionId: discover.sessionId,
        outputPath: discoverOutput,
        confirmedModel: discover.expectedModel,
      });

      const acquire = await prepareNativeResearchStage({
        root,
        projectId: "native-formalized",
        stage: "acquire",
        hostAgent: "codex",
      });
      const unboundPath = join(staging, "unbound-network.txt");
      await writeFile(unboundPath, "network-looking content without a download event\n");
      const unbound = await registerEvidenceArtifact({
        root,
        projectId: "native-formalized",
        candidateId: native.candidate.id,
        path: unboundPath,
      });
      const unboundAudit = join(staging, "unbound-acquisition.json");
      await writeFile(
        unboundAudit,
        JSON.stringify(
          acquisitionValue(native.candidate.id, "formal-source", [unbound.artifactId]),
        ),
      );
      await assert.rejects(
        submitNativeResearchStage({
          root,
          projectId: "native-formalized",
          sessionId: acquire.sessionId,
          outputPath: unboundAudit,
          confirmedModel: acquire.expectedModel,
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_STRUCTURED_OUTPUT_INVALID",
      );
      const pdfPath = join(staging, "formal-source.pdf");
      await writeFile(pdfPath, await validPdf("binary-only source"));
      const formalDownload = await completedDownload(
        root,
        "native-formalized",
        native.candidate.id,
        pdfPath,
        "https://example.test/formal-source",
      );
      const pdf = await registerEvidenceArtifact({
        root,
        projectId: "native-formalized",
        candidateId: native.candidate.id,
        path: pdfPath,
        sourceUrl: "https://example.test/formal-source",
        downloadBindingId: formalDownload.binding.bindingId,
      });
      const acquisitionOutput = join(staging, "formalized-acquisition.json");
      await writeFile(
        acquisitionOutput,
        JSON.stringify({
          schemaVersion: 1,
          decisions: [
            {
              sourceId: "formal-source",
              candidateId: native.candidate.id,
              artifactIds: [pdf.artifactId],
              status: "accepted",
              rationale: "Exact PDF acquired and structurally verified.",
              limitations: ["No text derivative was registered for producer context."],
            },
          ],
          limitations: [],
          gaps: [],
        }),
      );
      await submitNativeResearchStage({
        root,
        projectId: "native-formalized",
        sessionId: acquire.sessionId,
        outputPath: acquisitionOutput,
        confirmedModel: acquire.expectedModel,
      });
      const snapshot = await loadCurrentEvidenceSnapshot(root, "native-formalized");
      const source = snapshot.sources[0]!;
      assert.equal(source.fullTextAvailable, false);
      assert.equal(source.registeredFullFile, true);
      assert.equal(source.producerContextLevel, "metadata-only");
      assert.deepEqual(source.producerVisibleArtifactIds, []);
      assert.equal(source.reviewerBoundFullFile, true);
      assert.equal(source.locallyAcquired, true);
      assert.equal(snapshot.coverage.fullTextSources, 0);
      assert.deepEqual(snapshot.activitySummary, {
        total: 1,
        byKind: { "web-search": 1 },
        blockedChallenges: 0,
        linkedCandidateIds: [native.candidate.id],
      });
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(staging, { recursive: true, force: true }),
      ]);
    }
  });
});

async function freezeInputOnlyProject(
  root: string,
  staging: string,
  projectId: string,
): Promise<{ snapshot: Awaited<ReturnType<typeof loadCurrentEvidenceSnapshot>> }> {
  await initializeProject(root, projectId, "Evaluate an immutable input evidence source.");
  const input = join(staging, `${projectId}.txt`);
  await writeFile(input, "stable source evidence\n");
  await addProjectInput(root, projectId, input, "primary");
  const discover = await prepareNativeResearchStage({
    root,
    projectId,
    stage: "discover",
    hostAgent: "codex",
  });
  const [candidate] = await listEvidenceCandidates(root, projectId);
  assert.ok(candidate);
  await recordAdmission(root, projectId, candidate.id, "source-1");
  const discoverOutput = join(staging, `${projectId}-discover.json`);
  await writeFile(discoverOutput, JSON.stringify(discoveryValue(candidate.id, "source-1")));
  await submitNativeResearchStage({
    root,
    projectId,
    sessionId: discover.sessionId,
    outputPath: discoverOutput,
    confirmedModel: discover.expectedModel,
  });
  const acquire = await prepareNativeResearchStage({
    root,
    projectId,
    stage: "acquire",
    hostAgent: "codex",
  });
  const acquireOutput = join(staging, `${projectId}-acquire.json`);
  await writeFile(acquireOutput, JSON.stringify(acquisitionValue(candidate.id, "source-1")));
  await submitNativeResearchStage({
    root,
    projectId,
    sessionId: acquire.sessionId,
    outputPath: acquireOutput,
    confirmedModel: acquire.expectedModel,
  });
  return { snapshot: await loadCurrentEvidenceSnapshot(root, projectId) };
}

function discoveryValue(candidateId: string, sourceId: string): Record<string, unknown> {
  void candidateId;
  void sourceId;
  return {
    schemaVersion: 2,
    limitations: [],
    dimensionJudgments: [{ id: "research-question", status: "covered" }],
    gaps: [],
  };
}

async function recordAdmission(
  root: string,
  projectId: string,
  candidateId: string,
  sourceId: string,
): Promise<void> {
  await recordDiscoveryAssessmentBatch({
    root,
    projectId,
    value: {
      schemaVersion: 1,
      assessments: [
        {
          decision: "admit",
          candidateId,
          sourceId,
          sourceType: "primary",
          relevance: "Direct source evidence.",
          quality: { level: "primary", rationale: "Registered immutable input." },
          applicability: "Directly applicable.",
          coverageDimensions: ["research-question"],
          limitations: [],
        },
      ],
    },
  });
}

async function completedDownload(
  root: string,
  projectId: string,
  candidateId: string,
  path: string,
  downloadUrl: string,
): Promise<Extract<Awaited<ReturnType<typeof bindEvidenceDownload>>, { status: "completed" }>> {
  const result = await bindEvidenceDownload({
    root,
    projectId,
    candidateId,
    value: {
      schemaVersion: 1,
      backend: "native-browser",
      status: "completed",
      path,
      downloadUrl,
      suggestedFilename: path,
      downloadIdentifier: `event-${candidateId}`,
    },
  });
  assert.equal(result.status, "completed");
  return result as Extract<typeof result, { status: "completed" }>;
}

function acquisitionValue(
  candidateId: string,
  sourceId: string,
  artifactIds: string[] = [],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    decisions: [
      {
        sourceId,
        candidateId,
        artifactIds,
        status: "accepted",
        rationale: "Immutable local input is already available in full.",
        limitations: [],
      },
    ],
    limitations: [],
    gaps: [],
  };
}

async function validPdf(title: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.setTitle(title);
  document.addPage([300, 300]);
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

function storedZip(entries: Array<[string, Buffer]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [entryName, data] of entries) {
    const name = Buffer.from(entryName, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
