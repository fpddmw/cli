import { firstEnv } from "../env.js";
import {
  DEFAULT_EDGE_SEARCH_API_BASE_URL,
  edgeFunctionUrl,
  type EdgeSearchAuthStrategy,
  type EdgeSearchSourceSpec,
} from "../edge-search.js";
import { CliError } from "../errors.js";
import { strictString, type StrictParsedArgs } from "../strict-args.js";
import type { ResearchSourceId } from "./types.js";

export const DEFAULT_SCI_SEARCH_ENDPOINT = "sci_search";
export const DEFAULT_REPORT_SEARCH_ENDPOINT = "report_search";
export const DEFAULT_PATENT_SEARCH_ENDPOINT = "patent_search";
export const DEFAULT_RESEARCH_SOURCES: ResearchSourceId[] = ["sci"];
export const ALL_RESEARCH_SOURCES: ResearchSourceId[] = ["sci", "report", "patent"];
export const RESEARCH_SEARCH_SOURCES: Record<ResearchSourceId, EdgeSearchSourceSpec> = {
  sci: {
    endpoint: DEFAULT_SCI_SEARCH_ENDPOINT,
    includeRegion: true,
    authStrategy: "apiKey",
  },
  report: {
    endpoint: DEFAULT_REPORT_SEARCH_ENDPOINT,
    includeRegion: true,
    authStrategy: "apiKey",
  },
  patent: {
    endpoint: DEFAULT_PATENT_SEARCH_ENDPOINT,
    includeRegion: true,
    authStrategy: "apiKey",
  },
};

export interface ResearchConfig {
  timeoutSeconds: number;
  sources: Record<ResearchSourceId, ResearchSourceConfig>;
}

export interface ResearchSourceConfig {
  url: string;
  apiKey: string;
  region: string;
  authStrategy: EdgeSearchAuthStrategy;
  includeRegion: boolean;
}

export function resolveResearchConfig(
  args: StrictParsedArgs,
  env: NodeJS.ProcessEnv,
): ResearchConfig {
  const timeoutSeconds = getPositiveIntegerValue(
    strictString(args, "timeout") ?? firstEnv(env, "TIANGONG_RESEARCH_TIMEOUT"),
    120,
    "--timeout",
  );
  const apiKey = strictString(args, "api-key") ?? firstEnv(env, "TIANGONG_AI_APIKEY") ?? "";
  const apiBaseUrl =
    strictString(args, "api-base-url") ??
    firstEnv(
      env,
      "TIANGONG_RESEARCH_API_BASE_URL",
      "TIANGONG_AI_SEARCH_API_BASE_URL",
      "TIANGONG_AI_API_BASE_URL",
    ) ??
    DEFAULT_EDGE_SEARCH_API_BASE_URL;
  const region = strictString(args, "region") ?? firstEnv(env, "TIANGONG_REGION") ?? "us-east-1";
  return {
    timeoutSeconds,
    sources: {
      sci: {
        url:
          strictString(args, "sci-url") ??
          firstEnv(env, "TIANGONG_SCI_SEARCH_URL") ??
          edgeFunctionUrl(apiBaseUrl, RESEARCH_SEARCH_SOURCES.sci.endpoint),
        apiKey:
          strictString(args, "sci-api-key") ?? firstEnv(env, "TIANGONG_SCI_APIKEY") ?? apiKey ?? "",
        region,
        authStrategy: RESEARCH_SEARCH_SOURCES.sci.authStrategy,
        includeRegion: RESEARCH_SEARCH_SOURCES.sci.includeRegion,
      },
      report: {
        url:
          strictString(args, "report-url") ??
          firstEnv(env, "TIANGONG_REPORT_SEARCH_URL") ??
          edgeFunctionUrl(apiBaseUrl, RESEARCH_SEARCH_SOURCES.report.endpoint),
        apiKey:
          strictString(args, "report-api-key") ?? firstEnv(env, "TIANGONG_REPORT_APIKEY") ?? apiKey,
        region,
        authStrategy: RESEARCH_SEARCH_SOURCES.report.authStrategy,
        includeRegion: RESEARCH_SEARCH_SOURCES.report.includeRegion,
      },
      patent: {
        url:
          strictString(args, "patent-url") ??
          firstEnv(env, "TIANGONG_PATENT_SEARCH_URL") ??
          edgeFunctionUrl(apiBaseUrl, RESEARCH_SEARCH_SOURCES.patent.endpoint),
        apiKey:
          strictString(args, "patent-api-key") ?? firstEnv(env, "TIANGONG_PATENT_APIKEY") ?? apiKey,
        region,
        authStrategy: RESEARCH_SEARCH_SOURCES.patent.authStrategy,
        includeRegion: RESEARCH_SEARCH_SOURCES.patent.includeRegion,
      },
    },
  };
}

export function researchSourceConfig(
  config: ResearchConfig,
  source: ResearchSourceId,
): ResearchSourceConfig {
  return config.sources[source];
}

export function parseResearchSources(value: string | undefined): ResearchSourceId[] {
  const rawSources = (value ?? "default")
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean);
  const sources = rawSources.length ? rawSources : ["default"];
  return uniqueSources(
    sources.flatMap((source) => {
      if (source === "default") return DEFAULT_RESEARCH_SOURCES;
      if (source === "all") return ALL_RESEARCH_SOURCES;
      return [parseResearchSource(source)];
    }),
  );
}

function parseResearchSource(source: string): ResearchSourceId {
  if (source === "sci") return source;
  if (source === "report") return source;
  if (source === "patent") return source;
  throw new CliError(`Unsupported research source: ${source}`, {
    code: "RESEARCH_SOURCE_UNSUPPORTED",
    exitCode: 2,
    details: { source },
  });
}

function uniqueSources(sources: ResearchSourceId[]): ResearchSourceId[] {
  const seen = new Set<ResearchSourceId>();
  const unique: ResearchSourceId[] = [];
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
