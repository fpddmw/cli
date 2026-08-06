import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import { startCapabilityBroker } from "../src/research/workspace/broker.js";
import { readAndVerifyProjectInputPlan } from "../src/research/workspace/input-plan.js";
import {
  loadProjectEvidenceReceipts,
  stageProjectEvidence,
} from "../src/research/workspace/evidence.js";
import type { AgentExecutionRequest } from "../src/research/workspace/executor.js";
import {
  addProjectInput,
  forkProject,
  initializeProject,
  loadProject,
  retryProjectPackage,
} from "../src/research/workspace/projects.js";
import { runResearchWorkspace, type PackageExecutor } from "../src/research/workspace/runtime.js";
import { regularTreeFiles, workspacePaths } from "../src/research/workspace/storage.js";
import type { ExecutionResult } from "../src/research/workspace/types.js";
import {
  doctorResearchWorkspace,
  initializeResearchWorkspace,
  verifyDoctorAttestation,
} from "../src/research/workspace/workspace.js";

describe("production research evidence and broker", () => {
  it("persists exact broker evidence and includes verified objects in the review packet", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "broker-evidence", "Evaluate one broker evidence chain.");
      await installNetworkCapability(root, skillParent, {
        accept: "application/vnd.source+json",
        allowedContentTypes: ["application/json"],
        maxResponseBytes: 64 * 1024,
        maxItems: 2,
      });
      let observedAccept = "";
      let sourceFetches = 0;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.startsWith("https://source.test/")) {
          sourceFetches += 1;
          observedAccept = new Headers(init?.headers).get("accept") ?? "";
          return new Response(JSON.stringify({ records: [{ id: 1 }, { id: 2 }, { id: 3 }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      const prefetchCapsule = join(workspacePaths(root).runtime, "prefetch", "project");
      await mkdir(prefetchCapsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "broker-evidence", prefetchCapsule);
      assert.ok(broker);
      let receipt!: Record<string, unknown>;
      let paginatedReceipt!: Record<string, unknown>;
      try {
        const response = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/items?page=1",
            json_pointer: "/records",
            max_items: 1,
          },
        });
        const result = response.result as Record<string, unknown>;
        assert.notEqual(result.isError, true, JSON.stringify(result));
        receipt = JSON.parse(
          String(((result.content as Array<Record<string, unknown>>)[0] ?? {}).text),
        ) as Record<string, unknown>;
        const cachedResponse = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/items?page=1",
            json_pointer: "/records",
            max_items: 1,
          },
        });
        const cachedReceipt = JSON.parse(
          String(
            (
              (
                (cachedResponse.result as Record<string, unknown>).content as Array<
                  Record<string, unknown>
                >
              )[0] ?? {}
            ).text,
          ),
        ) as Record<string, unknown>;
        assert.equal(cachedReceipt.cacheHit, true);
        assert.equal(cachedReceipt.sha256, receipt.sha256);
        const paginatedResponse = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/items?page=1",
            json_pointer: "/records",
            item_offset: 1,
            max_items: 1,
          },
        });
        paginatedReceipt = JSON.parse(
          String(
            (
              (
                (paginatedResponse.result as Record<string, unknown>).content as Array<
                  Record<string, unknown>
                >
              )[0] ?? {}
            ).text,
          ),
        ) as Record<string, unknown>;
      } finally {
        await broker.stop();
      }
      await rm(join(workspacePaths(root).runtime, "prefetch"), {
        recursive: true,
        force: true,
      });

      assert.equal(observedAccept, "application/vnd.source+json");
      assert.equal(sourceFetches, 1);
      assert.match(String(receipt.locator), /^evidence\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
      assert.equal(receipt.contextItems, 1);
      assert.equal(receipt.contextOffset, 0);
      assert.equal(receipt.contextTotalItems, 3);
      assert.equal(receipt.contextNextOffset, 1);
      assert.equal(receipt.contextTruncated, true);
      assert.equal(paginatedReceipt.cacheHit, true);
      assert.equal(paginatedReceipt.sha256, receipt.sha256);
      assert.equal(paginatedReceipt.contextOffset, 1);
      assert.equal(paginatedReceipt.contextTotalItems, 3);
      assert.equal(paginatedReceipt.contextNextOffset, 2);
      const rawPath = join(workspacePaths(root).control, String(receipt.locator));
      const contextPath = join(workspacePaths(root).control, String(receipt.contextLocator));
      assert.deepEqual(JSON.parse(await readFile(rawPath, "utf8")), {
        records: [{ id: 1 }, { id: 2 }, { id: 3 }],
      });
      assert.deepEqual(JSON.parse(await readFile(contextPath, "utf8")), [{ id: 1 }]);
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(workspacePaths(root).control, String(paginatedReceipt.contextLocator)),
            "utf8",
          ),
        ),
        [{ id: 2 }],
      );

      let reviewVerified = false;
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        brokerBackedExecutor(() => {
          reviewVerified = true;
        }),
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.equal(reviewVerified, true);
      const review = JSON.parse(
        await readFile(
          join(workspacePaths(root).projects, "broker-evidence", "outputs", "review.json"),
          "utf8",
        ),
      ) as { packetSha256: string };
      const persistentPacketPath = join(
        workspacePaths(root).projects,
        "broker-evidence",
        "review",
        "packets",
        `${review.packetSha256}.json`,
      );
      const persistentPacket = JSON.parse(await readFile(persistentPacketPath, "utf8")) as {
        packetSha256: string;
        reviewEvidenceContext: { path: string; sha256: string };
      };
      assert.equal(persistentPacket.packetSha256, review.packetSha256);
      assert.equal(
        persistentPacket.reviewEvidenceContext.path,
        `review/contexts/${persistentPacket.reviewEvidenceContext.sha256}.txt`,
      );
      assert.ok(
        await readFile(
          join(
            workspacePaths(root).projects,
            "broker-evidence",
            persistentPacket.reviewEvidenceContext.path,
          ),
        ),
      );
      const closure = JSON.parse(
        await readFile(
          join(workspacePaths(root).projects, "broker-evidence", "outputs", "closure.json"),
          "utf8",
        ),
      ) as { reviewPacket: { path: string; packetSha256: string } };
      assert.equal(closure.reviewPacket.packetSha256, review.packetSha256);
      assert.equal(closure.reviewPacket.path, `review/packets/${review.packetSha256}.json`);
      assert.deepEqual(
        await readFile(rawPath),
        Buffer.from(JSON.stringify({ records: [{ id: 1 }, { id: 2 }, { id: 3 }] })),
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("reports sanitized HTTP failures, Retry-After, and request IDs", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent);
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith("https://source.test/")) {
          return new Response(
            'token=should-not-leak Authorization: Bearer should-not-leak {"error":"limited"}',
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "7",
                "x-request-id": "request-safe-123",
              },
            },
          );
        }
        return originalFetch(input, init);
      };
      const capsule = join(workspacePaths(root).runtime, "http-error", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "http-errors", capsule);
      assert.ok(broker);
      try {
        const response = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/limited?token=request-secret",
          },
        });
        const text = JSON.stringify(response);
        assert.match(text, /RESEARCH_BROKER_HTTP_ERROR/);
        assert.match(text, /retryAfterSeconds\\?":7/);
        assert.match(text, /request-safe-123/);
        assert.doesNotMatch(text, /should-not-leak|request-secret/);
      } finally {
        await broker.stop();
      }
      const workspaceText = await readWorkspaceText(root);
      assert.match(workspaceText, /request-safe-123/);
      assert.doesNotMatch(workspaceText, /should-not-leak|request-secret/);
      assert.equal((await loadProjectEvidenceReceipts(root, "http-errors")).length, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("bounds staged broker context by estimated tokens without truncating permanent evidence", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        budget: { maxBrokerContextTokens: number };
      };
      config.budget.maxBrokerContextTokens = 16;
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await installNetworkCapability(root, skillParent);
      const body = JSON.stringify({ records: [{ value: "x".repeat(200) }, { value: "small" }] });
      globalThis.fetch = async (input, init) =>
        String(input).startsWith("https://source.test/")
          ? new Response(body, {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : originalFetch(input, init);
      const capsule = join(paths.runtime, "context-budget", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "context-budget", capsule);
      assert.ok(broker);
      let receipt!: Record<string, unknown>;
      try {
        const response = await rpc(broker.url, "tools/call", {
          name: "fetch_candidate_source",
          arguments: {
            capability_id: "method.public-source",
            url: "https://source.test/large-context",
            json_pointer: "/records",
          },
        });
        receipt = JSON.parse(
          String(
            (
              (
                (response.result as Record<string, unknown>).content as Array<
                  Record<string, unknown>
                >
              )[0] ?? {}
            ).text,
          ),
        ) as Record<string, unknown>;
      } finally {
        await broker.stop();
      }
      assert.equal(receipt.contextTruncated, true);
      assert.equal(receipt.contextItems, 0);
      assert.ok(Number(receipt.contextEstimatedTokens) <= 16);
      assert.equal(await readFile(join(paths.control, String(receipt.locator)), "utf8"), body);
      assert.deepEqual(
        JSON.parse(await readFile(join(paths.control, String(receipt.contextLocator)), "utf8")),
        [],
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects oversized and undeclared response content without evidence promotion", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent, {
        accept: "application/json",
        allowedContentTypes: ["application/json"],
        maxResponseBytes: 20,
        maxItems: 10,
      });
      let responseKind: "oversized" | "content-type" = "oversized";
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith("https://source.test/")) {
          return responseKind === "oversized"
            ? new Response("x".repeat(21), {
                status: 200,
                headers: { "content-type": "application/json", "content-length": "21" },
              })
            : new Response("plain response", {
                status: 200,
                headers: { "content-type": "text/plain" },
              });
        }
        return originalFetch(input, init);
      };
      const capsule = join(workspacePaths(root).runtime, "bounded", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "bounded-broker", capsule);
      assert.ok(broker);
      try {
        const oversized = await callBroker(broker.url, "https://source.test/oversized");
        assert.match(oversized, /size limit/);
        responseKind = "content-type";
        const mismatched = await callBroker(broker.url, "https://source.test/plain");
        assert.match(mismatched, /unsupported content type/);
      } finally {
        await broker.stop();
      }
      assert.equal((await loadProjectEvidenceReceipts(root, "bounded-broker")).length, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("checks every redirect before fetching the next page", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent);
      const fetched: string[] = [];
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith("https://source.test/")) return originalFetch(input, init);
        fetched.push(url);
        if (url.endsWith("/start")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://source.test/final" },
          });
        }
        if (url.endsWith("/outside")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.test/blocked" },
          });
        }
        return new Response('{"page":1}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const capsule = join(workspacePaths(root).runtime, "redirect", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "redirect-project", capsule);
      assert.ok(broker);
      try {
        const admitted = await callBroker(broker.url, "https://source.test/start");
        assert.doesNotMatch(admitted, /isError|outside/);
        const blocked = await callBroker(broker.url, "https://source.test/outside");
        assert.match(blocked, /outside capability scope/);
      } finally {
        await broker.stop();
      }
      assert.deepEqual(fetched, [
        "https://source.test/start",
        "https://source.test/final",
        "https://source.test/outside",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });

  it("detects missing or tampered content-addressed evidence before staging", async () => {
    const root = await temporaryDirectory();
    const skillParent = await temporaryDirectory();
    const originalFetch = globalThis.fetch;
    try {
      await initializeResearchWorkspace(root, undefined);
      await installNetworkCapability(root, skillParent);
      globalThis.fetch = async (input, init) =>
        String(input).startsWith("https://source.test/")
          ? new Response('{"ok":true}', {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : originalFetch(input, init);
      const capsule = join(workspacePaths(root).runtime, "tamper-source", "project");
      await mkdir(capsule, { recursive: true });
      const broker = await startCapabilityBroker(root, "tamper-project", capsule);
      assert.ok(broker);
      try {
        const text = await callBroker(broker.url, "https://source.test/object");
        assert.doesNotMatch(text, /error/i);
      } finally {
        await broker.stop();
      }
      const [receipt] = await loadProjectEvidenceReceipts(root, "tamper-project");
      assert.ok(receipt);
      const objectPath = join(workspacePaths(root).control, receipt.locator);
      await chmod(objectPath, 0o600);
      await writeFile(objectPath, "tampered");
      await assert.rejects(
        stageProjectEvidence(root, "tamper-project", join(root, "stage-target")),
        /missing or invalid|hash mismatch/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(skillParent, { recursive: true, force: true }),
      ]);
    }
  });
});

describe("production research control plane", () => {
  it("binds full local evidence while embedding only bounded reviewer context", async () => {
    const root = await temporaryDirectory();
    const sourceRoot = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      const fullPath = join(sourceRoot, "full-source.txt");
      const contextPath = join(sourceRoot, "bounded-context.txt");
      await writeFile(fullPath, `${"Full evidence line.\n".repeat(200)}END\n`);
      await writeFile(contextPath, "Bounded evidence excerpt with provenance.\n");
      const planPath = join(sourceRoot, "input-plan.json");
      await writeFile(
        planPath,
        `${JSON.stringify({
          schemaVersion: 1,
          inputs: [
            {
              path: fullPath,
              contextPath,
              role: "primary",
              dimensions: ["research-question"],
              sourceType: "primary",
              fullText: true,
              publicationDate: "2025-01-01",
            },
          ],
        })}\n`,
      );
      const plan = await readAndVerifyProjectInputPlan(planPath);
      await initializeProject(
        root,
        "bounded-local-context",
        "Evaluate bounded local context staging and full evidence review.",
        undefined,
        false,
        plan,
      );
      const base = deterministicExecutor();
      let reviewedFullEvidence = false;
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        async (request) => {
          const stage = stageFrom(request);
          const [input] = JSON.parse(
            await readFile(join(request.projectRoot, "inputs", "manifest.json"), "utf8"),
          ) as Array<{
            id: string;
            path: string;
            sha256: string;
            contextPath: string;
            contextSha256: string;
            fullTextStaged: boolean;
          }>;
          assert.ok(input);
          assert.equal(
            await readFile(join(request.projectRoot, input.contextPath), "utf8"),
            await readFile(contextPath, "utf8"),
          );
          if (stage !== "review") {
            assert.equal(input.fullTextStaged, false);
            assert.equal(
              await lstat(join(request.projectRoot, input.path)).catch(() => null),
              null,
            );
            if (stage === "discover") {
              assert.match(request.prompt, /Bounded evidence excerpt with provenance/);
              assert.doesNotMatch(request.prompt, /Full evidence line/);
              assert.match(request.prompt, new RegExp(input.id));
              const schema = request.outputSchema as {
                properties: {
                  sources: {
                    items: {
                      properties: {
                        provenance: { properties: { id: { enum: string[] } } };
                      };
                    };
                  };
                };
              };
              assert.deepEqual(
                schema.properties.sources.items.properties.provenance.properties.id.enum,
                [input.id],
              );
            }
            if (stage === "analyze") {
              assert.equal(request.toolPolicy, "none");
              assert.equal(request.brokerUrl, null);
              assert.match(request.prompt, /"title":\s*"Input source"/);
            }
            if (stage === "synthesize") {
              assert.equal(request.toolPolicy, "none");
              assert.equal(request.brokerUrl, null);
              assert.match(request.prompt, /The admitted evidence supports a bounded finding/);
            }
          } else {
            assert.equal(input.fullTextStaged, true);
            assert.equal(request.toolPolicy, "none");
            assert.equal(request.maxTurns, 2);
            assert.equal(request.brokerUrl, null);
            assert.match(request.prompt, /### inputs\/review-packet\.json/);
            assert.match(request.prompt, /### inputs\/review-evidence-context\.txt/);
            assert.match(request.prompt, /Bounded evidence excerpt with provenance/);
            assert.doesNotMatch(request.prompt, /Full evidence line/);
            assert.equal(
              await readFile(join(request.projectRoot, input.path), "utf8"),
              await readFile(fullPath, "utf8"),
            );
            const packet = JSON.parse(
              await readFile(join(request.projectRoot, "inputs", "review-packet.json"), "utf8"),
            ) as {
              reviewEvidenceContext: { path: string; sha256: string };
              inputFiles: Array<{ path: string; sha256: string }>;
            };
            assert.match(
              packet.reviewEvidenceContext.path,
              /^review\/contexts\/[0-9a-f]{64}\.txt$/,
            );
            assert.match(packet.reviewEvidenceContext.sha256, /^[0-9a-f]{64}$/);
            assert.deepEqual(
              new Set(packet.inputFiles.map((file) => file.sha256)),
              new Set([input.sha256, input.contextSha256]),
            );
            reviewedFullEvidence = true;
          }
          return base(request);
        },
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.equal(reviewedFullEvidence, true);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(sourceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("repairs malformed structured output once without retrying the whole package", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "repair-json", "Evaluate structured output repair behavior.");
      const input = join(root, "evidence.txt");
      await writeFile(input, "measured evidence\n");
      await addProjectInput(root, "repair-json", input, "primary");
      const calls: Array<{ stage: string; purpose: string }> = [];
      const normal = deterministicExecutor();
      const executor: PackageExecutor = async (request) => {
        const stage = stageFrom(request);
        calls.push({ stage, purpose: request.purpose });
        if (stage === "discover" && request.purpose === "primary") {
          return execution('{"schemaVersion":1,', 5);
        }
        if (stage === "discover" && request.purpose === "repair") {
          assert.equal(request.maxTurns, 1);
          return execution(JSON.stringify(await inputEvidenceValue(request)), 2);
        }
        return normal(request);
      };
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        executor,
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.deepEqual(calls.slice(0, 2), [
        { stage: "discover", purpose: "primary" },
        { stage: "discover", purpose: "repair" },
      ]);
      const project = await loadProject(root, "repair-json");
      assert.equal(project.packages[0]?.attempts, 1);
      assert.equal(project.usage.tokens, 37);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a mechanically invalid provenance binding without repeating research", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "repair-provenance", "Evaluate provenance repair behavior.");
      const input = join(root, "evidence.txt");
      await writeFile(input, "measured evidence\n");
      const admitted = await addProjectInput(root, "repair-provenance", input, "primary");
      const calls: Array<{ stage: string; purpose: string }> = [];
      const normal = deterministicExecutor();
      const executor: PackageExecutor = async (request) => {
        const stage = stageFrom(request);
        calls.push({ stage, purpose: request.purpose });
        if (stage === "discover" && request.purpose === "primary") {
          const value = (await inputEvidenceValue(request)) as {
            sources: Array<{ id: string; provenance: { id: string } }>;
          } & Record<string, unknown>;
          const source = value.sources[0] as { id: string; provenance: { id: string } };
          source.provenance.id = source.id;
          return execution(JSON.stringify(value), 5);
        }
        if (stage === "discover" && request.purpose === "repair") {
          assert.equal(request.maxTurns, 1);
          assert.match(request.prompt, /invalid provenance/);
          assert.match(request.prompt, new RegExp(admitted.id));
          return execution(JSON.stringify(await inputEvidenceValue(request)), 2);
        }
        return normal(request);
      };
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        executor,
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.deepEqual(calls.slice(0, 2), [
        { stage: "discover", purpose: "primary" },
        { stage: "discover", purpose: "repair" },
      ]);
      const project = await loadProject(root, "repair-provenance");
      assert.equal(project.packages[0]?.attempts, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops on deterministic 422 failures but schedules 429 with Retry-After semantics", async () => {
    const deterministicRoot = await temporaryDirectory();
    const rateRoot = await temporaryDirectory();
    const budgetRoot = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(deterministicRoot, undefined);
      await initializeProject(
        deterministicRoot,
        "deterministic-http",
        "Evaluate deterministic HTTP failure behavior.",
      );
      const deterministic = await runResearchWorkspace(
        deterministicRoot,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        async () => execution("", 1, 22, "HTTP 422 invalid Accept header"),
      );
      assert.equal(deterministic.status, "blocked");
      const failed = await loadProject(deterministicRoot, "deterministic-http");
      assert.equal(failed.packages[0]?.attempts, 1);
      assert.equal(failed.packages[0]?.status, "failed");
      assert.equal(failed.packages[0]?.lastFailureKind, "deterministic");

      await initializeResearchWorkspace(rateRoot, undefined);
      await initializeProject(rateRoot, "rate-limited", "Evaluate rate limit retry behavior.");
      const rateLimited = await runResearchWorkspace(
        rateRoot,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        async () => execution("", 1, 29, "HTTP 429 rate limit; Retry-After: 60"),
      );
      assert.equal(rateLimited.status, "ready");
      assert.equal(rateLimited.stopReason, "no-ready-work");
      const retry = await loadProject(rateRoot, "rate-limited");
      assert.equal(retry.packages[0]?.status, "retry");
      assert.equal(retry.packages[0]?.lastFailureKind, "rate-limit");
      assert.ok(Date.parse(retry.packages[0]?.retryNotBefore ?? "") - Date.now() > 55_000);

      await initializeResearchWorkspace(budgetRoot, undefined);
      await initializeProject(budgetRoot, "provider-budget", "Evaluate provider budget failure.");
      const providerBudget = await runResearchWorkspace(
        budgetRoot,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        async () =>
          execution(
            "",
            1,
            1,
            '{"terminal_reason":"budget_exhausted","subtype":"error_max_budget_usd","session_id":"provider-session-value"}',
          ),
      );
      assert.equal(providerBudget.status, "blocked");
      const budgetFailure = await loadProject(budgetRoot, "provider-budget");
      assert.equal(budgetFailure.packages[0]?.lastFailureKind, "budget");
      assert.doesNotMatch(await readWorkspaceText(budgetRoot), /provider-session-value/);
      assert.match(await readWorkspaceText(budgetRoot), /\[REDACTED\]/);

      await initializeProject(
        budgetRoot,
        "provider-turn-limit",
        "Evaluate structured-output turn limit classification.",
      );
      const turnLimited = await runResearchWorkspace(
        budgetRoot,
        {
          maxParallel: 1,
          maxCycles: 1,
          dryRun: false,
          environment: {},
          projectId: "provider-turn-limit",
        },
        async () =>
          execution(
            "",
            1,
            1,
            '{"subtype":"error_max_turns","errors":["Reached maximum number of turns (1)"]}',
          ),
      );
      assert.equal(turnLimited.status, "blocked");
      assert.equal(
        (await loadProject(budgetRoot, "provider-turn-limit")).packages[0]?.lastFailureKind,
        "budget",
      );
    } finally {
      await Promise.all([
        rm(deterministicRoot, { recursive: true, force: true }),
        rm(rateRoot, { recursive: true, force: true }),
        rm(budgetRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("promotes evidence diagnostics but blocks analyze when coverage is insufficient", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "coverage-gate", "Evaluate evidence coverage gating.", {
        dimensions: ["impact", "cost"],
        sourceTypes: ["primary"],
        minSources: 2,
        minFullTextSources: 1,
        minDatedSources: 0,
        publicationDateFrom: null,
        publicationDateTo: null,
      });
      const input = join(root, "one-source.txt");
      await writeFile(input, "one source\n");
      await addProjectInput(root, "coverage-gate", input, "primary");
      let calls = 0;
      const events: Record<string, unknown>[] = [];
      const result = await runResearchWorkspace(
        root,
        {
          maxParallel: 1,
          maxCycles: 5,
          dryRun: false,
          environment: {},
          onProgress: (event) => events.push(event as unknown as Record<string, unknown>),
        },
        async (request) => {
          calls += 1;
          const value = await inputEvidenceValue(request, {
            dimensions: ["impact"],
            coverageDimensions: ["impact"],
            decision: "insufficient",
            gaps: ["missing cost and second source"],
          });
          return execution(JSON.stringify(value));
        },
      );
      assert.equal(result.status, "blocked");
      assert.equal(calls, 1);
      const project = await loadProject(root, "coverage-gate");
      assert.equal(project.packages[0]?.lastFailureKind, "configuration");
      assert.match(project.packages[0]?.lastError ?? "", /requires 2 source/);
      assert.equal(project.packages[1]?.status, "pending");
      assert.match(JSON.stringify(events), /requires 2 source/);
      assert.ok(
        await readFile(
          join(workspacePaths(root).projects, project.id, "outputs", "evidence.json"),
          "utf8",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes derived coverage fields while preserving usable partial coverage", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "partial-coverage", "Evaluate partial evidence coverage.");
      const input = join(root, "partial-source.txt");
      await writeFile(input, "partial source\n");
      await addProjectInput(root, "partial-coverage", input, "primary");
      const normal = deterministicExecutor();
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        async (request) => {
          if (stageFrom(request) !== "discover") return normal(request);
          const value = await inputEvidenceValue(request, {
            gaps: ["No directly normalized comparison."],
          });
          const source = (value.sources as Array<{ fullTextAvailable: boolean }>)[0]!;
          source.fullTextAvailable = false;
          const coverage = value.coverage as {
            dimensions: Array<{ status: string }>;
            sourceTypes: string[];
            fullTextSources: number;
            datedSources: number;
            decision: string;
          };
          coverage.dimensions[0]!.status = "partial";
          coverage.sourceTypes = [];
          coverage.fullTextSources = 0;
          coverage.datedSources = 99;
          coverage.decision = "insufficient";
          return execution(JSON.stringify(value));
        },
      );
      assert.equal(result.status, "complete", JSON.stringify(result));
      const evidence = JSON.parse(
        await readFile(
          join(workspacePaths(root).projects, "partial-coverage", "outputs", "evidence.json"),
          "utf8",
        ),
      ) as {
        sources: Array<{ fullTextAvailable: boolean }>;
        coverage: {
          dimensions: Array<{ status: string }>;
          sourceTypes: string[];
          fullTextSources: number;
          datedSources: number;
          decision: string;
          gaps: string[];
        };
      };
      assert.equal(evidence.coverage.dimensions[0]?.status, "partial");
      assert.equal(evidence.sources[0]?.fullTextAvailable, true);
      assert.deepEqual(evidence.coverage.sourceTypes, ["primary"]);
      assert.equal(evidence.coverage.fullTextSources, 1);
      assert.equal(evidence.coverage.datedSources, 0);
      assert.equal(evidence.coverage.decision, "pass");
      assert.deepEqual(evidence.coverage.gaps, ["No directly normalized comparison."]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not persist sensitive URL parameters, headers, cookies, or tokens", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "sensitive-output", "Evaluate output sanitization behavior.");
      const input = join(root, "source.txt");
      await writeFile(input, "source\n");
      await addProjectInput(root, "sensitive-output", input, "primary");
      const secret = "do-not-persist-secret";
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 2, dryRun: false, environment: {} },
        async (request) => {
          const value = await inputEvidenceValue(request);
          const source = (value.sources as Array<Record<string, unknown>>)[0]!;
          source.url = `https://proxy-user:proxy-password@example.test/paper?token=${secret}&X-Amz-Signature=${secret}#token=${secret}`;
          source.excerpt = `Authorization: Bearer ${secret}; Cookie: session=${secret}`;
          return execution(JSON.stringify(value));
        },
      );
      assert.equal(result.status, "blocked");
      const workspaceText = await readWorkspaceText(root);
      assert.doesNotMatch(workspaceText, new RegExp(secret));
      assert.doesNotMatch(workspaceText, /Bearer do-not|session=do-not/);
      assert.doesNotMatch(workspaceText, /proxy-user|proxy-password/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts configured opaque secrets from failures, journal records, and progress", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "opaque-secret", "Evaluate opaque error redaction behavior.");
      const secret = "opaque-value-9f4c2a7d";
      const events: Record<string, unknown>[] = [];
      const result = await runResearchWorkspace(
        root,
        {
          maxParallel: 1,
          maxCycles: 1,
          dryRun: false,
          environment: { RESEARCH_API_KEY: secret },
          onProgress: (event) => events.push(event as unknown as Record<string, unknown>),
        },
        async () => {
          throw new Error(`provider returned opaque value ${secret}`);
        },
      );
      assert.equal(result.status, "blocked");
      assert.doesNotMatch(await readWorkspaceText(root), new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
      assert.match(await readWorkspaceText(root), /\[REDACTED\]/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks downstream work when dated evidence falls outside the required publication range", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "date-coverage", "Evaluate publication date coverage.", {
        dimensions: ["research-question"],
        sourceTypes: ["primary"],
        minSources: 1,
        minFullTextSources: 1,
        minDatedSources: 1,
        publicationDateFrom: "2020-01-01",
        publicationDateTo: "2024-12-31",
      });
      const input = join(root, "dated-source.txt");
      await writeFile(input, "dated source\n");
      await addProjectInput(root, "date-coverage", input, "primary");
      let calls = 0;
      const result = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 5, dryRun: false, environment: {} },
        async (request) => {
          calls += 1;
          return execution(
            JSON.stringify(
              await inputEvidenceValue(request, {
                publicationDate: "2019-06-01",
                decision: "insufficient",
                gaps: ["publication date is outside the required range"],
              }),
            ),
          );
        },
      );
      assert.equal(result.status, "blocked");
      assert.equal(calls, 1);
      const project = await loadProject(root, "date-coverage");
      assert.equal(project.packages[0]?.lastFailureKind, "configuration");
      assert.match(project.packages[0]?.lastError ?? "", /coverage is insufficient/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a tampered journal before mutating package state", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "journal-guard", "Evaluate journal integrity admission.");
      await appendFile(workspacePaths(root).journal, '{"tampered":true}\n');
      await assert.rejects(
        runResearchWorkspace(
          root,
          { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
          deterministicExecutor(),
        ),
        /journal event|hash check/i,
      );
      const project = await loadProject(root, "journal-guard");
      assert.equal(project.status, "ready");
      assert.equal(project.packages[0]?.status, "ready");
      assert.equal(project.packages[0]?.attempts, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires production preflight inputs and an explicit real sandbox smoke", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined, "production-research");
      const paths = workspacePaths(root);
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        producer: { model: string | null; pricing?: Record<string, number> };
        reviewer: { model: string | null; pricing?: Record<string, number> };
      };
      config.producer.model = "producer-model-pinned";
      config.reviewer.model = "reviewer-model-pinned";
      config.producer.pricing = {
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 2,
      };
      config.reviewer.pricing = { ...config.producer.pricing };
      await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
      await lockCapabilities(root);
      await assert.rejects(
        initializeProject(root, "missing-preflight", "Evaluate production preflight behavior."),
        /explicit evidence requirements/,
      );
      await assert.rejects(
        initializeProject(
          root,
          "missing-confirmation",
          "Evaluate production budget confirmation.",
          {
            dimensions: ["question"],
            sourceTypes: ["primary"],
            minSources: 1,
            minFullTextSources: 1,
            minDatedSources: 1,
            publicationDateFrom: null,
            publicationDateTo: null,
          },
        ),
        /explicit confirmation/,
      );
      const withoutSmoke = await doctorResearchWorkspace(root);
      assert.equal(withoutSmoke.status, "blocked");
      assert.equal(
        withoutSmoke.checks.find((check) => check.id === "agent-sandbox-smoke")?.status,
        "fail",
      );
      const smokeRequests: AgentExecutionRequest[] = [];
      const withSmoke = await doctorResearchWorkspace(root, {
        agentSmoke: true,
        environment: {},
        executor: async (request) => {
          smokeRequests.push(request);
          return execution('{"ok":true}', 1, 0, "", request.route.model, {
            agent: request.route.agent,
            model: request.route.model,
            binarySha256: "a".repeat(64),
            wrapperSha256: "b".repeat(64),
            adapterSha256: "d".repeat(64),
            binaryVersion: "mock 1.0.0",
            platform: process.platform,
            architecture: process.arch,
          });
        },
      });
      assert.equal(withSmoke.status, "ready", JSON.stringify(withSmoke));
      assert.deepEqual(
        smokeRequests.map((request) => request.route.agent),
        ["codex", "claude"],
      );
      assert.ok(smokeRequests.every((request) => request.purpose === "doctor"));
      assert.equal((await verifyDoctorAttestation(root)).status, "verified");
      const driftedConfig = JSON.parse(await readFile(paths.config, "utf8")) as {
        budget: { maxInputContextTokens: number };
      };
      driftedConfig.budget.maxInputContextTokens += 1;
      await writeFile(paths.config, `${JSON.stringify(driftedConfig, null, 2)}\n`);
      assert.equal((await verifyDoctorAttestation(root)).status, "drifted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits JSONL-ready progress and supports explicit retry and fork recovery", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "recover-source", "Evaluate recovery command behavior.");
      const input = join(root, "source.txt");
      await writeFile(input, "source\n");
      await addProjectInput(root, "recover-source", input, "primary");
      const events: Record<string, unknown>[] = [];
      let failOnce = true;
      const normal = deterministicExecutor();
      const first = await runResearchWorkspace(
        root,
        {
          maxParallel: 1,
          maxCycles: 10,
          dryRun: false,
          environment: {},
          onProgress: (event) => events.push(event as unknown as Record<string, unknown>),
        },
        async (request) => {
          if (stageFrom(request) === "analyze" && failOnce) {
            failOnce = false;
            return execution("", 1, 2, "deterministic validation failure");
          }
          return normal(request);
        },
      );
      assert.equal(first.status, "blocked");
      assert.deepEqual(await readdir(workspacePaths(root).runtime), []);
      assert.equal(events[0]?.type, "run.started");
      assert.equal(events.at(-1)?.type, "run.completed");
      assert.ok(events.every((event) => event.requestId === first.requestId));
      const retried = await retryProjectPackage(root, "recover-source", "analyze");
      assert.equal(retried.packages[1]?.status, "ready");
      const completed = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        normal,
      );
      assert.equal(completed.status, "complete", JSON.stringify(completed));

      const forked = await forkProject(root, "recover-source", "recover-fork", "analyze");
      assert.equal(forked.packages[0]?.status, "complete");
      assert.equal(forked.packages[1]?.status, "complete");
      assert.equal(forked.packages[2]?.status, "ready");
      const forkResult = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 10, dryRun: false, environment: {} },
        normal,
      );
      assert.equal(forkResult.status, "complete", JSON.stringify(forkResult));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses closure when the persistent review packet or context is tampered", async () => {
    const root = await temporaryDirectory();
    try {
      await initializeResearchWorkspace(root, undefined);
      await initializeProject(root, "tampered-review-packet", "Evaluate packet immutability.");
      const input = join(root, "packet-source.txt");
      await writeFile(input, "hash-bound source evidence\n");
      await addProjectInput(root, "tampered-review-packet", input, "primary");

      const reviewed = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 4, dryRun: false, environment: {} },
        deterministicExecutor(),
      );
      assert.equal(reviewed.status, "ready", JSON.stringify(reviewed));
      const review = JSON.parse(
        await readFile(
          join(workspacePaths(root).projects, "tampered-review-packet", "outputs", "review.json"),
          "utf8",
        ),
      ) as { packetSha256: string };
      const packetPath = join(
        workspacePaths(root).projects,
        "tampered-review-packet",
        "review",
        "packets",
        `${review.packetSha256}.json`,
      );
      const originalPacket = await readFile(packetPath, "utf8");
      const packet = JSON.parse(originalPacket) as {
        reviewEvidenceContext: { path: string };
      };
      await writeFile(
        packetPath,
        `${JSON.stringify({ packetSha256: review.packetSha256, tampered: true })}\n`,
      );

      const closure = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        deterministicExecutor(),
      );
      assert.equal(closure.status, "blocked", JSON.stringify(closure));
      const project = await loadProject(root, "tampered-review-packet");
      assert.equal(project.packages.at(-1)?.lastFailureKind, "configuration");
      assert.equal(
        await lstat(
          join(workspacePaths(root).projects, "tampered-review-packet", "outputs", "closure.json"),
        ).catch(() => null),
        null,
      );

      await retryProjectPackage(root, "tampered-review-packet", "close");
      await writeFile(packetPath, originalPacket);
      await writeFile(
        join(
          workspacePaths(root).projects,
          "tampered-review-packet",
          packet.reviewEvidenceContext.path,
        ),
        "tampered review evidence context\n",
      );
      const contextClosure = await runResearchWorkspace(
        root,
        { maxParallel: 1, maxCycles: 1, dryRun: false, environment: {} },
        deterministicExecutor(),
      );
      assert.equal(contextClosure.status, "blocked", JSON.stringify(contextClosure));
      assert.match(
        (await loadProject(root, "tampered-review-packet")).packages.at(-1)?.lastError ?? "",
        /review evidence context/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function installNetworkCapability(
  root: string,
  skillParent: string,
  http: {
    accept: string;
    allowedContentTypes: string[];
    maxResponseBytes: number;
    maxItems: number;
  } = {
    accept: "application/json",
    allowedContentTypes: ["application/json"],
    maxResponseBytes: 64 * 1024,
    maxItems: 10,
  },
): Promise<void> {
  const skillPath = join(skillParent, "public-source-fetch");
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    join(skillPath, "SKILL.md"),
    "---\nname: public-source-fetch\ndescription: Fetch bounded public evidence.\n---\n\n# Fetch\n",
  );
  await writeFile(
    workspacePaths(root).capabilityDeclarations,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        capabilities: [
          {
            id: "method.public-source",
            skillPath,
            permissions: ["project-read", "candidate-write", "brokered-network"],
            allowedHosts: ["source.test"],
            http,
            coverage: {
              dimensions: ["research-question"],
              sourceTypes: ["primary"],
              fullText: true,
              publicationDates: true,
            },
            credentials: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await lockCapabilities(root);
}

function brokerBackedExecutor(onReview: () => void): PackageExecutor {
  return async (request) => {
    const stage = stageFrom(request);
    if (stage === "discover") {
      const [receipt] = JSON.parse(
        await readFile(join(request.projectRoot, "inputs", "evidence-receipts.json"), "utf8"),
      ) as Array<Record<string, unknown>>;
      assert.ok(receipt);
      return execution(
        JSON.stringify({
          schemaVersion: 1,
          sources: [
            {
              id: "broker-source",
              title: "Broker source",
              locator: receipt.locator,
              relevance: "Direct evidence.",
              provenance: { kind: "broker", id: receipt.attemptId },
              sourceType: "primary",
              retrievedAt: receipt.retrievedAt,
              fullTextAvailable: true,
              url: null,
              doi: null,
              publicationDate: null,
              excerpt: "One bounded record.",
              jsonPointer: "/records/0",
              quality: { level: "primary", rationale: "Direct response." },
              applicability: "Declared question.",
              coverageDimensions: ["research-question"],
            },
          ],
          limitations: [],
          coverage: {
            dimensions: [
              { id: "research-question", status: "covered", sourceIds: ["broker-source"] },
            ],
            sourceTypes: ["primary"],
            fullTextSources: 1,
            datedSources: 0,
            publicationDateRange: { earliest: null, latest: null },
            decision: "pass",
            gaps: [],
          },
        }),
      );
    }
    if (stage === "review") {
      const packet = JSON.parse(
        await readFile(join(request.projectRoot, "inputs", "review-packet.json"), "utf8"),
      ) as {
        packetSha256: string;
        evidenceFiles: Array<{ path: string; sha256: string }>;
        evidenceReceipts: Array<{ locator: string; sha256: string }>;
      };
      assert.ok(packet.evidenceFiles.length >= 1);
      assert.ok(packet.evidenceReceipts.length >= 1);
      assert.match(request.prompt, /### inputs\/review-evidence-context\.txt/);
      assert.match(request.prompt, /\{"id":1\}/);
      assert.match(request.prompt, /\{"id":2\}/);
      assert.doesNotMatch(request.prompt, /\{"id":3\}/);
      for (const file of packet.evidenceFiles) {
        assert.ok(await readFile(join(request.projectRoot, file.path)));
      }
      onReview();
      return execution(JSON.stringify(reviewValue(packet.packetSha256)));
    }
    return deterministicExecutor()(request);
  };
}

function deterministicExecutor(): PackageExecutor {
  return async (request) => {
    const stage = stageFrom(request);
    if (stage === "discover") return execution(JSON.stringify(await inputEvidenceValue(request)));
    if (stage === "analyze") {
      const evidence = JSON.parse(
        await readFile(join(request.projectRoot, "outputs", "evidence.json"), "utf8"),
      ) as { sources: Array<{ id: string }> };
      const sourceId = evidence.sources[0]?.id ?? "source-1";
      return execution(
        JSON.stringify({
          schemaVersion: 1,
          findings: [
            {
              id: "finding-1",
              statement: "The admitted evidence supports a bounded finding.",
              evidence: [sourceId],
              uncertainty: "Limited to admitted evidence.",
              applicability: "Declared question.",
            },
          ],
          limitations: [],
        }),
      );
    }
    if (stage === "synthesize") {
      return execution(
        JSON.stringify({
          schemaVersion: 1,
          reportMarkdown:
            "# Findings\n\nA bounded finding.\n\n# Uncertainty\n\nLimited evidence.\n\n# Next actions\n\nReview.",
        }),
      );
    }
    if (stage === "review") {
      const packet = JSON.parse(
        await readFile(join(request.projectRoot, "inputs", "review-packet.json"), "utf8"),
      ) as { packetSha256: string };
      return execution(JSON.stringify(reviewValue(packet.packetSha256)));
    }
    throw new Error(`Unexpected stage ${stage}`);
  };
}

async function inputEvidenceValue(
  request: AgentExecutionRequest,
  override: {
    dimensions?: string[];
    coverageDimensions?: string[];
    decision?: "pass" | "insufficient";
    gaps?: string[];
    publicationDate?: string | null;
  } = {},
): Promise<Record<string, unknown>> {
  const state = JSON.parse(await readFile(join(request.projectRoot, "project.json"), "utf8")) as {
    inputs: Array<{ id: string; path: string }>;
  };
  const input = state.inputs[0];
  assert.ok(input);
  const coverageDimensions = override.coverageDimensions ?? ["research-question"];
  const dimensions = override.dimensions ?? coverageDimensions;
  const publicationDate = override.publicationDate ?? null;
  return {
    schemaVersion: 1,
    sources: [
      {
        id: "source-1",
        title: "Input source",
        locator: input.path,
        relevance: "Direct evidence.",
        provenance: { kind: "input", id: input.id },
        sourceType: "primary",
        retrievedAt: "2026-08-06T00:00:00.000Z",
        fullTextAvailable: true,
        url: null,
        doi: null,
        publicationDate,
        excerpt: "Measured evidence.",
        jsonPointer: null,
        quality: { level: "primary", rationale: "Direct input." },
        applicability: "Declared question.",
        coverageDimensions,
      },
    ],
    limitations: [],
    coverage: {
      dimensions: dimensions.map((id) => ({
        id,
        status: coverageDimensions.includes(id) ? "covered" : "missing",
        sourceIds: coverageDimensions.includes(id) ? ["source-1"] : [],
      })),
      sourceTypes: ["primary"],
      fullTextSources: 1,
      datedSources: publicationDate === null ? 0 : 1,
      publicationDateRange: {
        earliest: publicationDate,
        latest: publicationDate,
      },
      decision: override.decision ?? "pass",
      gaps: override.gaps ?? [],
    },
  };
}

function reviewValue(packetSha256: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packetSha256,
    decision: "pass",
    issues: [],
    rationale: "All claims are traceable to verified evidence.",
  };
}

function execution(
  stdout: string,
  tokens = 10,
  exitCode = 0,
  stderr = "",
  model: string | null = null,
  runtime: ExecutionResult["runtime"] = null,
): ExecutionResult {
  const inputTokens = Math.max(0, tokens - 4);
  const cachedInputTokens = tokens > 1 ? 1 : 0;
  const outputTokens = tokens - inputTokens - cachedInputTokens;
  return {
    exitCode,
    stdout,
    stderr,
    tokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: 0,
    wallSeconds: 0.01,
    model,
    runtime,
  };
}

function stageFrom(request: AgentExecutionRequest): string {
  return request.prompt.match(/^Stage: ([a-z]+)$/m)?.[1] ?? "unknown";
}

async function callBroker(url: string, target: string): Promise<string> {
  const response = await rpc(url, "tools/call", {
    name: "fetch_candidate_source",
    arguments: { capability_id: "method.public-source", url: target },
  });
  return String(
    (
      ((response.result as Record<string, unknown>).content as Array<Record<string, unknown>>)[0] ??
      {}
    ).text,
  );
}

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

async function readWorkspaceText(root: string): Promise<string> {
  const files = await regularTreeFiles(workspacePaths(root).control);
  const chunks: string[] = [];
  for (const path of files) chunks.push(await readFile(path, "utf8").catch(() => ""));
  return chunks.join("\n");
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tiangong-research-production-test-"));
}
