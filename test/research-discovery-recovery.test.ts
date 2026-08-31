import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  readAndVerifyDiscoveryRecovery,
  type DiscoveryRecoveryContract,
} from "../src/research/workspace/discovery-recovery.js";
import { fetchNativeCandidateSource } from "../src/research/workspace/broker.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import {
  commitDiscoveryDecisions,
  materializeDiscoveryEvidence,
  recordDiscoveryAssessmentBatch,
} from "../src/research/workspace/discovery.js";
import { inspectDiscoveryProgress } from "../src/research/workspace/discovery-status.js";
import {
  listEvidenceCandidates,
  registerNativeDiscoveryCandidate,
  registerProjectInputCandidates,
} from "../src/research/workspace/evidence-ledger.js";
import { recordNativeResearchActivity } from "../src/research/workspace/native-activity.js";
import {
  addProjectInput,
  forkProject,
  initializeProject,
  loadProject,
  saveProject,
} from "../src/research/workspace/projects.js";
import { hashRegularTree, workspacePaths } from "../src/research/workspace/storage.js";
import { nativeEvidenceRequestSchema } from "../src/research/workspace/runtime.js";
import type { ResearchPolicyBinding } from "../src/research/workspace/types.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";
import { passResearchDesignGate, scientificDesignInput } from "./helpers/scientific-design.js";

describe("bounded Discover recovery generations", () => {
  it("inherits a verified historical Discover ledger without reopening broad discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-discover-recovery-"));
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root);
      const historicalId = "discover-history-r1";
      const authoritativeId = "discover-history-r2";
      const targetId = "discover-history-r3";
      const historicalDesign = await scientificDesignInput(root, historicalId);
      const historical = await initializeProject(
        root,
        historicalId,
        "Can a bounded citation chase close one closest-work gap without repeating broad discovery?",
        undefined,
        false,
        undefined,
        policy(historicalId),
        historicalDesign,
      );
      historical.scientificDesign!.gates["research-design"].status = "passed";
      const discover = historical.packages.find((item) => item.stage === "discover")!;
      discover.status = "running";
      historical.status = "running";
      await saveProject(root, historical);

      for (let index = 0; index < 8; index += 1) {
        const path = join(root, `closest-work-${index + 1}.txt`);
        await writeFile(path, `closest prior work ${index + 1}\n`);
        await addProjectInput(root, historicalId, path, "primary");
      }
      const registered = await registerProjectInputCandidates(
        root,
        historicalId,
        (await loadProject(root, historicalId)).inputs,
      );
      await recordDiscoveryAssessmentBatch({
        root,
        projectId: historicalId,
        value: {
          schemaVersion: 1,
          assessments: registered.map((candidate, index) => ({
            decision: "admit",
            candidateId: candidate.id,
            sourceId: `closest-work-${index + 1}`,
            sourceType: "academic-paper",
            relevance: "Implements a nearby system-level explanation.",
            quality: { level: "primary", rationale: "Owner-registered test evidence." },
            applicability: "Closest-work novelty comparison.",
            coverageDimensions: ["research-question"],
            limitations: [],
          })),
        },
      });
      await commitDiscoveryDecisions(root, historicalId, {
        schemaVersion: 2,
        limitations: [],
        dimensionJudgments: [],
        gaps: [],
      });
      await writeFile(
        join(workspacePaths(root).projects, historicalId, "outputs", "evidence.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          sources: registered.map((candidate, index) => ({
            id: `closest-work-${index + 1}`,
            candidateId: candidate.id,
          })),
          limitations: [],
          coverage: { decision: "pass", gaps: [] },
        })}\n`,
      );
      const completedHistorical = await loadProject(root, historicalId);
      completedHistorical.packages.find((item) => item.stage === "discover")!.status = "complete";
      completedHistorical.packages.find((item) => item.stage === "discover")!.completedAt =
        new Date().toISOString();
      completedHistorical.packages.find((item) => item.stage === "acquire")!.status = "ready";
      completedHistorical.status = "ready";
      await saveProject(root, completedHistorical);

      await forkProject(root, historicalId, authoritativeId, undefined, {
        publicationPolicy: policy(authoritativeId),
        scientificDesign: await scientificDesignInput(root, authoritativeId),
      });

      const targetDesign = await scientificDesignInput(root, targetId, {
        additionalBrokerRoute: {
          id: "route-recovery-formalization",
          capabilityId: "method.public-source",
        },
      });
      const recoveryPath = join(root, "bounded-discover-recovery.json");
      const recoveryContract: DiscoveryRecoveryContract = {
        schemaVersion: 2,
        projectId: targetId,
        sourceProjectId: historicalId,
        evidenceRoleId: "role-closest-work",
        activeRouteIds: ["route-native-public-search"],
        formalizationRouteIds: ["route-recovery-formalization"],
        seedCandidateIds: registered.slice(0, 4).map((candidate) => candidate.id),
        inheritedEligibleCandidateIds: registered.map((candidate) => candidate.id),
        minimumDistinctCandidates: 10,
        maxNativeCitationChaseActivities: 8,
        maxBrokerFormalizationCalls: 4,
        floorClosureAction: "reject-further-citation-chase-formalization-and-admission",
        noveltyDefeatingPriorAction: "stop-and-return-to-design-review",
      };
      const { floorClosureAction: _legacyMissingFloorAction, ...legacyRecoveryContract } =
        recoveryContract;
      const legacyRecoveryContractV1 = { ...legacyRecoveryContract, schemaVersion: 1 as const };
      const legacyRecoveryPath = join(root, "legacy-bounded-discover-recovery.json");
      await writeFile(legacyRecoveryPath, `${JSON.stringify(legacyRecoveryContractV1, null, 2)}\n`);
      const verifiedLegacyRecovery = await readAndVerifyDiscoveryRecovery(
        legacyRecoveryPath,
        targetId,
      );
      assert.equal(verifiedLegacyRecovery.contract.schemaVersion, 1);
      await writeFile(recoveryPath, `${JSON.stringify(recoveryContract, null, 2)}\n`);
      const verifiedRecovery = await readAndVerifyDiscoveryRecovery(recoveryPath, targetId);
      const recovered = await forkProject(
        root,
        authoritativeId,
        targetId,
        undefined,
        {
          publicationPolicy: policy(targetId),
          scientificDesign: targetDesign,
        },
        verifiedRecovery,
      );

      assert.equal(recovered.discoveryRecovery?.sourceProjectId, historicalId);
      assert.equal(recovered.discoveryRecovery?.schemaVersion, 2);
      assert.equal(recovered.discoveryRecovery?.minimumDistinctCandidates, 10);
      assert.equal(
        recovered.discoveryRecovery?.floorClosureAction,
        "reject-further-citation-chase-formalization-and-admission",
      );
      assert.equal(recovered.packages.find((item) => item.stage === "discover")?.status, "ready");
      assert.equal((await listEvidenceCandidates(root, targetId)).length, 8);
      assert.equal((await loadProject(root, authoritativeId)).lineage.supersededBy, targetId);
      assert.equal((await loadProject(root, historicalId)).lineage.supersededBy, authoritativeId);
      assert.match(
        await readFile(
          join(
            workspacePaths(root).projects,
            targetId,
            "outputs",
            "inherited-discovery-evidence.json",
          ),
          "utf8",
        ),
        /closest-work-8/,
      );
      await assert.rejects(
        readFile(join(workspacePaths(root).projects, targetId, "outputs", "evidence.json"), "utf8"),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
      );

      const designReviewPacket = await passResearchDesignGate(root, targetId);
      assert.equal(
        designReviewPacket.discoveryRecovery?.contractSha256,
        recovered.discoveryRecovery?.contractSha256,
      );
      const active = await loadProject(root, targetId);
      active.packages.find((item) => item.stage === "discover")!.status = "running";
      active.status = "running";
      await saveProject(root, active);
      const recoveryRequestRequired = nativeEvidenceRequestSchema(
        true,
        recovered.discoveryRecovery ?? null,
      ).required as string[];
      assert.ok(recoveryRequestRequired.includes("formalize_candidate_id"));
      assert.ok(recoveryRequestRequired.includes("max_items"));
      await assert.rejects(
        recordNativeResearchActivity({
          root,
          projectId: targetId,
          value: {
            schemaVersion: 1,
            acquisitionRouteId: "route-native-public-search",
            kind: "web-search",
            channel: "codex.web",
            input: "citation chase without its legal seed",
            candidateIds: [],
            resultCount: 0,
            status: "completed",
            challenge: "none",
          },
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_DISCOVERY_RECOVERY_SCOPE_VIOLATION",
      );
      const newCandidate = await registerNativeDiscoveryCandidate({
        root,
        projectId: targetId,
        value: {
          title: "A citation-chase result requiring identity formalization",
          url: "https://example.test/closest-work-nine",
          publicationDate: "2025",
        },
      });
      await recordNativeResearchActivity({
        root,
        projectId: targetId,
        value: {
          schemaVersion: 1,
          acquisitionRouteId: "route-native-public-search",
          kind: "web-search",
          channel: "codex.web",
          input: "forward and backward citations from a frozen legal seed",
          candidateIds: [newCandidate.candidate.id],
          seedCandidateIds: [registered[0]!.id],
          resultCount: 1,
          status: "completed",
          challenge: "none",
        },
      });
      const progress = await inspectDiscoveryProgress(root, await loadProject(root, targetId));
      assert.equal(progress.recovery?.eligibleCandidates, 8);
      assert.deepEqual(progress.recovery?.pendingFormalizationCandidateIds, [
        newCandidate.candidate.id,
      ]);
      assert.equal(progress.recommendedAction, "formalize-recovery-candidates");
      await assert.rejects(
        fetchNativeCandidateSource({
          root,
          projectId: targetId,
          request: {
            acquisition_route_id: "route-recovery-formalization",
            capability_id: "method.public-source",
            url: "https://source.test/items?q=closest-work-nine",
            max_items: 1,
          },
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_DISCOVERY_RECOVERY_SCOPE_VIOLATION",
      );
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify([
            {
              title: "A citation-chase result requiring identity formalization",
              url: "https://example.test/closest-work-nine",
              publicationDate: "2025",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      await fetchNativeCandidateSource({
        root,
        projectId: targetId,
        request: {
          acquisition_route_id: "route-recovery-formalization",
          capability_id: "method.public-source",
          formalize_candidate_id: newCandidate.candidate.id,
          url: "https://source.test/items?q=closest-work-nine",
          max_items: 1,
        },
      });
      await recordDiscoveryAssessmentBatch({
        root,
        projectId: targetId,
        value: {
          schemaVersion: 1,
          assessments: [
            {
              decision: "admit",
              candidateId: newCandidate.candidate.id,
              sourceId: "closest-work-9",
              sourceType: "academic-paper",
              relevance: "Implements another nearby system-level explanation.",
              quality: { level: "primary", rationale: "Citation-chase identity was formalized." },
              applicability: "Closest-work novelty comparison.",
              coverageDimensions: ["research-question"],
              evidenceRoleIds: ["role-closest-work"],
              limitations: [],
            },
          ],
        },
      });
      const afterFormalization = await inspectDiscoveryProgress(
        root,
        await loadProject(root, targetId),
      );
      assert.equal(afterFormalization.recovery?.eligibleCandidates, 9);
      assert.deepEqual(afterFormalization.recovery?.pendingFormalizationCandidateIds, []);
      await assert.rejects(
        recordDiscoveryAssessmentBatch({
          root,
          projectId: targetId,
          value: {
            schemaVersion: 1,
            assessments: [
              {
                decision: "admit",
                candidateId: registered[0]!.id,
                sourceId: "closest-work-1",
                sourceType: "academic-paper",
                relevance: "Inherited closest work.",
                quality: { level: "primary", rationale: "Owner-registered test evidence." },
                applicability: "Closest-work novelty comparison.",
                coverageDimensions: ["research-question"],
                limitations: [],
              },
            ],
          },
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_DISCOVERY_RECOVERY_SCOPE_VIOLATION",
      );
      await assert.rejects(
        materializeDiscoveryEvidence(root, await loadProject(root, targetId), {
          schemaVersion: 2,
          limitations: [],
          dimensionJudgments: [{ id: "research-question", status: "covered" }],
          gaps: [],
          recoveryDisposition: "minimum-satisfied",
          noveltyDefeatingCandidateIds: [],
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_DISCOVERY_RECOVERY_INCOMPLETE",
      );
      const tenthCandidate = await registerNativeDiscoveryCandidate({
        root,
        projectId: targetId,
        value: {
          title: "The second bounded closest-work result",
          url: "https://example.test/closest-work-ten",
          doi: "10.1234/closest-work-ten",
          publicationDate: "2024",
        },
      });
      await recordNativeResearchActivity({
        root,
        projectId: targetId,
        value: {
          schemaVersion: 1,
          acquisitionRouteId: "route-native-public-search",
          kind: "web-search",
          channel: "codex.web",
          input: "one final backward-citation trace from a frozen legal seed",
          candidateIds: [tenthCandidate.candidate.id],
          seedCandidateIds: [registered[1]!.id],
          resultCount: 1,
          status: "completed",
          challenge: "none",
        },
      });
      const eleventhCandidate = await registerNativeDiscoveryCandidate({
        root,
        projectId: targetId,
        value: {
          title: "A candidate that must remain outside the frozen floor",
          url: "https://example.test/closest-work-eleven",
          doi: "10.1234/closest-work-eleven",
          publicationDate: "2023",
        },
      });
      await recordNativeResearchActivity({
        root,
        projectId: targetId,
        value: {
          schemaVersion: 1,
          acquisitionRouteId: "route-native-public-search",
          kind: "web-search",
          channel: "codex.web",
          input: "a trace completed before the frozen floor was admitted",
          candidateIds: [eleventhCandidate.candidate.id],
          seedCandidateIds: [registered[2]!.id],
          resultCount: 1,
          status: "completed",
          challenge: "none",
        },
      });
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify([
            {
              title: "The second bounded closest-work result",
              url: "https://publisher.test/articles/closest-work-ten",
              doi: "10.1234/closest-work-ten",
              publicationDate: "2024",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      await fetchNativeCandidateSource({
        root,
        projectId: targetId,
        request: {
          acquisition_route_id: "route-recovery-formalization",
          capability_id: "method.public-source",
          formalize_candidate_id: tenthCandidate.candidate.id,
          url: "https://source.test/items?q=closest-work-ten",
          max_items: 1,
        },
      });
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify([
            {
              title: "A candidate that must remain outside the frozen floor",
              url: "https://publisher.test/articles/closest-work-eleven",
              doi: "10.1234/closest-work-eleven",
              publicationDate: "2023",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      await fetchNativeCandidateSource({
        root,
        projectId: targetId,
        request: {
          acquisition_route_id: "route-recovery-formalization",
          capability_id: "method.public-source",
          formalize_candidate_id: eleventhCandidate.candidate.id,
          url: "https://source.test/items?q=closest-work-eleven",
          max_items: 1,
        },
      });
      await assert.rejects(
        recordDiscoveryAssessmentBatch({
          root,
          projectId: targetId,
          value: {
            schemaVersion: 1,
            assessments: [
              {
                decision: "admit",
                candidateId: tenthCandidate.candidate.id,
                sourceId: "closest-work-10",
                sourceType: "academic-paper",
                relevance: "Completes the bounded closest-work novelty comparison.",
                quality: { level: "primary", rationale: "Identity was formalized." },
                applicability: "Closest-work novelty comparison.",
                coverageDimensions: ["research-question"],
                evidenceRoleIds: ["role-closest-work"],
                limitations: [],
              },
              {
                decision: "admit",
                candidateId: eleventhCandidate.candidate.id,
                sourceId: "closest-work-11",
                sourceType: "academic-paper",
                relevance: "Would exceed the frozen closest-work floor.",
                quality: { level: "primary", rationale: "Identity was formalized." },
                applicability: "Closest-work novelty comparison.",
                coverageDimensions: ["research-question"],
                evidenceRoleIds: ["role-closest-work"],
                limitations: [],
              },
            ],
          },
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_DISCOVERY_RECOVERY_SCOPE_VIOLATION",
      );
      await recordDiscoveryAssessmentBatch({
        root,
        projectId: targetId,
        value: {
          schemaVersion: 1,
          assessments: [
            {
              decision: "admit",
              candidateId: tenthCandidate.candidate.id,
              sourceId: "closest-work-10",
              sourceType: "academic-paper",
              relevance: "Completes the bounded closest-work novelty comparison.",
              quality: { level: "primary", rationale: "Identity was formalized." },
              applicability: "Closest-work novelty comparison.",
              coverageDimensions: ["research-question"],
              evidenceRoleIds: ["role-closest-work"],
              limitations: [],
            },
          ],
        },
      });
      const floorReached = await inspectDiscoveryProgress(root, await loadProject(root, targetId));
      assert.equal(floorReached.recovery?.eligibleCandidates, 10);
      assert.equal(floorReached.recommendedAction, "submit-bounded-recovery");
      const recoveredEvidence = await materializeDiscoveryEvidence(
        root,
        await loadProject(root, targetId),
        {
          schemaVersion: 2,
          limitations: [],
          dimensionJudgments: [{ id: "research-question", status: "covered" }],
          gaps: [],
          recoveryDisposition: "minimum-satisfied",
          noveltyDefeatingCandidateIds: [],
        },
      );
      assert.equal((recoveredEvidence.sources as unknown[]).length, 10);
      await assert.rejects(
        recordNativeResearchActivity({
          root,
          projectId: targetId,
          value: {
            schemaVersion: 1,
            acquisitionRouteId: "route-native-public-search",
            kind: "web-search",
            channel: "codex.web",
            input: "an impermissible search after the stop condition",
            candidateIds: [],
            seedCandidateIds: [registered[0]!.id],
            resultCount: 0,
            status: "completed",
            challenge: "none",
          },
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_DISCOVERY_RECOVERY_SCOPE_VIOLATION",
      );
      await assert.rejects(
        fetchNativeCandidateSource({
          root,
          projectId: targetId,
          request: {
            acquisition_route_id: "route-recovery-formalization",
            capability_id: "method.public-source",
            formalize_candidate_id: newCandidate.candidate.id,
            url: "https://source.test/items?q=closest-work-nine",
            max_items: 1,
          },
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_DISCOVERY_RECOVERY_SCOPE_VIOLATION",
      );
      await writeFile(
        join(workspacePaths(root).control, recovered.discoveryRecovery!.objectLocator),
        `${JSON.stringify({ ...recoveryContract, minimumDistinctCandidates: 11 })}\n`,
      );
      await assert.rejects(
        loadProject(root, targetId),
        (error: unknown) =>
          (error as { code?: string }).code === "RESEARCH_DISCOVERY_RECOVERY_BINDING_INVALID",
      );
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});

function policy(projectId: string): ResearchPolicyBinding {
  return {
    goal: "top-journal",
    projectId,
    articleType: "review",
    field: "environmental-science",
    journalClass: "discipline-flagship",
    targetJournal: "International Journal of Pavement Engineering",
    resolvedPolicySha256: "a".repeat(64),
    approvalSha256: "b".repeat(64),
    verdictCeiling: "target-journal-submission-ready",
    documents: [],
    resolvedRules: [],
    resolvedConstraints: {},
    requiredReviewers: ["evidence", "methods-reproducibility", "domain-novelty"],
    approvedAt: "2026-08-31T00:00:00.000Z",
    expiresAt: "2027-08-31T00:00:00.000Z",
  };
}

async function installNetworkCapability(root: string): Promise<void> {
  const skillPath = join(root, "capability-sources", "public-source-fetch");
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    join(skillPath, "SKILL.md"),
    "---\nname: public-source-fetch\ndescription: Formalize one bounded public source.\n---\n",
  );
  const expectedTreeSha256 = await hashRegularTree(skillPath);
  await writeFile(
    workspacePaths(root).capabilityDeclarations,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        capabilities: [
          {
            id: "method.public-source",
            skillPath,
            source: {
              type: "git",
              locator: "https://github.com/example/public-source-skill.git",
              immutableRef: "a".repeat(40),
              expectedTreeSha256,
              license: "MIT",
              catalogId: null,
            },
            permissions: ["project-read", "candidate-write", "brokered-network"],
            allowedHosts: ["source.test"],
            http: {
              endpoint: "https://source.test/",
              method: "GET",
              accept: "application/json",
              allowedContentTypes: ["application/json"],
              maxResponseBytes: 64 * 1024,
              maxItems: 10,
              staticHeaders: {},
            },
            coverage: {
              dimensions: ["*"],
              sourceTypes: ["*"],
              discoveryScopes: ["public-internet"],
              fullText: false,
              publicationDates: true,
            },
            credentials: [],
            healthCheck: {
              url: "https://source.test/?query=connectivity",
              credentialId: null,
              expectedContentTypes: ["application/json"],
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await lockCapabilities(root);
}
