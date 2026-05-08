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
});
