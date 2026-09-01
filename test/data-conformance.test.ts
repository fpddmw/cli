import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DataRunRequest } from "../src/data/contracts.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";
import { syntheticConnector } from "./support/data-synthetic-connector.js";

describe("connector conformance harness", () => {
  it("proves bounded pagination and credential injection through the common runtime", async () => {
    const requestedPages: string[] = [];
    const connector = syntheticConnector({
      credential: true,
      execute: async ({ http }) => {
        const observations = [];
        const values: string[] = [];
        for (const page of [1, 2]) {
          const response = await http.request({
            endpointId: "primary",
            method: "GET",
            path: "/v1/items",
            query: { page },
            credentialId: "api-token",
          });
          const payload = response.json() as { values: string[] };
          values.push(...payload.values);
          observations.push({
            ...response.observation,
            observationId: `page-${page}`,
            sourceId: `page:${page}`,
          });
        }
        return {
          status: "success",
          data: { echoed: values.join(",") },
          summary: {
            recordCount: values.length,
            pageCount: 2,
            chunkCount: 0,
            truncated: false,
            completeness: "complete",
          },
          warnings: [],
          errors: [],
          observations,
        };
      },
    });
    const request: DataRunRequest = {
      schemaVersion: "tiangong.data.run-request.v1",
      capabilityId: "test.synthetic",
      capabilityVersion: "1.0.0",
      operationId: "echo",
      operationVersion: "1.0.0",
      input: { value: "ignored" },
    };
    await assertDataConnectorConformance({
      connector,
      request,
      environment: { TIANGONG_DATA_TEST_TOKEN: "conformance-secret" },
      fetchImpl: (async (target, init) => {
        const url = new URL(String(target));
        const page = url.searchParams.get("page")!;
        requestedPages.push(page);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer conformance-secret");
        return new Response(JSON.stringify({ values: [`value-${page}`] }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    assert.deepEqual(requestedPages, ["1", "2"]);
  });
});
