import type {
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
  JsonSchema,
} from "../../src/data/contracts.js";

export const SYNTHETIC_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/test/synthetic-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: {
    value: { type: "string", minLength: 1 },
  },
} as const satisfies JsonSchema;

export const SYNTHETIC_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/test/synthetic-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["echoed"],
  properties: {
    echoed: { type: "string" },
  },
} as const satisfies JsonSchema;

export interface SyntheticConnectorOptions {
  credential?: boolean;
  liveDoctor?: boolean;
  execute?: (
    context: DataOperationExecutionContext,
  ) => DataOperationExecution | Promise<DataOperationExecution>;
}

export function syntheticConnector(
  options: SyntheticConnectorOptions = {},
): DataConnectorDefinition {
  return {
    schemaVersion: "tiangong.data.manifest.v1",
    capabilityId: "test.synthetic",
    capabilityVersion: "1.0.0",
    minimumCliVersion: "0.0.51",
    provider: {
      providerId: "synthetic",
      name: "Synthetic provider",
    },
    sourceCategory: "test-fixture",
    endpoints: [
      {
        endpointId: "primary",
        baseUrl: "https://example.test",
        pathPrefixes: ["/v1/"],
        allowedMethods: ["GET"],
        allowedContentTypes: ["application/json"],
      },
    ],
    license: {
      name: "Synthetic test fixture",
      url: "https://example.test/license",
      restrictions: ["test-only"],
    },
    credentials: options.credential
      ? [
          {
            credentialId: "api-token",
            environmentVariable: "TIANGONG_DATA_TEST_TOKEN",
            required: true,
            endpointIds: ["primary"],
            injection: {
              kind: "header",
              name: "Authorization",
              prefix: "Bearer ",
            },
          },
        ]
      : [],
    limits: {
      timeoutMs: 1_000,
      maxRequestBytes: 1_024,
      maxResponseBytes: 4_096,
      maxPages: 2,
      maxRecords: 10,
      maxRetries: 1,
      maxRetryDelayMs: 10,
      maxRedirects: 2,
    },
    diagnostics: {
      static: true,
      live: options.liveDoctor ?? false,
    },
    freshness: {
      kind: "provider-defined",
      description: "Synthetic fixture data has no freshness guarantee.",
    },
    limitations: ["Not a real provider."],
    operations: [
      {
        operationId: "echo",
        operationVersion: "1.0.0",
        summary: "Echo one validated string.",
        inputSchema: SYNTHETIC_INPUT_SCHEMA,
        outputSchema: SYNTHETIC_OUTPUT_SCHEMA,
        execute:
          options.execute ??
          ((context) => ({
            status: "success",
            data: { echoed: (context.input as { value: string }).value },
            summary: {
              recordCount: 1,
              pageCount: 0,
              chunkCount: 0,
              truncated: false,
              completeness: "complete",
            },
            warnings: [],
            errors: [],
            observations: [],
          })),
      },
    ],
    ...(options.liveDoctor
      ? {
          liveDoctor: async () => ({
            status: "ready" as const,
            checks: [
              {
                checkId: "synthetic-live",
                status: "pass" as const,
                message: "Synthetic live check passed.",
              },
            ],
          }),
        }
      : {}),
  };
}

export function partialResult(
  message = "One synthetic page was unavailable.",
): DataOperationExecution | Promise<DataOperationExecution> {
  const error: DataMachineError = {
    code: "partial-result",
    message,
    retryable: true,
    userActionRequired: false,
    details: { missingPages: [2] },
  };
  return {
    status: "partial",
    data: { echoed: "available" },
    summary: {
      recordCount: 1,
      pageCount: 1,
      chunkCount: 0,
      truncated: false,
      completeness: "partial",
      missing: [{ kind: "page", identifiers: ["2"] }],
    },
    warnings: [],
    errors: [error],
    observations: [],
  };
}
