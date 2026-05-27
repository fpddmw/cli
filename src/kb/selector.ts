import { getString, type ParsedArgs } from "../args.js";
import { firstEnv } from "../env.js";
import { CliError } from "../errors.js";
import type { CollectionSelector } from "./client.js";

export function resolveCollectionSelector(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): CollectionSelector {
  const selectors: CollectionSelector[] = [];
  addSelector(selectors, "primary_collection_id", getString(args, "collection-id"));
  addSelector(selectors, "collection_path", getString(args, "collection-path"));
  addSelector(selectors, "collection_key", getString(args, "collection-key"));
  addSelector(selectors, "collection_name", getString(args, "collection-name"));

  if (selectors.length > 1) {
    throw new CliError("Provide exactly one collection selector.");
  }
  if (selectors.length === 1) return selectors[0] as CollectionSelector;

  const envName = firstEnv(env, "TIANGONG_KB_DEFAULT_COLLECTION_NAME");
  if (envName) return { field: "collection_name", value: envName };

  const legacyName = firstEnv(env, "TIANGONG_KB_DEFAULT_COLLECTION_ID");
  if (legacyName) {
    if (isUuid(legacyName)) {
      throw new CliError(
        "TIANGONG_KB_DEFAULT_COLLECTION_ID is treated as a collection name. Use --collection-id for UUID uploads.",
      );
    }
    return { field: "collection_name", value: legacyName };
  }

  const envPath = firstEnv(env, "TIANGONG_KB_DEFAULT_COLLECTION_PATH");
  if (envPath) return { field: "collection_path", value: envPath };

  const envKey = firstEnv(env, "TIANGONG_KB_DEFAULT_COLLECTION_KEY");
  if (envKey) return { field: "collection_key", value: envKey };

  throw new CliError(
    "Missing collection selector. Provide --collection-name, --collection-key, --collection-path, --collection-id, or set TIANGONG_KB_DEFAULT_COLLECTION_NAME.",
  );
}

function addSelector(
  selectors: CollectionSelector[],
  field: CollectionSelector["field"],
  value: string | undefined,
): void {
  if (value) selectors.push({ field, value });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
