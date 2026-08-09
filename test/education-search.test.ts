import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import { parseEducationSources, resolveEducationConfig } from "../src/education/config.js";
import { CliError } from "../src/errors.js";
import { parseStrictArgs } from "../src/strict-args.js";

const EDUCATION_OPTIONS = {
  json: "boolean",
  "dry-run": "boolean",
  input: "string",
  query: "string",
  sources: "string",
  "api-key": "string",
  "api-base-url": "string",
  "bearer-token": "string",
  "course-api-key": "string",
  "edu-api-key": "string",
  "textbook-api-key": "string",
  "course-url": "string",
  "edu-url": "string",
  "textbook-url": "string",
  region: "string",
  timeout: "string",
  "top-k": "string",
  "ext-k": "string",
} as const;

describe("education search config", () => {
  it("parses education source presets and explicit sources", () => {
    assert.deepEqual(parseEducationSources(undefined), ["course"]);
    assert.deepEqual(parseEducationSources("default"), ["course"]);
    assert.deepEqual(parseEducationSources("all"), ["course", "edu", "textbook"]);
    assert.deepEqual(parseEducationSources("textbook,edu,course,textbook"), [
      "textbook",
      "edu",
      "course",
    ]);
    assert.throws(
      () => parseEducationSources("sci"),
      (error) =>
        error instanceof CliError &&
        error.code === "EDUCATION_SOURCE_UNSUPPORTED" &&
        error.exitCode === 2,
    );
  });

  it("resolves source URLs, credentials, bearer token, region, and timeout from flags", () => {
    const config = resolveEducationConfig(
      parseStrictArgs(
        [
          "--api-key",
          "common-key",
          "--bearer-token",
          "course-bearer",
          "--course-api-key",
          "course-key",
          "--edu-api-key",
          "edu-key",
          "--textbook-api-key",
          "textbook-key",
          "--course-url",
          "https://example.test/course",
          "--edu-url",
          "https://example.test/edu",
          "--textbook-url",
          "https://example.test/textbook",
          "--region",
          "ap-southeast-1",
          "--timeout",
          "11",
        ],
        EDUCATION_OPTIONS,
        "education search",
      ),
      {},
    );

    assert.equal(config.timeoutSeconds, 11);
    assert.deepEqual(config.sources.course, {
      url: "https://example.test/course",
      apiKey: "course-key",
      bearerToken: "course-bearer",
      region: "ap-southeast-1",
      authStrategy: "bearerOrApiKey",
      includeRegion: true,
    });
    assert.deepEqual(config.sources.edu, {
      url: "https://example.test/edu",
      apiKey: "edu-key",
      bearerToken: undefined,
      region: "ap-southeast-1",
      authStrategy: "apiKey",
      includeRegion: true,
    });
    assert.deepEqual(config.sources.textbook, {
      url: "https://example.test/textbook",
      apiKey: "textbook-key",
      bearerToken: undefined,
      region: "ap-southeast-1",
      authStrategy: "apiKey",
      includeRegion: true,
    });
  });

  it("resolves env fallbacks and validates timeout", () => {
    const config = resolveEducationConfig(
      parseStrictArgs([], EDUCATION_OPTIONS, "education search"),
      {
        TIANGONG_AI_APIKEY: "common-env-key",
        TIANGONG_EDUCATION_BEARER_TOKEN: "course-bearer-env",
        TIANGONG_COURSE_APIKEY: "course-env-key",
        TIANGONG_EDU_APIKEY: "edu-env-key",
        TIANGONG_TEXTBOOK_APIKEY: "textbook-env-key",
        TIANGONG_COURSE_SEARCH_URL: "https://env.test/course",
        TIANGONG_EDU_SEARCH_URL: "https://env.test/edu",
        TIANGONG_TEXTBOOK_SEARCH_URL: "https://env.test/textbook",
        TIANGONG_REGION: "eu-central-1",
        TIANGONG_EDUCATION_TIMEOUT: "44",
      },
    );

    assert.equal(config.timeoutSeconds, 44);
    assert.equal(config.sources.course.bearerToken, "course-bearer-env");
    assert.equal(config.sources.course.apiKey, "course-env-key");
    assert.equal(config.sources.edu.apiKey, "edu-env-key");
    assert.equal(config.sources.textbook.apiKey, "textbook-env-key");
    assert.equal(config.sources.course.url, "https://env.test/course");
    assert.equal(config.sources.edu.url, "https://env.test/edu");
    assert.equal(config.sources.textbook.url, "https://env.test/textbook");
    assert.equal(config.sources.course.region, "eu-central-1");
    assert.throws(
      () =>
        resolveEducationConfig(
          parseStrictArgs(["--timeout", "0"], EDUCATION_OPTIONS, "education search"),
          {},
        ),
      (error) =>
        error instanceof CliError &&
        error.code === "INVALID_NUMERIC_OPTION" &&
        error.exitCode === 2,
    );
  });

  it("derives source URLs from project, functions, and rest base URLs", () => {
    const fromProject = resolveEducationConfig(
      parseStrictArgs(
        ["--api-base-url", "https://example.supabase.co"],
        EDUCATION_OPTIONS,
        "education search",
      ),
      {},
    );
    assert.equal(
      fromProject.sources.course.url,
      "https://example.supabase.co/functions/v1/course_search",
    );
    assert.equal(
      fromProject.sources.edu.url,
      "https://example.supabase.co/functions/v1/edu_search",
    );
    assert.equal(
      fromProject.sources.textbook.url,
      "https://example.supabase.co/functions/v1/textbook_search",
    );

    const fromFunctions = resolveEducationConfig(
      parseStrictArgs(
        ["--api-base-url", "https://example.supabase.co/functions/v1"],
        EDUCATION_OPTIONS,
        "education search",
      ),
      {},
    );
    assert.equal(
      fromFunctions.sources.course.url,
      "https://example.supabase.co/functions/v1/course_search",
    );

    const fromRestEnv = resolveEducationConfig(
      parseStrictArgs([], EDUCATION_OPTIONS, "education search"),
      {
        TIANGONG_EDUCATION_API_BASE_URL: "https://env.supabase.co/rest/v1",
      },
    );
    assert.equal(
      fromRestEnv.sources.course.url,
      "https://env.supabase.co/functions/v1/course_search",
    );

    const explicitSourceUrl = resolveEducationConfig(
      parseStrictArgs(
        [
          "--api-base-url",
          "https://example.supabase.co",
          "--course-url",
          "https://override.test/course",
        ],
        EDUCATION_OPTIONS,
        "education search",
      ),
      {},
    );
    assert.equal(explicitSourceUrl.sources.course.url, "https://override.test/course");

    assert.throws(
      () =>
        resolveEducationConfig(
          parseStrictArgs(
            ["--api-base-url", "https://example.supabase.co/custom/path"],
            EDUCATION_OPTIONS,
            "education search",
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

describe("education search command", () => {
  it("shows focused help", async () => {
    let stdout = "";
    const exitCode = await runCli(["education", "search", "--help"], {
      env: {},
      stdout: { write: (chunk: string) => void (stdout += chunk) },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 0);
    assert.match(stdout, /--input <file>/);
    assert.match(stdout, /--query <text>/);
  });

  it("dry-runs --input for all education sources with exact request plans", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-education-search-test-"));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("dry-run should not fetch");
    }) as typeof fetch;

    try {
      const body = {
        query: "activated sludge process",
        filter: { subject: "environmental engineering" },
        topK: 9,
        extK: 3,
      };
      const inputPath = join(tempDir, "request.json");
      await writeFile(inputPath, JSON.stringify(body));

      let stdout = "";
      const exitCode = await runCli(
        [
          "education",
          "search",
          "--input",
          inputPath,
          "--sources",
          "all",
          "--course-url",
          "https://example.test/course_search",
          "--edu-url",
          "https://example.test/edu_search",
          "--textbook-url",
          "https://example.test/textbook_search",
          "--bearer-token",
          "course-token",
          "--edu-api-key",
          "edu-key",
          "--textbook-api-key",
          "textbook-key",
          "--region",
          "ap-northeast-1",
          "--timeout",
          "19",
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
      assert.deepEqual(
        payload.requests.map((request) => request.source),
        ["course", "edu", "textbook"],
      );
      assert.deepEqual(payload.requests[0]?.request.headers, {
        "Content-Type": "application/json",
        "x-region": "ap-northeast-1",
        Authorization: "Bearer ****",
      });
      assert.equal(payload.requests[1]?.request.headers["Content-Type"], "application/json");
      assert.equal(payload.requests[1]?.request.headers["x-api-key"], "****");
      assert.equal(payload.requests[2]?.request.headers["Content-Type"], "application/json");
      assert.equal(payload.requests[2]?.request.headers["x-api-key"], "****");
      assert.deepEqual(
        payload.requests.map((request) => request.request.url),
        [
          "https://example.test/course_search",
          "https://example.test/edu_search",
          "https://example.test/textbook_search",
        ],
      );
      for (const request of payload.requests) {
        assert.deepEqual(request.request.body, body);
        assert.equal(request.request.inputPath, inputPath);
        assert.equal(request.request.timeoutMs, 19000);
      }
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("posts --query convenience bodies and prints a single raw response", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), "https://example.test/course_search");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("x-api-key"), "course-key");
      assert.equal(headers.get("x-region"), "us-west-2");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        query: "knowledge organization",
        topK: 4,
        extK: 2,
      });
      return new Response(JSON.stringify([{ document_id: "course-doc-1" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "education",
          "search",
          "--query",
          "knowledge organization",
          "--sources",
          "course",
          "--course-url",
          "https://example.test/course_search",
          "--course-api-key",
          "course-key",
          "--region",
          "us-west-2",
          "--top-k",
          "4",
          "--ext-k",
          "2",
          "--json",
        ],
        {
          env: {},
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      assert.deepEqual(JSON.parse(stdout), [{ document_id: "course-doc-1" }]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("wraps multiple source responses without response normalization", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-region"), "us-east-1");
      assert.deepEqual(JSON.parse(String(init?.body)), { query: "filter layer" });
      return new Response(JSON.stringify({ url }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      let stdout = "";
      const exitCode = await runCli(
        [
          "education",
          "search",
          "--query",
          "filter layer",
          "--sources",
          "edu,textbook",
          "--edu-url",
          "https://example.test/edu_search",
          "--textbook-url",
          "https://example.test/textbook_search",
          "--api-key",
          "common-key",
          "--json",
        ],
        {
          env: {},
          stdout: { write: (chunk: string) => void (stdout += chunk) },
          stderr: { write: () => undefined },
        },
      );

      assert.equal(exitCode, 0);
      assert.deepEqual(JSON.parse(stdout), {
        dryRun: false,
        responses: [
          { source: "edu", response: { url: "https://example.test/edu_search" } },
          { source: "textbook", response: { url: "https://example.test/textbook_search" } },
        ],
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("rejects unknown flags, input/body conflicts, missing queries, and missing credentials", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("failed validation should not fetch");
    }) as typeof fetch;

    try {
      let stderr = "";
      const unknownExit = await runCli(["education", "search", "--query", "x", "--claim", "x"], {
        env: {},
        stdout: { write: () => undefined },
        stderr: { write: (chunk: string) => void (stderr += chunk) },
      });
      assert.equal(unknownExit, 2);
      assert.match(stderr, /Unknown option/);

      stderr = "";
      const missingQueryExit = await runCli(["education", "search"], {
        env: {},
        stdout: { write: () => undefined },
        stderr: { write: (chunk: string) => void (stderr += chunk) },
      });
      assert.equal(missingQueryExit, 2);
      assert.match(stderr, /--input <file> or --query <query>/);

      stderr = "";
      const tempDir = await mkdtemp(join(tmpdir(), "tiangong-education-search-conflict-"));
      try {
        const inputPath = join(tempDir, "request.json");
        await writeFile(inputPath, JSON.stringify({ query: "x" }));
        const conflictExit = await runCli(
          ["education", "search", "--input", inputPath, "--top-k", "2", "--course-api-key", "key"],
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
        ["education", "search", "--query", "x", "--sources", "edu"],
        {
          env: { TIANGONG_AI_APIKEY: " ", TIANGONG_EDU_APIKEY: " " },
          stdout: { write: () => undefined },
          stderr: { write: (chunk: string) => void (stderr += chunk) },
        },
      );
      assert.equal(missingCredentialExit, 2);
      assert.match(stderr, /Standalone ambient credential not found for edu search/);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
