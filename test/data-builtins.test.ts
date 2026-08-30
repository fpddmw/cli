import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { builtInDataRegistry } from "../src/data/builtins.js";
import { runDataCommand } from "../src/data/commands.js";

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      env: {},
      stdout: { write: (chunk: string) => void (stdout += chunk) },
      stderr: { write: (chunk: string) => void (stderr += chunk) },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("built-in data connectors", () => {
  it("publishes both first-batch capabilities in deterministic order", () => {
    assert.deepEqual(
      builtInDataRegistry.catalog().capabilities.map((item) => item.capabilityId),
      ["airnow.hourly-observations", "federal-register.documents"],
    );
  });

  it("describes and diagnoses each capability offline", async () => {
    for (const capabilityId of ["airnow.hourly-observations", "federal-register.documents"]) {
      const description = builtInDataRegistry.describe(capabilityId);
      assert.equal(description?.operations.length, 1);
      let fetched = false;
      const capture = captureIo();
      const exitCode = await runDataCommand(["doctor", capabilityId, "--json"], capture.io, {
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("offline doctor must not fetch");
        }) as typeof fetch,
      });
      assert.equal(exitCode, 0);
      assert.equal(fetched, false);
      assert.equal(JSON.parse(capture.stdout()).networkAttempted, false);
      assert.equal(capture.stderr(), "");
    }
  });
});
