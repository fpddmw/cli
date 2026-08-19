import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyPlatformPathRelation,
  researchPlatformCapabilities,
} from "../src/research/workspace/platform-capabilities.js";

describe("cross-platform research contracts", () => {
  it("classifies Windows drive letters, separators, case, and cross-drive paths on Linux", () => {
    const root = "C:\\Users\\Runner\\project\\.tiangong-research";

    assert.equal(
      classifyPlatformPathRelation({
        platform: "win32",
        root,
        candidate: "c:/users/runner/PROJECT/.tiangong-research/objects/model.py",
      }),
      "inside",
    );
    assert.equal(
      classifyPlatformPathRelation({
        platform: "win32",
        root,
        candidate: "C:\\Users\\Runner\\project\\.tiangong-research",
      }),
      "same",
    );
    assert.equal(
      classifyPlatformPathRelation({
        platform: "win32",
        root,
        candidate: "C:\\Users\\Runner\\project\\.tiangong-research-old\\model.py",
      }),
      "outside",
    );
    assert.equal(
      classifyPlatformPathRelation({
        platform: "win32",
        root,
        candidate: "D:\\Users\\Runner\\project\\model.py",
      }),
      "outside",
    );
  });

  it("treats the macOS /var parent alias as /private/var without host filesystem access", () => {
    const root = "/private/var/folders/ab/work/.tiangong-research";

    assert.equal(
      classifyPlatformPathRelation({
        platform: "darwin",
        root,
        candidate: "/var/folders/ab/work/.tiangong-research/objects/model.py",
      }),
      "inside",
    );
    assert.equal(
      classifyPlatformPathRelation({
        platform: "darwin",
        root: "/var/folders/ab/work/.tiangong-research",
        candidate: root,
      }),
      "same",
    );
    assert.equal(
      classifyPlatformPathRelation({
        platform: "darwin",
        root,
        candidate: "/var/folders/ab/work/model.py",
      }),
      "outside",
    );
  });

  it("centralizes native execution and Windows configuration-only capabilities", () => {
    assert.deepEqual(researchPlatformCapabilities("win32"), {
      platform: "win32",
      pathFlavor: "win32",
      pathCaseSensitive: false,
      pathAliases: [],
      nativeIsolationProvider: null,
      nativeReviewerExecution: false,
      reviewerSidecarExecution: false,
      setupMode: "configuration-smoke",
      productionResearch: false,
    });
    assert.deepEqual(researchPlatformCapabilities("darwin"), {
      platform: "darwin",
      pathFlavor: "posix",
      pathCaseSensitive: true,
      pathAliases: [{ alias: "/var", canonical: "/private/var" }],
      nativeIsolationProvider: "sandbox-exec",
      nativeReviewerExecution: true,
      reviewerSidecarExecution: true,
      setupMode: "native",
      productionResearch: true,
    });
    assert.equal(researchPlatformCapabilities("linux").nativeIsolationProvider, "bubblewrap");
    assert.equal(researchPlatformCapabilities("linux").productionResearch, true);

    const unsupported = researchPlatformCapabilities("freebsd");
    assert.equal(unsupported.setupMode, "configuration-smoke");
    assert.equal(unsupported.nativeIsolationProvider, null);
    assert.equal(unsupported.reviewerSidecarExecution, false);
    assert.equal(unsupported.productionResearch, false);
  });
});
