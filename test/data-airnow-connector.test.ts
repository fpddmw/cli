import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { airNowHourlyObservationsConnector } from "../src/data/connectors/airnow-hourly-observations.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";

const FIXTURE_ROOT = new URL("./fixtures/data/airnow/", import.meta.url);

function request(
  input: Record<string, unknown> = {
    startDateTimeUtc: "2026-03-22T00:00:00Z",
    endDateTimeUtc: "2026-03-22T01:00:00Z",
    boundingBox: {
      minLongitude: -123.5,
      minLatitude: 37,
      maxLongitude: -121.5,
      maxLatitude: 38.8,
    },
    parameters: ["PM25", "OZONE"],
  },
): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "airnow.hourly-observations",
    capabilityVersion: "1.0.0",
    operationId: "fetch-hourly",
    operationVersion: "1.0.0",
    input,
  };
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE_ROOT), "utf8");
}

describe("AirNow hourly observations connector", () => {
  it("plans multiple UTC files and filters rows by bbox, time, and parameter", async () => {
    const requestedPaths: string[] = [];
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([airNowHourlyObservationsConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        requestedPaths.push(url.pathname);
        return new Response(await fixture(basename(url.pathname)), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }) as typeof fetch,
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
    });

    assert.equal(result.status, "success");
    assert.deepEqual(requestedPaths, [
      "/airnow/2026/20260322/HourlyAQObs_2026032200.dat",
      "/airnow/2026/20260322/HourlyAQObs_2026032201.dat",
    ]);
    assert.equal(result.summary.chunkCount, 2);
    assert.equal(result.summary.recordCount, 4);
    const data = result.data as {
      source: { preliminary: boolean; regulatoryUse: boolean };
      files: Array<{ status: string; sourceFile: string }>;
      records: Array<{
        aqsid: string;
        siteName: string;
        parameterName: string;
        rawConcentration: number | null;
        sourceFile: string;
      }>;
    };
    assert.deepEqual(data.source, {
      providerId: "airnow",
      product: "HourlyAQObs",
      preliminary: true,
      regulatoryUse: false,
    });
    assert.deepEqual(
      data.records.map((record) => [record.parameterName, record.rawConcentration]),
      [
        ["OZONE", 31],
        ["PM25", 7.1],
        ["OZONE", 29],
        ["PM25", -1.2],
      ],
    );
    assert.equal(
      data.records.every((record) => record.aqsid === "060750001"),
      true,
    );
    assert.equal(
      data.records.every((record) => record.siteName === "Bay, Test Site"),
      true,
    );
    assert.equal(
      data.files.every((file) => file.status === "ok"),
      true,
    );
    assert.equal(
      data.records.every((record) => record.sourceFile.startsWith("/airnow/")),
      true,
    );
  });

  it("returns explicit partial coverage when an hourly file is missing", async () => {
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([airNowHourlyObservationsConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        if (url.pathname.endsWith("01.dat")) return new Response("missing", { status: 404 });
        return new Response(await fixture(basename(url.pathname)), {
          headers: { "content-type": "text/plain" },
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.errors[0]?.code, "partial-result");
    assert.deepEqual(result.summary.missing, [
      {
        kind: "file",
        identifiers: ["/airnow/2026/20260322/HourlyAQObs_2026032201.dat"],
      },
    ]);
    assert.equal(result.summary.recordCount, 2);
  });

  it("isolates a file whose required CSV headers are invalid", async () => {
    const result = await executeDataRun(
      request({
        startDateTimeUtc: "2026-03-22T00:00:00Z",
        endDateTimeUtc: "2026-03-22T00:00:00Z",
        boundingBox: {
          minLongitude: -123.5,
          minLatitude: 37,
          maxLongitude: -121.5,
          maxLatitude: 38.8,
        },
        parameters: ["PM25"],
      }),
      {
        registry: createDataRegistry([airNowHourlyObservationsConnector]),
        environment: {},
        fetchImpl: (async () =>
          new Response(await fixture("invalid-header.dat"), {
            headers: { "content-type": "text/csv" },
          })) as typeof fetch,
      },
    );

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 0);
    const data = result.data as { files: Array<{ status: string; errorCode?: string }> };
    assert.deepEqual(
      data.files.map(({ status, errorCode }) => ({ status, errorCode })),
      [{ status: "invalid", errorCode: "invalid-csv-header" }],
    );
  });

  it("rejects non-hour boundaries and inverted windows before network access", async () => {
    let fetched = false;
    const result = await executeDataRun(
      request({
        startDateTimeUtc: "2026-03-22T01:30:00Z",
        endDateTimeUtc: "2026-03-22T00:00:00Z",
        boundingBox: {
          minLongitude: -123.5,
          minLatitude: 37,
          maxLongitude: -121.5,
          maxLatitude: 38.8,
        },
        parameters: ["PM25"],
      }),
      {
        registry: createDataRegistry([airNowHourlyObservationsConnector]),
        environment: {},
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "invalid-request");
    assert.equal(fetched, false);
  });

  it("publishes the preliminary-data and regulatory-use restrictions", () => {
    const manifest = createDataRegistry([airNowHourlyObservationsConnector]).describe(
      "airnow.hourly-observations",
    );
    assert.equal(manifest?.license.url, "https://docs.airnowapi.org/faq");
    assert.equal(
      manifest?.license.restrictions.some((item) => item.includes("preliminary")),
      true,
    );
    assert.equal(
      manifest?.limitations.some((item) => item.includes("regulatory")),
      true,
    );
  });
});
