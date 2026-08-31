import assert from "node:assert/strict";

import { createDataRegistry } from "../../src/data/catalog.js";
import type { DataConnectorDefinition, DataRunRequest } from "../../src/data/contracts.js";
import { executeDataRun } from "../../src/data/runtime/execute.js";
import { validateDataPublicContract } from "../../src/data/schemas.js";

export async function assertDataConnectorConformance(input: {
  connector: DataConnectorDefinition;
  request: DataRunRequest;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  expectedStatus?: "success" | "partial";
  artifactOutputDirectory?: string;
}): Promise<void> {
  const registry = createDataRegistry([input.connector]);
  const catalog = registry.catalog();
  const manifest = registry.describe(input.connector.capabilityId);
  const schemas = registry.schemas(input.connector.capabilityId);
  assert.equal(catalog.capabilities.length, 1);
  assert.ok(manifest);
  assert.ok(schemas);
  validateDataPublicContract("catalog", catalog);
  validateDataPublicContract("manifest", manifest);
  assert.equal(Object.keys(schemas).length, input.connector.operations.length * 2);

  const result = await executeDataRun(input.request, {
    registry,
    environment: input.environment ?? {},
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.artifactOutputDirectory === undefined
      ? {}
      : { artifactOutputDirectory: input.artifactOutputDirectory }),
    clock: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  assert.equal(result.status, input.expectedStatus ?? "success");
  validateDataPublicContract("runResult", result);
  assert.equal(result.contract.manifestDigest, manifest.manifestDigest);
  assert.equal(result.receipt.manifestDigest, manifest.manifestDigest);
}
