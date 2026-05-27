import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import { parseStrictArgs, strictBoolean, strictString } from "../src/strict-args.js";

describe("parseStrictArgs", () => {
  const options = {
    query: "string",
    "dry-run": "boolean",
    json: "boolean",
  } as const;

  it("parses string and boolean options", () => {
    const args = parseStrictArgs(
      ["--query", "mechanical recycling", "--dry-run", "--json=true"],
      options,
      "research search",
    );

    assert.equal(strictString(args, "query"), "mechanical recycling");
    assert.equal(strictBoolean(args, "dry-run"), true);
    assert.equal(strictBoolean(args, "json"), true);
    assert.deepEqual(args.positionals, []);
  });

  it("supports equals syntax and boolean false", () => {
    const args = parseStrictArgs(
      ["--query=filter layer", "--json=false"],
      options,
      "education search",
    );

    assert.equal(strictString(args, "query"), "filter layer");
    assert.equal(strictBoolean(args, "json"), false);
  });

  it("rejects unknown options with structured CLI errors", () => {
    assert.throws(
      () => parseStrictArgs(["--no-expand"], options, "research search"),
      (error) =>
        error instanceof CliError &&
        error.code === "INVALID_ARGS" &&
        error.exitCode === 2 &&
        /Unknown option/.test(error.message),
    );
  });

  it("rejects missing string values and invalid boolean values", () => {
    assert.throws(
      () => parseStrictArgs(["--query", "--json"], options, "education search"),
      /Missing value for --query/,
    );
    assert.throws(
      () => parseStrictArgs(["--json=maybe"], options, "education search"),
      /Boolean option --json must be true or false/,
    );
  });
});
