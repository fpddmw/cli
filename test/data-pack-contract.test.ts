import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { DATA_PUBLIC_SCHEMA_IDS, dataPublicSchemas } from "../src/data/schemas.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("data package contract", () => {
  it("emits every public JSON Schema into dist", async () => {
    const filenames = {
      catalog: "catalog.v1.json",
      coreReceipt: "core-receipt.v1.json",
      describe: "describe.v1.json",
      doctor: "doctor.v1.json",
      error: "error.v1.json",
      manifest: "manifest.v1.json",
      runRequest: "run-request.v1.json",
      runResult: "run-result.v1.json",
    } as const;
    for (const [name, filename] of Object.entries(filenames)) {
      const parsed = JSON.parse(
        await readFile(join(repositoryRoot, "dist", "data", "schemas", filename), "utf8"),
      ) as { $id: string };
      const typedName = name as keyof typeof filenames;
      assert.equal(parsed.$id, DATA_PUBLIC_SCHEMA_IDS[typedName]);
      assert.deepEqual(parsed, dataPublicSchemas[typedName]);
    }
  });
});
