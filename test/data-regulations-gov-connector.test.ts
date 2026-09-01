import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { regulationsGovCommentsConnector } from "../src/data/connectors/regulations-gov-comments.js";
import {
  REGULATIONS_GOV_DETAIL_INPUT_SCHEMA,
  REGULATIONS_GOV_SEARCH_INPUT_SCHEMA,
} from "../src/data/connectors/regulations-gov-comments.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

const FIXTURE_ROOT = new URL("./fixtures/data/regulations-gov/", import.meta.url);
const API_KEY = "regulations-gov-test-key-that-must-not-escape";

function searchRequest(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "regulations-gov.comments",
    capabilityVersion: "1.0.0",
    operationId: "search",
    operationVersion: "1.0.0",
    input: Object.fromEntries(
      Object.entries({
        postedDate: { from: "2026-03-01", to: "2026-03-02" },
        agencyId: "EPA",
        searchTerm: "air quality",
        pageSize: 5,
        sortOrder: "asc",
        ...inputOverrides,
      }).filter(([, value]) => value !== undefined),
    ),
  };
}

function detailRequest(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "regulations-gov.comments",
    capabilityVersion: "1.0.0",
    operationId: "fetch-details",
    operationVersion: "1.0.0",
    input: {
      commentIds: ["EPA-HQ-OAR-2026-0001-0002"],
      includeAttachments: true,
      ...inputOverrides,
    },
  };
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE_ROOT), "utf8");
}

function jsonResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "application/vnd.api+json; charset=utf-8" },
  });
}

async function successfulFetch(target: string | URL | Request): Promise<Response> {
  const url = new URL(String(target));
  if (url.pathname === "/v4/comments") {
    return jsonResponse(await fixture(`search-page-${url.searchParams.get("page[number]")}.json`));
  }
  if (url.pathname.endsWith("0002")) {
    return jsonResponse(await fixture("detail-with-attachments.json"));
  }
  if (url.pathname.endsWith("0001")) {
    return jsonResponse(await fixture("detail-without-attachments.json"));
  }
  throw new Error(`Unexpected fixture URL: ${url.pathname}${url.search}`);
}

describe("Regulations.gov comments connector", () => {
  it("documents every operation input and nested date-window field", () => {
    for (const schema of [
      REGULATIONS_GOV_SEARCH_INPUT_SCHEMA,
      REGULATIONS_GOV_DETAIL_INPUT_SCHEMA,
    ]) {
      for (const [name, field] of Object.entries(schema.properties)) {
        assert.equal(typeof (field as Record<string, unknown>).description, "string", name);
        assert.ok(Array.isArray((field as Record<string, unknown>).examples), name);
      }
    }
    for (const window of ["postedDate", "lastModifiedDate"] as const) {
      for (const [name, field] of Object.entries(
        REGULATIONS_GOV_SEARCH_INPUT_SCHEMA.properties[window].properties,
      )) {
        assert.equal(typeof (field as Record<string, unknown>).description, "string", name);
        assert.ok(Array.isArray((field as Record<string, unknown>).examples), name);
      }
    }
  });

  it("blocks both operations before network access when the logical API key is missing", async () => {
    for (const request of [searchRequest(), detailRequest()]) {
      let fetched = false;
      const result = await executeDataRun(request, {
        registry: createDataRegistry([regulationsGovCommentsConnector]),
        environment: {},
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.errors[0]?.code, "credential-missing");
      assert.equal(fetched, false);
      assert.doesNotMatch(JSON.stringify(result), /REGGOV_API_KEY|regulations-gov-test-key/);
    }
  });

  it("searches a bounded posted-date window with stable pagination", async () => {
    const requested: string[] = [];
    const result = await executeDataRun(searchRequest(), {
      registry: createDataRegistry([regulationsGovCommentsConnector]),
      environment: { REGGOV_API_KEY: API_KEY },
      fetchImpl: (async (target, init) => {
        const url = new URL(String(target));
        requested.push(`${url.pathname}?${url.searchParams.toString()}`);
        assert.equal(new Headers(init?.headers).get("X-Api-Key"), API_KEY);
        return successfulFetch(target);
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 6);
    assert.equal(result.summary.pageCount, 2);
    assert.deepEqual(requested, [
      "/v4/comments?filter%5BagencyId%5D=EPA&filter%5BpostedDate%5D%5Bge%5D=2026-03-01&filter%5BpostedDate%5D%5Ble%5D=2026-03-02&filter%5BsearchTerm%5D=air+quality&page%5Bnumber%5D=1&page%5Bsize%5D=5&sort=postedDate%2CdocumentId",
      "/v4/comments?filter%5BagencyId%5D=EPA&filter%5BpostedDate%5D%5Bge%5D=2026-03-01&filter%5BpostedDate%5D%5Ble%5D=2026-03-02&filter%5BsearchTerm%5D=air+quality&page%5Bnumber%5D=2&page%5Bsize%5D=5&sort=postedDate%2CdocumentId",
    ]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
    const data = result.data as { records: Array<Record<string, unknown>>; stopReason: string };
    assert.equal(data.stopReason, "completed");
    assert.deepEqual(data.records[0], {
      recordIndex: 0,
      sourcePageNumber: 1,
      commentId: "EPA-HQ-OAR-2026-0001-0002",
      agencyId: "EPA",
      documentType: "Proposed Rule",
      highlightedContent: "Synthetic highlighted air quality text",
      lastModifiedDateTime: "2026-03-02T14:30:00Z",
      objectId: "0900006480000002",
      postedDateTime: "2026-03-02T12:00:00Z",
      title: "Synthetic comment two",
      withdrawn: false,
    });
  });

  it("preserves absent provider search metadata as explicit nulls", async () => {
    const result = await executeDataRun(searchRequest({ agencyId: undefined }), {
      registry: createDataRegistry([regulationsGovCommentsConnector]),
      environment: { REGGOV_API_KEY: API_KEY },
      fetchImpl: (async () =>
        jsonResponse(
          JSON.stringify({
            data: [{ id: "EPA-HQ-OAR-2026-0001-0099", type: "comments", attributes: {} }],
            meta: {
              hasNextPage: false,
              hasPreviousPage: false,
              numberOfElements: 1,
              pageNumber: 1,
              pageSize: 5,
              totalElements: 1,
              totalPages: 1,
              firstPage: true,
              lastPage: true,
            },
          }),
        )) as typeof fetch,
    });

    assert.equal(result.status, "success");
    const record = (result.data as { records: Array<Record<string, unknown>> }).records[0];
    assert.deepEqual(record, {
      recordIndex: 0,
      sourcePageNumber: 1,
      commentId: "EPA-HQ-OAR-2026-0001-0099",
      agencyId: null,
      documentType: null,
      highlightedContent: null,
      lastModifiedDateTime: null,
      objectId: null,
      postedDateTime: null,
      title: null,
      withdrawn: null,
    });
  });

  it("converts an RFC3339 last-modified window to the provider's documented Eastern wall time", async () => {
    let requested = "";
    const result = await executeDataRun(
      searchRequest({
        postedDate: undefined,
        lastModifiedDate: {
          from: "2026-03-01T05:00:00Z",
          to: "2026-03-02T04:59:59Z",
        },
        searchTerm: undefined,
      }),
      {
        registry: createDataRegistry([regulationsGovCommentsConnector]),
        environment: { REGGOV_API_KEY: API_KEY },
        fetchImpl: (async (target) => {
          const url = new URL(String(target));
          requested = `${url.pathname}?${url.searchParams.toString()}`;
          return jsonResponse(
            JSON.stringify({
              data: [],
              meta: {
                hasNextPage: false,
                hasPreviousPage: false,
                numberOfElements: 0,
                pageNumber: 1,
                pageSize: 5,
                totalElements: 0,
                totalPages: 0,
                firstPage: true,
                lastPage: true,
              },
            }),
          );
        }) as typeof fetch,
      },
    );
    assert.equal(result.status, "success");
    assert.equal(
      requested,
      "/v4/comments?filter%5BagencyId%5D=EPA&filter%5BlastModifiedDate%5D%5Bge%5D=2026-03-01+00%3A00%3A00&filter%5BlastModifiedDate%5D%5Ble%5D=2026-03-01+23%3A59%3A59&page%5Bnumber%5D=1&page%5Bsize%5D=5&sort=lastModifiedDate%2CdocumentId",
    );
  });

  it("fetches one curated comment detail with attachment metadata but no attachment bytes", async () => {
    let requested = "";
    const result = await executeDataRun(detailRequest(), {
      registry: createDataRegistry([regulationsGovCommentsConnector]),
      environment: { REGGOV_API_KEY: API_KEY },
      fetchImpl: (async (target, init) => {
        const url = new URL(String(target));
        requested = `${url.pathname}?${url.searchParams.toString()}`;
        assert.equal(new Headers(init?.headers).get("X-Api-Key"), API_KEY);
        return successfulFetch(target);
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(requested, "/v4/comments/EPA-HQ-OAR-2026-0001-0002?include=attachments");
    assert.equal(result.summary.recordCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /Sensitive-name|sensitive@example|000-000-0000/);
    const records = (result.data as { records: Array<Record<string, unknown>> }).records;
    assert.deepEqual(records[0], {
      recordIndex: 0,
      requestIndex: 0,
      commentId: "EPA-HQ-OAR-2026-0001-0002",
      agencyId: "EPA",
      commentText: "Synthetic public comment text for connector testing.",
      commentOnDocumentId: "EPA-HQ-OAR-2026-0001-0001",
      docketId: "EPA-HQ-OAR-2026-0001",
      documentType: "Proposed Rule",
      postedDateTime: "2026-03-02T12:00:00Z",
      modifiedDateTime: "2026-03-02T14:30:00Z",
      receivedDateTime: "2026-03-02T10:00:00Z",
      title: "Synthetic comment two",
      trackingNumber: "synthetic-tracking-number",
      withdrawn: false,
      reasonWithdrawn: null,
      restriction: { type: null, reason: null },
      submitterContext: {
        organization: "Synthetic Research Organization",
        governmentAgency: null,
        governmentAgencyType: null,
      },
      duplicateComments: 4,
      attachments: [
        {
          attachmentId: "EPA-HQ-OAR-2026-0001-0002-ATTACHMENT-1",
          title: "Synthetic supporting attachment",
          agencyNote: null,
          authors: ["Synthetic Organization"],
          abstract: "Synthetic attachment abstract.",
          order: 1,
          modifiedDateTime: "2026-03-02T14:20:00Z",
          publication: null,
          restriction: { type: null, reason: null },
          fileFormats: [
            {
              url: "https://downloads.regulations.gov/synthetic/attachment.pdf",
              format: "pdf",
              sizeBytes: 12345,
            },
          ],
        },
      ],
    });
  });

  it("preserves an absent detail modification date and sparse attachment formats", async () => {
    const result = await executeDataRun(detailRequest(), {
      registry: createDataRegistry([regulationsGovCommentsConnector]),
      environment: { REGGOV_API_KEY: API_KEY },
      fetchImpl: (async () =>
        jsonResponse(
          JSON.stringify({
            data: {
              id: "EPA-HQ-OAR-2026-0001-0002",
              type: "comments",
              attributes: {
                agencyId: "EPA",
                comment: "Synthetic sparse detail.",
                commentOnDocumentId: "EPA-HQ-OAR-2026-0001-0001",
                docketId: "EPA-HQ-OAR-2026-0001",
                documentType: "Proposed Rule",
                postedDate: "2026-03-02T12:00:00Z",
                receiveDate: "2026-03-02T10:00:00Z",
                title: "Synthetic sparse comment",
                trackingNbr: "synthetic-sparse-tracking",
                withdrawn: false,
              },
              relationships: {
                attachments: {
                  data: [{ id: "SYNTHETIC-SPARSE-ATTACHMENT", type: "attachments" }],
                },
              },
            },
            included: [
              {
                id: "SYNTHETIC-SPARSE-ATTACHMENT",
                type: "attachments",
                attributes: { fileFormats: [{}] },
              },
            ],
          }),
        )) as typeof fetch,
    });

    assert.equal(result.status, "success");
    const record = (
      result.data as {
        records: Array<{
          modifiedDateTime: string | null;
          attachments: Array<{ fileFormats: Array<Record<string, unknown>> }>;
        }>;
      }
    ).records[0];
    assert.equal(record?.modifiedDateTime, null);
    assert.deepEqual(record?.attachments[0]?.fileFormats, [
      { url: null, format: null, sizeBytes: null },
    ]);
  });

  it("preserves successful details when a later comment request fails", async () => {
    const result = await executeDataRun(
      detailRequest({
        commentIds: ["EPA-HQ-OAR-2026-0001-0002", "EPA-HQ-OAR-2026-0001-9999"],
      }),
      {
        registry: createDataRegistry([regulationsGovCommentsConnector]),
        environment: { REGGOV_API_KEY: API_KEY },
        fetchImpl: (async (target) =>
          String(target).includes("0002")
            ? jsonResponse(await fixture("detail-with-attachments.json"))
            : jsonResponse(
                '{"errors":[{"status":"404","title":"Not found"}]}',
                404,
              )) as typeof fetch,
      },
    );
    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.deepEqual(result.summary.missing, [
      { kind: "range", identifiers: ["EPA-HQ-OAR-2026-0001-9999"] },
    ]);
  });

  it("rejects ambiguous, reversed, oversized, and unsafe requests before fetching", async () => {
    const requests = [
      searchRequest({
        lastModifiedDate: { from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" },
      }),
      searchRequest({ postedDate: { from: "2026-03-02", to: "2026-03-01" } }),
      searchRequest({ postedDate: { from: "2024-01-01", to: "2026-03-01" } }),
      detailRequest({ commentIds: ["../unsafe/path"] }),
    ];
    for (const request of requests) {
      let fetched = false;
      const result = await executeDataRun(request, {
        registry: createDataRegistry([regulationsGovCommentsConnector]),
        environment: { REGGOV_API_KEY: API_KEY },
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.errors[0]?.code, "invalid-request");
      assert.equal(fetched, false);
    }
  });

  it("stops search at a record cap before spending another request", async () => {
    let fetchCount = 0;
    const result = await executeDataRun(
      { ...searchRequest(), limits: { maxRecords: 1 } },
      {
        registry: createDataRegistry([regulationsGovCommentsConnector]),
        environment: { REGGOV_API_KEY: API_KEY },
        fetchImpl: (async () => {
          fetchCount += 1;
          return jsonResponse(await fixture("search-page-1.json"));
        }) as typeof fetch,
      },
    );
    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.truncated, true);
    assert.equal(fetchCount, 1);
  });

  it("publishes comment-quality, privacy, non-posting, and attachment-download boundaries", () => {
    const discovery = createDataRegistry([regulationsGovCommentsConnector]).discovery(
      "regulations-gov.comments",
    );
    assert.ok(discovery);
    assert.ok(
      discovery.limitations.some((item) => /representative|sentiment|public opinion/i.test(item)),
    );
    assert.ok(
      discovery.limitations.some((item) => /agency-configurable|duplicate|withdrawn/i.test(item)),
    );
    assert.ok(discovery.doesNotProvide.some((item) => /post|submit|modify/i.test(item)));
    assert.ok(
      discovery.doesNotProvide.some((item) => /attachment.*download|bytes|full text/i.test(item)),
    );
    assert.ok(discovery.doesNotProvide.some((item) => /email|phone|address|personal/i.test(item)));
    assert.ok(discovery.doesNotProvide.some((item) => /docketId|documentType|subtype/i.test(item)));
    assert.ok(discovery.limitations.some((item) => /null|absent|unavailable/i.test(item)));
    assert.ok(discovery.limitations.some((item) => /lastModifiedDate.*beta/i.test(item)));
  });

  it("conforms for both credentialed operations", async () => {
    for (const request of [searchRequest(), detailRequest()]) {
      await assertDataConnectorConformance({
        connector: regulationsGovCommentsConnector,
        request,
        environment: { REGGOV_API_KEY: API_KEY },
        fetchImpl: successfulFetch as typeof fetch,
      });
    }
  });
});
