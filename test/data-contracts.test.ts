import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import {
  DATA_PUBLIC_SCHEMA_IDS,
  dataPublicSchemas,
  validateDataPublicContract,
} from "../src/data/schemas.js";
import { canonicalJson, sha256CanonicalJson } from "../src/data/runtime/canonical-json.js";
import { syntheticConnector } from "./support/data-synthetic-connector.js";

describe("data canonical JSON", () => {
  it("sorts object keys by code point without changing array order", () => {
    assert.equal(
      canonicalJson({ z: [3, 2, 1], a: { beta: 2, alpha: 1 } }),
      '{"a":{"alpha":1,"beta":2},"z":[3,2,1]}',
    );
    assert.equal(sha256CanonicalJson({ z: 2, a: 1 }), sha256CanonicalJson({ a: 1, z: 2 }));
  });

  it("rejects values that JSON cannot represent deterministically", () => {
    assert.throws(() => canonicalJson({ missing: undefined }), /undefined/);
    assert.throws(() => canonicalJson({ invalid: Number.NaN }), /finite/);
    assert.throws(() => canonicalJson({ invalid: 1n }), /bigint/);
  });
});

describe("data public schemas", () => {
  it("ships one closed schema for every public contract", () => {
    assert.deepEqual(Object.keys(dataPublicSchemas).sort(), [
      "catalog",
      "coreReceipt",
      "describe",
      "doctor",
      "error",
      "manifest",
      "runRequest",
      "runResult",
    ]);
    for (const [name, schema] of Object.entries(dataPublicSchemas)) {
      assert.equal(schema.$id, DATA_PUBLIC_SCHEMA_IDS[name as keyof typeof DATA_PUBLIC_SCHEMA_IDS]);
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    }
  });

  it("validates a published manifest and rejects undeclared fields", () => {
    const registry = createDataRegistry([syntheticConnector()]);
    const manifest = registry.describe("test.synthetic");
    assert.ok(manifest);
    assert.doesNotThrow(() => validateDataPublicContract("manifest", manifest));
    assert.throws(
      () => validateDataPublicContract("manifest", { ...manifest, unexpected: true }),
      /additional properties/i,
    );
  });
});

describe("data registry", () => {
  it("keeps an empty registry deterministic and side-effect free", () => {
    const first = createDataRegistry([]).catalog();
    const second = createDataRegistry([]).catalog();
    assert.deepEqual(first, second);
    assert.deepEqual(first.capabilities, []);
    assert.match(first.catalogDigest, /^[a-f0-9]{64}$/);
  });

  it("publishes stable manifest and schema digests", () => {
    const first = createDataRegistry([syntheticConnector()]).describe("test.synthetic");
    const second = createDataRegistry([syntheticConnector()]).describe("test.synthetic");
    assert.deepEqual(first, second);
    assert.match(first?.manifestDigest ?? "", /^[a-f0-9]{64}$/);
    assert.match(first?.operations[0]?.inputSchema.digest ?? "", /^[a-f0-9]{64}$/);
    assert.match(first?.operations[0]?.outputSchema.digest ?? "", /^[a-f0-9]{64}$/);
  });

  it("does not let caller mutation change a registered connector contract", () => {
    const definition = syntheticConnector();
    const registry = createDataRegistry([definition]);
    const before = registry.describe("test.synthetic");
    definition.capabilityVersion = "9.9.9";
    definition.endpoints[0]!.baseUrl = "https://changed.example";
    (definition.operations[0]!.inputSchema.properties as Record<string, unknown>).value = {
      type: "number",
    };
    assert.deepEqual(registry.describe("test.synthetic"), before);
    assert.equal(registry.registered("test.synthetic")?.definition.capabilityVersion, "1.0.0");
  });
});
