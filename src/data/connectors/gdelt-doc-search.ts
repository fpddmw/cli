import type {
  DataConnectorDefinition,
  DataOperationExecution,
  DataOperationExecutionContext,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  GDELT_DOC_SEARCH_INPUT_SCHEMA,
  GDELT_DOC_SEARCH_OUTPUT_SCHEMA,
} from "./gdelt-doc-search.schemas.js";

const DOC_PATH = "/api/v2/doc/doc";
const TIMELINE_MODES = new Set([
  "timelinevol",
  "timelinevolraw",
  "timelinetone",
  "timelinelang",
  "timelinesourcecountry",
]);
const RELATIVE_MAXIMUMS = {
  minutes: 527_040,
  hours: 8_784,
  days: 366,
  weeks: 52,
  months: 12,
  years: 1,
} as const;
const RELATIVE_SUFFIXES = {
  minutes: "min",
  hours: "h",
  days: "d",
  weeks: "w",
  months: "m",
  years: "y",
} as const;

type DocMode =
  | "artlist"
  | "timelinevol"
  | "timelinevolraw"
  | "timelinetone"
  | "timelinelang"
  | "timelinesourcecountry";
type RelativeUnit = keyof typeof RELATIVE_MAXIMUMS;
type ArticleSort = "datedesc" | "dateasc" | "tonedesc" | "toneasc" | "hybridrel";

interface GdeltDocInput {
  query: string;
  mode: DocMode;
  relativeWindow?: { value: number; unit: RelativeUnit };
  absoluteWindow?: { from: string; to: string };
  maxRecords?: number;
  sort?: ArticleSort;
  timelineSmooth?: number;
}

interface NormalizedDocQuery {
  query: string;
  mode: DocMode;
  relativeWindow: { value: number; unit: RelativeUnit } | null;
  absoluteWindow: { from: string; to: string } | null;
  maxRecords: number | null;
  sort: ArticleSort | null;
  timelineSmooth: number | null;
}

export const gdeltDocSearchConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "gdelt.doc-search",
  capabilityVersion: "1.0.0",
  minimumCliVersion: "0.0.51",
  provider: { providerId: "gdelt", name: "GDELT Project" },
  sourceCategory: "global-news-metadata",
  endpoints: [
    {
      endpointId: "gdelt-doc-api",
      baseUrl: "https://api.gdeltproject.org",
      pathPrefixes: ["/api/v2/doc/"],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/json"],
    },
  ],
  license: {
    name: "GDELT Project data",
    url: "https://www.gdeltproject.org/about.html",
    restrictions: [
      "GDELT derives signals automatically from monitored news and other open sources.",
      "Users remain responsible for source-specific rights when following or reusing linked content.",
      "This connector returns DOC metadata and aggregate timelines, not article bodies or media bytes.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 45_000,
    maxRequestBytes: 4_096,
    maxResponseBytes: 20_000_000,
    maxPages: 1,
    maxRecords: 5_000,
    maxRetries: 4,
    maxRetryDelayMs: 120_000,
    maxRedirects: 2,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-current",
    description: "DOC results reflect the provider's rolling index at request time.",
  },
  limitations: [
    "This connector bounds each DOC operation to 366 days; article-list mode only considers the final three months of a longer selected window under provider behavior.",
    "Language translation, entity extraction, tone, and topical coding are automated and can be wrong.",
    "Monitored-source coverage and reporting volume vary across countries, languages, and time.",
  ],
  discovery: {
    source: {
      maintainedBy: "The GDELT Project",
      summary: "GDELT DOC 2.0 global news search metadata and aggregate timelines.",
      description:
        "The GDELT DOC 2.0 API searches a rolling multilingual news index and exposes article-link metadata or aggregate timelines derived through automated processing.",
      coverage: {
        geographic: "Global monitored news sources, with uneven source and language coverage.",
        temporal:
          "Provider-searchable DOC holdings; this connector accepts at most a 366-day window per operation.",
        granularity:
          "One indexed article metadata item or one timestamped aggregate timeline point.",
      },
    },
    summary: "Search recent GDELT news metadata or bounded aggregate news timelines.",
    description:
      "Use a closed DOC 2.0 JSON surface with one explicit rolling or absolute window of at most 366 days; output is normalized and capped by the common runtime.",
    provides: [
      "Article-link metadata for bounded recent-news queries.",
      "Volume, raw-volume, tone, language, or source-country timeline series.",
      "Explicit query parameters and machine-verifiable source observations.",
    ],
    doesNotProvide: [
      "Article full text, article body downloads, image bytes, or archived source files.",
      "Representative samples of all news, population opinion, or ground-truth facts.",
      "Causal conclusions or validation that an automatically extracted claim or event occurred.",
    ],
    selectionHints: [
      "Choose DOC search for recent article discovery or aggregate attention/tone trends.",
      "Choose the Events, Mentions, or GKG file capability for structured 15-minute feed records.",
      "Treat returned links as candidates for separately governed source retrieval and verification.",
    ],
    typicalUseCases: [
      "Find recent article metadata matching a topic and country filter.",
      "Compare the temporal shape of monitored-news attention within a bounded window.",
    ],
    sourceDocumentation: [
      {
        title: "GDELT DOC 2.0 API",
        url: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
      },
      { title: "About GDELT", url: "https://www.gdeltproject.org/about.html" },
    ],
  },
  operations: [
    {
      operationId: "search",
      operationVersion: "1.0.0",
      summary: "Search recent article metadata or one supported GDELT DOC timeline.",
      description:
        "Validates one bounded search window and mode-specific parameters, calls the JSON endpoint, and normalizes article metadata or timeline points without retrieving linked content.",
      inputSchema: GDELT_DOC_SEARCH_INPUT_SCHEMA,
      outputSchema: GDELT_DOC_SEARCH_OUTPUT_SCHEMA,
      execute: executeGdeltDocSearch,
    },
  ],
};

async function executeGdeltDocSearch(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeQuery(context.input as GdeltDocInput);
  const response = await context.http.request({
    endpointId: "gdelt-doc-api",
    method: "GET",
    path: DOC_PATH,
    query: buildProviderQuery(query),
  });
  const payload = requireObject(response.json(), "GDELT DOC response");
  const queryDetails = normalizeQueryDetails(payload.query_details);
  if (query.mode === "artlist") {
    const rawArticles = requireArray(payload.articles, "articles");
    const cap = Math.min(context.limits.maxRecords, query.maxRecords ?? 75);
    const articles = rawArticles.slice(0, cap).map(normalizeArticle);
    const truncated = rawArticles.length > articles.length;
    return {
      status: "success",
      data: {
        source: { providerId: "gdelt", endpoint: DOC_PATH, metadataOnly: true },
        query,
        kind: "articles",
        queryDetails,
        articles,
        timelines: [],
        stopReason: articles.length === 0 ? "no-results" : truncated ? "max-records" : "completed",
      },
      summary: {
        recordCount: articles.length,
        pageCount: 1,
        chunkCount: 0,
        truncated,
        completeness: "complete",
      },
      warnings: discoveryWarnings(truncated),
      errors: [],
      observations: [{ ...response.observation, sourceId: "doc:article-list" }],
    };
  }

  const rawTimelines = requireArray(payload.timeline, "timeline");
  let remaining = context.limits.maxRecords;
  let rawPointCount = 0;
  const timelines = rawTimelines.map((value, seriesIndex) => {
    const series = requireObject(value, `timeline[${seriesIndex}]`);
    const rawData = requireArray(series.data, `timeline[${seriesIndex}].data`);
    rawPointCount += rawData.length;
    const data = rawData
      .slice(0, remaining)
      .map((point, pointIndex) =>
        normalizeTimelinePoint(point, `timeline[${seriesIndex}].data[${pointIndex}]`),
      );
    remaining -= data.length;
    return {
      series: requireNonBlankString(series.series, `timeline[${seriesIndex}].series`),
      data,
    };
  });
  const recordCount = context.limits.maxRecords - remaining;
  const truncated = rawPointCount > recordCount;
  return {
    status: "success",
    data: {
      source: { providerId: "gdelt", endpoint: DOC_PATH, metadataOnly: true },
      query,
      kind: "timeline",
      queryDetails,
      articles: [],
      timelines,
      stopReason: recordCount === 0 ? "no-results" : truncated ? "max-records" : "completed",
    },
    summary: {
      recordCount,
      pageCount: 1,
      chunkCount: timelines.length,
      truncated,
      completeness: "complete",
    },
    warnings: discoveryWarnings(truncated),
    errors: [],
    observations: [{ ...response.observation, sourceId: `doc:${query.mode}` }],
  };
}

function normalizeQuery(input: GdeltDocInput): NormalizedDocQuery {
  const query = input.query.trim().replace(/\s+/g, " ");
  if (!query || /[\u0000-\u001f\u007f]/.test(input.query)) {
    throw new DataRuntimeError(
      "invalid-request",
      "GDELT DOC query must be non-blank text without control characters.",
    );
  }
  const hasRelative = input.relativeWindow !== undefined;
  const hasAbsolute = input.absoluteWindow !== undefined;
  if (hasRelative === hasAbsolute) {
    throw new DataRuntimeError(
      "invalid-request",
      "GDELT DOC search requires exactly one relativeWindow or absoluteWindow.",
    );
  }
  let relativeWindow: NormalizedDocQuery["relativeWindow"] = null;
  let absoluteWindow: NormalizedDocQuery["absoluteWindow"] = null;
  if (input.relativeWindow) {
    const maximum = RELATIVE_MAXIMUMS[input.relativeWindow.unit];
    if (
      input.relativeWindow.value > maximum ||
      (input.relativeWindow.unit === "minutes" && input.relativeWindow.value < 15)
    ) {
      throw new DataRuntimeError(
        "invalid-request",
        "GDELT DOC relativeWindow must span from 15 minutes through one year.",
      );
    }
    relativeWindow = { ...input.relativeWindow };
  }
  if (input.absoluteWindow) {
    const from = parseRfc3339(input.absoluteWindow.from, "absoluteWindow.from");
    const to = parseRfc3339(input.absoluteWindow.to, "absoluteWindow.to");
    if (from.getTime() > to.getTime()) {
      throw new DataRuntimeError(
        "invalid-request",
        "GDELT DOC absoluteWindow.from must not follow absoluteWindow.to.",
      );
    }
    if (to.getTime() - from.getTime() > 366 * 86_400_000) {
      throw new DataRuntimeError(
        "invalid-request",
        "GDELT DOC absoluteWindow cannot exceed 366 days.",
      );
    }
    absoluteWindow = {
      from: from.toISOString().replace(".000Z", "Z"),
      to: to.toISOString().replace(".000Z", "Z"),
    };
  }
  const timeline = TIMELINE_MODES.has(input.mode);
  if (input.mode === "artlist" && input.timelineSmooth !== undefined) {
    throw new DataRuntimeError(
      "invalid-request",
      "timelineSmooth is accepted only for timeline modes.",
    );
  }
  if (timeline && (input.maxRecords !== undefined || input.sort !== undefined)) {
    throw new DataRuntimeError(
      "invalid-request",
      "maxRecords and sort are accepted only for artlist mode.",
    );
  }
  return {
    query,
    mode: input.mode,
    relativeWindow,
    absoluteWindow,
    maxRecords: input.mode === "artlist" ? (input.maxRecords ?? 75) : null,
    sort: input.mode === "artlist" ? (input.sort ?? "hybridrel") : null,
    timelineSmooth: timeline ? (input.timelineSmooth ?? 0) : null,
  };
}

function buildProviderQuery(query: NormalizedDocQuery): Record<string, string | number> {
  return {
    format: "json",
    mode: query.mode,
    query: query.query,
    ...(query.relativeWindow
      ? { TIMESPAN: `${query.relativeWindow.value}${RELATIVE_SUFFIXES[query.relativeWindow.unit]}` }
      : {}),
    ...(query.absoluteWindow
      ? {
          STARTDATETIME: gdeltDateTime(query.absoluteWindow.from),
          ENDDATETIME: gdeltDateTime(query.absoluteWindow.to),
        }
      : {}),
    ...(query.maxRecords === null ? {} : { MAXRECORDS: query.maxRecords }),
    ...(query.sort === null ? {} : { sort: query.sort }),
    ...(query.timelineSmooth === null ? {} : { TIMELINESMOOTH: query.timelineSmooth }),
  };
}

function normalizeArticle(value: unknown, index: number): Record<string, unknown> {
  const article = requireObject(value, `articles[${index}]`);
  return {
    recordIndex: index,
    url: requireNonBlankString(article.url, "article.url"),
    mobileUrl: nullableString(article.url_mobile, "article.url_mobile"),
    title: requireNonBlankString(article.title, "article.title"),
    seenDateTime: parseProviderDateTime(article.seendate, "article.seendate"),
    socialImageUrl: nullableString(article.socialimage, "article.socialimage"),
    domain: requireNonBlankString(article.domain, "article.domain"),
    language: requireNonBlankString(article.language, "article.language"),
    sourceCountry: requireNonBlankString(article.sourcecountry, "article.sourcecountry"),
  };
}

function normalizeTimelinePoint(value: unknown, field: string): Record<string, unknown> {
  const point = requireObject(value, field);
  return {
    dateTime: parseProviderDateTime(point.date, `${field}.date`),
    value: requireFiniteNumber(point.value, `${field}.value`),
    norm:
      point.norm === undefined || point.norm === null
        ? null
        : requireFiniteNumber(point.norm, `${field}.norm`),
  };
}

function normalizeQueryDetails(
  value: unknown,
): Record<string, string | number | boolean | null> | null {
  if (value === undefined || value === null) return null;
  const details = requireObject(value, "query_details");
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(details)) {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      normalized[key] = item;
    }
  }
  return normalized;
}

function parseProviderDateTime(value: unknown, field: string): string {
  if (typeof value !== "string") throw providerInvalid(`${field} must be a timestamp string.`);
  const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) throw providerInvalid(`${field} must use a GDELT UTC timestamp.`);
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().replace(".000Z", "Z") !== iso) {
    throw providerInvalid(`${field} must be a valid UTC timestamp.`);
  }
  return iso;
}

function parseRfc3339(value: string, field: string): Date {
  const parsed = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().replace(".000Z", "Z") !== value
  ) {
    throw new DataRuntimeError(
      "invalid-request",
      `${field} must be an exact canonical UTC timestamp.`,
    );
  }
  return parsed;
}

function gdeltDateTime(value: string): string {
  return value.replace(/[-:TZ.]/g, "").slice(0, 14);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerInvalid(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw providerInvalid(`${field} must be an array.`);
  return value;
}

function requireNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw providerInvalid(`${field} must be a non-empty string.`);
  return value.trim();
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireNonBlankString(value, field);
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw providerInvalid(`${field} must be a finite number.`);
  return value;
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}

function discoveryWarnings(truncated: boolean): string[] {
  return [
    "GDELT DOC signals are automatically extracted from uneven monitored-news coverage.",
    "Returned metadata and timelines are not ground-truth facts or representative population measures.",
    ...(truncated ? ["The normalized result stopped at the explicit record limit."] : []),
  ];
}
