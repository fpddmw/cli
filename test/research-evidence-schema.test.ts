import assert from "node:assert/strict";
import { it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

import { runCli } from "../src/cli.js";

it("publishes closed CLI-owned content input schemas and shared batch bounds", async () => {
  const atom = {
    schemaVersion: 1,
    atomId: "fact-1",
    sourceId: "source-1",
    candidateId: "candidate-1",
    artifactId: "artifact-1",
    locator: { kind: "line-range", startLine: 1, endLine: 1 },
    statement: "A precise source-backed observation.",
    evidenceRoleIds: [],
    coverageDimensionIds: ["research-question"],
    evidenceFunction: "support",
    scope: "Offline schema contract verification.",
    limitations: [],
  };
  const decomposition = {
    schemaVersion: 1,
    sourceArtifactId: "artifact-1",
    status: "complete",
    parser: { id: "test.parser", version: "1" },
    outputArtifactIds: ["artifact-2"],
    contentClasses: ["fulltext"],
    limitations: [],
  };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const [name, input] of [
    ["evidence-atom", atom],
    ["artifact-decomposition", decomposition],
  ] as const) {
    const single = await invoke(["research", "schema", "show", name, "--json"]);
    assert.equal(single.exitCode, 0, single.stderr);
    const schema = JSON.parse(single.stdout);
    assert.match(schema.description, /shape|structur/i);
    assert.match(schema.description, /execution|command/i);
    const validate = ajv.compile(schema);
    assert.equal(validate(input), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...input, unexpected: true }), false);
    assert.equal(validate({ ...input, schemaVersion: 2 }), false);
    const batch = await invoke(["research", "schema", "show", `${name}-batch`, "--json"]);
    assert.equal(batch.exitCode, 0, batch.stderr);
    const batchSchema = JSON.parse(batch.stdout);
    assert.equal(batchSchema.properties.records.maxItems, 500);
    assert.match(batchSchema.description, /4194304/);
    const validateBatch = ajv.compile(batchSchema);
    assert.equal(validateBatch({ schemaVersion: 1, records: [input] }), true);
    assert.equal(validateBatch({ schemaVersion: 1, records: [] }), false);
    assert.equal(
      validateBatch({ schemaVersion: 1, records: Array.from({ length: 501 }, () => input) }),
      false,
    );
    assert.equal(
      validateBatch({ schemaVersion: 1, records: [{ ...input, unexpected: true }] }),
      false,
    );
  }
  const help = await invoke(["research", "--help"]);
  assert.equal(help.exitCode, 0, help.stderr);
  assert.match(help.stdout, /500 records/);
  assert.match(help.stdout, /4194304 bytes/);
  assert.match(help.stdout, /evidence-atom-batch/);
  assert.match(help.stdout, /artifact-decomposition-batch/);
});

async function invoke(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    env: {},
    stdout: { write: (chunk) => ((stdout += chunk), true) },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
  });
  return { exitCode, stdout, stderr };
}
