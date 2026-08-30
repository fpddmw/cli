import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { partialResult, syntheticConnector } from "./support/data-synthetic-connector.js";

function request(overrides: Partial<DataRunRequest> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "test.synthetic",
    capabilityVersion: "1.0.0",
    operationId: "echo",
    operationVersion: "1.0.0",
    input: { value: "hello" },
    ...overrides,
  };
}

describe("data execution", () => {
  it("validates input and emits a schema-valid success result", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([syntheticConnector()]),
      environment: {},
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.data, { echoed: "hello" });
    assert.equal(result.summary.completeness, "complete");
    assert.match(result.receipt.requestDigest, /^[a-f0-9]{64}$/);
    assert.match(result.receipt.normalizedDataDigest ?? "", /^[a-f0-9]{64}$/);
    assert.match(result.receipt.receiptDigest, /^[a-f0-9]{64}$/);
  });

  it("returns blocked machine errors for invalid input without running the connector", async () => {
    let executed = false;
    const result = await executeDataRun(request({ input: { value: 3 } }), {
      registry: createDataRegistry([
        syntheticConnector({
          execute: () => {
            executed = true;
            throw new Error("must not run");
          },
        }),
      ]),
      environment: {},
    });

    assert.equal(executed, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.data, null);
    assert.equal(result.errors[0]?.code, "invalid-request");
    assert.equal(result.receipt.completionStatus, "blocked");
  });

  it("rejects non-JSON values before semantic receipt hashing", async () => {
    const result = await executeDataRun(
      request({ input: { value: "hello", unsupported: undefined } }),
      {
        registry: createDataRegistry([syntheticConnector()]),
        environment: {},
      },
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "invalid-request");
    assert.match(result.receipt.receiptDigest, /^[a-f0-9]{64}$/);
  });

  it("rejects capability and operation version drift", async () => {
    const registry = createDataRegistry([syntheticConnector()]);
    const capability = await executeDataRun(request({ capabilityVersion: "2.0.0" }), {
      registry,
      environment: {},
    });
    const operation = await executeDataRun(request({ operationVersion: "2.0.0" }), {
      registry,
      environment: {},
    });

    assert.equal(capability.errors[0]?.code, "incompatible-contract");
    assert.equal(operation.errors[0]?.code, "incompatible-contract");
  });

  it("blocks before execution when a required logical credential is missing", async () => {
    let executed = false;
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([
        syntheticConnector({
          credential: true,
          execute: () => {
            executed = true;
            throw new Error("must not run");
          },
        }),
      ]),
      environment: {},
    });

    assert.equal(executed, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "credential-missing");
    assert.equal(result.errors[0]?.userActionRequired, true);
  });

  it("does not let an invalid connector output escape the output schema", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([
        syntheticConnector({
          execute: () => ({
            status: "success",
            data: { wrong: true },
            summary: {
              recordCount: 1,
              pageCount: 0,
              chunkCount: 0,
              truncated: false,
              completeness: "complete",
            },
            warnings: [],
            errors: [],
            observations: [],
          }),
        }),
      ]),
      environment: {},
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.data, null);
    assert.equal(result.errors[0]?.code, "provider-response-invalid");
  });

  it("keeps partial data explicit and exits the semantic happy path", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([syntheticConnector({ execute: () => partialResult() })]),
      environment: {},
    });

    assert.equal(result.status, "partial");
    assert.deepEqual(result.summary.missing, [{ kind: "page", identifiers: ["2"] }]);
    assert.equal(result.errors[0]?.code, "partial-result");
    assert.equal(result.receipt.completionStatus, "partial");
  });

  it("keeps audit time and request IDs outside the semantic receipt digest", async () => {
    const registry = createDataRegistry([syntheticConnector()]);
    const first = await executeDataRun(request({ requestId: "caller-one" }), {
      registry,
      environment: {},
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    const second = await executeDataRun(request({ requestId: "caller-two" }), {
      registry,
      environment: {},
      clock: () => new Date("2026-08-31T00:00:00.000Z"),
    });

    assert.notEqual(first.receipt.generatedAt, second.receipt.generatedAt);
    assert.equal(first.receipt.receiptDigest, second.receipt.receiptDigest);
  });
});
