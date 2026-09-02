import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

describe("transport-aware reviewer operator commands", () => {
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
      assert.equal(value.doctorAttestation.status, "missing");
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
