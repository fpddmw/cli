import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/io.js";
import {
  exportProjectAuditBundle,
  verifyProjectAuditBundle,
  type ProjectAuditManifest,
} from "../src/research/workspace/audit-bundle.js";
import { addProjectInput, initializeProject } from "../src/research/workspace/projects.js";
import { regularTreeFiles } from "../src/research/workspace/storage.js";
import { initializeResearchWorkspace } from "../src/research/workspace/workspace.js";

describe("portable research audit bundles", () => {
  it("exports only hash-bound project evidence without host paths or unrelated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-audit-workspace-"));
    const destination = join(tmpdir(), `tiangong-audit-${process.pid}-${Date.now()}`);
    try {
      await initializeResearchWorkspace(root, "Portable audit workspace");
      const projectId = "portable-audit";
      await initializeProject(
        root,
        projectId,
        "Can an independent reviewer reproduce this exact bounded evidence package?",
      );
      const inputPath = join(root, "owner-observation.csv");
      await writeFile(inputPath, "id,value\ncase-1,7\n");
      await addProjectInput(root, projectId, inputPath, "primary");
      await writeFile(join(root, "unrelated-concurrent.pdf"), "%PDF-unrelated\n");

      const exported = await exportProjectAuditBundle({ root, projectId, destination });
      assert.equal(exported.projectId, projectId);
      assert.match(exported.manifestSha256, /^[a-f0-9]{64}$/);
      const verified = await verifyProjectAuditBundle(destination);
      assert.equal(verified.status, "verified");
      const manifest = JSON.parse(
        await readFile(join(destination, "manifest.json"), "utf8"),
      ) as ProjectAuditManifest;
      assert.ok(manifest.files.some((file) => file.path.startsWith("inputs/")));
      assert.ok(manifest.files.some((file) => file.path === "state/project.json"));
      assert.equal(
        manifest.files.some((file) => file.path.includes("unrelated-concurrent.pdf")),
        false,
      );

      const textFiles = await regularTreeFiles(destination);
      const combined = (
        await Promise.all(
          textFiles.map(async (path) => {
            const bytes = await readFile(path);
            return bytes.includes(0) ? "" : bytes.toString("utf8");
          }),
        )
      ).join("\n");
      assert.doesNotMatch(combined, new RegExp(escapeRegExp(root)));

      const cliVerified = await invokeCli([
        "research",
        "project",
        "audit",
        "verify",
        "--bundle",
        destination,
        "--json",
      ]);
      assert.equal(cliVerified.exitCode, 0, cliVerified.stderr);
      assert.equal(JSON.parse(cliVerified.stdout).status, "verified");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
      ]);
    }
  });

  it("fails closed on tampering and a symlinked export destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-audit-integrity-"));
    const destination = join(tmpdir(), `tiangong-audit-integrity-${process.pid}-${Date.now()}`);
    const symlinkPath = `${destination}-link`;
    try {
      await initializeResearchWorkspace(root, "Audit integrity workspace");
      await initializeProject(
        root,
        "audit-integrity",
        "Does every portable audit byte remain exactly bound to its manifest?",
      );
      await exportProjectAuditBundle({ root, projectId: "audit-integrity", destination });
      const projectPath = join(destination, "state", "project.json");
      await chmod(projectPath, 0o600);
      await writeFile(projectPath, '{"tampered":true}\n');
      await assert.rejects(verifyProjectAuditBundle(destination), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "RESEARCH_AUDIT_BUNDLE_INVALID");
        return true;
      });

      await symlink(destination, symlinkPath);
      await assert.rejects(
        exportProjectAuditBundle({
          root,
          projectId: "audit-integrity",
          destination: symlinkPath,
        }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "RESEARCH_AUDIT_BUNDLE_PATH_INVALID");
          return true;
        },
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
        rm(symlinkPath, { force: true }),
      ]);
    }
  });
});

async function invokeCli(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    env: {},
    stdout: { write: (chunk) => ((stdout += chunk), true) },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
  };
  const exitCode = await runCli(argv, io);
  return { exitCode, stdout, stderr };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
