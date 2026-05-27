import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveSupabaseFunctionsBaseUrl,
  deriveSupabaseProjectBaseUrl,
  deriveSupabaseRestBaseUrl,
  runEdgeSearch,
} from "../src/edge-search.js";
import { CliError } from "../src/errors.js";

describe("edge search forwarding", () => {
  it("derives Supabase project and functions base URLs", () => {
    assert.equal(
      deriveSupabaseProjectBaseUrl("https://example.supabase.co/functions/v1"),
      "https://example.supabase.co",
    );
    assert.equal(
      deriveSupabaseProjectBaseUrl("https://example.supabase.co/rest/v1"),
      "https://example.supabase.co",
    );
    assert.equal(
      deriveSupabaseFunctionsBaseUrl("https://example.supabase.co"),
      "https://example.supabase.co/functions/v1",
    );
    assert.equal(
      deriveSupabaseFunctionsBaseUrl("https://example.supabase.co/rest/v1"),
      "https://example.supabase.co/functions/v1",
    );
    assert.equal(
      deriveSupabaseRestBaseUrl("https://example.supabase.co/functions/v1"),
      "https://example.supabase.co/rest/v1",
    );

    assert.throws(
      () => deriveSupabaseFunctionsBaseUrl("https://example.supabase.co/custom/path"),
      (error) =>
        error instanceof CliError &&
        error.code === "EDGE_SEARCH_API_BASE_URL_INVALID" &&
        error.exitCode === 2,
    );
  });

  it("dry-runs exact request plans with masked credentials and unchanged bodies", async () => {
    const body = {
      query: "microplastic tire wear",
      filter: { year_gte: 2020, journal: ["Nature"] },
      topK: 8,
    };

    const result = await runEdgeSearch({
      body,
      sources: [
        {
          source: "sci",
          url: "https://example.test/sci_search",
          apiKey: "sci-secret",
          region: "ap-southeast-1",
          authStrategy: "apiKey",
          includeRegion: true,
        },
        {
          source: "course",
          url: "https://example.test/course_search",
          apiKey: "",
          bearerToken: "course-secret",
          region: "ap-southeast-1",
          authStrategy: "bearerOrApiKey",
          includeRegion: true,
        },
      ],
      inputPath: "/tmp/request.json",
      timeoutMs: 17000,
      dryRun: true,
      missingCredentialHelp: "Provide credentials.",
    });

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.requests, [
      {
        source: "sci",
        request: {
          method: "POST",
          url: "https://example.test/sci_search",
          headers: {
            "Content-Type": "application/json",
            "x-region": "ap-southeast-1",
            "x-api-key": "****",
          },
          inputPath: "/tmp/request.json",
          body,
          timeoutMs: 17000,
        },
      },
      {
        source: "course",
        request: {
          method: "POST",
          url: "https://example.test/course_search",
          headers: {
            "Content-Type": "application/json",
            "x-region": "ap-southeast-1",
            Authorization: "Bearer ****",
          },
          inputPath: "/tmp/request.json",
          body,
          timeoutMs: 17000,
        },
      },
    ]);
  });

  it("posts exact request bodies and returns raw JSON responses", async () => {
    const previousFetch = globalThis.fetch;
    const body = { query: "knowledge organization", topK: 4 };
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), "https://example.test/course_search");
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-api-key"), "course-key");
      assert.equal(headers.get("x-region"), "us-west-2");
      assert.equal(headers.get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      return new Response(JSON.stringify({ data: [{ id: "course-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await runEdgeSearch({
        body,
        sources: [
          {
            source: "course",
            url: "https://example.test/course_search",
            apiKey: "course-key",
            region: "us-west-2",
            authStrategy: "apiKey",
            includeRegion: true,
          },
        ],
        timeoutMs: 5000,
        dryRun: false,
        missingCredentialHelp: "Provide credentials.",
      });

      assert.deepEqual(result, {
        dryRun: false,
        responses: [{ source: "course", response: { data: [{ id: "course-1" }] } }],
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("rejects missing credentials before fetching", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("missing credentials should not fetch");
    }) as typeof fetch;

    try {
      await assert.rejects(
        () =>
          runEdgeSearch({
            body: { query: "test" },
            sources: [
              {
                source: "report",
                url: "https://example.test/report_search",
                apiKey: "",
                region: "us-east-1",
                authStrategy: "apiKey",
                includeRegion: true,
              },
            ],
            timeoutMs: 5000,
            dryRun: false,
            missingCredentialHelp: "Provide credentials.",
          }),
        (error) =>
          error instanceof CliError &&
          error.code === "EDGE_SEARCH_CREDENTIALS_REQUIRED" &&
          error.exitCode === 2 &&
          /Missing report search credentials/.test(error.message),
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
