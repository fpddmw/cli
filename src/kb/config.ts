import { getString, positiveNumberValue, type ParsedArgs } from "../args.js";
import { firstEnv } from "../env.js";
import { CliError } from "../errors.js";

export const DEFAULT_API_BASE_URL = "https://thuenv.tiangong.world:7300";
export const DEFAULT_API_PATH_PREFIX = "/api/v1/kb";

export interface KbConfig {
  apiBaseUrl: string;
  apiPathPrefix: string;
  apiKey: string;
  timeoutSeconds: number;
}

export function resolveKbConfig(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  options: { requireKey?: boolean } = {},
): KbConfig {
  const requireKey = options.requireKey ?? true;
  const apiKey =
    getString(args, "api-key") ?? firstEnv(env, "TIANGONG_AI_API_KEY", "TIANGONG_KB_API_KEY") ?? "";
  if (requireKey && !apiKey) {
    throw new CliError("Missing API key. Provide --api-key or set TIANGONG_AI_API_KEY.");
  }

  return {
    apiBaseUrl: (
      getString(args, "api-base-url") ??
      firstEnv(env, "TIANGONG_KB_API_BASE_URL") ??
      DEFAULT_API_BASE_URL
    ).replace(/\/+$/, ""),
    apiPathPrefix: normalizePrefix(
      getString(args, "api-path-prefix") ??
        firstEnv(env, "TIANGONG_KB_API_PATH_PREFIX") ??
        DEFAULT_API_PATH_PREFIX,
    ),
    apiKey,
    timeoutSeconds: positiveNumberValue(
      getString(args, "timeout") ?? firstEnv(env, "TIANGONG_KB_TIMEOUT"),
      120,
      "--timeout",
    ),
  };
}

function normalizePrefix(value: string): string {
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}
