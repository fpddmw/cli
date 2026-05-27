import { firstEnv } from "../env.js";
import {
  DEFAULT_EDGE_SEARCH_API_BASE_URL,
  edgeFunctionUrl,
  type EdgeSearchAuthStrategy,
  type EdgeSearchSourceSpec,
} from "../edge-search.js";
import { CliError } from "../errors.js";
import { strictString, type StrictParsedArgs } from "../strict-args.js";
import type { EducationSourceId } from "./types.js";

export const DEFAULT_COURSE_SEARCH_ENDPOINT = "course_search";
export const DEFAULT_EDU_SEARCH_ENDPOINT = "edu_search";
export const DEFAULT_TEXTBOOK_SEARCH_ENDPOINT = "textbook_search";
export const DEFAULT_EDUCATION_SOURCES: EducationSourceId[] = ["course"];
export const ALL_EDUCATION_SOURCES: EducationSourceId[] = ["course", "edu", "textbook"];
export const EDUCATION_SEARCH_SOURCES: Record<EducationSourceId, EdgeSearchSourceSpec> = {
  course: {
    endpoint: DEFAULT_COURSE_SEARCH_ENDPOINT,
    includeRegion: true,
    authStrategy: "bearerOrApiKey",
  },
  edu: {
    endpoint: DEFAULT_EDU_SEARCH_ENDPOINT,
    includeRegion: true,
    authStrategy: "apiKey",
  },
  textbook: {
    endpoint: DEFAULT_TEXTBOOK_SEARCH_ENDPOINT,
    includeRegion: true,
    authStrategy: "apiKey",
  },
};

export interface EducationConfig {
  timeoutSeconds: number;
  sources: Record<EducationSourceId, EducationSourceConfig>;
}

export interface EducationSourceConfig {
  url: string;
  apiKey: string;
  bearerToken: string | undefined;
  region: string;
  authStrategy: EdgeSearchAuthStrategy;
  includeRegion: boolean;
}

export function resolveEducationConfig(
  args: StrictParsedArgs,
  env: NodeJS.ProcessEnv,
): EducationConfig {
  const timeoutSeconds = getPositiveIntegerValue(
    strictString(args, "timeout") ?? firstEnv(env, "TIANGONG_EDUCATION_TIMEOUT"),
    120,
    "--timeout",
  );
  const apiKey = strictString(args, "api-key") ?? firstEnv(env, "TIANGONG_AI_APIKEY") ?? "";
  const bearerToken =
    strictString(args, "bearer-token") ??
    firstEnv(env, "TIANGONG_EDUCATION_BEARER_TOKEN", "TIANGONG_KB_READ_TOKEN");
  const apiBaseUrl =
    strictString(args, "api-base-url") ??
    firstEnv(
      env,
      "TIANGONG_EDUCATION_API_BASE_URL",
      "TIANGONG_AI_SEARCH_API_BASE_URL",
      "TIANGONG_AI_API_BASE_URL",
    ) ??
    DEFAULT_EDGE_SEARCH_API_BASE_URL;
  const region = strictString(args, "region") ?? firstEnv(env, "TIANGONG_REGION") ?? "us-east-1";
  return {
    timeoutSeconds,
    sources: {
      course: {
        url:
          strictString(args, "course-url") ??
          firstEnv(env, "TIANGONG_COURSE_SEARCH_URL") ??
          edgeFunctionUrl(apiBaseUrl, EDUCATION_SEARCH_SOURCES.course.endpoint),
        apiKey:
          strictString(args, "course-api-key") ?? firstEnv(env, "TIANGONG_COURSE_APIKEY") ?? apiKey,
        bearerToken,
        region,
        authStrategy: EDUCATION_SEARCH_SOURCES.course.authStrategy,
        includeRegion: EDUCATION_SEARCH_SOURCES.course.includeRegion,
      },
      edu: {
        url:
          strictString(args, "edu-url") ??
          firstEnv(env, "TIANGONG_EDU_SEARCH_URL") ??
          edgeFunctionUrl(apiBaseUrl, EDUCATION_SEARCH_SOURCES.edu.endpoint),
        apiKey: strictString(args, "edu-api-key") ?? firstEnv(env, "TIANGONG_EDU_APIKEY") ?? apiKey,
        bearerToken: undefined,
        region,
        authStrategy: EDUCATION_SEARCH_SOURCES.edu.authStrategy,
        includeRegion: EDUCATION_SEARCH_SOURCES.edu.includeRegion,
      },
      textbook: {
        url:
          strictString(args, "textbook-url") ??
          firstEnv(env, "TIANGONG_TEXTBOOK_SEARCH_URL") ??
          edgeFunctionUrl(apiBaseUrl, EDUCATION_SEARCH_SOURCES.textbook.endpoint),
        apiKey:
          strictString(args, "textbook-api-key") ??
          firstEnv(env, "TIANGONG_TEXTBOOK_APIKEY") ??
          apiKey,
        bearerToken: undefined,
        region,
        authStrategy: EDUCATION_SEARCH_SOURCES.textbook.authStrategy,
        includeRegion: EDUCATION_SEARCH_SOURCES.textbook.includeRegion,
      },
    },
  };
}

export function educationSourceConfig(
  config: EducationConfig,
  source: EducationSourceId,
): EducationSourceConfig {
  return config.sources[source];
}

export function parseEducationSources(value: string | undefined): EducationSourceId[] {
  const rawSources = (value ?? "default")
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean);
  const sources = rawSources.length ? rawSources : ["default"];
  return uniqueSources(
    sources.flatMap((source) => {
      if (source === "default") return DEFAULT_EDUCATION_SOURCES;
      if (source === "all") return ALL_EDUCATION_SOURCES;
      return [parseEducationSource(source)];
    }),
  );
}

function parseEducationSource(source: string): EducationSourceId {
  if (source === "course") return source;
  if (source === "edu") return source;
  if (source === "textbook") return source;
  throw new CliError(`Unsupported education source: ${source}`, {
    code: "EDUCATION_SOURCE_UNSUPPORTED",
    exitCode: 2,
    details: { source },
  });
}

function uniqueSources(sources: EducationSourceId[]): EducationSourceId[] {
  const seen = new Set<EducationSourceId>();
  const unique: EducationSourceId[] = [];
  for (const source of sources) {
    if (seen.has(source)) continue;
    seen.add(source);
    unique.push(source);
  }
  return unique;
}

function getPositiveIntegerValue(
  value: string | undefined,
  defaultValue: number,
  label: string,
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new CliError(`${label} must be a positive integer.`, {
      code: "INVALID_NUMERIC_OPTION",
      exitCode: 2,
      details: { label, value },
    });
  return parsed;
}
