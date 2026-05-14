import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { inflateRawSync } from "node:zlib";

import sharp from "sharp";

import { DEFAULT_API_BASE_URL, parseArgs, resolveCollectionSelector, runCli } from "../src/cli.js";

function pipelineHealthPayload(action: "continue" | "slow_down" | "pause_top_up" = "continue") {
  return {
    data: {
      healthy: action === "continue",
      pressure: action === "continue" ? "ok" : action === "slow_down" ? "degraded" : "paused",
      recommendedAction: action,
      recommendedPollAfterSeconds: 1,
      checkedAt: "2026-05-11T00:00:00.000Z",
      queues: {},
      retries: {},
      workers: {},
      indexPreflight: { status: "healthy", message: null },
    },
  };
}

function isPipelineHealthUrl(input: string) {
  return new URL(input).pathname.endsWith("/pipeline/health");
}

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

  it("routes upload compatibility through bulk and collection-name resolution", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-test-"));
    const filePath = join(tempDir, "sample.txt");
    const statePath = join(tempDir, "job.sqlite");
    const schemaPath = join(tempDir, "schema.json");
    await writeFile(filePath, "sample upload content\n");
    await writeFile(schemaPath, JSON.stringify({ metadataSchema: { fields: [] } }));

    const previousFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
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

      if (url.endsWith("/documents") && init?.method === "POST") {
        assert.equal((init.body as FormData).get("collection_path"), "/course/thu_humanities");
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
      }
      if (url.endsWith("/documents/status:batch") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            data: {
              results: [
                {
                  documentId: "doc_123",
                  ok: true,
                  status: {
                    documentId: "doc_123",
                    status: "completed",
                    opensearchIndexed: true,
                    pineconeIndexed: true,
                    indexRecordCount: 1,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (isPipelineHealthUrl(url)) {
        return new Response(JSON.stringify(pipelineHealthPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
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
          "--schema-file",
          schemaPath,
          "--state",
          statePath,
          "--poll-interval",
          "0.01",
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
      assert.equal(summary.completed, 1);
      assert.equal(summary.failed, 0);
      assert.equal(summary.statePath, statePath);
      assert.ok(requestedUrls.some((url) => url.includes("/collections?")));
      await assert.rejects(stat(join(tempDir, "manifest.jsonl")));
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects removed JSONL manifest upload checkpoints", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-manifest-"));
    const filePath = join(tempDir, "sample.txt");
    const manifestPath = join(tempDir, "manifest.jsonl");
    await writeFile(filePath, "sample upload content\n");

    try {
      let stderr = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "upload",
          filePath,
          "--collection-path",
          "/course/thu_humanities",
          "--manifest",
          manifestPath,
          "--wait",
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: () => undefined },
          stderr: { write: (chunk: string) => void (stderr += chunk) },
        },
      );

      assert.equal(exitCode, 1);
      assert.match(stderr, /--manifest option was removed/);
      await assert.rejects(stat(manifestPath));
    } finally {
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
    assert.match(stderr, /Usage: tiangong-ai kb ingest status/);
  });

  it("scans bulk folders with structural JSON coverage", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-bulk-scan-"));
    await mkdir(join(tempDir, "courseA", "2026-01"), { recursive: true });
    await mkdir(join(tempDir, "teacher", "zhang"), { recursive: true });
    await writeFile(join(tempDir, "courseA", "2026-01", "week-01.pdf"), "pdf");
    await writeFile(join(tempDir, "teacher", "zhang", "notes.txt"), "notes");

    try {
      let stdout = "";
      const exitCode = await runCli(["kb", "ingest", "bulk", "scan", tempDir, "--json"], {
        env: {},
        stdout: { write: (chunk: string) => void (stdout += chunk) },
        stderr: { write: () => undefined },
      });

      assert.equal(exitCode, 0);
      const payload = JSON.parse(stdout);
      assert.equal(payload.totalFiles, 2);
      assert.equal(payload.extensions[".pdf"], 1);
      assert.equal(payload.extensions[".txt"], 1);
      assert.ok(payload.patterns.length >= 2);
      assert.ok(
        payload.samples.some((sample: { path: string }) => sample.path.endsWith("week-01.pdf")),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("dry-runs layered metadata maps with machine-readable validation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-bulk-dry-run-"));
    const rootDir = join(tempDir, "root");
    const metadataMapPath = join(tempDir, "metadata-map.yaml");
    const invalidMetadataMapPath = join(tempDir, "invalid-metadata-map.yaml");
    const schemaPath = join(tempDir, "schema.json");
    await mkdir(join(rootDir, "CS101", "2026-01", "lecture"), { recursive: true });
    await writeFile(join(rootDir, "CS101", "2026-01", "lecture", "week-02.pdf"), "pdf");
    await writeFile(
      metadataMapPath,
      [
        "version: 1",
        "rule_mode: layered",
        "defaults:",
        "  source: local_bulk_upload",
        "layers:",
        "  - name: base",
        "    merge: all",
        "    rules:",
        "      - name: filesystem",
        "        match:",
        '          glob: "**/*"',
        "        fields:",
        "          relative_path:",
        "            source: relative_path",
        "          filename:",
        "            source: filename",
        "          material_type: attachment",
        "          tags: [thu_humanities]",
        "  - name: domain",
        "    merge: first_match",
        "    rules:",
        "      - name: course_layout",
        "        match:",
        '          glob: "*/*/**/*"',
        "        fields:",
        "          course_code:",
        "            source: path_segment",
        "            index: 0",
        "  - name: detectors",
        "    merge: all",
        "    rules:",
        "      - name: week_detector",
        "        match:",
        '          regex: "week[-_]?[0-9]+"',
        "        fields:",
        "          week:",
        "            source: relative_path",
        '            regex: "week[-_]?(\\\\d+)"',
        "            type: number",
        "          year:",
        "            source: relative_path",
        '            regex: "(20[0-9]{2})"',
        "            type: number",
        "",
      ].join("\n"),
    );
    await writeFile(
      invalidMetadataMapPath,
      [
        "version: 1",
        "layers:",
        "  - name: base",
        "    rules:",
        "      - name: bad_tags",
        "        fields:",
        "          tags: thu_humanities",
        "",
      ].join("\n"),
    );
    await writeFile(
      schemaPath,
      JSON.stringify({
        metadataSchema: {
          fields: [
            { key: "course_code", type: "string", required: true },
            { key: "relative_path", type: "string", required: true },
            { key: "material_type", type: "enum", values: ["attachment"], required: true },
            { key: "tags", type: "tag_array", required: true },
            { key: "week", type: "number", required: false },
            { key: "year", type: "number", required: false },
          ],
        },
      }),
    );

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          "dry-run",
          rootDir,
          "--metadata-map",
          metadataMapPath,
          "--schema-file",
          schemaPath,
          "--json",
        ],
        {
          env: {},
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      const payload = JSON.parse(stdout);
      assert.equal(payload.validRate, 1);
      assert.equal(payload.ruleCoverage.course_layout, 1);
      assert.equal(payload.ruleCoverage.week_detector, 1);
      assert.deepEqual(payload.requiredMissing, {});

      let aliasStdout = "";
      const aliasExitCode = await runCli(
        [
          "kb",
          "ingest",
          "metadata",
          "dry-run",
          rootDir,
          "--metadata-map",
          metadataMapPath,
          "--schema-file",
          schemaPath,
          "--json",
        ],
        {
          env: {},
          stdout: { write: (chunk: string) => void (aliasStdout += chunk) },
          stderr: { write: () => undefined },
        },
      );
      assert.equal(aliasExitCode, 0);
      assert.equal(JSON.parse(aliasStdout).validRate, 1);

      let invalidStdout = "";
      const invalidExitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          "dry-run",
          rootDir,
          "--metadata-map",
          invalidMetadataMapPath,
          "--schema-file",
          schemaPath,
          "--json",
        ],
        {
          env: {},
          stdout: { write: (chunk: string) => void (invalidStdout += chunk) },
          stderr: { write: () => undefined },
        },
      );
      assert.equal(invalidExitCode, 1);
      assert.equal(JSON.parse(invalidStdout).typeErrors.tags, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs bulk ingest through SQLite checkpoint and batch status", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-bulk-run-"));
    const rootDir = join(tempDir, "root");
    const statePath = join(tempDir, "job.sqlite");
    const schemaPath = join(tempDir, "schema.json");
    await mkdir(join(rootDir, "CS101"), { recursive: true });
    await writeFile(join(rootDir, "CS101", "week-01.txt"), "one");
    await writeFile(join(rootDir, "CS101", "week-02.txt"), "two");
    await writeFile(schemaPath, JSON.stringify({ metadataSchema: { fields: [] } }));

    const previousFetch = globalThis.fetch;
    const uploadedIds: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/documents") && init?.method === "POST") {
        const documentId = `doc_${uploadedIds.length + 1}`;
        uploadedIds.push(documentId);
        return new Response(JSON.stringify({ data: { documentId, duplicate: false } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/documents/status:batch") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            data: {
              results: body.documentIds.map((documentId: string) => ({
                documentId,
                ok: true,
                status: {
                  documentId,
                  status: "completed",
                  opensearchIndexed: true,
                  pineconeIndexed: true,
                  indexRecordCount: 1,
                },
              })),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (isPipelineHealthUrl(url)) {
        return new Response(JSON.stringify(pipelineHealthPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          "run",
          rootDir,
          "--collection-path",
          "/course/test",
          "--schema-file",
          schemaPath,
          "--state",
          statePath,
          "--window-size",
          "1",
          "--top-up-max",
          "1",
          "--poll-interval",
          "0.01",
          "--max-polls",
          "5",
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      const payload = JSON.parse(stdout);
      assert.equal(payload.completed, 2);
      assert.equal(payload.failed, 0);
      assert.equal(payload.statePath, statePath);
      assert.equal(uploadedIds.length, 2);
      assert.ok((await stat(statePath)).isFile());
      await assert.rejects(stat(join(rootDir, ".tiangong-kb-ingest-manifest.jsonl")));
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps completed documents waiting when status APIs omit index flags", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-bulk-status-flags-"));
    const rootDir = join(tempDir, "root");
    const statePath = join(tempDir, "job.sqlite");
    const schemaPath = join(tempDir, "schema.json");
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "sample.txt"), "sample");
    await writeFile(schemaPath, JSON.stringify({ metadataSchema: { fields: [] } }));

    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/documents") && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { documentId: "doc_wait" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/documents/status:batch")) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/documents/doc_wait/status")) {
        return new Response(
          JSON.stringify({ data: { documentId: "doc_wait", status: "completed", terminal: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (isPipelineHealthUrl(url)) {
        return new Response(JSON.stringify(pipelineHealthPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          rootDir,
          "--collection-path",
          "/course/test",
          "--schema-file",
          schemaPath,
          "--state",
          statePath,
          "--window-size",
          "1",
          "--top-up-max",
          "1",
          "--poll-interval",
          "0.01",
          "--max-polls",
          "2",
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      const payload = JSON.parse(stdout);
      assert.equal(payload.completed, 0);
      assert.equal(payload.waitingForIndexFlags, 1);

      let statusOut = "";
      const statusCode = await runCli(["kb", "ingest", "status", statePath, "--json"], {
        env: {},
        stdout: { write: (chunk: string) => void (statusOut += chunk) },
        stderr: { write: () => undefined },
      });
      assert.equal(statusCode, 0);
      assert.equal(JSON.parse(statusOut).summary.waitingForIndexFlags, 1);
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks only the affected row failed for per-document batch status errors", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-bulk-partial-status-"));
    const rootDir = join(tempDir, "root");
    const statePath = join(tempDir, "job.sqlite");
    const schemaPath = join(tempDir, "schema.json");
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "good.txt"), "good");
    await writeFile(join(rootDir, "bad.txt"), "bad");
    await writeFile(schemaPath, JSON.stringify({ metadataSchema: { fields: [] } }));

    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/documents") && init?.method === "POST") {
        const form = init.body as FormData;
        const name = String((form.get("file") as File).name);
        return new Response(
          JSON.stringify({ data: { documentId: name.includes("good") ? "doc_good" : "doc_bad" } }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/documents/status:batch")) {
        return new Response(
          JSON.stringify({
            data: {
              results: [
                {
                  documentId: "doc_good",
                  ok: true,
                  status: {
                    documentId: "doc_good",
                    status: "completed",
                    opensearchIndexed: true,
                    pineconeIndexed: true,
                    indexRecordCount: 1,
                  },
                },
                {
                  documentId: "doc_bad",
                  ok: false,
                  error: { code: "DOCUMENT_NOT_FOUND", message: "missing", retryable: false },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (isPipelineHealthUrl(url)) {
        return new Response(JSON.stringify(pipelineHealthPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          rootDir,
          "--collection-path",
          "/course/test",
          "--schema-file",
          schemaPath,
          "--state",
          statePath,
          "--poll-interval",
          "0.01",
          "--max-polls",
          "3",
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 1);
      const payload = JSON.parse(stdout);
      assert.equal(payload.completed, 1);
      assert.equal(payload.failed, 1);
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pauses bulk upload top-up when pipeline health says pause_top_up", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-bulk-health-pause-"));
    const rootDir = join(tempDir, "root");
    const statePath = join(tempDir, "job.sqlite");
    const schemaPath = join(tempDir, "schema.json");
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "one.txt"), "one");
    await writeFile(schemaPath, JSON.stringify({ metadataSchema: { fields: [] } }));

    const previousFetch = globalThis.fetch;
    let uploads = 0;
    let healthUrl = "";
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (isPipelineHealthUrl(url)) {
        healthUrl = url;
        return new Response(JSON.stringify(pipelineHealthPayload("pause_top_up")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/documents") && init?.method === "POST") {
        uploads += 1;
        return new Response(JSON.stringify({ data: { documentId: "doc_never" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          rootDir,
          "--collection-path",
          "/course/test",
          "--schema-file",
          schemaPath,
          "--state",
          statePath,
          "--poll-interval",
          "0.01",
          "--max-polls",
          "1",
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      const payload = JSON.parse(stdout);
      assert.equal(payload.pending, 1);
      assert.equal(payload.pipelineHealth.recommendedAction, "pause_top_up");
      assert.equal(new URL(healthUrl).searchParams.get("collection_path"), "/course/test");
      assert.equal(uploads, 0);
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses collection resolve maxUploadBytes for bulk preflight", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-resolve-max-"));
    const rootDir = join(tempDir, "root");
    await mkdir(rootDir, { recursive: true });
    const largePath = join(rootDir, "large.txt");
    await writeFile(largePath, "");
    await truncate(largePath, 41 * 1024 * 1024);

    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      assert.ok(url.includes("/collections/resolve?"));
      return new Response(
        JSON.stringify({
          data: {
            collection: {
              id: "22222222-2222-4222-8222-222222222222",
              key: "course/test",
              path: "/course/test",
              maxUploadBytes: 209715200,
              metadataSchema: { fields: [] },
            },
          },
          request_id: "req_resolve",
          api_version: "v1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          "preflight",
          rootDir,
          "--collection-path",
          "/course/test",
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      const payload = JSON.parse(stdout);
      assert.equal(payload.maxUploadBytes, 209715200);
      assert.equal(payload.classificationCounts.direct_upload, 1);
      assert.equal(payload.blockedCount, 0);
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to 200MiB when collection resolve omits maxUploadBytes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-default-max-"));
    const rootDir = join(tempDir, "root");
    await mkdir(rootDir, { recursive: true });
    const largePath = join(rootDir, "large.txt");
    await writeFile(largePath, "");
    await truncate(largePath, 41 * 1024 * 1024);

    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      assert.ok(url.includes("/collections/resolve?"));
      return new Response(
        JSON.stringify({
          data: {
            collection: {
              id: "22222222-2222-4222-8222-222222222222",
              key: "course/test",
              path: "/course/test",
              metadataSchema: { fields: [] },
            },
          },
          request_id: "req_resolve",
          api_version: "v1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          "preflight",
          rootDir,
          "--collection-path",
          "/course/test",
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      const payload = JSON.parse(stdout);
      assert.equal(payload.maxUploadBytes, 200 * 1024 * 1024);
      assert.equal(payload.classificationCounts.direct_upload, 1);
      assert.equal(payload.blockedCount, 0);
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("dry-runs bulk preflight classification counts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-preflight-dry-run-"));
    const rootDir = join(tempDir, "root");
    const schemaPath = join(tempDir, "schema.json");
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "direct.txt"), "direct");
    await writeStoredZip(join(rootDir, "small.docx"), [
      ["[Content_Types].xml", Buffer.from("<Types></Types>")],
      [
        "word/document.xml",
        Buffer.from(
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>',
        ),
      ],
    ]);
    await writeFile(join(rootDir, "empty.txt"), "");
    await writeFile(join(rootDir, "unsupported.exe"), "binary");
    await writeFile(join(rootDir, "scanned.pdf"), await scannedPdfFixture(4, 5000));
    await mkdir(join(rootDir, ".tiangong-kb-ingest-derived"), { recursive: true });
    await writeFile(join(rootDir, ".tiangong-kb-ingest-derived", "ignored.pdf"), "ignored");
    await writeFile(schemaPath, JSON.stringify({ metadataSchema: { fields: [] } }));

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          "dry-run",
          rootDir,
          "--schema-file",
          schemaPath,
          "--max-upload-bytes",
          "1000",
          "--max-fallback-rate",
          "1",
          "--json",
        ],
        {
          env: {},
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      const payload = JSON.parse(stdout);
      assert.equal(payload.preflight.classificationCounts.direct_upload, 2);
      assert.equal(payload.preflight.classificationCounts.empty, 1);
      assert.equal(payload.preflight.classificationCounts.unsupported, 1);
      assert.equal(payload.preflight.classificationCounts.oversize_scanned_pdf, 1);
      assert.equal(payload.preflight.totalFiles, 5);
      assert.equal(payload.preflight.planned.normalizedDocx, 0);
      assert.equal(payload.preflight.categoryCounts.oversize, 1);
      assert.equal(payload.preflight.categoryCounts.imageHeavy, 1);

      let preflightStdout = "";
      const preflightExitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          "preflight",
          rootDir,
          "--schema-file",
          schemaPath,
          "--max-upload-bytes",
          "1000",
          "--json",
        ],
        {
          env: {},
          stdout: { write: (chunk: string) => void (preflightStdout += chunk) },
          stderr: { write: () => undefined },
        },
      );
      assert.equal(preflightExitCode, 0);
      assert.equal(JSON.parse(preflightStdout).classificationCounts.oversize_scanned_pdf, 1);

      let normalizeStdout = "";
      const normalizeExitCode = await runCli(
        [
          "kb",
          "ingest",
          "normalize",
          "dry-run",
          rootDir,
          "--schema-file",
          schemaPath,
          "--max-upload-bytes",
          "1000",
          "--json",
        ],
        {
          env: {},
          stdout: { write: (chunk: string) => void (normalizeStdout += chunk) },
          stderr: { write: () => undefined },
        },
      );
      assert.equal(normalizeExitCode, 0);
      assert.equal(JSON.parse(normalizeStdout).classificationCounts.empty, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uploads an ingest-ready DOCX copy with original metadata", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-docx-copy-"));
    const rootDir = join(tempDir, "root");
    const statePath = join(tempDir, "job.sqlite");
    const schemaPath = join(tempDir, "schema.json");
    await mkdir(rootDir, { recursive: true });
    const imagePixels = randomBytes(900 * 900 * 3);
    const sourceImage = await sharp(imagePixels, {
      raw: { width: 900, height: 900, channels: 3 },
    })
      .jpeg({ quality: 95 })
      .toBuffer();
    await writeStoredZip(join(rootDir, "image-heavy.docx"), [
      ["[Content_Types].xml", Buffer.from("<Types></Types>")],
      [
        "word/document.xml",
        Buffer.from(
          [
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
            ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
            "<w:body><w:p><w:r><w:drawing><wp:inline>",
            '<wp:extent cx="914400" cy="914400"/>',
            '<a:graphic><a:graphicData><a:blip r:embed="rId1"/></a:graphicData></a:graphic>',
            "</wp:inline></w:drawing></w:r></w:p></w:body></w:document>",
          ].join(""),
        ),
      ],
      [
        "word/_rels/document.xml.rels",
        Buffer.from(
          [
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
            '<Relationship Id="rId1"',
            ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"',
            ' Target="media/image1.jpg"/>',
            "</Relationships>",
          ].join(""),
        ),
      ],
      ["word/media/image1.jpg", sourceImage],
      ["word/embeddings/filler.bin", randomBytes(11 * 1024 * 1024)],
    ]);
    await writeFile(schemaPath, JSON.stringify({ metadataSchema: { fields: [] } }));

    const previousFetch = globalThis.fetch;
    const uploads: Array<{ metadata: Record<string, unknown>; fileSize: number; file: Buffer }> =
      [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/documents") && init?.method === "POST") {
        const form = init.body as FormData;
        const metadata = JSON.parse(String(form.get("metadata_json"))) as Record<string, unknown>;
        const file = form.get("file") as Blob;
        uploads.push({
          metadata,
          fileSize: file.size,
          file: Buffer.from(await file.arrayBuffer()),
        });
        return new Response(JSON.stringify({ data: { documentId: "doc_docx" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/documents/status:batch")) {
        return new Response(
          JSON.stringify({
            data: {
              results: [
                {
                  documentId: "doc_docx",
                  ok: true,
                  status: {
                    documentId: "doc_docx",
                    status: "completed",
                    opensearchIndexed: true,
                    pineconeIndexed: true,
                    indexRecordCount: 1,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (isPipelineHealthUrl(url)) {
        return new Response(JSON.stringify(pipelineHealthPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          "run",
          rootDir,
          "--collection-path",
          "/course/test",
          "--schema-file",
          schemaPath,
          "--state",
          statePath,
          "--max-upload-bytes",
          "1",
          "--poll-interval",
          "0.01",
          "--max-polls",
          "3",
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      assert.equal(JSON.parse(stdout).completed, 1);
      assert.equal(uploads.length, 1);
      assert.ok(uploads[0]!.fileSize > 1);
      const normalizedImage = readZipEntry(uploads[0]!.file, "word/media/image1.jpg");
      const normalizedMetadata = await sharp(normalizedImage).metadata();
      assert.equal(normalizedMetadata.width, 300);
      assert.equal(normalizedMetadata.height, 300);
      assert.equal(uploads[0]!.metadata.ingest_variant, undefined);
      assert.equal(uploads[0]!.metadata.preflight_classification, undefined);
      assert.equal(uploads[0]!.metadata.normalize_strategy, undefined);
      assert.equal(uploads[0]!.metadata.source_original_path, undefined);

      let exportOut = "";
      const exportCode = await runCli(["kb", "ingest", "export", statePath, "--format", "json"], {
        env: {},
        stdout: { write: (chunk: string) => void (exportOut += chunk) },
        stderr: { write: () => undefined },
      });
      assert.equal(exportCode, 0);
      const row = JSON.parse(exportOut).files[0];
      assert.equal(row.classification, "oversize_docx_image_heavy");
      assert.equal(row.ingestVariant, "compressed_docx");
      assert.equal(row.metadataJson.source_original_path, undefined);
      assert.equal(row.generatedMetadata.source_original_path, "image-heavy.docx");
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports bulk upload of one DOCX file that needs a derived ingest copy", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-single-docx-"));
    const filePath = join(tempDir, "人才基金_物理系金锝人才发展项目.docx");
    const statePath = join(tempDir, "job.sqlite");
    const schemaPath = join(tempDir, "schema.json");
    const imagePixels = randomBytes(900 * 900 * 3);
    const sourceImage = await sharp(imagePixels, {
      raw: { width: 900, height: 900, channels: 3 },
    })
      .jpeg({ quality: 95 })
      .toBuffer();
    await writeStoredZip(filePath, [
      ["[Content_Types].xml", Buffer.from("<Types></Types>")],
      [
        "word/document.xml",
        Buffer.from(
          [
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
            ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
            "<w:body><w:p><w:r><w:drawing><wp:inline>",
            '<wp:extent cx="914400" cy="914400"/>',
            '<a:graphic><a:graphicData><a:blip r:embed="rId1"/></a:graphicData></a:graphic>',
            "</wp:inline></w:drawing></w:r></w:p></w:body></w:document>",
          ].join(""),
        ),
      ],
      [
        "word/_rels/document.xml.rels",
        Buffer.from(
          [
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
            '<Relationship Id="rId1"',
            ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"',
            ' Target="media/image1.jpg"/>',
            "</Relationships>",
          ].join(""),
        ),
      ],
      ["word/media/image1.jpg", sourceImage],
      ["word/embeddings/filler.bin", randomBytes(11 * 1024 * 1024)],
    ]);
    await writeFile(schemaPath, JSON.stringify({ metadataSchema: { fields: [] } }));

    const previousFetch = globalThis.fetch;
    const uploads: Array<{ filename: string; fileSize: number }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/documents") && init?.method === "POST") {
        const form = init.body as FormData;
        const file = form.get("file") as File;
        uploads.push({ filename: file.name, fileSize: file.size });
        return new Response(JSON.stringify({ data: { documentId: "doc_single_docx" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/documents/status:batch")) {
        return new Response(
          JSON.stringify({
            data: {
              results: [
                {
                  documentId: "doc_single_docx",
                  ok: true,
                  status: {
                    documentId: "doc_single_docx",
                    status: "completed",
                    opensearchIndexed: true,
                    pineconeIndexed: true,
                    indexRecordCount: 1,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (isPipelineHealthUrl(url)) {
        return new Response(JSON.stringify(pipelineHealthPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          "run",
          filePath,
          "--collection-path",
          "/course/test",
          "--schema-file",
          schemaPath,
          "--state",
          statePath,
          "--max-upload-bytes",
          "1",
          "--poll-interval",
          "0.01",
          "--max-polls",
          "3",
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      assert.equal(JSON.parse(stdout).completed, 1);
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0]!.filename, "人才基金_物理系金锝人才发展项目.docx");
      assert.ok(uploads[0]!.fileSize > 0);
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the user-provided relative folder path for metadata scan context", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-logical-path-"));
    const previousCwd = process.cwd();
    const rootPath = join(
      "清华人文大展",
      "链接",
      "出土文献研究与保护中心",
      "期刊目录-清华大学出土文献研究与保护中心",
    );
    const docPath = join(tempDir, rootPath, "目录.docx");

    try {
      await mkdir(join(tempDir, rootPath), { recursive: true });
      await writeFile(docPath, "docx placeholder");
      process.chdir(tempDir);

      let stdout = "";
      const exitCode = await runCli(["kb", "ingest", "bulk", "scan", rootPath, "--json"], {
        env: {},
        stdout: { write: (chunk: string) => void (stdout += chunk) },
        stderr: { write: () => undefined },
      });

      assert.equal(exitCode, 0);
      const summary = JSON.parse(stdout);
      assert.equal(summary.topLevelDirs["清华人文大展"], 1);
      assert.equal(
        summary.samples[0].path,
        "清华人文大展/链接/出土文献研究与保护中心/期刊目录-清华大学出土文献研究与保护中心/目录.docx",
      );
      assert.equal(
        summary.samples[0].pathSegments.at(-2),
        "期刊目录-清华大学出土文献研究与保护中心",
      );
    } finally {
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uploads metadata using the user-provided relative folder path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-logical-upload-"));
    const previousCwd = process.cwd();
    const rootPath = join(
      "清华人文大展",
      "链接",
      "出土文献研究与保护中心",
      "期刊目录-清华大学出土文献研究与保护中心",
    );
    const docPath = join(tempDir, rootPath, "2021目录.docx");
    const metadataMapPath = join(tempDir, "metadata-map.yaml");
    const schemaPath = join(tempDir, "schema.json");
    const statePath = join(tempDir, "job.sqlite");
    const previousFetch = globalThis.fetch;

    try {
      await mkdir(join(tempDir, rootPath), { recursive: true });
      await writeFile(docPath, "docx placeholder");
      await writeFile(
        metadataMapPath,
        [
          "version: 1",
          "layers:",
          "  - name: base",
          "    rules:",
          "      - name: filesystem",
          "        fields:",
          "          relative_path:",
          "            source: relative_path",
          "          source_unit:",
          "            source: path_segment",
          "            index: 2",
          "          material_type: periodical",
          "          tags: [thu_humanities]",
          "          year:",
          "            source: relative_path",
          '            regex: "(20[0-9]{2})"',
          "            type: number",
          "",
        ].join("\n"),
      );
      await writeFile(
        schemaPath,
        JSON.stringify({
          metadataSchema: {
            fields: [
              { key: "source_unit", type: "string", required: true },
              {
                key: "material_type",
                type: "enum",
                values: ["periodical"],
                required: true,
              },
              { key: "relative_path", type: "string", required: true },
              { key: "tags", type: "tag_array", required: true },
              { key: "year", type: "number", required: true },
            ],
          },
        }),
      );
      process.chdir(tempDir);

      const uploads: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/documents") && init?.method === "POST") {
          const form = init.body as FormData;
          uploads.push(JSON.parse(String(form.get("metadata_json"))) as Record<string, unknown>);
          return new Response(JSON.stringify({ data: { documentId: "doc_logical" } }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/documents/status:batch")) {
          return new Response(
            JSON.stringify({
              data: {
                results: [
                  {
                    documentId: "doc_logical",
                    ok: true,
                    status: {
                      documentId: "doc_logical",
                      status: "completed",
                      opensearchIndexed: true,
                      pineconeIndexed: true,
                      indexRecordCount: 1,
                    },
                  },
                ],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (isPipelineHealthUrl(url)) {
          return new Response(JSON.stringify(pipelineHealthPayload()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;

      let stdout = "";
      const exitCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          "run",
          rootPath,
          "--collection-path",
          "/course/test",
          "--metadata-map",
          metadataMapPath,
          "--schema-file",
          schemaPath,
          "--state",
          statePath,
          "--poll-interval",
          "0.01",
          "--max-polls",
          "3",
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      assert.equal(JSON.parse(stdout).completed, 1);
      assert.deepEqual(uploads[0], {
        relative_path:
          "清华人文大展/链接/出土文献研究与保护中心/期刊目录-清华大学出土文献研究与保护中心/2021目录.docx",
        source_unit: "出土文献研究与保护中心",
        material_type: "periodical",
        tags: ["thu_humanities"],
        year: 2021,
        client_filename: "2021目录.docx",
        client_size: 16,
        client_mtime_ms: uploads[0]?.client_mtime_ms,
      });
    } finally {
      globalThis.fetch = previousFetch;
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("splits oversized PDFs into the fewest ordinary PDF part uploads", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-cli-pdf-split-"));
    const rootDir = join(tempDir, "root");
    const statePath = join(tempDir, "job.sqlite");
    const schemaPath = join(tempDir, "schema.json");
    await mkdir(join(rootDir, "course"), { recursive: true });
    await writeFile(join(rootDir, "course", "scan.pdf"), await scannedPdfFixture(4, 9000));
    await writeFile(schemaPath, JSON.stringify({ metadataSchema: { fields: [] } }));

    const previousFetch = globalThis.fetch;
    const uploads: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/documents") && init?.method === "POST") {
        const form = init.body as FormData;
        uploads.push(JSON.parse(String(form.get("metadata_json"))) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ data: { documentId: `doc_part_${uploads.length}` } }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/documents/status:batch")) {
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            data: {
              results: body.documentIds.map((documentId: string) => ({
                documentId,
                ok: true,
                status: {
                  documentId,
                  status: "completed",
                  opensearchIndexed: true,
                  pineconeIndexed: true,
                  indexRecordCount: 1,
                },
              })),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (isPipelineHealthUrl(url)) {
        return new Response(JSON.stringify(pipelineHealthPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      const firstCode = await runCli(
        [
          "kb",
          "ingest",
          "bulk",
          "run",
          rootDir,
          "--collection-path",
          "/course/test",
          "--schema-file",
          schemaPath,
          "--state",
          statePath,
          "--max-upload-bytes",
          "220000",
          "--max-polls",
          "1",
          "--json",
        ],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: () => undefined },
          stderr: { write: () => undefined },
        },
      );
      assert.equal(firstCode, 0);
      assert.equal(uploads.length, 0);

      let resumeOut = "";
      const resumeCode = await runCli(
        ["kb", "ingest", "resume", statePath, "--poll-interval", "0.01", "--json"],
        {
          env: { TIANGONG_AI_API_KEY: "fake" },
          stdout: { write: (chunk: string) => void (resumeOut += chunk) },
          stderr: { write: () => undefined },
        },
      );
      assert.equal(resumeCode, 0);
      assert.equal(JSON.parse(resumeOut).completed, 2);
      assert.equal(uploads.length, 2);
      assert.ok(uploads.every((metadata) => metadata.ingest_variant === undefined));
      assert.ok(uploads.every((metadata) => metadata.source_original_path === undefined));
      assert.ok(uploads.every((metadata) => metadata.source_part_index === undefined));

      let exportOut = "";
      const exportCode = await runCli(["kb", "ingest", "export", statePath, "--format", "json"], {
        env: {},
        stdout: { write: (chunk: string) => void (exportOut += chunk) },
        stderr: { write: () => undefined },
      });
      assert.equal(exportCode, 0);
      const rows = JSON.parse(exportOut).files;
      assert.equal(rows.length, 2);
      assert.ok(
        rows.every(
          (row: { classification: string }) => row.classification === "oversize_scanned_pdf",
        ),
      );
      assert.ok(
        rows.every((row: { metadataJson: Record<string, unknown> }) => {
          return (
            row.metadataJson.source_original_path === undefined &&
            row.metadataJson.source_part_index === undefined &&
            row.metadataJson.source_page_start === undefined &&
            row.metadataJson.ingest_variant === undefined
          );
        }),
      );
      assert.deepEqual(
        rows.map((row: { relativePath: string }) => row.relativePath),
        ["course/scan.part001-p001-p002.pdf", "course/scan.part002-p003-p004.pdf"],
      );
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function readZipEntry(input: Buffer, entryName: string): Buffer {
  const eocdOffset = findEndOfCentralDirectory(input);
  assert.notEqual(eocdOffset, -1);
  const entryCount = input.readUInt16LE(eocdOffset + 10);
  const centralOffset = input.readUInt32LE(eocdOffset + 16);
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(input.readUInt32LE(cursor), 0x02014b50);
    const method = input.readUInt16LE(cursor + 10);
    const compressedSize = input.readUInt32LE(cursor + 20);
    const nameLength = input.readUInt16LE(cursor + 28);
    const extraLength = input.readUInt16LE(cursor + 30);
    const commentLength = input.readUInt16LE(cursor + 32);
    const localOffset = input.readUInt32LE(cursor + 42);
    const name = input.slice(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name === entryName) {
      assert.equal(input.readUInt32LE(localOffset), 0x04034b50);
      const localNameLength = input.readUInt16LE(localOffset + 26);
      const localExtraLength = input.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressedData = input.slice(dataStart, dataStart + compressedSize);
      return method === 8 ? inflateRawSync(compressedData) : Buffer.from(compressedData);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${entryName}`);
}

function findEndOfCentralDirectory(input: Buffer): number {
  const start = Math.max(0, input.length - 65557);
  for (let offset = input.length - 22; offset >= start; offset -= 1) {
    if (input.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

async function writeStoredZip(path: string, entries: Array<[string, Buffer]>): Promise<void> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [entryName, data] of entries) {
    const name = Buffer.from(entryName, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  await writeFile(path, Buffer.concat([...localParts, central, eocd]));
}

async function scannedPdfFixture(pageCount: number, minBytes: number): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    const sourceImage = await sharp(randomBytes(350 * 350 * 3), {
      raw: { width: 350, height: 350, channels: 3 },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    const png = await document.embedJpg(sourceImage);
    const page = document.addPage([612, 792]);
    page.drawImage(png, { x: 72, y: 72, width: 468, height: 468 });
  }
  const pdf = Buffer.from(await document.save({ useObjectStreams: false }));
  if (pdf.length >= minBytes) return pdf;
  return Buffer.concat([pdf, Buffer.alloc(minBytes - pdf.length, 0x20)]);
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});
