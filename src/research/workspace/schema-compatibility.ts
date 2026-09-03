import type { JsonSchema } from "./schemas.js";

/** Claude Code loads the supplied schema with its default Ajv dialect. Keep
 * validation constraints intact, remove dialect/id annotations and make implied
 * scalar types explicit; the controller still uses the canonical schema. */
export function claudeCodeCompatibleSchema(schema: JsonSchema): JsonSchema {
  const compatible = structuredClone(schema);
  const dataKeywords = new Set(["const", "enum", "default", "examples"]);
  const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions"]);
  const stripMetadata = (value: unknown, isSchemaMap = false): void => {
    if (Array.isArray(value)) {
      for (const item of value) stripMetadata(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (!isSchemaMap) {
      delete record.$schema;
      delete record.$id;
      // Claude's StructuredOutput tool can otherwise present an untyped
      // numeric const as a string parameter. This adds only types already
      // implied by scalar const/enum values; never coerce returned data.
      if (record.type === undefined) {
        const literals = Object.hasOwn(record, "const")
          ? [record.const]
          : Array.isArray(record.enum)
            ? record.enum
            : [];
        const types = [...new Set(literals.map(scalarType))];
        if (types.length && !types.includes(undefined)) {
          const normalized = types.includes("number")
            ? types.filter((type) => type !== "integer")
            : types;
          record.type = normalized.length === 1 ? normalized[0] : normalized;
        }
      }
    }
    for (const [key, item] of Object.entries(record)) {
      if (isSchemaMap || !dataKeywords.has(key))
        stripMetadata(item, !isSchemaMap && schemaMaps.has(key));
    }
  };
  stripMetadata(compatible);
  return compatible;
}

function scalarType(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return typeof value;
  if (typeof value === "number" && Number.isFinite(value))
    return Number.isInteger(value) ? "integer" : "number";
  return undefined;
}
