const SENSITIVE_KEY =
  /(^|[_-])(authorization|auth|cookie|credential|password|passwd|private[_-]?key|proxy[_-]?password|secret|session|token|access[_-]?key|api[_-]?key)([_-]|$)/i;
const SENSITIVE_QUERY_KEY =
  /^(access[_-]?token|api[_-]?key|apikey|auth|authorization|awsaccesskeyid|code|cookie|credential|key|password|secret|session(?:[_-]?id)?|sig|signature|token|x[_-]amz[_-](credential|security[_-]token|signature)|x[_-]goog[_-](credential|signature))$/i;
const SENSITIVE_URL_FRAGMENT =
  /(^|[&#;?])(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|code|cookie|credential|key|password|secret|session(?:[_-]?id)?|sig|signature|token)=/i;

export function sanitizeResearchValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") return sanitizeResearchText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeResearchValue(item, secrets));
  if (!value || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key] = SENSITIVE_KEY.test(key)
      ? item === null
        ? null
        : "[REDACTED]"
      : sanitizeResearchValue(item, secrets);
  }
  return sanitized;
}

export function sanitizeResearchRecord(
  value: Record<string, unknown>,
  secrets: readonly string[] = [],
): Record<string, unknown> {
  return sanitizeResearchValue(value, secrets) as Record<string, unknown>;
}

export function sanitizeResearchText(value: string, secrets: readonly string[] = []): string {
  let sanitized = value;
  for (const secret of [...secrets].filter((item) => item.length >= 8).sort(longestFirst)) {
    sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  sanitized = sanitized
    .replace(
      /(["']?(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|cookie|credential|password|secret|session(?:[_-]?id)?|token)["']?\s*:\s*["'])([^"']*)(["'])/gi,
      "$1[REDACTED]$3",
    )
    .replace(
      /\b((?:proxy-)?authorization)\s*:\s*((?:Bearer|Basic)\s+)?[^\s,;}"'<>\\]+/gi,
      "$1: $2[REDACTED]",
    )
    .replace(
      /\b(access_token|api[_-]?key|apikey|auth|authorization|cookie|password|secret|session|token)\s*=\s*[^\s,;}&"'<>\\]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b(cookie|set-cookie|x-api-key|api-key)\s*:\s*[^\s,;}"'<>\\]+/gi, "$1: [REDACTED]");
  return sanitizeUrls(sanitized);
}

export function configuredResearchSecrets(source: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set(
      Object.entries(source)
        .filter(
          ([name, value]) =>
            SENSITIVE_KEY.test(name) && typeof value === "string" && value.length >= 8,
        )
        .map(([, value]) => value as string),
    ),
  ].sort(longestFirst);
}

export function isSensitiveEnvironmentName(name: string): boolean {
  return SENSITIVE_KEY.test(name);
}

function sanitizeUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>`]+/gi, (candidate) => {
    const bounded = splitUrlCandidate(candidate);
    const trailing = bounded.source.match(/[,.;!?]+$/)?.[0] ?? "";
    const source = trailing ? bounded.source.slice(0, -trailing.length) : bounded.source;
    try {
      const url = new URL(source);
      let changed = false;
      if (url.username || url.password) {
        url.username = "REDACTED";
        url.password = "";
        changed = true;
      }
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEY.test(key)) {
          url.searchParams.set(key, "[REDACTED]");
          changed = true;
        }
      }
      if (SENSITIVE_URL_FRAGMENT.test(url.hash)) {
        url.hash = "REDACTED";
        changed = true;
      }
      return changed ? `${url.toString()}${trailing}${bounded.suffix}` : candidate;
    } catch {
      return candidate;
    }
  });
}

function splitUrlCandidate(candidate: string): { source: string; suffix: string } {
  let parenthesisDepth = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index]!;
    if (character === "(") {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ")") {
      if (parenthesisDepth > 0) {
        parenthesisDepth -= 1;
        continue;
      }
      return { source: candidate.slice(0, index), suffix: candidate.slice(index) };
    }
    if ("，。；！？（）【】".includes(character)) {
      return { source: candidate.slice(0, index), suffix: candidate.slice(index) };
    }
  }
  return { source: candidate, suffix: "" };
}

function longestFirst(left: string, right: string): number {
  return right.length - left.length;
}
