import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { federalRegisterDocumentsConnector } from "../src/data/connectors/federal-register-documents.js";
import { FEDERAL_REGISTER_INPUT_SCHEMA } from "../src/data/connectors/federal-register-documents.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";

const FIXTURE_ROOT = new URL("./fixtures/data/federal-register/", import.meta.url);

function request(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "federal-register.documents",
    capabilityVersion: "1.0.0",
    operationId: "search",
    operationVersion: "1.0.0",
    input: {
      term: "clean air",
      publicationDate: { from: "2026-01-01", to: "2026-03-31" },
      agencies: ["environmental-protection-agency"],
      documentTypes: ["RULE"],
      topics: ["Air Pollution Control"],
      docketId: "EPA-HQ-OAR-2024-0001",
      regulationIdNumber: "2060-AV01",
      order: "newest",
      pageSize: 2,
      ...inputOverrides,
    },
  };
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE_ROOT), "utf8");
}

function responseFor(name: string): Promise<Response> {
  return fixture(name).then(
    (body) => new Response(body, { headers: { "content-type": "application/json" } }),
  );
}

describe("Federal Register documents connector", () => {
  it("documents every input field for agent selection and request construction", () => {
    for (const [name, schema] of Object.entries(FEDERAL_REGISTER_INPUT_SCHEMA.properties)) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
    for (const [name, schema] of Object.entries(
      FEDERAL_REGISTER_INPUT_SCHEMA.properties.publicationDate.properties,
    )) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
  });

  it("encodes all filters deterministically and returns bounded paginated metadata", async () => {
    const requestedUrls: string[] = [];
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([federalRegisterDocumentsConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        requestedUrls.push(url.toString());
        return responseFor(url.searchParams.get("page") === "2" ? "page-2.json" : "page-1.json");
      }) as typeof fetch,
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.pageCount, 2);
    assert.equal(result.summary.recordCount, 3);
    assert.equal(result.summary.truncated, false);
    assert.equal(requestedUrls.length, 2);
    const first = new URL(requestedUrls[0]!);
    assert.deepEqual(first.searchParams.getAll("fields[]"), [
      "abstract",
      "action",
      "agencies",
      "agency_names",
      "body_html_url",
      "citation",
      "comments_close_on",
      "dates",
      "docket_id",
      "docket_ids",
      "document_number",
      "effective_on",
      "full_text_xml_url",
      "html_url",
      "json_url",
      "pdf_url",
      "public_inspection_pdf_url",
      "publication_date",
      "raw_text_url",
      "regulation_id_numbers",
      "regulations_dot_gov_url",
      "significant",
      "title",
      "topics",
      "type",
    ]);
    assert.equal(first.searchParams.get("conditions[term]"), "clean air");
    assert.equal(first.searchParams.get("conditions[publication_date][gte]"), "2026-01-01");
    assert.equal(first.searchParams.get("conditions[publication_date][lte]"), "2026-03-31");
    assert.deepEqual(first.searchParams.getAll("conditions[agencies][]"), [
      "environmental-protection-agency",
    ]);
    assert.deepEqual(first.searchParams.getAll("conditions[type][]"), ["RULE"]);
    assert.deepEqual(first.searchParams.getAll("conditions[topics][]"), ["Air Pollution Control"]);
    assert.equal(first.searchParams.get("conditions[docket_id]"), "EPA-HQ-OAR-2024-0001");
    assert.equal(first.searchParams.get("conditions[regulation_id_number]"), "2060-AV01");
    assert.equal(first.searchParams.get("order"), "newest");
    assert.equal(first.searchParams.get("per_page"), "2");
    assert.equal(first.searchParams.get("page"), "1");
    const data = result.data as {
      records: Array<Record<string, unknown>>;
      stopReason: string;
      provider: { count: number; totalPages: number };
    };
    assert.equal(data.stopReason, "completed");
    assert.deepEqual(data.provider, {
      description: "Documents matching synthetic test filters",
      count: 3,
      totalPages: 2,
    });
    assert.deepEqual(
      data.records.map((record) => record.documentNumber),
      ["2026-TEST01", "2026-TEST02", "2026-TEST03"],
    );
    assert.equal(
      data.records.some((record) => "body" in record || "rawText" in record),
      false,
    );
  });

  it("normalizes equivalent array filter order into the same request URL", async () => {
    const targets: string[] = [];
    for (const agencies of [
      ["environmental-protection-agency", "energy-department"],
      ["energy-department", "environmental-protection-agency"],
    ]) {
      await executeDataRun(request({ agencies }), {
        registry: createDataRegistry([federalRegisterDocumentsConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          targets.push(String(target));
          return responseFor("empty.json");
        }) as typeof fetch,
      });
    }
    assert.equal(targets[0], targets[1]);
  });

  it("returns a complete empty result without inventing records", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([federalRegisterDocumentsConnector]),
      environment: {},
      fetchImpl: (async () => responseFor("empty.json")) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 0);
    const data = result.data as { records: unknown[]; stopReason: string };
    assert.deepEqual(data.records, []);
    assert.equal(data.stopReason, "no-results");
  });

  it("marks intentional max-page and max-record truncation", async () => {
    const maxPages = await executeDataRun(
      { ...request(), limits: { maxPages: 1 } },
      {
        registry: createDataRegistry([federalRegisterDocumentsConnector]),
        environment: {},
        fetchImpl: (async () => responseFor("page-1.json")) as typeof fetch,
      },
    );
    assert.equal(maxPages.status, "success");
    assert.equal(maxPages.summary.truncated, true);
    assert.equal((maxPages.data as { stopReason: string }).stopReason, "max-pages");

    const maxRecords = await executeDataRun(
      { ...request(), limits: { maxRecords: 1 } },
      {
        registry: createDataRegistry([federalRegisterDocumentsConnector]),
        environment: {},
        fetchImpl: (async () => responseFor("page-1.json")) as typeof fetch,
      },
    );
    assert.equal(maxRecords.status, "success");
    assert.equal(maxRecords.summary.recordCount, 1);
    assert.equal(maxRecords.summary.truncated, true);
    assert.equal((maxRecords.data as { stopReason: string }).stopReason, "max-records");
  });

  it("validates only records inside the explicit record budget", async () => {
    const payload = JSON.parse(await fixture("page-1.json")) as {
      results: Array<{ agencies: Array<{ name: string; raw_name?: string }> }>;
    };
    payload.results[1]!.agencies[0]!.name = "";
    delete payload.results[1]!.agencies[0]!.raw_name;
    const result = await executeDataRun(
      { ...request(), limits: { maxRecords: 1 } },
      {
        registry: createDataRegistry([federalRegisterDocumentsConnector]),
        environment: {},
        fetchImpl: (async () =>
          new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.truncated, true);
  });

  it("tolerates optional provider summary metadata that is absent or malformed", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([federalRegisterDocumentsConnector]),
      environment: {},
      fetchImpl: (async () => responseFor("invalid-metadata.json")) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.deepEqual((result.data as { provider: unknown }).provider, {
      description: "Invalid provider metadata",
      count: null,
      totalPages: 1,
    });
  });

  it("preserves validated earlier pages when a later page fails", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([federalRegisterDocumentsConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        const page = new URL(String(target)).searchParams.get("page");
        return page === "2"
          ? new Response("provider unavailable", { status: 503 })
          : responseFor("page-1.json");
      }) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 2);
    assert.deepEqual(result.summary.missing, [{ kind: "page", identifiers: ["2"] }]);
    assert.equal(result.errors[0]?.code, "partial-result");
    assert.deepEqual(
      (result.data as { records: Array<{ documentNumber: string }> }).records.map(
        (record) => record.documentNumber,
      ),
      ["2026-TEST01", "2026-TEST02"],
    );
  });

  it("supports a provider-wide newest listing within runtime page and record limits", async () => {
    let requested: URL | undefined;
    const result = await executeDataRun(
      { ...request(), input: {} },
      {
        registry: createDataRegistry([federalRegisterDocumentsConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          requested = new URL(String(target));
          return responseFor("empty.json");
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 0);
    assert.equal(
      [...(requested?.searchParams.keys() ?? [])].some((key) => key.startsWith("conditions[")),
      false,
    );
    assert.equal(requested?.searchParams.get("order"), "newest");
  });

  it("preserves sparse records and source-provided governance links", async () => {
    const payload = {
      description: "Sparse synthetic result",
      count: 1,
      total_pages: 1,
      next_page_url: null,
      results: [
        {
          citation: "91 FR 1234",
          comments_close_on: "2026-04-30",
          raw_text_url: "https://www.federalregister.gov/example.txt",
          full_text_xml_url: "https://www.federalregister.gov/example.xml",
          regulations_dot_gov_url: "https://www.regulations.gov/document/TEST-1",
        },
      ],
    };
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([federalRegisterDocumentsConnector]),
      environment: {},
      fetchImpl: (async () => Response.json(payload)) as typeof fetch,
    });

    assert.equal(result.status, "success");
    const record = (result.data as { records: Array<Record<string, unknown>> }).records[0];
    assert.equal(record?.documentNumber, "federal-register-0");
    assert.equal(record?.title, "Federal Register document federal-register-0");
    assert.equal(record?.publicationDate, "");
    assert.equal(record?.citation, "91 FR 1234");
    assert.equal(record?.commentsCloseOn, "2026-04-30");
    assert.equal(record?.rawTextUrl, "https://www.federalregister.gov/example.txt");
  });
});
