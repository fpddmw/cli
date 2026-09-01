import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { builtInDataRegistry } from "../src/data/builtins.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import {
  executeResearchDataCapability,
  projectResearchDataCapabilities,
} from "../src/research/workspace/data-evidence-adapter.js";
import {
  researchDataCredentialId,
  researchDataCredentialIds,
  setCapabilityCredentialValue,
} from "../src/research/workspace/credentials.js";
import { loadProjectEvidenceReceipts } from "../src/research/workspace/evidence.js";
import { listEvidenceCandidates } from "../src/research/workspace/evidence-ledger.js";
import { initializeProject } from "../src/research/workspace/projects.js";
import {
  abortNativeResearchStage,
  prepareNativeResearchStage,
} from "../src/research/workspace/runtime.js";
import { workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";
import { syntheticConnector } from "./support/data-synthetic-connector.js";

function request(): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "test.synthetic",
    capabilityVersion: "1.0.0",
    operationId: "echo",
    operationVersion: "1.0.0",
    input: { value: "research evidence" },
  };
}

describe("research data evidence adapter", () => {
  it("projects every registered operation without a per-capability research adapter", () => {
    const projection = projectResearchDataCapabilities(createDataRegistry([syntheticConnector()]));

    assert.equal(projection.capabilities.length, 1);
    assert.equal(projection.capabilities[0]?.id, "data:test.synthetic:echo");
    assert.equal(projection.capabilities[0]?.capabilityId, "test.synthetic");
    assert.equal(projection.capabilities[0]?.operationId, "echo");
    assert.equal(projection.capabilities[0]?.summary, "Echo one validated string.");
    assert.match(projection.capabilities[0]?.manifestDigest ?? "", /^[a-f0-9]{64}$/);
    assert.match(projection.catalogDigest, /^[a-f0-9]{64}$/);
  });

  it("executes the shared TypeScript runtime and only adds research evidence state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-research-data-adapter-"));
    const registry = createDataRegistry([syntheticConnector()]);
    const clock = () => new Date("2026-08-31T00:00:00.000Z");
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "data-evidence", "Use one structured data result.");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "data-evidence",
        stage: "discover",
        hostAgent: "codex",
      });

      const standalone = await executeDataRun(request(), { registry, environment: {}, clock });
      const adapted = await executeResearchDataCapability({
        root,
        projectId: "data-evidence",
        request: request(),
        registry,
        clock,
      });

      assert.deepEqual(adapted.coreResult, standalone);
      assert.equal(adapted.evidenceReceipt?.evidenceKind, "data");
      assert.equal(
        adapted.evidenceReceipt?.data?.coreReceiptDigest,
        standalone.receipt.receiptDigest,
      );
      assert.equal(adapted.evidenceReceipt?.capabilityId, "data:test.synthetic:echo");
      assert.equal(adapted.candidate?.origin.kind, "data");
      assert.equal(adapted.candidate?.origin.receiptId, adapted.evidenceReceipt?.attemptId);

      const [receipt] = await loadProjectEvidenceReceipts(root, "data-evidence");
      assert.equal(receipt?.data?.coreReceiptDigest, standalone.receipt.receiptDigest);
      const persisted = JSON.parse(
        await readFile(join(workspacePaths(root).control, receipt!.locator), "utf8"),
      ) as { receipt: { receiptDigest: string } };
      assert.equal(persisted.receipt.receiptDigest, standalone.receipt.receiptDigest);
      assert.equal((await listEvidenceCandidates(root, "data-evidence")).length, 1);

      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.match(journal, /data\.capability\.requested/);
      assert.match(journal, /data\.capability\.completed/);
      await abortNativeResearchStage({
        root,
        projectId: "data-evidence",
        sessionId: packet.sessionId,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes the built-in data registry through the native discover packet", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-research-data-packet-"));
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "data-packet", "Discover structured public evidence.");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "data-packet",
        stage: "discover",
        hostAgent: "codex",
      });

      assert.ok(packet.commands.runDataCapability);
      assert.equal(
        packet.commands.runDataCapability.catalog.capabilities.length,
        packet.commands.runDataCapability.catalog.capabilities.filter((capability) =>
          capability.id.startsWith("data:"),
        ).length,
      );
      const registeredOperationCount = builtInDataRegistry
        .catalog()
        .capabilities.reduce((total, capability) => total + capability.operations.length, 0);
      assert.equal(
        packet.commands.runDataCapability.catalog.capabilities.length,
        registeredOperationCount,
      );
      assert.deepEqual(packet.commands.runDataCapability.argv.slice(0, 6), [
        "tiangong-ai",
        "research",
        "project",
        "evidence",
        "data",
        "run",
      ]);
      assert.match(packet.prompt, /structured data capabilities/i);
      await abortNativeResearchStage({
        root,
        projectId: "data-packet",
        sessionId: packet.sessionId,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects a namespaced owner-only credential without leaking it into evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-research-data-credential-"));
    const registry = createDataRegistry([syntheticConnector({ credential: true })]);
    const secret = "research-data-secret-marker";
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "data-credential", "Use credentialed structured data.");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "data-credential",
        stage: "discover",
        hostAgent: "codex",
      });
      const credentialId = researchDataCredentialId("test.synthetic", "api-token");
      await setCapabilityCredentialValue({
        root,
        declaredCredentialIds: researchDataCredentialIds(registry),
        credentialId,
        value: secret,
        minimumUtf8Bytes: 8,
      });

      const result = await executeResearchDataCapability({
        root,
        projectId: "data-credential",
        request: request(),
        registry,
      });

      assert.equal(result.coreResult.status, "success");
      assert.equal(result.evidenceReceipt?.evidenceKind, "data");
      const journal = await readFile(workspacePaths(root).journal, "utf8");
      assert.doesNotMatch(journal, new RegExp(secret));
      const evidence = await readFile(
        join(workspacePaths(root).control, result.evidenceReceipt!.locator),
        "utf8",
      );
      assert.doesNotMatch(evidence, new RegExp(secret));
      await abortNativeResearchStage({
        root,
        projectId: "data-credential",
        sessionId: packet.sessionId,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not inherit provider credentials from the host environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-research-data-ambient-credential-"));
    let networkRequests = 0;
    const registry = createDataRegistry([
      syntheticConnector({
        credential: true,
        execute: async (context) => {
          const response = await context.http.request({
            endpointId: "primary",
            method: "GET",
            path: "/v1/echo",
            credentialId: "api-token",
          });
          return {
            status: "success",
            data: { echoed: response.text() },
            summary: {
              recordCount: 1,
              pageCount: 1,
              chunkCount: 0,
              truncated: false,
              completeness: "complete",
            },
            warnings: [],
            errors: [],
            observations: [response.observation],
          };
        },
      }),
    ]);
    const previous = process.env.TIANGONG_DATA_TEST_TOKEN;
    process.env.TIANGONG_DATA_TEST_TOKEN = "ambient-provider-secret";
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "data-ambient", "Reject ambient provider credentials.");
      const packet = await prepareNativeResearchStage({
        root,
        projectId: "data-ambient",
        stage: "discover",
        hostAgent: "codex",
      });

      const result = await executeResearchDataCapability({
        root,
        projectId: "data-ambient",
        request: request(),
        registry,
        fetchImpl: async () => {
          networkRequests += 1;
          return new Response('"network-result"', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      await abortNativeResearchStage({
        root,
        projectId: "data-ambient",
        sessionId: packet.sessionId,
      });

      assert.equal(result.coreResult.status, "blocked");
      assert.equal(result.coreResult.errors[0]?.code, "credential-missing");
      assert.equal(result.evidenceReceipt, null);
      assert.equal(result.candidate, null);
      assert.equal(networkRequests, 0);
    } finally {
      if (previous === undefined) delete process.env.TIANGONG_DATA_TEST_TOKEN;
      else process.env.TIANGONG_DATA_TEST_TOKEN = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
