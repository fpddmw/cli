export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

export function responseData(payload: unknown): unknown {
  if (
    isObject(payload) &&
    "data" in payload &&
    ("api_version" in payload || "request_id" in payload || isObject(payload.data))
  ) {
    return payload.data;
  }
  return payload;
}
