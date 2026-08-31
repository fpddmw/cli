import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { usgsWaterInstantaneousValuesConnector } from "../src/data/connectors/usgs-water-instantaneous-values.js";
import { USGS_WATER_IV_INPUT_SCHEMA } from "../src/data/connectors/usgs-water-instantaneous-values.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

const FIXTURE_ROOT = new URL("./fixtures/data/usgs-water/", import.meta.url);

function request(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  const input: Record<string, unknown> = {
    boundingBox: {
      minLongitude: -77.3,
      minLatitude: 38.8,
      maxLongitude: -77,
      maxLatitude: 39.1,
    },
    period: "P1D",
    ...inputOverrides,
  };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) delete input[key];
  }
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "usgs.water-instantaneous-values",
    capabilityVersion: "1.0.0",
    operationId: "fetch",
    operationVersion: "1.0.0",
    input,
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

describe("USGS WaterServices instantaneous-values connector", () => {
  it("documents every input field for agent request construction", () => {
    for (const [name, schema] of Object.entries(USGS_WATER_IV_INPUT_SCHEMA.properties)) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
    for (const [name, schema] of Object.entries(
      USGS_WATER_IV_INPUT_SCHEMA.properties.boundingBox.properties,
    )) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
  });

  it("encodes a bounded request and normalizes WaterML JSON observations", async () => {
    let requestedUrl = "";
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([usgsWaterInstantaneousValuesConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        requestedUrl = String(target);
        return responseFor("instantaneous-values.json");
      }) as typeof fetch,
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 2);
    assert.equal(result.summary.truncated, false);
    const url = new URL(requestedUrl);
    assert.equal(url.origin, "https://waterservices.usgs.gov");
    assert.equal(url.pathname, "/nwis/iv/");
    assert.equal(url.searchParams.get("format"), "json");
    assert.equal(url.searchParams.get("bBox"), "-77.300000,38.800000,-77.000000,39.100000");
    assert.equal(url.searchParams.get("period"), "P1D");
    assert.equal(url.searchParams.get("parameterCd"), "00060,00065");
    assert.equal(url.searchParams.get("siteType"), "ST");
    assert.equal(url.searchParams.get("siteStatus"), "active");
    const data = result.data as {
      stopReason: string;
      series: Array<{ recordCount: number; provisionalRecordCount: number }>;
      records: Array<Record<string, unknown>>;
    };
    assert.equal(data.stopReason, "completed");
    assert.deepEqual(data.series, [
      {
        siteNumber: "01646500",
        siteName: "SYNTHETIC RIVER AT TEST CITY",
        agencyCode: "USGS",
        siteType: "ST",
        stateCode: "51",
        countyCode: "51059",
        hucCode: "02070010",
        latitude: 38.94978,
        longitude: -77.12764,
        parameterCode: "00060",
        variableName: "Streamflow, ft3/s",
        variableDescription: "Discharge, cubic feet per second",
        statisticCode: "00011",
        unit: "ft3/s",
        recordCount: 2,
        provisionalRecordCount: 1,
        firstObservedAtUtc: "2026-03-22T04:00:00Z",
        lastObservedAtUtc: "2026-03-22T05:00:00Z",
      },
    ]);
    assert.deepEqual(data.records[0], {
      siteNumber: "01646500",
      siteName: "SYNTHETIC RIVER AT TEST CITY",
      agencyCode: "USGS",
      siteType: "ST",
      stateCode: "51",
      countyCode: "51059",
      hucCode: "02070010",
      latitude: 38.94978,
      longitude: -77.12764,
      parameterCode: "00060",
      variableName: "Streamflow, ft3/s",
      variableDescription: "Discharge, cubic feet per second",
      statisticCode: "00011",
      unit: "ft3/s",
      observedAtUtc: "2026-03-22T04:00:00Z",
      value: 125.5,
      qualifiers: ["P"],
      provisional: true,
    });
  });

  it("sorts site and parameter lists into a deterministic explicit-window query", async () => {
    let requestedUrl = "";
    const result = await executeDataRun(
      request({
        boundingBox: undefined,
        period: undefined,
        siteNumbers: ["01646500", "01646000"],
        startDateTimeUtc: "2026-03-22T00:00:00Z",
        endDateTimeUtc: "2026-03-22T23:59:59Z",
        parameterCodes: ["00065", "00060"],
        siteStatus: "all",
        agencyCode: "USGS",
      }),
      {
        registry: createDataRegistry([usgsWaterInstantaneousValuesConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          requestedUrl = String(target);
          return responseFor("instantaneous-values.json");
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    const url = new URL(requestedUrl);
    assert.equal(url.searchParams.get("sites"), "01646000,01646500");
    assert.equal(url.searchParams.get("parameterCd"), "00060,00065");
    assert.equal(url.searchParams.get("startDT"), "2026-03-22T00:00:00Z");
    assert.equal(url.searchParams.get("endDT"), "2026-03-22T23:59:59Z");
    assert.equal(url.searchParams.get("agencyCd"), "USGS");
    assert.equal(url.searchParams.get("siteStatus"), "all");
  });

  it("rejects ambiguous selectors, oversized boxes, and reversed time windows before fetch", async () => {
    for (const input of [
      {
        boundingBox: {
          minLongitude: -77.3,
          minLatitude: 38.8,
          maxLongitude: -77,
          maxLatitude: 39.1,
        },
        siteNumbers: ["01646500"],
        period: "P1D",
      },
      {
        boundingBox: {
          minLongitude: -100,
          minLatitude: 20,
          maxLongitude: -90,
          maxLatitude: 30,
        },
        period: "P1D",
      },
      {
        siteNumbers: ["01646500"],
        startDateTimeUtc: "2026-03-23T00:00:00Z",
        endDateTimeUtc: "2026-03-22T00:00:00Z",
      },
    ]) {
      let fetched = false;
      const result = await executeDataRun(request(input), {
        registry: createDataRegistry([usgsWaterInstantaneousValuesConnector]),
        environment: {},
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

  it("rejects non-positive and malformed ISO duration periods before fetch", async () => {
    for (const period of ["P0D", "PT0S", "P1DT", "P1W1D", "P1WT2H"]) {
      let fetched = false;
      const result = await executeDataRun(request({ period }), {
        registry: createDataRegistry([usgsWaterInstantaneousValuesConnector]),
        environment: {},
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(result.status, "blocked", period);
      assert.equal(result.errors[0]?.code, "invalid-request", period);
      assert.equal(fetched, false, period);
    }
  });

  it("publishes current legacy-service and operational-data limits", () => {
    assert.ok(
      usgsWaterInstantaneousValuesConnector.limitations.some((item) =>
        /degradation|blackout/i.test(item),
      ),
    );
    assert.ok(
      usgsWaterInstantaneousValuesConnector.limitations.some((item) => /120 days/i.test(item)),
    );
  });

  it("blocks a malformed WaterML response envelope", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([usgsWaterInstantaneousValuesConnector]),
      environment: {},
      fetchImpl: (async () => responseFor("invalid-envelope.json")) as typeof fetch,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "provider-response-invalid");
  });

  it("preserves valid rows and marks malformed rows as partial coverage", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([usgsWaterInstantaneousValuesConnector]),
      environment: {},
      fetchImpl: (async () => responseFor("partial-values.json")) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.errors[0]?.code, "partial-result");
    assert.deepEqual(result.summary.missing, [
      {
        kind: "range",
        identifiers: ["$.value.timeSeries[0].values[0].value[1]"],
      },
    ]);
  });

  it("marks an intentional record cap without misreporting source coverage", async () => {
    const result = await executeDataRun(
      { ...request(), limits: { maxRecords: 1 } },
      {
        registry: createDataRegistry([usgsWaterInstantaneousValuesConnector]),
        environment: {},
        fetchImpl: (async () => responseFor("instantaneous-values.json")) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.truncated, true);
    assert.equal((result.data as { stopReason: string }).stopReason, "max-records");
  });

  it("conforms to the public connector contract", async () => {
    await assertDataConnectorConformance({
      connector: usgsWaterInstantaneousValuesConnector,
      request: request(),
      fetchImpl: (async () => responseFor("instantaneous-values.json")) as typeof fetch,
    });
  });
});
