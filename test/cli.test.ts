import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_API_BASE_URL, parseArgs, resolveCollectionSelector, runCli } from "../src/cli.js";

describe("parseArgs", () => {
  it("parses positionals, boolean flags, and value flags", () => {
    const parsed = parseArgs(["file.pdf", "--recursive", "--concurrency", "3", "--json=true"]);

    assert.deepEqual(parsed.positionals, ["file.pdf"]);
    assert.equal(parsed.flags.get("recursive"), true);
    assert.equal(parsed.flags.get("concurrency"), "3");
    assert.equal(parsed.flags.get("json"), "true");
  });
});

describe("resolveCollectionSelector", () => {
  it("prefers explicit collection name", () => {
    const selector = resolveCollectionSelector(parseArgs(["--collection-name", "Course Docs"]), {});

    assert.deepEqual(selector, { field: "collection_name", value: "Course Docs" });
  });

  it("rejects legacy env UUID as collection name", () => {
    assert.throws(
      () =>
        resolveCollectionSelector(parseArgs([]), {
          TIANGONG_KB_DEFAULT_COLLECTION_ID: "11111111-1111-4111-8111-111111111111",
        }),
      /Use --collection-id/,
    );
  });
});

describe("defaults", () => {
  it("uses the shared KB API base URL", () => {
    assert.equal(DEFAULT_API_BASE_URL, "https://thuenv.tiangong.world:7300");
  });
});

describe("runCli", () => {
  it("formats async CLI errors without throwing stack traces", async () => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(["kb", "collections"], {
      env: {},
      stdout: { write: (chunk: string) => void (stdout += chunk) },
      stderr: { write: (chunk: string) => void (stderr += chunk) },
    });

    assert.equal(exitCode, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /Missing API key/);
    assert.doesNotMatch(stderr, /CliError:/);
  });

  it("supports nested KB ingest upload alias", async () => {
    let stderr = "";
    const exitCode = await runCli(["kb", "ingest", "upload", "/does/not/exist"], {
      env: { TIANGONG_AI_API_KEY: "fake", TIANGONG_KB_DEFAULT_COLLECTION_KEY: "course/test" },
      stdout: { write: () => undefined },
      stderr: { write: (chunk: string) => void (stderr += chunk) },
    });

    assert.equal(exitCode, 1);
    assert.match(stderr, /Path not found/);
  });

  it("supports nested KB collections list alias", async () => {
    let stderr = "";
    const exitCode = await runCli(["kb", "collections", "list"], {
      env: {},
      stdout: { write: () => undefined },
      stderr: { write: (chunk: string) => void (stderr += chunk) },
    });

    assert.equal(exitCode, 1);
    assert.match(stderr, /Missing API key/);
  });

  it("supports nested KB ingest status alias", async () => {
    let stderr = "";
    const exitCode = await runCli(["kb", "ingest", "status"], {
      env: { TIANGONG_AI_API_KEY: "fake" },
      stdout: { write: () => undefined },
      stderr: { write: (chunk: string) => void (stderr += chunk) },
    });

    assert.equal(exitCode, 1);
    assert.match(stderr, /Usage: tiangong kb status/);
  });
});
