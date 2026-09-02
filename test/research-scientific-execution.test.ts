import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import { initializeProject, loadProject, saveProject } from "../src/research/workspace/projects.js";
import {
  initializeResearchWorkspace,
  loadWorkspaceConfig,
} from "../src/research/workspace/workspace.js";
import {
  prepareScientificReview,
  submitScientificReview,
  type ScientificReviewPacket,
} from "../src/research/workspace/scientific-review.js";
import { executeScientificReview } from "../src/research/workspace/scientific-review-execution.js";
import {
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
  sha256Text,
} from "../src/research/workspace/storage.js";
import type { ExecutionResult, ResearchPolicyBinding } from "../src/research/workspace/types.js";
import { scientificDesignInput } from "./helpers/scientific-design.js";
import { appendJournalEvent, readVerifiedJournal } from "../src/research/workspace/journal.js";

describe("explicit isolated scientific review execution", () => {
  it("replays only a bounded execution receipt from the exact project namespace", async () => {
    const fixture = await preparedFixture("execution-receipt-size");
    try {
      await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async () => result(fixture.packet),
      );
      const paths = workspacePaths(fixture.root);
      const event = (await readVerifiedJournal(paths.journal)).findLast(
        (item) => item.type === "scientific-review.execution.completed",
      )!;
      const original = JSON.parse(
        await readFile(join(paths.control, String(event.payload.receiptLocator)), "utf8"),
      );
      const oversized = JSON.stringify({ ...original, padding: "x".repeat(2 * 1024 * 1024) });
      const receiptSha256 = sha256Text(oversized);
      const receiptLocator = `projects/${fixture.projectId}/scientific/execution-receipts/${receiptSha256}.json`;
      await writeTextAtomic(join(paths.control, receiptLocator), oversized);
      await appendJournalEvent(paths.journal, event.type, event.scope, {
        ...event.payload,
        receiptLocator,
        receiptSha256,
      });
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => {
            throw new Error("replay must not invoke");
          },
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_BINDING_INVALID" },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("atomically accepts only the matching completed submission during execution recovery", async () => {
    const fixture = await preparedFixture("execution-submit-replay");
    try {
      const executed = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async () => result(fixture.packet),
      );
      const replay = {
        root: fixture.root,
        projectId: fixture.projectId,
        role: "research-design" as const,
        reviewPath: join(
          workspacePaths(fixture.root).projects,
          fixture.projectId,
          "scientific/execution-outputs",
          `${executed.reviewSha256}.json`,
        ),
        executionBinding: {
          packetSha256: fixture.packet.packetSha256,
          reviewSha256: executed.reviewSha256,
        },
      };
      assert.equal((await submitScientificReview(replay)).status, "passed");
      const mismatched = {
        ...replay,
        executionBinding: { ...replay.executionBinding, reviewSha256: "0".repeat(64) },
      };
      await assert.rejects(submitScientificReview(mismatched), {
        code: "RESEARCH_SCIENTIFIC_REVIEW_BINDING_INVALID",
      });
      assert.equal(
        (await readVerifiedJournal(workspacePaths(fixture.root).journal)).filter(
          (event) => event.type === "scientific-review.submitted",
        ).length,
        1,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("settles observed wall time after exceptions while retaining unknown token reservations", async () => {
    const fixture = await preparedFixture("execution-wall-throw");
    try {
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error("interrupted call");
          },
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED" },
      );
      const project = await loadProject(fixture.root, fixture.projectId);
      assert.ok(project.usage.tokens > 0);
      assert.ok(project.usage.wallSeconds > 0);
      assert.ok(project.usage.wallSeconds < 60);
    } finally {
      await fixture.cleanup();
    }
  });

  it("revalidates immutable submitted proof before replaying a completed execution", async () => {
    const fixture = await preparedFixture("execution-replay-drift");
    try {
      const executed = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async () => result(fixture.packet),
      );
      const path = join(
        workspacePaths(fixture.root).projects,
        fixture.projectId,
        "scientific/reviews/research-design",
        executed.reviewSha256 + ".json",
      );
      await chmod(path, 0o600);
      await writeFile(path, "{}\n");
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => {
            throw new Error("replay must not invoke");
          },
        ),
        { code: "RESEARCH_SCIENTIFIC_GATE_INVALID" },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses recovered submission when its authoritative project became abandoned", async () => {
    const fixture = await preparedFixture("execution-recovered-authority");
    try {
      await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async () => result(fixture.packet),
      );
      const project = await loadProject(fixture.root, fixture.projectId);
      project.status = "abandoned";
      project.scientificDesign!.gates["research-design"].status = "prepared";
      project.scientificDesign!.gates["research-design"].reviewSha256 = null;
      await saveProject(fixture.root, project);
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => {
            throw new Error("replay must not invoke");
          },
        ),
        { code: "RESEARCH_PROJECT_NOT_AUTHORITATIVE" },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves conservative reservation when a failed call returns no usage", async () => {
    const fixture = await preparedFixture("execution-unknown-usage");
    try {
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => ({
            ...result(fixture.packet),
            exitCode: 86,
            stdout: "",
            tokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
          }),
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED" },
      );
      assert.ok((await loadProject(fixture.root, fixture.projectId)).usage.tokens > 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reserves finite wall time before a call can be interrupted", async () => {
    const fixture = await preparedFixture("execution-wall-reserve");
    try {
      await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async (request) => {
          assert.ok(
            (await loadProject(fixture.root, fixture.projectId)).usage.wallSeconds >=
              request.timeoutSeconds,
          );
          return result(fixture.packet);
        },
      );
      assert.equal((await loadProject(fixture.root, fixture.projectId)).usage.wallSeconds, 0.01);
    } finally {
      await fixture.cleanup();
    }
  });

  it("stages and embeds the exact approved Policy Markdown in the tool-free review", async () => {
    const fixture = await preparedFixture(
      "execution-policy-text",
      true,
      "# Reviewed Policy\nHuman rule: distinguish field observations from simulations.\n",
    );
    try {
      await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async (request) => {
          assert.match(
            request.prompt,
            /Human rule: distinguish field observations from simulations/u,
          );
          return result(fixture.packet);
        },
      );
    } finally {
      await fixture.cleanup();
    }
  });
  it("requires explicit cost consent before invoking a reviewer", async () => {
    const fixture = await preparedFixture("execution-consent");
    try {
      let calls = 0;
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: false, environment: {} },
          async () => {
            calls++;
            return result(fixture.packet);
          },
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_COST_CONFIRMATION_REQUIRED" },
      );
      assert.equal(calls, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("executes one bound tool-free reviewer, commits proof, and replays without a model call", async () => {
    const fixture = await preparedFixture("execution-success");
    try {
      let calls = 0;
      const executor = async (
        request: Parameters<NonNullable<Parameters<typeof executeScientificReview>[1]>>[0],
      ) => {
        calls++;
        assert.equal(request.route.agent, "claude");
        assert.equal(request.toolPolicy, "none");
        assert.equal(request.brokerUrl, null);
        assert.match(request.prompt, new RegExp(fixture.packet.packetSha256));
        assert.match(request.prompt, /model-comparison|cross-model/u);
        assert.equal(request.expectedRuntime, undefined);
        return result(fixture.packet);
      };
      const executed = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        executor,
      );
      assert.equal(executed.status, "passed");
      assert.match(executed.receiptSha256, /^[a-f0-9]{64}$/u);
      const replay = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        executor,
      );
      assert.equal(replay.replayed, true);
      assert.equal(calls, 1);
      assert.equal(
        (await loadProject(fixture.root, fixture.projectId)).scientificDesign?.gates[
          "research-design"
        ].status,
        "passed",
      );
      const journal = await readFile(workspacePaths(fixture.root).journal, "utf8");
      assert.match(journal, /scientific-review.execution.completed/u);
      assert.doesNotMatch(journal, /secret-execution-token/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it("allows a mechanically nonpassing packet to receive an independent stop verdict", async () => {
    const fixture = await preparedFixture("execution-stop", false);
    try {
      assert.equal(fixture.packet.mechanicalAssessment.canPass, false);
      const executed = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, environment: {} },
        async () => result(fixture.packet, "stop"),
      );
      assert.equal(executed.status, "stopped");
    } finally {
      await fixture.cleanup();
    }
  });

  it("records failed execution without submitting and requires an explicit bounded retry", async () => {
    const fixture = await preparedFixture("execution-failure");
    try {
      let calls = 0;
      const executor = async () => {
        calls++;
        return { ...result(fixture.packet), exitCode: 1, stderr: "synthetic provider failure" };
      };
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          executor,
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_EXECUTION_FAILED" },
      );
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          executor,
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_RETRY_REQUIRED" },
      );
      assert.equal(calls, 1);
      assert.equal(
        (await loadProject(fixture.root, fixture.projectId)).scientificDesign?.gates[
          "research-design"
        ].status,
        "prepared",
      );
      const recovered = await executeScientificReview(
        { ...fixture, role: "research-design", confirmCost: true, retry: true, environment: {} },
        async () => result(fixture.packet),
      );
      assert.equal(recovered.status, "passed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("blocks before execution when the reservation cannot fit", async () => {
    const fixture = await preparedFixture("execution-budget");
    try {
      const config = await loadWorkspaceConfig(fixture.root);
      config.budget.earlyScientificReviewMaxTokens = 1;
      await writeJsonAtomic(workspacePaths(fixture.root).config, config);
      let calls = 0;
      await assert.rejects(
        executeScientificReview(
          { ...fixture, role: "research-design", confirmCost: true, environment: {} },
          async () => {
            calls++;
            return result(fixture.packet);
          },
        ),
        { code: "RESEARCH_BUDGET_EXCEEDED" },
      );
      assert.equal(calls, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("never persists a reflected secret and leaves the scientific gate unpassed", async () => {
    const fixture = await preparedFixture("execution-secret");
    try {
      await assert.rejects(
        executeScientificReview(
          {
            ...fixture,
            role: "research-design",
            confirmCost: true,
            environment: { ANTHROPIC_API_KEY: "secret-execution-token" },
          },
          async () => ({
            ...result(fixture.packet),
            stdout: JSON.stringify({
              ...review(fixture.packet),
              boundedRecommendation: "secret-execution-token",
            }),
          }),
        ),
        { code: "RESEARCH_SCIENTIFIC_REVIEW_OUTPUT_UNSAFE" },
      );
      const journal = await readFile(workspacePaths(fixture.root).journal, "utf8");
      assert.doesNotMatch(journal, /secret-execution-token/u);
      assert.equal(
        (await loadProject(fixture.root, fixture.projectId)).scientificDesign?.gates[
          "research-design"
        ].status,
        "prepared",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

async function preparedFixture(projectId: string, passing = true, policyText?: string) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-scientific-execute-"));
  await initializeResearchWorkspace(root, "Scientific execution fixture");
  await lockCapabilities(root);
  const config = await loadWorkspaceConfig(root);
  config.budget.earlyScientificReviewMaxTokens = 200000;
  config.budget.maxInputContextTokens = 128000;
  config.budget.maxTokens = 2000000;
  await writeJsonAtomic(workspacePaths(root).config, config);
  const policy: ResearchPolicyBinding = {
    goal: "top-journal",
    projectId,
    articleType: "computational-modeling",
    field: "pavement-engineering",
    journalClass: "discipline-flagship",
    targetJournal: "International Journal of Pavement Engineering",
    resolvedPolicySha256: "a".repeat(64),
    approvalSha256: "b".repeat(64),
    verdictCeiling: "target-journal-submission-ready",
    documents: [],
    resolvedRules: [],
    resolvedConstraints: {},
    requiredReviewers: ["evidence", "methods-reproducibility", "domain-novelty", "journal-editor"],
    approvedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2027-08-14T00:00:00.000Z",
  };
  const design = await scientificDesignInput(root, projectId, {
    targetJournal: policy.targetJournal,
  });
  if (policyText) {
    const sha256 = sha256Text(policyText);
    const objectLocator = `policies/objects/${sha256}.md`;
    await writeTextAtomic(join(workspacePaths(root).control, objectLocator), policyText);
    policy.documents.push({
      id: "human-rule",
      kind: "baseline",
      logicalPath: "baseline.md",
      sha256,
      sourceClass: "human-customized",
      objectLocator,
    });
  }
  const project = await initializeProject(
    root,
    projectId,
    "How can model discrepancy be bounded without inventing validation?",
    undefined,
    false,
    undefined,
    policy,
    design,
  );
  const assessmentPath = join(root, "assessment.json");
  await writeJsonAtomic(assessmentPath, {
    schemaVersion: 1,
    role: "research-design",
    designSha256: project.scientificDesign!.designSha256,
    recommendation: passing ? "pass" : "stop",
    checks: {
      identityCoherent: true,
      estimandObservable: true,
      claimGraphComplete: true,
      endpointTruthRolesCorrect: true,
      quantityOntologyComplete: true,
      validationSemanticsCorrect: true,
      knownGapDispositionComplete: true,
      lifecycleFeasible: passing,
    },
    findings: [],
  });
  const packet = await prepareScientificReview({
    root,
    projectId,
    role: "research-design",
    assessmentPath,
    reviewerAgent: "claude",
    reviewerSessionId: "execution-" + projectId,
  });
  return { root, projectId, packet, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function review(packet: ScientificReviewPacket, decision: "pass" | "stop" = "pass") {
  return {
    schemaVersion: 1,
    role: packet.role,
    packetSha256: packet.packetSha256,
    reviewerSessionSha256: packet.reviewer.sessionSha256,
    decision,
    findings: [],
    boundedRecommendation: "Only the provided immutable context was independently reviewed.",
  };
}

function result(
  packet: ScientificReviewPacket,
  decision: "pass" | "stop" = "pass",
): ExecutionResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(review(packet, decision)),
    stderr: "",
    tokens: 100,
    inputTokens: 80,
    cachedInputTokens: 0,
    outputTokens: 20,
    costUsd: 0,
    wallSeconds: 0.01,
    model: null,
    runtime: {
      agent: "claude",
      model: null,
      binarySha256: "1".repeat(64),
      wrapperSha256: "2".repeat(64),
      adapterSha256: "3".repeat(64),
      binaryVersion: "fixture",
      platform: process.platform,
      architecture: process.arch,
    },
    isolation: {
      provider: process.platform === "darwin" ? "sandbox-exec" : "bubblewrap",
      policySha256: "4".repeat(64),
      readScopes: ["platform-runtime", "agent-runtime", "private-capsule"],
      writeScopes: ["private-capsule"],
      networkPolicy: "reviewer-provider-only",
      toolPolicy: "none",
    },
  };
}
