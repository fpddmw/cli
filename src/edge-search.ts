import { CliError } from "./errors.js";
import { postJson, type FetchLike } from "./http.js";

export const DEFAULT_EDGE_SEARCH_API_BASE_URL =
  "https://qyyqlnwqwgvzxnccnbgm.supabase.co/functions/v1";

export type EdgeSearchAuthStrategy = "apiKey" | "bearerOrApiKey";

export type EdgeSearchSourceSpec = {
  endpoint: string;
  includeRegion: boolean;
  authStrategy: EdgeSearchAuthStrategy;
};

export interface EdgeSearchSourceConfig<SourceId extends string> {
  source: SourceId;
  url: string;
  apiKey: string;
  bearerToken?: string | undefined;
  region: string;
  authStrategy: EdgeSearchAuthStrategy;
  includeRegion: boolean;
}

export interface EdgeSearchRequestPlan<SourceId extends string> {
  source: SourceId;
  request: {
    method: "POST";
    url: string;
    headers: Record<string, string>;
    inputPath?: string | undefined;
    body: unknown;
    timeoutMs: number;
  };
}

export interface EdgeSearchDryRunResult<SourceId extends string> {
  dryRun: true;
  requests: Array<EdgeSearchRequestPlan<SourceId>>;
}

export interface EdgeSearchResponse<SourceId extends string> {
  source: SourceId;
  response: unknown;
}

export interface EdgeSearchRunResult<SourceId extends string> {
  dryRun: false;
  responses: Array<EdgeSearchResponse<SourceId>>;
}

export type EdgeSearchResult<SourceId extends string> =
  | EdgeSearchDryRunResult<SourceId>
  | EdgeSearchRunResult<SourceId>;

function normalizeBaseUrl(apiBaseUrl: string): string {
  const normalized = apiBaseUrl.trim().replace(/\/+$/u, "");
  if (!normalized) {
    throw new CliError("Cannot derive Supabase URLs from an empty API base URL.", {
      code: "EDGE_SEARCH_API_BASE_URL_INVALID",
      exitCode: 2,
    });
  }
  return normalized;
}

export function deriveSupabaseProjectBaseUrl(apiBaseUrl: string): string {
  const normalized = normalizeBaseUrl(apiBaseUrl);

  if (normalized.endsWith("/functions/v1")) {
    return normalized.replace(/\/functions\/v1$/u, "");
  }

  if (normalized.endsWith("/rest/v1")) {
    return normalized.replace(/\/rest\/v1$/u, "");
  }

  if (/^https?:\/\/[^/]+$/u.test(normalized)) {
    return normalized;
  }

  throw new CliError(
    "Cannot derive a Supabase project base URL from TIANGONG_AI_API_BASE_URL. Use a Supabase project base URL, a /functions/v1 base URL, or a /rest/v1 base URL.",
    {
      code: "EDGE_SEARCH_API_BASE_URL_INVALID",
      exitCode: 2,
      details: normalized,
    },
  );
}

export function deriveSupabaseRestBaseUrl(apiBaseUrl: string): string {
  return `${deriveSupabaseProjectBaseUrl(apiBaseUrl)}/rest/v1`;
}

export const deriveSupabaseFunctionsBaseUrl = (apiBaseUrl: string): string =>
  `${deriveSupabaseProjectBaseUrl(apiBaseUrl)}/functions/v1`;

export function edgeFunctionUrl(apiBaseUrl: string, endpoint: string): string {
  return `${deriveSupabaseFunctionsBaseUrl(apiBaseUrl)}/${endpoint.replace(/^\/+/u, "")}`;
}

export async function runEdgeSearch<SourceId extends string>(input: {
  body: unknown;
  inputPath?: string | undefined;
  sources: Array<EdgeSearchSourceConfig<SourceId>>;
  timeoutMs: number;
  dryRun: boolean;
  missingCredentialHelp: string;
  fetchImpl?: FetchLike | undefined;
}): Promise<EdgeSearchResult<SourceId>> {
  const plans = input.sources.map((source) =>
    edgeSearchRequestPlan({
      source,
      body: input.body,
      inputPath: input.inputPath,
      timeoutMs: input.timeoutMs,
      masked: input.dryRun,
      missingCredentialHelp: input.missingCredentialHelp,
    }),
  );

  if (input.dryRun) {
    return { dryRun: true, requests: plans };
  }

  const responses: Array<EdgeSearchResponse<SourceId>> = [];
  for (const plan of plans) {
    try {
      responses.push({
        source: plan.source,
        response: await postJson({
          url: plan.request.url,
          headers: plan.request.headers,
          body: plan.request.body,
          timeoutMs: input.timeoutMs,
          fetchImpl: input.fetchImpl ?? fetch,
        }),
      });
    } catch (error) {
      if (error instanceof CliError && error.code === "REMOTE_REQUEST_FAILED") {
        const status =
          error.details && typeof error.details === "object" && "status" in error.details
            ? Number(error.details.status)
            : null;
        const authenticationFailed = status === 401 || status === 403;
        throw new CliError(
          authenticationFailed
            ? `The ${plan.source} provider rejected the standalone credential.`
            : `The ${plan.source} standalone provider request failed.`,
          {
            code: authenticationFailed
              ? "PROVIDER_AUTHENTICATION_FAILED"
              : "STANDALONE_PROVIDER_REQUEST_FAILED",
            exitCode: 1,
            details: {
              source: plan.source,
              executionMode: "standalone",
              credentialScope: "ambient-or-explicit-owner-env",
              networkAttempted: true,
              ...(status === null ? {} : { status }),
              minimumAction: authenticationFailed
                ? "Verify the owner-provided standalone credential and provider entitlement, then retry the isolated query."
                : "Verify the exact endpoint, provider availability, and quota before retrying the isolated query.",
            },
          },
        );
      }
      throw error;
    }
  }

  return { dryRun: false, responses };
}

function edgeSearchRequestPlan<SourceId extends string>(input: {
  source: EdgeSearchSourceConfig<SourceId>;
  body: unknown;
  inputPath?: string | undefined;
  timeoutMs: number;
  masked: boolean;
  missingCredentialHelp: string;
}): EdgeSearchRequestPlan<SourceId> {
  const headers = edgeSearchHeaders(input.source, input.masked, input.missingCredentialHelp);
  return {
    source: input.source.source,
    request: {
      method: "POST",
      url: input.source.url,
      headers,
      ...(input.inputPath ? { inputPath: input.inputPath } : {}),
      body: input.body,
      timeoutMs: input.timeoutMs,
    },
  };
}

function edgeSearchHeaders<SourceId extends string>(
  source: EdgeSearchSourceConfig<SourceId>,
  masked: boolean,
  missingCredentialHelp: string,
): Record<string, string> {
  if (source.authStrategy === "apiKey" && !source.apiKey) {
    throw new CliError(`Standalone ambient credential not found for ${source.source} search.`, {
      code: "STANDALONE_AMBIENT_CREDENTIAL_MISSING",
      exitCode: 2,
      details: {
        source: source.source,
        executionMode: "standalone",
        credentialScope: "ambient-or-explicit-owner-env",
        networkAttempted: false,
        minimumAction: missingCredentialHelp,
      },
    });
  }
  if (source.authStrategy === "bearerOrApiKey" && !source.apiKey && !source.bearerToken) {
    throw new CliError(`Standalone ambient credential not found for ${source.source} search.`, {
      code: "STANDALONE_AMBIENT_CREDENTIAL_MISSING",
      exitCode: 2,
      details: {
        source: source.source,
        executionMode: "standalone",
        credentialScope: "ambient-or-explicit-owner-env",
        networkAttempted: false,
        minimumAction: missingCredentialHelp,
      },
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (source.includeRegion && source.region) {
    headers["x-region"] = source.region;
  }
  if (source.authStrategy === "bearerOrApiKey" && source.bearerToken) {
    headers.Authorization = `Bearer ${masked ? "****" : source.bearerToken}`;
  } else {
    headers["x-api-key"] = masked ? "****" : source.apiKey;
  }
  return headers;
}
