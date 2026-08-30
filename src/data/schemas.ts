import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import catalogSchemaDocument from "./schemas/catalog.v1.json" with { type: "json" };
import coreReceiptSchemaDocument from "./schemas/core-receipt.v1.json" with { type: "json" };
import describeSchemaDocument from "./schemas/describe.v1.json" with { type: "json" };
import doctorSchemaDocument from "./schemas/doctor.v1.json" with { type: "json" };
import errorSchemaDocument from "./schemas/error.v1.json" with { type: "json" };
import manifestSchemaDocument from "./schemas/manifest.v1.json" with { type: "json" };
import runRequestSchemaDocument from "./schemas/run-request.v1.json" with { type: "json" };
import runResultSchemaDocument from "./schemas/run-result.v1.json" with { type: "json" };
import type { JsonSchema } from "./contracts.js";

export type DataPublicSchemaName =
  | "catalog"
  | "coreReceipt"
  | "describe"
  | "doctor"
  | "error"
  | "manifest"
  | "runRequest"
  | "runResult";

export const DATA_PUBLIC_SCHEMA_IDS = {
  catalog: "https://schemas.tiangong.ai/data/catalog.v1.json",
  coreReceipt: "https://schemas.tiangong.ai/data/core-receipt.v1.json",
  describe: "https://schemas.tiangong.ai/data/describe.v1.json",
  doctor: "https://schemas.tiangong.ai/data/doctor.v1.json",
  error: "https://schemas.tiangong.ai/data/error.v1.json",
  manifest: "https://schemas.tiangong.ai/data/manifest.v1.json",
  runRequest: "https://schemas.tiangong.ai/data/run-request.v1.json",
  runResult: "https://schemas.tiangong.ai/data/run-result.v1.json",
} as const satisfies Record<DataPublicSchemaName, string>;

type PublicSchemaDocument = JsonSchema & { $id: string; $schema: string };

export const dataPublicSchemas = {
  catalog: catalogSchemaDocument,
  coreReceipt: coreReceiptSchemaDocument,
  describe: describeSchemaDocument,
  doctor: doctorSchemaDocument,
  error: errorSchemaDocument,
  manifest: manifestSchemaDocument,
  runRequest: runRequestSchemaDocument,
  runResult: runResultSchemaDocument,
} as Record<DataPublicSchemaName, PublicSchemaDocument>;

export class DataContractValidationError extends Error {
  constructor(
    readonly contract: DataPublicSchemaName,
    readonly issues: string[],
  ) {
    super(`Data ${contract} contract validation failed: ${issues.join("; ")}`);
    this.name = "DataContractValidationError";
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
  validateFormats: false,
});
for (const schema of Object.values(dataPublicSchemas)) ajv.addSchema(schema);

const validators = Object.fromEntries(
  (Object.keys(DATA_PUBLIC_SCHEMA_IDS) as DataPublicSchemaName[]).map((name) => [
    name,
    ajv.getSchema(DATA_PUBLIC_SCHEMA_IDS[name]),
  ]),
) as Record<DataPublicSchemaName, ValidateFunction | undefined>;

export function validateDataPublicContract(name: DataPublicSchemaName, value: unknown): void {
  const validate = validators[name];
  if (!validate) throw new Error(`Data ${name} schema validator is unavailable.`);
  if (validate(value)) return;
  throw new DataContractValidationError(name, formatValidationErrors(validate.errors));
}

export function formatValidationErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const path = error.instancePath || "/";
    return `${path} ${error.message ?? "is invalid"}`;
  });
}
