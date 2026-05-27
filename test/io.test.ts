import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import { readJsonInput, stringifyJson } from "../src/io.js";

describe("io", () => {
  it("reads JSON input files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-io-test-"));
    try {
      const inputPath = join(tempDir, "request.json");
      await writeFile(inputPath, JSON.stringify({ query: "plastic recycling", nested: { k: 1 } }));

      assert.deepEqual(readJsonInput(inputPath), {
        query: "plastic recycling",
        nested: { k: 1 },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports missing and invalid JSON inputs as structured CLI errors", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tiangong-io-invalid-test-"));
    try {
      assert.throws(
        () => readJsonInput(""),
        (error) =>
          error instanceof CliError && error.code === "INPUT_REQUIRED" && error.exitCode === 2,
      );

      assert.throws(
        () => readJsonInput(join(tempDir, "missing.json")),
        (error) =>
          error instanceof CliError && error.code === "INPUT_NOT_FOUND" && error.exitCode === 2,
      );

      const invalidPath = join(tempDir, "invalid.json");
      await writeFile(invalidPath, "{");
      assert.throws(
        () => readJsonInput(invalidPath),
        (error) =>
          error instanceof CliError && error.code === "INPUT_INVALID_JSON" && error.exitCode === 2,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stringifies compact and pretty JSON with trailing newlines", () => {
    assert.equal(stringifyJson({ ok: true }, true), '{"ok":true}\n');
    assert.equal(stringifyJson({ ok: true }, false), '{\n  "ok": true\n}\n');
  });
});
