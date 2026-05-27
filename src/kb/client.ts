import { isObject, responseData, stringField } from "../data.js";
import { CliError } from "../errors.js";
import { jsonRequest } from "../http.js";
import type { KbConfig } from "./config.js";

export interface CollectionSelector {
  field: "primary_collection_id" | "collection_path" | "collection_key" | "collection_name";
  value: string;
}

export interface CollectionItem {
  id?: string;
  key?: string;
  path?: string;
  name?: string;
  [key: string]: unknown;
}

export async function resolveCollection(
  config: KbConfig,
  selector: CollectionSelector,
  options: { includeSchema: boolean },
): Promise<unknown> {
  const params = new URLSearchParams({ action: "upload" });
  params.set(selector.field, selector.value);
  if (options.includeSchema) params.set("include_schema", "true");
  return jsonRequest(config, `collections/resolve?${params.toString()}`);
}

export async function resolveSelectorFields(
  config: KbConfig,
  selector: CollectionSelector,
): Promise<Record<string, string>> {
  if (selector.field !== "collection_name") {
    return { [selector.field]: selector.value };
  }

  const matches = (await listCollections(config, "upload", 100)).filter(
    (item) => item.name === selector.value,
  );
  if (matches.length === 0)
    throw new CliError(`No uploadable collection matched name: ${selector.value}`);
  if (matches.length > 1) {
    const choices = matches.map((item) => item.key ?? item.path ?? item.id ?? "").join(", ");
    throw new CliError(
      `Collection name is not unique: ${selector.value}. Use --collection-key or --collection-path. Matches: ${choices}`,
    );
  }

  const match = matches[0] as CollectionItem;
  const key = collectionKey(match);
  if (key) return { collection_key: key };
  const path = collectionPath(match);
  if (path) return { collection_path: path };
  if (typeof match.id === "string" && match.id) return { primary_collection_id: match.id };
  throw new CliError(
    `Collection matched name ${selector.value}, but response had no key, path, or id.`,
  );
}

export async function listCollections(
  config: KbConfig,
  capability: string,
  limit: number,
): Promise<CollectionItem[]> {
  const collections: CollectionItem[] = [];
  let offset = 0;

  while (true) {
    const payload = await jsonRequest(
      config,
      `collections?${new URLSearchParams({
        capability,
        limit: String(limit),
        offset: String(offset),
      }).toString()}`,
    );
    const page = collectionItems(payload);
    collections.push(...page);
    if (page.length < limit) return collections;
    offset += limit;
  }
}

export function collectionKey(item: CollectionItem): string | undefined {
  return (
    stringField(item, "key") ??
    stringField(item, "collectionKey") ??
    stringField(item, "collection_key")
  );
}

export function collectionPath(item: CollectionItem): string | undefined {
  return (
    stringField(item, "path") ??
    stringField(item, "collectionPath") ??
    stringField(item, "collection_path")
  );
}

function collectionItems(payload: unknown): CollectionItem[] {
  const data = responseData(payload);
  if (Array.isArray(data)) return data.filter(isObject) as CollectionItem[];
  if (isObject(data) && Array.isArray(data.collections))
    return data.collections.filter(isObject) as CollectionItem[];
  if (isObject(data) && Array.isArray(data.data))
    return data.data.filter(isObject) as CollectionItem[];
  if (isObject(payload) && Array.isArray(payload.data))
    return payload.data.filter(isObject) as CollectionItem[];
  throw new CliError("Collection list response did not contain a data array.");
}
