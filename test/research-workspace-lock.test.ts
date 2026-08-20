import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { initializeProject } from "../src/research/workspace/projects.js";
import { clearStaleSetupLock } from "../src/research/workspace/setup.js";
import {
  acquireFileLock,
  canonicalJson,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

describe("research workspace lock crash consistency", () => {
  it("recovers a lock whose real holder process was killed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-workspace-lock-crash-"));
    await initializeResearchWorkspace(root, "Crash-consistent workspace lock");
    const holder = spawn(
      process.execPath,
      ["--import", "tsx", resolve("test/helpers/workspace-lock-holder.ts"), root],
      {
        cwd: resolve("."),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    holder.stderr!.setEncoding("utf8");
    holder.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      await waitForOutput(holder, "LOCK_ACQUIRED");
      assert.equal(holder.kill("SIGKILL"), true);
      await waitForExit(holder);

      const lockPath = join(workspacePaths(root).locks, "workspace.lock");
      assert.equal((await lstat(lockPath)).isDirectory(), true);

      const project = await initializeProject(
        root,
        "recovered-after-crash",
        "Can a definitely dead workspace lock owner be recovered safely?",
      );
      assert.equal(project.id, "recovered-after-crash");
      assert.equal(await lstat(lockPath).catch(() => null), null);

      const journal = (await readFile(workspacePaths(root).journal, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> });
      const recovered = journal.filter((event) => event.type === "workspace.lock.recovered");
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.payload?.previousOperation, "test.crash-consistency.holder");
      assert.equal(JSON.stringify(recovered[0]).includes(root), false);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
      assert.doesNotMatch(stderr, /unexpected|unhandled/iu);
    }
  });

  it("refuses a live owner with safe actionable diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-workspace-lock-live-"));
    await initializeResearchWorkspace(root, "Live workspace lock");
    const holder = spawnLockHolder(root);
    let stderr = "";
    holder.stderr!.setEncoding("utf8");
    holder.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      await waitForOutput(holder, "LOCK_ACQUIRED");
      await assert.rejects(
        initializeProject(
          root,
          "must-not-steal-live-lock",
          "Can an active workspace lock be protected from another writer?",
        ),
        (error: unknown) => {
          const typed = error as {
            code?: string;
            details?: Record<string, unknown>;
          };
          assert.equal(typed.code, "RESEARCH_WORKSPACE_LOCKED");
          assert.equal(typed.details?.ownerState, "alive");
          assert.equal(typed.details?.operation, "test.crash-consistency.holder");
          assert.equal(typeof typed.details?.minimumAction, "string");
          assert.equal(JSON.stringify(typed.details).includes(root), false);
          return true;
        },
      );
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      await waitForExit(holder).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      assert.doesNotMatch(stderr, /unexpected|unhandled/iu);
    }
  });

  it("recovers the legacy file lock left by a killed 0.0.46-style owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-workspace-lock-legacy-"));
    await initializeResearchWorkspace(root, "Legacy workspace lock recovery");
    const lockPath = join(workspacePaths(root).locks, "workspace.lock");
    const deadOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      assert.equal(deadOwner.kill("SIGKILL"), true);
      await waitForExit(deadOwner);
      await writeFile(
        lockPath,
        `${JSON.stringify({
          pid: deadOwner.pid,
          operation: "research.download.bind",
          acquiredAt: "2026-08-20T00:00:00.000Z",
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );

      const project = await initializeProject(
        root,
        "recovered-legacy-lock",
        "Can the released single-file workspace lock be recovered?",
      );
      assert.equal(project.id, "recovered-legacy-lock");
      const journalText = await readFile(workspacePaths(root).journal, "utf8");
      assert.match(journalText, /"reason":"legacy-dead-owner"/u);
      assert.equal(journalText.includes(String(deadOwner.pid)), false);
    } finally {
      if (deadOwner.exitCode === null && deadOwner.signalCode === null) {
        deadOwner.kill("SIGKILL");
      }
      await waitForExit(deadOwner).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a release callback delete a lock after its owner token changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-workspace-lock-owner-token-"));
    const lockPath = join(root, "workspace.lock");
    try {
      const releaseOld = await acquireFileLock(lockPath, {
        pid: process.pid,
        operation: "test.old-owner",
        acquiredAt: new Date().toISOString(),
      });
      const { recordSha256: _recordSha256, ...changedCore } = releaseOld.owner;
      const changedOwner = {
        ...changedCore,
        lockId: "00000000-0000-4000-8000-000000000000",
      };
      await writeJsonAtomic(`${lockPath}.owner.json`, {
        ...changedOwner,
        recordSha256: sha256Text(canonicalJson(changedOwner)),
      });

      await assert.rejects(releaseOld, (error: unknown) => {
        assert.equal((error as { code?: string }).code, "RESEARCH_WORKSPACE_LOCK_COMPROMISED");
        return true;
      });
      assert.notEqual(await lstat(lockPath).catch(() => null), null);
      await writeJsonAtomic(`${lockPath}.owner.json`, releaseOld.owner);
      await releaseOld();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a killed setup lease through the supported retry operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-setup-lock-crash-"));
    await initializeResearchWorkspace(root, "Setup lock crash recovery");
    const holder = spawnLockHolder(root, "setup");
    try {
      await waitForOutput(holder, "LOCK_ACQUIRED");
      assert.equal(holder.kill("SIGKILL"), true);
      await waitForExit(holder);

      await clearStaleSetupLock(root);
      const lockPath = workspacePaths(root).setupLock;
      assert.equal(await lstat(lockPath).catch(() => null), null);
      assert.equal(await lstat(`${lockPath}.owner.json`).catch(() => null), null);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      await waitForExit(holder).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to clear a live setup lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-setup-lock-live-"));
    await initializeResearchWorkspace(root, "Live setup lock");
    const holder = spawnLockHolder(root, "setup");
    try {
      await waitForOutput(holder, "LOCK_ACQUIRED");
      await assert.rejects(clearStaleSetupLock(root), (error: unknown) => {
        const typed = error as { code?: string; details?: Record<string, unknown> };
        assert.equal(typed.code, "RESEARCH_SETUP_LOCK_ACTIVE");
        assert.equal(JSON.stringify(typed).includes(root), false);
        return true;
      });
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      await waitForExit(holder).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});

function spawnLockHolder(root: string, kind = "workspace"): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    ["--import", "tsx", resolve("test/helpers/workspace-lock-holder.ts"), root, kind],
    {
      cwd: resolve("."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function waitForOutput(child: ReturnType<typeof spawn>, marker: string): Promise<void> {
  child.stdout!.setEncoding("utf8");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let output = "";
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for lock holder output: ${output}`));
    }, 10_000);
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timeout);
      resolvePromise();
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (!output.includes(marker)) {
        clearTimeout(timeout);
        rejectPromise(new Error(`Lock holder exited early: code=${code} signal=${signal}`));
      }
    });
  });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error("Lock holder did not exit.")), 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
    child.once("error", rejectPromise);
  });
}
