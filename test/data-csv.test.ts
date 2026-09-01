import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CsvParseError, parseCsvRows } from "../src/data/runtime/csv.js";

describe("data CSV parser", () => {
  it("parses CRLF, quoted commas, and escaped quotes deterministically", () => {
    assert.deepEqual(parseCsvRows('a,b\r\n"one,two","say ""hi"""\r\n'), [
      ["a", "b"],
      ["one,two", 'say "hi"'],
    ]);
  });

  it("rejects unterminated quoted fields", () => {
    assert.throws(() => parseCsvRows('a,"broken'), CsvParseError);
  });
});
