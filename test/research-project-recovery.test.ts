import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { CliError } from "../src/errors.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import { evidenceLedgerPath } from "../src/research/workspace/evidence-ledger.js";
import { readJournal } from "../src/research/workspace/journal.js";
import {
  forkProject,
  initializeProject,
  loadProject,
  retryProjectPackage,
  saveProject,
} from "../src/research/workspace/projects.js";
import { prepareNativeResearchStage } from "../src/research/workspace/runtime.js";
import { pathExists, workspacePaths } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const worker = join(repo, "test", "fixtures", "research-recovery", "crash-worker.mjs");

async function invoke(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env: {},
    stdout: { write: (text: string) => void (stdout += text) },
    stderr: { write: (text: string) => void (stderr += text) },
  });
  return { exitCode, stdout, stderr };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tiangong-project-recovery-"));
  await initializeResearchWorkspace(root, "Synthetic process-crash regression");
  await lockCapabilities(root);
  await initializeProject(root, "source", "Recover a research fork without external execution.");
  return root;
}

function killFork(root: string, point: string) {
  return spawnSync(process.execPath, ["--import", "tsx", worker, root, point], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("committed research project authority and crash recovery", () => {
  for (const point of ["retry-state", "retry-committed"]) {
    it("recovers a report revision and acknowledges its lost response at " + point, async () => {
      const root = await fixture();
      try {
        const source = await loadProject(root, "source");
        for (const item of source.packages) {
          if (["discover", "acquire", "analyze", "synthesize"].includes(item.stage)) {
            item.status = "complete";
            item.completedAt = "2026-09-02T00:00:00.000Z";
          }
          if (item.stage === "review") {
            item.status = "failed";
            item.lastError = "Independent review requested revision.";
            item.lastFailureKind = "configuration";
          }
        }
        await saveProject(root, source);
        const report = join(workspacePaths(root).projects, "source", "outputs", "report.md");
        await writeFile(report, "# Preserved report\n");
        const child = killFork(root, point);
        assert.equal(child.stderr, "");
        assert.equal(await readFile(join(root, "fault-point.txt"), "utf8"), point);
        const recovered = await retryProjectPackage(root, "source", "synthesize");
        assert.equal(
          recovered.packages.find((item) => item.stage === "synthesize")?.status,
          "ready",
        );
        assert.deepEqual(await retryProjectPackage(root, "source", "synthesize"), recovered);
        assert.equal(
          (await readJournal(workspacePaths(root).journal)).filter(
            (event) => event.type === "project.retry.requested",
          ).length,
          1,
        );
        assert.equal(await readFile(report, "utf8"), "# Preserved report\n");
        const archives = await readdir(
          join(workspacePaths(root).projects, "source", "outputs", "revisions", "synthesize"),
        );
        assert.equal(archives.length, 1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  for (const point of ["target-directory", "target-state", "source-state"]) {
    it(`keeps one consistent authority after a fork crash at ${point}`, async () => {
      const root = await fixture();
      try {
        const child = killFork(root, point);
        assert.equal(child.stderr, "");
        assert.equal(await readFile(join(root, "fault-point.txt"), "utf8"), point);
        assert.ok(child.signal || child.status !== 0);
        const events = await readJournal(workspacePaths(root).journal);
        const committed = events.some(
          (event) => event.type === "project.forked" && event.scope === "target",
        );
        const status = await invoke(["research", "status", "--workspace", root, "--json"]);
        assert.equal(status.exitCode, 0, status.stderr);
        const projects = JSON.parse(status.stdout).projects as Array<{
          id: string;
          authority: { state: string };
        }>;
        const authoritative = projects.filter(
          (project) => project.authority.state === "authoritative",
        );
        assert.deepEqual(
          authoritative.map((project) => project.id),
          [committed ? "target" : "source"],
        );
        if (!committed) {
          const prepared = await invoke([
            "research",
            "project",
            "stage",
            "prepare",
            "target",
            "--stage",
            "discover",
            "--host-agent",
            "codex",
            "--workspace",
            root,
            "--json",
          ]);
          assert.notEqual(
            prepared.exitCode,
            0,
            "An uncommitted target must not receive a native packet",
          );
          assert.equal(
            (await readJournal(workspacePaths(root).journal)).some(
              (event) => event.type === "native.stage.prepared" && event.scope === "target",
            ),
            false,
          );
        }
        const recovered = await forkProject(root, "source", "target");
        assert.equal(recovered.id, "target");
        assert.equal((await loadProject(root, "source")).lineage.supersededBy, "target");
        const replay = await forkProject(root, "source", "target");
        assert.deepEqual(replay, recovered);
        assert.equal(
          (await readJournal(workspacePaths(root).journal)).filter(
            (event) => event.type === "project.forked" && event.scope === "target",
          ).length,
          1,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("acknowledges a committed fork after its response is lost without repeating work", async () => {
    const root = await fixture();
    try {
      const child = killFork(root, "committed");
      assert.equal(child.stderr, "");
      assert.equal(await readFile(join(root, "fault-point.txt"), "utf8"), "committed");
      const targetBefore = await loadProject(root, "target");
      const replay = await forkProject(root, "source", "target");
      assert.deepEqual(replay, targetBefore);
      assert.equal(
        (await readJournal(workspacePaths(root).journal)).filter(
          (event) => event.type === "project.forked" && event.scope === "target",
        ).length,
        1,
      );
      await assert.rejects(
        forkProject(root, "source", "target", "discover"),
        (error: unknown) => error instanceof CliError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not leave a false supersession ledger entry when the fork commit fails", async () => {
    const root = await fixture();
    try {
      const child = killFork(root, "before-commit");
      assert.equal(child.status, 0, child.stderr);
      assert.equal(await readFile(join(root, "fault-point.txt"), "utf8"), "before-commit");
      assert.equal((await loadProject(root, "source")).lineage.supersededBy, null);
      assert.equal(await pathExists(join(workspacePaths(root).projects, "target")), false);
      const ledger = await readJournal(evidenceLedgerPath(root, "source"));
      assert.equal(
        ledger.some((event) => event.type === "project.superseded"),
        false,
      );
      assert.equal((await forkProject(root, "source", "target")).id, "target");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies the same historical authority guard to public native prepare", async () => {
    const root = await fixture();
    try {
      await forkProject(root, "source", "target");
      const before = await loadProject(root, "source");
      await assert.rejects(
        prepareNativeResearchStage({
          root,
          projectId: "source",
          stage: "discover",
          hostAgent: "codex",
        }),
        (error: unknown) =>
          error instanceof CliError && error.code === "RESEARCH_PROJECT_NOT_AUTHORITATIVE",
      );
      assert.deepEqual(await loadProject(root, "source"), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
