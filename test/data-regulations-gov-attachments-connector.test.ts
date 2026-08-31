import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { regulationsGovAttachmentsConnector } from "../src/data/connectors/regulations-gov-attachments.js";
import { REGULATIONS_GOV_ATTACHMENTS_INPUT_SCHEMA } from "../src/data/connectors/regulations-gov-attachments.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

const API_KEY = "synthetic-regulations-gov-key";
const FIRST_COMMENT = "EPA-HQ-OAR-2026-0001-0002";
const SECOND_COMMENT = "EPA-HQ-OAR-2026-0001-0003";
const FIRST_ATTACHMENT = `${FIRST_COMMENT}-ATTACHMENT-1`;
const SECOND_ATTACHMENT = `${FIRST_COMMENT}-ATTACHMENT-2`;
const PDF_BYTES = Buffer.from("%PDF-1.7\nsynthetic attachment\n", "utf8");
const TEXT_BYTES = Buffer.from("synthetic text attachment\n", "utf8");

function request(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "regulations-gov.attachments",
    capabilityVersion: "1.0.0",
    operationId: "download",
    operationVersion: "1.0.0",
    input: {
      commentIds: [FIRST_COMMENT],
      maxFiles: 10,
      maxTotalBytes: 10_000_000,
      ...inputOverrides,
    },
  };
}

function metadataResponse(
  input: {
    commentId?: string;
    secondDownloadHost?: string;
  } = {},
): Response {
  const commentId = input.commentId ?? FIRST_COMMENT;
  const firstAttachmentId = `${commentId}-ATTACHMENT-1`;
  const secondAttachmentId = `${commentId}-ATTACHMENT-2`;
  return Response.json(
    {
      data: {
        id: commentId,
        type: "comments",
        relationships: {
          attachments: {
            data: [
              { id: firstAttachmentId, type: "attachments" },
              { id: secondAttachmentId, type: "attachments" },
            ],
          },
        },
      },
      included: [
        {
          id: firstAttachmentId,
          type: "attachments",
          attributes: {
            title: "Synthetic supporting attachment",
            docAbstract: "Synthetic PDF attachment.",
            docOrder: 1,
            modifyDate: "2026-03-02T14:20:00Z",
            restrictReasonType: null,
            restrictReason: null,
            fileFormats: [
              {
                fileUrl: `https://downloads.regulations.gov/${commentId}/support.pdf`,
                format: "pdf",
                size: PDF_BYTES.byteLength,
              },
            ],
          },
        },
        {
          id: secondAttachmentId,
          type: "attachments",
          attributes: {
            title: "Synthetic text attachment",
            docAbstract: null,
            docOrder: 2,
            modifyDate: null,
            restrictReasonType: null,
            restrictReason: null,
            fileFormats: [
              {
                fileUrl: `${input.secondDownloadHost ?? "https://downloads.regulations.gov"}/${commentId}/notes.txt`,
                format: "txt",
                size: TEXT_BYTES.byteLength,
              },
            ],
          },
        },
      ],
    },
    { headers: { "content-type": "application/vnd.api+json; charset=utf-8" } },
  );
}

function fixtureFetch(options: { failSecondDownload?: boolean } = {}): {
  fetchImpl: typeof fetch;
  requested: string[];
} {
  const requested: string[] = [];
  return {
    requested,
    fetchImpl: (async (target, init) => {
      const url = new URL(String(target));
      requested.push(url.toString());
      if (url.hostname === "api.regulations.gov") {
        assert.equal(new Headers(init?.headers).get("X-Api-Key"), API_KEY);
        assert.equal(url.pathname, `/v4/comments/${FIRST_COMMENT}`);
        assert.equal(url.searchParams.get("include"), "attachments");
        return metadataResponse();
      }
      assert.equal(url.hostname, "downloads.regulations.gov");
      assert.equal(new Headers(init?.headers).get("X-Api-Key"), null);
      if (url.pathname.endsWith("support.pdf")) {
        return new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } });
      }
      if (options.failSecondDownload) throw new Error("synthetic download failure");
      return new Response(TEXT_BYTES, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as typeof fetch,
  };
}

async function withArtifactDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-reggov-attachments-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("Regulations.gov attachments connector", () => {
  it("documents every input field for agent request construction", () => {
    for (const [name, property] of Object.entries(
      REGULATIONS_GOV_ATTACHMENTS_INPUT_SCHEMA.properties,
    )) {
      assert.equal(typeof (property as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((property as Record<string, unknown>).examples), name);
    }
  });

  it("requires an explicit artifact directory and the logical API credential before fetching", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      throw new Error("must not fetch");
    }) as typeof fetch;
    const registry = createDataRegistry([regulationsGovAttachmentsConnector]);

    const missingDirectory = await executeDataRun(request(), {
      registry,
      environment: { REGGOV_API_KEY: API_KEY },
      fetchImpl,
    });
    assert.equal(missingDirectory.status, "blocked");
    assert.equal(missingDirectory.errors[0]?.code, "invalid-request");

    await withArtifactDirectory(async (artifactOutputDirectory) => {
      const missingCredential = await executeDataRun(request(), {
        registry,
        environment: {},
        fetchImpl,
        artifactOutputDirectory,
      });
      assert.equal(missingCredential.status, "blocked");
      assert.equal(missingCredential.errors[0]?.code, "credential-missing");
      assert.deepEqual(await readdir(artifactOutputDirectory), []);
    });
    assert.equal(fetched, false);
  });

  it("downloads selected official files and commits a hash-bound relative manifest", async () => {
    await withArtifactDirectory(async (artifactOutputDirectory) => {
      const fixture = fixtureFetch();
      const result = await executeDataRun(request(), {
        registry: createDataRegistry([regulationsGovAttachmentsConnector]),
        environment: { REGGOV_API_KEY: API_KEY },
        fetchImpl: fixture.fetchImpl,
        artifactOutputDirectory,
      });

      assert.equal(result.status, "success");
      assert.equal(result.summary.recordCount, 2);
      assert.equal(result.summary.chunkCount, 2);
      assert.equal(fixture.requested.length, 3);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(artifactOutputDirectory));
      assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
      const data = result.data as {
        files: Array<{
          attachmentId: string;
          relativePath: string;
          sha256: string;
          byteSize: number;
          sizeMatchesProvider: boolean;
        }>;
        manifest: { relativePath: string; sha256: string; byteSize: number };
        stopReason: string;
      };
      assert.equal(data.stopReason, "completed");
      assert.deepEqual(
        data.files.map((file) => file.attachmentId),
        [FIRST_ATTACHMENT, SECOND_ATTACHMENT],
      );
      assert.equal(data.files[0]?.sha256, createHash("sha256").update(PDF_BYTES).digest("hex"));
      assert.equal(data.files[0]?.byteSize, PDF_BYTES.byteLength);
      assert.equal(data.files[0]?.sizeMatchesProvider, true);
      assert.deepEqual(
        await readFile(join(artifactOutputDirectory, data.files[0]!.relativePath)),
        PDF_BYTES,
      );
      const manifestBytes = await readFile(
        join(artifactOutputDirectory, data.manifest.relativePath),
      );
      assert.equal(data.manifest.sha256, createHash("sha256").update(manifestBytes).digest("hex"));
      assert.equal(data.manifest.byteSize, manifestBytes.byteLength);
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
        schemaVersion: string;
        files: unknown[];
      };
      assert.equal(manifest.schemaVersion, "tiangong.data.artifact-manifest.v1");
      assert.equal(manifest.files.length, 2);
    });
  });

  it("filters explicit attachment IDs without accepting arbitrary file URLs", async () => {
    await withArtifactDirectory(async (artifactOutputDirectory) => {
      let externalFetched = false;
      const result = await executeDataRun(request({ attachmentIds: [SECOND_ATTACHMENT] }), {
        registry: createDataRegistry([regulationsGovAttachmentsConnector]),
        environment: { REGGOV_API_KEY: API_KEY },
        artifactOutputDirectory,
        fetchImpl: (async (target, init) => {
          const url = new URL(String(target));
          if (url.hostname === "api.regulations.gov") {
            assert.equal(new Headers(init?.headers).get("X-Api-Key"), API_KEY);
            return metadataResponse({ secondDownloadHost: "https://example.test" });
          }
          externalFetched = true;
          throw new Error("arbitrary host must not be fetched");
        }) as typeof fetch,
      });
      assert.equal(result.status, "partial");
      assert.equal(externalFetched, false);
      assert.deepEqual(result.summary.missing, [
        { kind: "file", identifiers: [`${SECOND_ATTACHMENT}:format:1`] },
      ]);
      const names = await readdir(artifactOutputDirectory);
      assert.deepEqual(names, ["regulations-gov-attachments-manifest.json"]);
    });
  });

  it("commits earlier files and a manifest when a later official download fails", async () => {
    await withArtifactDirectory(async (artifactOutputDirectory) => {
      const fixture = fixtureFetch({ failSecondDownload: true });
      const result = await executeDataRun(request(), {
        registry: createDataRegistry([regulationsGovAttachmentsConnector]),
        environment: { REGGOV_API_KEY: API_KEY },
        fetchImpl: fixture.fetchImpl,
        artifactOutputDirectory,
      });
      assert.equal(result.status, "partial");
      assert.equal(result.summary.recordCount, 1);
      assert.deepEqual(result.summary.missing, [
        { kind: "file", identifiers: [`${SECOND_ATTACHMENT}:format:1`] },
      ]);
      const names = await readdir(artifactOutputDirectory);
      assert.equal(names.includes("regulations-gov-attachments-manifest.json"), true);
      assert.equal(
        names.some((name) => name.endsWith(".pdf")),
        true,
      );
      assert.equal(
        names.some((name) => name.endsWith(".txt")),
        false,
      );
    });
  });

  it("refuses to overwrite an existing manifest before provider access", async () => {
    await withArtifactDirectory(async (artifactOutputDirectory) => {
      const firstFixture = fixtureFetch();
      const options = {
        registry: createDataRegistry([regulationsGovAttachmentsConnector]),
        environment: { REGGOV_API_KEY: API_KEY },
        fetchImpl: firstFixture.fetchImpl,
        artifactOutputDirectory,
      };
      assert.equal((await executeDataRun(request(), options)).status, "success");
      let fetched = false;
      const second = await executeDataRun(request(), {
        ...options,
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(second.status, "blocked");
      assert.equal(second.errors[0]?.code, "invalid-request");
      assert.equal(fetched, false);
    });
  });

  it("conforms to the artifact-producing connector contract", async () => {
    await withArtifactDirectory(async (artifactOutputDirectory) => {
      const fixture = fixtureFetch();
      await assertDataConnectorConformance({
        connector: regulationsGovAttachmentsConnector,
        request: request({ attachmentIds: [FIRST_ATTACHMENT] }),
        environment: { REGGOV_API_KEY: API_KEY },
        fetchImpl: fixture.fetchImpl,
        artifactOutputDirectory,
      });
    });
  });
});
