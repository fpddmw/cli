import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

export const EVIDENCE_CONTENT_LIMITS = Object.freeze({
  maxBatchRecords: 500,
  maxBatchInputBytes: 4 * 1024 * 1024,
  maxExcerptBytes: 8_000,
});

export const EVIDENCE_CONTENT_CLASSES = [
  "fulltext",
  "table-data",
  "supplementary-data",
  "structured-data",
  "metadata",
  "figure-text",
  "code",
  "container-index",
] as const;
export const EVIDENCE_CONTENT_FUNCTIONS = [
  "support",
  "counterevidence",
  "definition",
  "method",
  "limitation",
  "context",
] as const;
export const EVIDENCE_CONTENT_IDENTIFIER = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
export const EVIDENCE_CONTENT_SCHEMA_NAMES = [
  "evidence-atom",
  "artifact-decomposition",
  "evidence-atom-batch",
  "artifact-decomposition-batch",
] as const;
export type EvidenceContentSchemaName = (typeof EVIDENCE_CONTENT_SCHEMA_NAMES)[number];

const identifier = { type: "string", pattern: EVIDENCE_CONTENT_IDENTIFIER };
const identifiers = { type: "array", items: identifier, maxItems: 100, uniqueItems: true };
const limitations = { type: "array", items: { type: "string", maxLength: 2_000 }, maxItems: 100 };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const atom = object({
  schemaVersion: { const: 1 },
  atomId: identifier,
  sourceId: identifier,
  candidateId: identifier,
  artifactId: identifier,
  locator: {
    description:
      "Execution additionally requires endLine >= startLine with at most 20 lines, or an existing JSON Pointer in the exact artifact.",
    oneOf: [
      object({
        kind: { const: "line-range" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      }),
      object({
        kind: { const: "json-pointer" },
        pointer: { type: "string", pattern: "^/", maxLength: 1_000 },
      }),
    ],
  },
  statement: { type: "string", minLength: 8, maxLength: 2_000 },
  evidenceRoleIds: identifiers,
  coverageDimensionIds: identifiers,
  evidenceFunction: { type: "string", enum: [...EVIDENCE_CONTENT_FUNCTIONS] },
  scope: { type: "string", minLength: 8, maxLength: 1_000 },
  limitations,
});
const decomposition = object({
  schemaVersion: { const: 1 },
  sourceArtifactId: identifier,
  status: { type: "string", enum: ["complete", "limited", "failed"] },
  // Existing parser metadata accepts extension fields; record-level fields remain closed.
  parser: {
    type: "object",
    required: ["id", "version"],
    properties: { id: identifier, version: { type: "string", minLength: 1, maxLength: 100 } },
    additionalProperties: true,
  },
  outputArtifactIds: identifiers,
  contentClasses: {
    type: "array",
    minItems: 1,
    maxItems: EVIDENCE_CONTENT_CLASSES.length,
    uniqueItems: true,
    items: { type: "string", enum: [...EVIDENCE_CONTENT_CLASSES] },
  },
  limitations,
});

export function isEvidenceContentSchemaName(value: string): value is EvidenceContentSchemaName {
  return EVIDENCE_CONTENT_SCHEMA_NAMES.some((name) => name === value);
}

export function evidenceContentInputSchema(
  name: EvidenceContentSchemaName,
): Record<string, unknown> {
  const item = name.startsWith("evidence-atom") ? atom : decomposition;
  const batch = name.endsWith("-batch");
  return structuredClone({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:tiangong:research:${name}:v1`,
    description: `Input shape only. Command execution verifies stage, exact artifact/source/lineage, trimmed text, sensitive content, locator bounds, and duplicate identities.${batch ? ` Batch input is limited to ${EVIDENCE_CONTENT_LIMITS.maxBatchRecords} records and ${EVIDENCE_CONTENT_LIMITS.maxBatchInputBytes} UTF-8 bytes; the byte cap is enforced by command intake, not JSON Schema.` : ""}`,
    ...(batch
      ? object({
          schemaVersion: { const: 1 },
          records: {
            type: "array",
            minItems: 1,
            maxItems: EVIDENCE_CONTENT_LIMITS.maxBatchRecords,
            items: item,
          },
        })
      : item),
  });
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = new Map<EvidenceContentSchemaName, ValidateFunction>();

/** Same structural contract used by public schema show and command execution. */
export function isEvidenceContentInputShape(
  name: EvidenceContentSchemaName,
  value: unknown,
): boolean {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile(evidenceContentInputSchema(name));
    validators.set(name, validate);
  }
  return Boolean(validate(value));
}
