import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseArgs } from "../src/args.js";
import {
  buildCourseFulltextPrefix,
  resolveCourseFulltextOptions,
  selectCourseFulltextTextKey,
} from "../src/kb/course-fulltext.js";

describe("course fulltext", () => {
  it("builds the course S3 prefix from document id and tags", () => {
    assert.equal(
      buildCourseFulltextPrefix({
        documentId: "000125ed-c4d9-4fe3-9380-000000000000",
        tags: "thu_humanities",
        prefix: "/processed_docs/course_pickle/",
      }),
      "processed_docs/course_pickle/thu_humanities_pickle/000125ed-c4d9-4fe3-9380-000000000000/",
    );
  });

  it("resolves default bucket and prefix from CLI args", () => {
    const options = resolveCourseFulltextOptions(
      parseArgs([
        "000125ed-c4d9-4fe3-9380-000000000000",
        "--tags",
        "thu_humanities",
        "--region",
        "us-east-1",
      ]),
      {},
    );

    assert.deepEqual(options, {
      documentId: "000125ed-c4d9-4fe3-9380-000000000000",
      tags: "thu_humanities",
      bucket: "tiangong",
      prefix: "processed_docs/course_pickle",
      region: "us-east-1",
    });
  });

  it("selects the only txt object under the document prefix", () => {
    const prefix =
      "processed_docs/course_pickle/thu_humanities_pickle/000125ed-c4d9-4fe3-9380-000000000000/";

    assert.equal(
      selectCourseFulltextTextKey(
        [
          `${prefix}chunks.pkl`,
          `${prefix}metadata.json`,
          `${prefix}full text.TXT`,
          "processed_docs/course_pickle/thu_humanities_pickle/other/fulltext.txt",
        ],
        prefix,
      ),
      `${prefix}full text.TXT`,
    );
  });

  it("rejects missing or ambiguous txt objects", () => {
    const prefix =
      "processed_docs/course_pickle/thu_humanities_pickle/000125ed-c4d9-4fe3-9380-000000000000/";

    assert.throws(() => selectCourseFulltextTextKey([`${prefix}metadata.json`], prefix), {
      code: "COURSE_FULLTEXT_NOT_FOUND",
    });
    assert.throws(() => selectCourseFulltextTextKey([`${prefix}a.txt`, `${prefix}b.txt`], prefix), {
      code: "COURSE_FULLTEXT_AMBIGUOUS",
    });
  });
});
