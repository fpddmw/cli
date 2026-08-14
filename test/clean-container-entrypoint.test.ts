import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = join(repoRoot, "scripts", "test-clean-container.sh");

async function withFakeDocker(
  run: (context: { env: NodeJS.ProcessEnv; logPath: string }) => Promise<void>,
) {
  const testRoot = await mkdtemp(join(tmpdir(), "tiangong-clean-container-entrypoint-"));
  const binDir = join(testRoot, "bin");
  const logPath = join(testRoot, "docker.log");
  const dockerPath = join(binDir, "docker");

  try {
    await mkdir(binDir);
    await writeFile(
      dockerPath,
      [
        "#!/bin/sh",
        "set -eu",
        ': "${FAKE_DOCKER_LOG:?}"',
        'printf "%s" "$1" >>"$FAKE_DOCKER_LOG"',
        "shift",
        "for argument do",
        '  printf "\\t%s" "$argument" >>"$FAKE_DOCKER_LOG"',
        "done",
        'printf "\\n" >>"$FAKE_DOCKER_LOG"',
      ].join("\n") + "\n",
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    await run({
      env: {
        ...process.env,
        FAKE_DOCKER_LOG: logPath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      logPath,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

async function readDockerCalls(logPath: string) {
  return (await readFile(logPath, "utf8")).trim().split("\n");
}

describe("clean-container entrypoint", () => {
  it("reuses valid build layers by default while preserving a fresh isolated run", async () => {
    await withFakeDocker(async ({ env, logPath }) => {
      await execFileAsync("sh", [entrypoint], { cwd: repoRoot, env });
      const calls = await readDockerCalls(logPath);
      const build = calls.find((call) => call.startsWith("build\t"));
      const run = calls.find((call) => call.startsWith("run\t"));

      assert.ok(build);
      assert.doesNotMatch(build, /(?:^|\t)--no-cache(?:\t|$)/);
      assert.ok(run);
      assert.match(run, /(?:^|\t)--rm(?:\t|$)/);
      assert.match(run, /(?:^|\t)--network\tnone(?:\t|$)/);
      assert.match(run, /(?:^|\t)--tmpfs\t\/home\/node:/);
    });
  });

  it("uses a cold build only when explicitly requested", async () => {
    await withFakeDocker(async ({ env, logPath }) => {
      await execFileAsync("sh", [entrypoint, "--cold-build"], { cwd: repoRoot, env });
      const calls = await readDockerCalls(logPath);
      const build = calls.find((call) => call.startsWith("build\t"));

      assert.ok(build);
      assert.match(build, /(?:^|\t)--no-cache(?:\t|$)/);
    });
  });

  it("rejects unknown modes before invoking Docker", async () => {
    await withFakeDocker(async ({ env, logPath }) => {
      await assert.rejects(
        execFileAsync("sh", [entrypoint, "--unexpected"], { cwd: repoRoot, env }),
        (error: unknown) => {
          assert.equal((error as { code?: number }).code, 2);
          return true;
        },
      );
      await assert.rejects(readFile(logPath, "utf8"), { code: "ENOENT" });
    });
  });

  it("keeps local TDD cached and makes hosted and release cold builds explicit", async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const qualityWorkflow = await readFile(
      join(repoRoot, ".github", "workflows", "quality-gate.yml"),
      "utf8",
    );
    const publishWorkflow = await readFile(
      join(repoRoot, ".github", "workflows", "publish.yml"),
      "utf8",
    );

    assert.equal(packageJson.scripts["test:clean"], "sh ./scripts/test-clean-container.sh");
    assert.equal(
      packageJson.scripts["test:clean:cold"],
      "sh ./scripts/test-clean-container.sh --cold-build",
    );
    assert.match(qualityWorkflow, /run: npm run test:clean:cold/);
    assert.match(publishWorkflow, /run: npm run test:clean:cold/);
  });
});
