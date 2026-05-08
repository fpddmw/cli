import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("parses v1 collection list envelopes", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            collections: [
              {
                id: "183973c7-8ee8-473d-89bf-048a2d3b771c",
                name: "THU Humanities",
                key: "course/thu_humanities_alias",
                path: "/course/thu_humanities_alias",
              },
              {
                id: "2d498a3f-b3af-4dd7-b467-fd245ad1df42",
                name: "THU Humanities Camel",
                collectionKey: "course/thu_humanities",
                collectionPath: "/course/thu_humanities",
              },
              {
                id: "b7035f3f-396b-40aa-a650-b0c92ca812c5",
                name: "THU Humanities Snake",
                collection_key: "course/thu_humanities_snake",
                collection_path: "/course/thu_humanities_snake",
              },
            ],
            limit: 100,
            offset: 0,
          },
          request_id: "req_test",
          api_version: "v1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(["kb", "collections", "list"], {
        env: { TIANGONG_AI_API_KEY: "fake" },
        stdout: { write: (chunk: string) => void (stdout += chunk) },
        stderr: { write: () => undefined },
      });

      assert.equal(exitCode, 0);
      assert.equal(
        stdout,
        [
          "THU Humanities\tcourse/thu_humanities_alias\t/course/thu_humanities_alias\t183973c7-8ee8-473d-89bf-048a2d3b771c",
          "THU Humanities Camel\tcourse/thu_humanities\t/course/thu_humanities\t2d498a3f-b3af-4dd7-b467-fd245ad1df42",
          "THU Humanities Snake\tcourse/thu_humanities_snake\t/course/thu_humanities_snake\tb7035f3f-396b-40aa-a650-b0c92ca812c5",
          "",
        ].join("\n"),
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("resolves collection names from v1 collection envelopes before upload", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-test-"));
    const filePath = join(tempDir, "sample.txt");
    const manifestPath = join(tempDir, "manifest.jsonl");
    await writeFile(filePath, "sample upload content\n");

    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/collections?")) {
        return new Response(
          JSON.stringify({
            data: {
              collections: [
                {
                  id: "183973c7-8ee8-473d-89bf-048a2d3b771c",
                  name: "THU Humanities",
                  collectionPath: "/course/thu_humanities",
                },
              ],
            },
            request_id: "req_collections",
            api_version: "v1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      assert.ok(url.endsWith("/documents"));
      assert.equal(init?.method, "POST");
      assert.equal((init?.body as FormData).get("collection_path"), "/course/thu_humanities");
      return new Response(
        JSON.stringify({
          data: {
            documentId: "doc_123",
            status: "parse_queued",
            duplicate: false,
            requestId: "req_upload",
            idempotencyKey: "idem_123",
          },
          request_id: "req_upload",
          api_version: "v1",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "upload",
          filePath,
          "--collection-name",
          "THU Humanities",
          "--manifest",
          manifestPath,
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      const summary = JSON.parse(stdout);
      assert.equal(summary.uploaded, 1);
      assert.equal(summary.results[0].documentId, "doc_123");
      assert.equal(summary.results[0].duplicate, false);
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports nested KB ingest status alias", async () => {
    let stderr = "";
    const exitCode = await runCli(["kb", "ingest", "status"], {
      env: { TIANGONG_AI_API_KEY: "fake" },
      stdout: { write: () => undefined },
      stderr: { write: (chunk: string) => void (stderr += chunk) },
    });

    assert.equal(exitCode, 1);
    assert.match(stderr, /Usage: tiangong-ai kb status/);
  });
});
