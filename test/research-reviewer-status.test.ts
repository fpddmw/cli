import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import {
  initializeResearchWorkspace,
  loadWorkspaceConfig,
} from "../src/research/workspace/workspace.js";
import { workspacePaths, writeJsonAtomic } from "../src/research/workspace/storage.js";
import { researchPlatformCapabilities } from "../src/research/workspace/platform-capabilities.js";

describe("transport-aware reviewer operator commands", () => {
  it("does not prescribe an impossible production attestation loop for smoke configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-smoke-review-status-"));
    try {
      await initializeResearchWorkspace(root, "Smoke reviewer status");
      const config = await loadWorkspaceConfig(root);
      config.reviewer.binary = process.execPath;
      await writeJsonAtomic(workspacePaths(root).config, config);
      const result = await invoke([
        "research",
        "reviewer",
        "status",
        "--workspace",
        root,
        "--json",
      ]);
      const value = JSON.parse(result.stdout);
      assert.equal(value.readinessScope, "smoke-configuration");
      assert.equal(value.doctorAttestation.status, "not-required");
      if (researchPlatformCapabilities().nativeIsolationProvider) {
        assert.equal(value.status, "ready");
        assert.equal(result.exitCode, 0);
        assert.equal(value.minimumAction, null);
      }
      assert.equal(value.productionReady, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports native-direct readiness without requiring a bridge connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-native-review-status-"));
    try {
      await initializeResearchWorkspace(root, "Native reviewer status");
      const result = await invoke([
        "research",
        "reviewer",
        "status",
        "--workspace",
        root,
        "--json",
      ]);
      assert.equal(result.stderr, "");
      const value = JSON.parse(result.stdout);
      assert.equal(value.transport, "native-direct");
      assert.equal(value.status, "blocked");
      assert.equal(result.exitCode, 3);
      assert.equal(value.doctorAttestation.status, "not-required");
      assert.ok(
        value.errors.some(
          (error: { code: string }) => error.code === "RESEARCH_EXECUTOR_UNAVAILABLE",
        ),
      );
      assert.doesNotMatch(result.stdout, /Start.*sidecar|RESEARCH_REVIEW_BRIDGE_UNAVAILABLE/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes early scientific review execution help before workspace lookup", async () => {
    const result = await invoke([
      "research",
      "project",
      "scientific",
      "review",
      "execute",
      "--help",
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /scientific review execute/u);
    assert.match(result.stdout, /confirm-agent-smoke-cost|confirm-review-cost/u);
  });
});

async function invoke(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env: { PATH: "/intentionally-empty-reviewer-path" },
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
      },
    },
  });
  return { exitCode, stdout, stderr };
}
