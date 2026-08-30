import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet<object>()));
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "undefined") {
    throw new TypeError("Canonical JSON does not support undefined values.");
  }
  if (typeof value === "bigint") {
    throw new TypeError("Canonical JSON does not support bigint values.");
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Canonical JSON does not support ${typeof value} values.`);
  }
  if (typeof value !== "object") throw new TypeError("Unsupported canonical JSON value.");
  if (ancestors.has(value)) throw new TypeError("Canonical JSON does not support cyclic values.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        if (!(index in value))
          throw new TypeError("Canonical JSON does not support sparse arrays.");
        return normalize(item, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON supports only plain objects.");
    }
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(codePointOrder)) {
      result[key] = normalize(source[key], ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function codePointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
