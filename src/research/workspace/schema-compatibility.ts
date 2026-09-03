import type { JsonSchema } from "./schemas.js";

/** Claude Code loads the supplied schema with its default Ajv dialect. Keep
 * validation constraints intact and remove only dialect/id annotations from
 * schema nodes; the controller still validates against the canonical schema. */
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
    }
    for (const [key, item] of Object.entries(record)) {
      if (isSchemaMap || !dataKeywords.has(key))
        stripMetadata(item, !isSchemaMap && schemaMaps.has(key));
    }
  };
  stripMetadata(compatible);
  return compatible;
}
