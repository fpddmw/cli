import type { DataErrorCode, DataMachineError, JsonValue } from "../contracts.js";

const SENSITIVE_KEY =
  /(^|[_-])(authorization|auth|cookie|credential|password|passwd|private[_-]?key|secret|session|token|access[_-]?key|api[_-]?key)([_-]|$)/i;
const SENSITIVE_QUERY_KEY =
  /^(access[_-]?token|api[_-]?key|apikey|auth|authorization|code|cookie|credential|key|password|secret|session|sig|signature|token)$/i;

export class DataRuntimeError extends Error {
  constructor(
    readonly code: DataErrorCode,
    message: string,
    readonly options: {
      retryable?: boolean;
      userActionRequired?: boolean;
      details?: Record<string, JsonValue>;
      exitCode?: number;
    } = {},
  ) {
    super(message);
    this.name = "DataRuntimeError";
  }

  get exitCode(): number {
    return this.options.exitCode ?? dataErrorExitCode(this.code);
  }
}

export function dataErrorExitCode(code: DataErrorCode): number {
  if (
    code === "invalid-request" ||
    code === "unsupported-operation" ||
    code === "incompatible-contract"
  ) {
    return 2;
  }
  if (code === "internal-error") return 1;
  if (code === "partial-result") return 4;
  return 3;
}

export function toDataMachineError(
  error: unknown,
  secrets: readonly string[] = [],
): DataMachineError {
  if (error instanceof DataRuntimeError) {
    const details = error.options.details
      ? (sanitizeDataValue(error.options.details, secrets) as Record<string, JsonValue>)
      : undefined;
    return {
      code: error.code,
      message: sanitizeDataText(error.message, secrets),
      retryable: error.options.retryable ?? false,
      userActionRequired: error.options.userActionRequired ?? false,
      ...(details === undefined ? {} : { details }),
    };
  }
  return {
    code: "internal-error",
    message: "The data runtime encountered an unexpected internal error.",
    retryable: false,
    userActionRequired: false,
  };
}

export function sanitizeDataValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") return sanitizeDataText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeDataValue(item, secrets));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key)
      ? item === null
        ? null
        : "[REDACTED]"
      : sanitizeDataValue(item, secrets);
  }
  return result;
}

export function sanitizeDataText(value: string, secrets: readonly string[] = []): string {
  let sanitized = value;
  for (const secret of [...secrets].filter((item) => item.length >= 4).sort(longestFirst)) {
    sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  sanitized = sanitized
    .replace(
      /\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key|api-key)\s*:\s*[^\s,;}"'<>\\]+/gi,
      "$1: [REDACTED]",
    )
    .replace(
      /\b(access_token|api[_-]?key|apikey|auth|authorization|cookie|password|secret|session|token)\s*=\s*[^\s,;}&"'<>\\]+/gi,
      "$1=[REDACTED]",
    );
  return sanitized.replace(/https?:\/\/[^\s"'<>`]+/gi, sanitizeUrl);
}

export function containsConfiguredSecret(
  value: Uint8Array | string,
  secrets: readonly string[],
): boolean {
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  return secrets.some((secret) => secret.length >= 4 && text.includes(secret));
}

function sanitizeUrl(candidate: string): string {
  const trailing = candidate.match(/[,.;!?]+$/)?.[0] ?? "";
  const source = trailing ? candidate.slice(0, -trailing.length) : candidate;
  try {
    const url = new URL(source);
    if (url.username || url.password) {
      url.username = "REDACTED";
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return `${url.toString()}${trailing}`;
  } catch {
    return candidate;
  }
}

function longestFirst(left: string, right: string): number {
  return right.length - left.length;
}
