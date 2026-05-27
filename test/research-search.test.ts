import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { CliError } from "../src/errors.js";
import { parseResearchSources, resolveResearchConfig } from "../src/research/config.js";
import { parseStrictArgs } from "../src/strict-args.js";

const RESEARCH_OPTIONS = {
  json: "boolean",
  "dry-run": "boolean",
  input: "string",
  query: "string",
  claim: "string",
  sources: "string",
  "api-key": "string",
  "api-base-url": "string",
  "sci-api-key": "string",
  "report-api-key": "string",
  "patent-api-key": "string",
  "sci-url": "string",
  "report-url": "string",
  "patent-url": "string",
  region: "string",
  timeout: "string",
  "top-k": "string",
  "ext-k": "string",
  "get-meta": "boolean",
} as const;

describe("research search config", () => {
  it("parses research source presets and explicit sources", () => {
    assert.deepEqual(parseResearchSources(undefined), ["sci"]);
    assert.deepEqual(parseResearchSources("default"), ["sci"]);
    assert.deepEqual(parseResearchSources("all"), ["sci", "report", "patent"]);
    assert.deepEqual(parseResearchSources("report,patent,sci,report"), ["report", "patent", "sci"]);
    assert.throws(
      () => parseResearchSources("edu"),
      (error) =>
        error instanceof CliError &&
        error.code === "RESEARCH_SOURCE_UNSUPPORTED" &&
        error.exitCode === 2,
    );
  });

  it("resolves source URLs, credentials, region, and timeout from flags", () => {
    const config = resolveResearchConfig(
      parseStrictArgs(
        [
          "--api-key",
          "common-key",
          "--sci-api-key",
          "sci-key",
          "--report-api-key",
          "report-key",
          "--patent-api-key",
          "patent-key",
          "--sci-url",
          "https://example.test/sci",
          "--report-url",
          "https://example.test/report",
          "--patent-url",
          "https://example.test/patent",
          "--region",
          "ap-southeast-1",
          "--timeout",
          "9",
        ],
        RESEARCH_OPTIONS,
        "research search",
      ),
      {},
    );

    assert.equal(config.timeoutSeconds, 9);
    assert.deepEqual(config.sources.sci, {
      url: "https://example.test/sci",
      apiKey: "sci-key",
      region: "ap-southeast-1",
      authStrategy: "apiKey",
      includeRegion: true,
    });
    assert.deepEqual(config.sources.report, {
      url: "https://example.test/report",
      apiKey: "report-key",
      region: "ap-southeast-1",
      authStrategy: "apiKey",
      includeRegion: true,
    });
    assert.deepEqual(config.sources.patent, {
      url: "https://example.test/patent",
      apiKey: "patent-key",
      region: "ap-southeast-1",
      authStrategy: "apiKey",
      includeRegion: true,
    });
  });

  it("resolves env fallbacks and validates timeout", () => {
    const config = resolveResearchConfig(parseStrictArgs([], RESEARCH_OPTIONS, "research search"), {
      TIANGONG_AI_APIKEY: "common-env-key",
      TIANGONG_SCI_APIKEY: "sci-env-key",
      TIANGONG_REPORT_APIKEY: "report-env-key",
      TIANGONG_PATENT_APIKEY: "patent-env-key",
      TIANGONG_SCI_SEARCH_URL: "https://env.test/sci",
      TIANGONG_REPORT_SEARCH_URL: "https://env.test/report",
      TIANGONG_PATENT_SEARCH_URL: "https://env.test/patent",
      TIANGONG_REGION: "eu-central-1",
      TIANGONG_RESEARCH_TIMEOUT: "33",
    });

    assert.equal(config.timeoutSeconds, 33);
    assert.equal(config.sources.sci.apiKey, "sci-env-key");
    assert.equal(config.sources.report.apiKey, "report-env-key");
    assert.equal(config.sources.patent.apiKey, "patent-env-key");
    assert.equal(config.sources.sci.url, "https://env.test/sci");
    assert.equal(config.sources.report.url, "https://env.test/report");
    assert.equal(config.sources.patent.url, "https://env.test/patent");
    assert.equal(config.sources.sci.region, "eu-central-1");
    assert.throws(
      () =>
        resolveResearchConfig(
          parseStrictArgs(["--timeout", "0"], RESEARCH_OPTIONS, "research search"),
          {},
        ),
      (error) =>
        error instanceof CliError &&
        error.code === "INVALID_NUMERIC_OPTION" &&
        error.exitCode === 2,
    );
  });

  it("derives source URLs from project, functions, and rest base URLs", () => {
    const fromProject = resolveResearchConfig(
      parseStrictArgs(
        ["--api-base-url", "https://example.supabase.co"],
        RESEARCH_OPTIONS,
        "research search",
      ),
      {},
    );
    assert.equal(
      fromProject.sources.sci.url,
      "https://example.supabase.co/functions/v1/sci_search",
    );
    assert.equal(
      fromProject.sources.report.url,
      "https://example.supabase.co/functions/v1/report_search",
    );
    assert.equal(
      fromProject.sources.patent.url,
      "https://example.supabase.co/functions/v1/patent_search",
    );

    const fromFunctions = resolveResearchConfig(
      parseStrictArgs(
        ["--api-base-url", "https://example.supabase.co/functions/v1"],
        RESEARCH_OPTIONS,
        "research search",
      ),
      {},
    );
    assert.equal(
      fromFunctions.sources.sci.url,
      "https://example.supabase.co/functions/v1/sci_search",
    );

    const fromRestEnv = resolveResearchConfig(
      parseStrictArgs([], RESEARCH_OPTIONS, "research search"),
      {
        TIANGONG_AI_API_BASE_URL: "https://env.supabase.co/rest/v1",
      },
    );
    assert.equal(fromRestEnv.sources.sci.url, "https://env.supabase.co/functions/v1/sci_search");

    const explicitSourceUrl = resolveResearchConfig(
      parseStrictArgs(
        ["--api-base-url", "https://example.supabase.co", "--sci-url", "https://override.test/sci"],
        RESEARCH_OPTIONS,
        "research search",
      ),
      {},
    );
    assert.equal(explicitSourceUrl.sources.sci.url, "https://override.test/sci");

    assert.throws(
      () =>
        resolveResearchConfig(
          parseStrictArgs(
            ["--api-base-url", "https://example.supabase.co/custom/path"],
            RESEARCH_OPTIONS,
            "research search",
          ),
          {},
        ),
      (error) =>
        error instanceof CliError &&
        error.code === "EDGE_SEARCH_API_BASE_URL_INVALID" &&
        error.exitCode === 2,
    );
  });
});

describe("research search command", () => {
  it("shows focused help", async () => {
    let stdout = "";
    const exitCode = await runCli(["research", "search", "--help"], {
      env: {},
      stdout: { write: (chunk: string) => void (stdout += chunk) },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 0);
    assert.match(stdout, /--input <file>/);
    assert.match(stdout, /--query <text>/);
  });

  it("dry-runs --input for all research sources with exact request plans", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-research-search-test-"));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("dry-run should not fetch");
    }) as typeof fetch;

    try {
      const body = {
        query: "microplastic tire wear health",
        datefilter: { start: "2020-01-01", end: "2025-12-31" },
        meta_contains: { journal: "Environment" },
        topK: 12,
        extK: 2,
      };
      const inputPath = join(tempDir, "request.json");
      await writeFile(inputPath, JSON.stringify(body));

      let stdout = "";
      const exitCode = await runCli(
        [
          "research",
          "search",
          "--input",
          inputPath,
          "--sources",
          "all",
          "--sci-url",
          "https://example.test/sci_search",
          "--report-url",
          "https://example.test/report_search",
          "--patent-url",
          "https://example.test/patent_search",
          "--sci-api-key",
          "sci-key",
          "--report-api-key",
          "report-key",
          "--patent-api-key",
          "patent-key",
          "--region",
          "ap-northeast-1",
          "--timeout",
          "23",
          "--dry-run",
          "--json",
        ],
        {
          env: {},
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      const payload = JSON.parse(stdout) as {
        dryRun: true;
        requests: Array<{
          source: string;
          request: {
            url: string;
            headers: Record<string, string>;
            inputPath: string;
            body: unknown;
            timeoutMs: number;
          };
        }>;
      };
      assert.equal(payload.dryRun, true);
      assert.deepEqual(
        payload.requests.map((request) => request.source),
        ["sci", "report", "patent"],
      );
      assert.deepEqual(
        payload.requests.map((request) => request.request.url),
        [
          "https://example.test/sci_search",
          "https://example.test/report_search",
          "https://example.test/patent_search",
        ],
      );
      for (const request of payload.requests) {
        assert.deepEqual(request.request.body, body);
        assert.equal(request.request.inputPath, inputPath);
        assert.equal(request.request.headers["Content-Type"], "application/json");
        assert.equal(request.request.headers["x-api-key"], "****");
        assert.equal(request.request.headers["x-region"], "ap-northeast-1");
        assert.equal(request.request.timeoutMs, 23000);
      }
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("posts --query convenience bodies and prints a single raw response", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), "https://example.test/sci_search");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-api-key"), "sci-key");
      assert.equal(headers.get("x-region"), "us-west-2");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        query: "mechanical recycling emissions",
        topK: 3,
        extK: 4,
        getMeta: true,
      });
      return new Response(JSON.stringify({ data: [{ id: "chunk-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "research",
          "search",
          "--query",
          "mechanical recycling emissions",
          "--sources",
          "sci",
          "--sci-url",
          "https://example.test/sci_search",
          "--sci-api-key",
          "sci-key",
          "--region",
          "us-west-2",
          "--top-k",
          "3",
          "--ext-k",
          "4",
          "--get-meta",
          "--json",
        ],
        {
          env: {},
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      assert.deepEqual(JSON.parse(stdout), { data: [{ id: "chunk-1" }] });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("keeps --claim as a compatibility alias for query body construction", async () => {
    let stdout = "";
    const exitCode = await runCli(
      [
        "research",
        "search",
        "--claim",
        "biochar improves soil carbon",
        "--sci-url",
        "https://example.test/sci_search",
        "--sci-api-key",
        "sci-key",
        "--dry-run",
        "--json",
      ],
      {
        env: {},
        stdout: { write: (chunk: string) => void (stdout += chunk) },
        stderr: { write: () => undefined },
      },
    );

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout) as { requests: Array<{ request: { body: unknown } }> };
    assert.deepEqual(payload.requests[0]?.request.body, { query: "biochar improves soil carbon" });
  });

  it("rejects unknown flags, input/body conflicts, and missing credentials", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("failed validation should not fetch");
    }) as typeof fetch;

    try {
      let stderr = "";
      const unknownExit = await runCli(["research", "search", "--query", "x", "--no-expand"], {
        env: {},
        stdout: { write: () => undefined },
        stderr: { write: (chunk: string) => void (stderr += chunk) },
      });
      assert.equal(unknownExit, 2);
      assert.match(stderr, /Unknown option/);

      stderr = "";
      const tempDir = await mkdtemp(join(tmpdir(), "tiangong-research-search-conflict-"));
      try {
        const inputPath = join(tempDir, "request.json");
        await writeFile(inputPath, JSON.stringify({ query: "x" }));
        const conflictExit = await runCli(
          ["research", "search", "--input", inputPath, "--query", "x", "--sci-api-key", "key"],
          {
            env: {},
            stdout: { write: () => undefined },
            stderr: { write: (chunk: string) => void (stderr += chunk) },
          },
        );
        assert.equal(conflictExit, 2);
        assert.match(stderr, /--input cannot be combined/);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }

      stderr = "";
      const missingCredentialExit = await runCli(
        ["research", "search", "--query", "x", "--sources", "report"],
        {
          env: { TIANGONG_AI_APIKEY: " ", TIANGONG_REPORT_APIKEY: " " },
          stdout: { write: () => undefined },
          stderr: { write: (chunk: string) => void (stderr += chunk) },
        },
      );
      assert.equal(missingCredentialExit, 2);
      assert.match(stderr, /Missing report search credentials/);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
