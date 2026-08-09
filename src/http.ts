import { CliError, HttpError } from "./errors.js";

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type ResponseLike = {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<ResponseLike>;

export interface HttpJsonConfig {
  apiBaseUrl: string;
  apiPathPrefix: string;
  apiKey: string;
  timeoutSeconds: number;
}

export async function jsonRequest(
  config: HttpJsonConfig,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<unknown> {
  const url = `${config.apiBaseUrl}${config.apiPathPrefix}/${path.replace(/^\/+/, "")}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.apiKey}`);
  return jsonRequestUrl(url, { ...init, headers }, config.timeoutSeconds);
}

export async function jsonRequestUrl(
  url: string,
  init: RequestInit & { headers?: HeadersInit } = {},
  timeoutSeconds = 120,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  } catch (error) {
    throw new HttpError(
      `Request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      undefined,
      true,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      `HTTP ${response.status} from ${url}: ${text}`,
      response.status,
      retryAfterSeconds(response.headers),
      RETRYABLE_HTTP_STATUSES.has(response.status),
    );
  }

  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
  }
}

async function parseResponse(response: ResponseLike, url: string): Promise<unknown> {
  const rawText = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    throw new CliError(`HTTP ${response.status} returned from ${url}`, {
      code: "REMOTE_REQUEST_FAILED",
      exitCode: 1,
      details: {
        status: response.status,
        retryAfterSeconds: responseRetryAfterSeconds(response.headers),
        networkAttempted: true,
      },
    });
  }

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(rawText);
    } catch (error) {
      throw new CliError(`Remote response was not valid JSON for ${url}`, {
        code: "REMOTE_INVALID_JSON",
        exitCode: 1,
        details: String(error),
      });
    }
  }

  return rawText;
}

function responseRetryAfterSeconds(headers: ResponseLike["headers"]): number | null {
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
}

export async function postJson(options: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  fetchImpl: FetchLike;
}): Promise<unknown> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const response = await options.fetchImpl(options.url, {
    method: "POST",
    headers: options.headers,
    body: JSON.stringify(options.body),
    signal,
  });

  return parseResponse(response, options.url);
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const value = headers.get("Retry-After");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
