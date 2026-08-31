import type {
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
  DataSourceObservation,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  REGULATIONS_GOV_DETAIL_INPUT_SCHEMA,
  REGULATIONS_GOV_DETAIL_OUTPUT_SCHEMA,
  REGULATIONS_GOV_SEARCH_INPUT_SCHEMA,
  REGULATIONS_GOV_SEARCH_OUTPUT_SCHEMA,
} from "./regulations-gov-comments.schemas.js";

const API_PATH_PREFIX = "/v4/";
const SEARCH_PATH = "/v4/comments";
const PROVIDER_TIME_ZONE = "America/New_York";
const MAX_SEARCH_WINDOW_DAYS = 366;
const MAX_PROVIDER_PAGES = 20;
const MAX_DETAIL_COMMENTS = 100;

interface DateWindow {
  from: string;
  to: string;
}

interface SearchInput {
  postedDate?: DateWindow;
  lastModifiedDate?: DateWindow;
  agencyId?: string;
  commentOnId?: string;
  searchTerm?: string;
  pageSize?: number;
  sortOrder?: "asc" | "desc";
}

interface NormalizedSearchQuery {
  dateMode: "posted" | "last-modified";
  postedDate: DateWindow | null;
  lastModifiedDate: DateWindow | null;
  providerTimeZone: typeof PROVIDER_TIME_ZONE;
  agencyId: string | null;
  commentOnId: string | null;
  searchTerm: string | null;
  pageSize: number;
  sortOrder: "asc" | "desc";
}

interface DetailInput {
  commentIds: string[];
  includeAttachments: boolean;
}

interface NormalizedDetailQuery {
  commentIds: string[];
  includeAttachments: boolean;
}

interface ProviderMeta {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  numberOfElements: number;
  pageNumber: number;
  pageSize: number;
  totalElements: number;
  totalPages: number;
  firstPage: boolean;
  lastPage: boolean;
}

interface SearchRecord {
  recordIndex: number;
  sourcePageNumber: number;
  commentId: string;
  agencyId: string | null;
  documentType: string | null;
  highlightedContent: string | null;
  lastModifiedDateTime: string | null;
  objectId: string | null;
  postedDateTime: string | null;
  title: string | null;
  withdrawn: boolean | null;
}

interface PageSummary {
  pageNumber: number;
  inputRecords: number;
  emittedRecords: number;
}

interface AttachmentRecord {
  attachmentId: string;
  title: string | null;
  agencyNote: string | null;
  authors: string[];
  abstract: string | null;
  order: number | null;
  modifiedDateTime: string | null;
  publication: string | null;
  restriction: { type: string | null; reason: string | null };
  fileFormats: Array<{
    url: string | null;
    format: string | null;
    sizeBytes: number | null;
  }>;
}

interface DetailRecord {
  recordIndex: number;
  requestIndex: number;
  commentId: string;
  agencyId: string;
  commentText: string;
  commentOnDocumentId: string;
  docketId: string;
  documentType: string;
  postedDateTime: string;
  modifiedDateTime: string | null;
  receivedDateTime: string;
  title: string;
  trackingNumber: string;
  withdrawn: boolean;
  reasonWithdrawn: string | null;
  restriction: { type: string | null; reason: string | null };
  submitterContext: {
    organization: string | null;
    governmentAgency: string | null;
    governmentAgencyType: string | null;
  };
  duplicateComments: number | null;
  attachments: AttachmentRecord[];
}

type SearchStopReason = "completed" | "no-results" | "max-pages" | "max-records" | "partial";

export const regulationsGovCommentsConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "regulations-gov.comments",
  capabilityVersion: "1.0.0",
  minimumCliVersion: "0.0.55",
  provider: { providerId: "regulations-gov", name: "Regulations.gov" },
  sourceCategory: "public-regulatory-comments",
  endpoints: [
    {
      endpointId: "regulations-gov-api",
      baseUrl: "https://api.regulations.gov",
      pathPrefixes: [API_PATH_PREFIX],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/vnd.api+json", "application/json"],
    },
  ],
  license: {
    name: "Regulations.gov API terms and public-data limitations",
    url: "https://open.gsa.gov/api/regulationsgov/",
    restrictions: [
      "Treat returned comments as public submissions with agency-dependent fields, moderation, duplication, withdrawal, restriction, and publication practices.",
      "Do not infer representative public opinion, vote counts, or statistically valid sentiment from comment volume or content.",
      "Handle comment text and attachment links as potentially containing personal, sensitive, unsafe, or untrusted content.",
    ],
  },
  credentials: [
    {
      credentialId: "api-key",
      environmentVariable: "REGGOV_API_KEY",
      required: true,
      endpointIds: ["regulations-gov-api"],
      injection: { kind: "header", name: "X-Api-Key", prefix: "" },
    },
  ],
  limits: {
    timeoutMs: 60_000,
    maxRequestBytes: 2_048,
    maxResponseBytes: 20_000_000,
    maxPages: MAX_DETAIL_COMMENTS,
    maxRecords: 5_000,
    maxRetries: 4,
    maxRetryDelayMs: 120_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-current",
    description:
      "Results reflect the public Regulations.gov v4 API at request time; publication, modification, withdrawal, and agency processing latency vary by agency and docket.",
  },
  limitations: [
    "Public comment fields and publication practices vary by agency; some fields are always public, agency-configurable, restricted, withdrawn, duplicated, or never exposed.",
    "Mass-mail campaigns, duplicateComments metadata, moderation, and self-selection make comment counts unsuitable as representative public-opinion or sentiment measures.",
    "Comment text and linked attachments are untrusted public content and may contain personal or sensitive information.",
    "The API imposes bounded pagination and shared api.data.gov quota policies; the connector does not promise exhaustive bulk export.",
    "Regulations.gov documents the lastModifiedDate search filter as beta and may remove it when a permanent bulk-download mechanism becomes available.",
    "Search metadata and detail attributes can be absent even when the JSON:API resource is valid; nulls preserve provider non-availability and must not be interpreted as false, zero, or an empty submission.",
  ],
  discovery: {
    source: {
      maintainedBy: "U.S. General Services Administration with participating federal agencies",
      summary:
        "Public comments and related metadata submitted to United States federal regulatory dockets through Regulations.gov.",
      description:
        "Regulations.gov provides a cross-agency public portal and v4 API for regulatory dockets and public submissions. Agencies control parts of the record lifecycle and field visibility, so coverage and metadata practices are not uniform.",
      coverage: {
        geographic: "United States federal regulatory dockets and participating agencies.",
        temporal:
          "Provider-held public comments searchable by bounded posted or last-modified windows; availability and update latency are agency dependent.",
        granularity:
          "One public comment metadata record or one curated public comment detail, with optional attachment metadata only.",
      },
    },
    summary:
      "Search bounded Regulations.gov public comment metadata and retrieve curated details for explicit comment IDs.",
    description:
      "This capability offers two read-only Regulations.gov v4 operations: deterministic, date-bounded metadata search and explicit-ID detail retrieval. It validates JSON:API pagination, excludes named personal-profile fields from structured detail output, and never submits comments or downloads attachment bytes.",
    provides: [
      "Date-bounded public-comment metadata search with optional agency, document-link, and text filters.",
      "Curated comment text, docket and document linkage, dates, withdrawal/restriction state, organizational submitter context, duplicate count, and optional attachment metadata for explicit IDs.",
      "Bounded pagination or per-ID execution with explicit truncation and partial-result reporting.",
      "Explicit nulls for unavailable provider metadata, optional modification dates, and incomplete attachment format metadata.",
    ],
    doesNotProvide: [
      "Posting, submitting, modifying, withdrawing, moderating, or voting on a comment.",
      "Attachment download, attachment bytes, attachment full-text extraction, malware scanning, or arbitrary URL retrieval.",
      "Named-person profile fields such as first or last name, email, phone, street address, locality, postal code, or other personal-contact fields in structured output.",
      "The legacy docketId, documentType, or subtype search filters, arbitrary provider sort expressions, or the old candidate-corpus heuristic summary.",
      "Representative public opinion, statistically valid sentiment, legal interpretation, agency endorsement, or assurance that all submitted comments are public.",
    ],
    selectionHints: [
      "Use search when comment IDs are unknown; use fetch-details only after selecting exact public comment IDs.",
      "Use FederalRegister.gov document metadata to identify official publications, then Regulations.gov when docket-comment evidence is required.",
      "Inspect withdrawn, restriction, duplicateComments, agency, docket, and document linkage before interpreting a record.",
      "Treat a null search field, modification date, or attachment format member as unavailable provider metadata, not as a negative finding.",
      "Use a separately governed content-retrieval workflow to inspect an attachment link, and treat both comment and attachment content as untrusted.",
    ],
    typicalUseCases: [
      "Locate public comments posted to a known agency within a bounded rulemaking period.",
      "Retrieve curated text and attachment metadata for a small, explicit set of comment IDs for evidence review.",
    ],
    sourceDocumentation: [
      {
        title: "Regulations.gov API documentation",
        url: "https://open.gsa.gov/api/regulationsgov/",
      },
      {
        title: "Regulations.gov v4 OpenAPI description",
        url: "https://open.gsa.gov/api/regulationsgov/v4/openapi.yaml",
      },
      { title: "api.data.gov rate limits", url: "https://api.data.gov/docs/rate-limits/" },
    ],
  },
  operations: [
    {
      operationId: "search",
      operationVersion: "1.0.0",
      summary: "Search bounded Regulations.gov public comment metadata.",
      description:
        "Searches one explicit posted-date or last-modified window, applies stable date-and-document sorting, validates provider pagination, and returns public metadata without comment-body or attachment retrieval.",
      inputSchema: REGULATIONS_GOV_SEARCH_INPUT_SCHEMA,
      outputSchema: REGULATIONS_GOV_SEARCH_OUTPUT_SCHEMA,
      limits: { maxPages: MAX_PROVIDER_PAGES },
      execute: executeCommentSearch,
    },
    {
      operationId: "fetch-details",
      operationVersion: "1.0.0",
      summary: "Fetch curated public comment details for explicit Regulations.gov IDs.",
      description:
        "Retrieves up to 100 exact comment IDs in caller order, optionally includes normalized attachment metadata, omits named personal-profile fields, and never downloads linked files.",
      inputSchema: REGULATIONS_GOV_DETAIL_INPUT_SCHEMA,
      outputSchema: REGULATIONS_GOV_DETAIL_OUTPUT_SCHEMA,
      limits: { maxPages: MAX_DETAIL_COMMENTS, maxRecords: MAX_DETAIL_COMMENTS },
      execute: executeCommentDetails,
    },
  ],
};

async function executeCommentSearch(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeSearchQuery(context.input as SearchInput);
  const records: SearchRecord[] = [];
  const pages: PageSummary[] = [];
  const observations: DataSourceObservation[] = [];
  let provider: ProviderMeta | null = null;
  let stopReason: SearchStopReason = "completed";
  let failedPage: number | null = null;
  let failure: unknown;

  for (let pageNumber = 1; pageNumber <= context.limits.maxPages; pageNumber += 1) {
    try {
      const response = await context.http.request({
        endpointId: "regulations-gov-api",
        method: "GET",
        path: SEARCH_PATH,
        query: buildSearchParameters(query, pageNumber),
        credentialId: "api-key",
      });
      const parsed = parseSearchPage(
        response.json(),
        pageNumber,
        query.pageSize,
        Math.max(0, context.limits.maxRecords - records.length),
        records.length,
      );
      validateProviderConsistency(provider, parsed.meta);
      provider ??= parsed.meta;
      observations.push({ ...response.observation, sourceId: `comments:page:${pageNumber}` });
      records.push(...parsed.records);
      pages.push({
        pageNumber,
        inputRecords: parsed.rawRecordCount,
        emittedRecords: parsed.records.length,
      });

      if (
        records.length >= context.limits.maxRecords &&
        (parsed.meta.hasNextPage || parsed.rawRecordCount > parsed.records.length)
      ) {
        stopReason = "max-records";
        break;
      }
      if (!parsed.meta.hasNextPage) {
        stopReason = pageNumber === 1 && parsed.rawRecordCount === 0 ? "no-results" : "completed";
        break;
      }
      if (pageNumber >= context.limits.maxPages) {
        stopReason = "max-pages";
        break;
      }
    } catch (error) {
      if (isCredentialFailure(error)) throw error;
      if (pages.length === 0) throw normalizeProviderFailure(error);
      failedPage = pageNumber;
      failure = error;
      stopReason = "partial";
      break;
    }
  }

  if (!provider) {
    throw providerInvalid("Regulations.gov search completed without pagination metadata.");
  }
  const partial = failedPage !== null;
  const truncated = stopReason === "max-pages" || stopReason === "max-records";
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message: "A later Regulations.gov comment page could not be retrieved or validated.",
          retryable:
            failure instanceof DataRuntimeError ? (failure.options.retryable ?? false) : false,
          userActionRequired: false,
          details: {
            missingPages: [failedPage],
            causeCode:
              failure instanceof DataRuntimeError ? failure.code : "provider-response-invalid",
          },
        },
      ]
    : [];
  return {
    status: partial ? "partial" : "success",
    data: {
      source: sourceDescriptor(),
      query,
      provider,
      pages,
      records,
      stopReason,
    },
    summary: {
      recordCount: records.length,
      pageCount: pages.length,
      chunkCount: 0,
      truncated,
      completeness: partial ? "partial" : "complete",
      ...(partial
        ? { missing: [{ kind: "page" as const, identifiers: [String(failedPage)] }] }
        : {}),
    },
    warnings: [
      "Public comments are self-selected submissions and must not be treated as representative public opinion or statistically valid sentiment.",
      "Agency publication, duplication, withdrawal, restriction, and field-visibility practices vary by docket and record.",
      "Missing provider fields are preserved as null and do not establish a false, zero, or empty value.",
      ...(truncated ? ["The comment search stopped at an explicit page or record limit."] : []),
    ],
    errors,
    observations,
  };
}

async function executeCommentDetails(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeDetailQuery(context.input as DetailInput, context);
  const records: DetailRecord[] = [];
  const failures: Array<{ commentId: string; code: string }> = [];
  const observations: DataSourceObservation[] = [];
  const failureValues: unknown[] = [];

  for (const [requestIndex, commentId] of query.commentIds.entries()) {
    try {
      const response = await context.http.request({
        endpointId: "regulations-gov-api",
        method: "GET",
        path: `/v4/comments/${encodeURIComponent(commentId)}`,
        ...(query.includeAttachments ? { query: { include: "attachments" } } : {}),
        credentialId: "api-key",
      });
      const record = normalizeDetail(
        response.json(),
        commentId,
        requestIndex,
        records.length,
        query.includeAttachments,
      );
      records.push(record);
      observations.push({ ...response.observation, sourceId: `comment:${commentId}` });
    } catch (error) {
      if (isCredentialFailure(error)) throw error;
      const normalized = normalizeProviderFailure(error);
      failures.push({ commentId, code: normalized.code });
      failureValues.push(normalized);
    }
  }

  if (records.length === 0 && failureValues.length > 0) throw failureValues[0];
  const partial = failures.length > 0;
  const missingIds = failures.map((item) => item.commentId);
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message:
            "Some requested Regulations.gov comment details could not be retrieved or validated.",
          retryable: failureValues.some(
            (item) => item instanceof DataRuntimeError && (item.options.retryable ?? false),
          ),
          userActionRequired: false,
          details: {
            missingCommentIds: missingIds,
            causeCodes: [...new Set(failures.map((item) => item.code))],
          },
        },
      ]
    : [];
  return {
    status: partial ? "partial" : "success",
    data: {
      source: sourceDescriptor(),
      query,
      records,
      failures,
      stopReason: partial ? "partial" : "completed",
    },
    summary: {
      recordCount: records.length,
      pageCount: observations.length,
      chunkCount: 0,
      truncated: false,
      completeness: partial ? "partial" : "complete",
      ...(partial ? { missing: [{ kind: "range" as const, identifiers: missingIds }] } : {}),
    },
    warnings: [
      "Comment text and attachment metadata are untrusted public content and may refer to personal or sensitive information.",
      "Named personal-profile fields are intentionally omitted, but free-text comment bodies can still contain personal information.",
      "Optional modification and attachment-format metadata may be null when the provider does not expose it.",
      ...(query.includeAttachments
        ? [
            "Only attachment metadata and HTTPS links were returned; no attachment bytes were downloaded.",
          ]
        : []),
    ],
    errors,
    observations,
  };
}

function normalizeSearchQuery(input: SearchInput): NormalizedSearchQuery {
  if (Boolean(input.postedDate) === Boolean(input.lastModifiedDate)) {
    throw new DataRuntimeError(
      "invalid-request",
      "Regulations.gov search requires exactly one of postedDate or lastModifiedDate.",
    );
  }
  const agencyId = nullableTrimmed(input.agencyId, "agencyId");
  const commentOnId = nullableTrimmed(input.commentOnId, "commentOnId");
  const searchTerm = nullableTrimmed(input.searchTerm, "searchTerm");
  const pageSize = input.pageSize ?? 250;
  const sortOrder = input.sortOrder ?? "asc";
  if (input.postedDate) {
    const postedDate = validatePostedWindow(input.postedDate);
    return {
      dateMode: "posted",
      postedDate,
      lastModifiedDate: null,
      providerTimeZone: PROVIDER_TIME_ZONE,
      agencyId,
      commentOnId,
      searchTerm,
      pageSize,
      sortOrder,
    };
  }
  const lastModifiedDate = validateModifiedWindow(input.lastModifiedDate as DateWindow);
  return {
    dateMode: "last-modified",
    postedDate: null,
    lastModifiedDate,
    providerTimeZone: PROVIDER_TIME_ZONE,
    agencyId,
    commentOnId,
    searchTerm,
    pageSize,
    sortOrder,
  };
}

function normalizeDetailQuery(
  input: DetailInput,
  context: DataOperationExecutionContext,
): NormalizedDetailQuery {
  const maximum = Math.min(MAX_DETAIL_COMMENTS, context.limits.maxPages, context.limits.maxRecords);
  if (input.commentIds.length > maximum) {
    throw new DataRuntimeError(
      "invalid-request",
      `The commentIds array exceeds the effective ${maximum}-comment execution limit.`,
      { details: { requestedComments: input.commentIds.length, maximumComments: maximum } },
    );
  }
  return { commentIds: [...input.commentIds], includeAttachments: input.includeAttachments };
}

function validatePostedWindow(window: DateWindow): DateWindow {
  const from = parseExactDate(window.from, "postedDate.from");
  const to = parseExactDate(window.to, "postedDate.to");
  if (from > to) {
    throw new DataRuntimeError("invalid-request", "postedDate.from must not follow postedDate.to.");
  }
  const inclusiveDays = (to - from) / 86_400_000 + 1;
  if (inclusiveDays > MAX_SEARCH_WINDOW_DAYS) {
    throw new DataRuntimeError(
      "invalid-request",
      `The postedDate window must not exceed ${MAX_SEARCH_WINDOW_DAYS} inclusive days.`,
      { details: { inclusiveDays, maximumDays: MAX_SEARCH_WINDOW_DAYS } },
    );
  }
  return { from: window.from, to: window.to };
}

function validateModifiedWindow(window: DateWindow): DateWindow {
  const from = parseRfc3339(window.from, "lastModifiedDate.from");
  const to = parseRfc3339(window.to, "lastModifiedDate.to");
  if (from > to) {
    throw new DataRuntimeError(
      "invalid-request",
      "lastModifiedDate.from must not follow lastModifiedDate.to.",
    );
  }
  const durationDays = (to - from) / 86_400_000;
  if (durationDays > MAX_SEARCH_WINDOW_DAYS) {
    throw new DataRuntimeError(
      "invalid-request",
      `The lastModifiedDate window must not exceed ${MAX_SEARCH_WINDOW_DAYS} days.`,
      { details: { durationDays, maximumDays: MAX_SEARCH_WINDOW_DAYS } },
    );
  }
  return { from: window.from, to: window.to };
}

function buildSearchParameters(
  query: NormalizedSearchQuery,
  pageNumber: number,
): Record<string, number | string> {
  const dateField = query.dateMode === "posted" ? "postedDate" : "lastModifiedDate";
  const inputWindow = query.postedDate ?? query.lastModifiedDate;
  if (!inputWindow) throw new DataRuntimeError("internal-error", "Date window was not normalized.");
  const from =
    query.dateMode === "posted" ? inputWindow.from : formatProviderWallTime(inputWindow.from);
  const to = query.dateMode === "posted" ? inputWindow.to : formatProviderWallTime(inputWindow.to);
  return {
    ...(query.agencyId ? { "filter[agencyId]": query.agencyId } : {}),
    [`filter[${dateField}][ge]`]: from,
    [`filter[${dateField}][le]`]: to,
    ...(query.commentOnId ? { "filter[commentOnId]": query.commentOnId } : {}),
    ...(query.searchTerm ? { "filter[searchTerm]": query.searchTerm } : {}),
    "page[number]": pageNumber,
    "page[size]": query.pageSize,
    sort: query.sortOrder === "asc" ? `${dateField},documentId` : `-${dateField},-documentId`,
  };
}

function parseSearchPage(
  value: unknown,
  requestedPage: number,
  requestedPageSize: number,
  remainingRecords: number,
  recordOffset: number,
): { meta: ProviderMeta; rawRecordCount: number; records: SearchRecord[] } {
  const payload = requireObject(value, "Regulations.gov search response");
  const data = requireArray(payload.data, "data");
  const meta = parseProviderMeta(payload.meta, requestedPage, requestedPageSize, data.length);
  const records = data
    .slice(0, remainingRecords)
    .map((item, index) => normalizeSearchRecord(item, requestedPage, recordOffset + index));
  return { meta, rawRecordCount: data.length, records };
}

function parseProviderMeta(
  value: unknown,
  requestedPage: number,
  requestedPageSize: number,
  recordCount: number,
): ProviderMeta {
  const meta = requireObject(value, "meta");
  const result: ProviderMeta = {
    hasNextPage: requireBoolean(meta.hasNextPage, "meta.hasNextPage"),
    hasPreviousPage: requireBoolean(meta.hasPreviousPage, "meta.hasPreviousPage"),
    numberOfElements: requireNonNegativeInteger(meta.numberOfElements, "meta.numberOfElements"),
    pageNumber: requirePositiveInteger(meta.pageNumber, "meta.pageNumber"),
    pageSize: requirePositiveInteger(meta.pageSize, "meta.pageSize"),
    totalElements: requireNonNegativeInteger(meta.totalElements, "meta.totalElements"),
    totalPages: requireNonNegativeInteger(meta.totalPages, "meta.totalPages"),
    firstPage: requireBoolean(meta.firstPage, "meta.firstPage"),
    lastPage: requireBoolean(meta.lastPage, "meta.lastPage"),
  };
  if (result.pageNumber !== requestedPage || result.pageSize !== requestedPageSize) {
    throw providerInvalid("Regulations.gov pagination metadata does not match the request.");
  }
  if (result.pageSize < 5 || result.pageSize > 250 || result.totalPages > MAX_PROVIDER_PAGES) {
    throw providerInvalid("Regulations.gov pagination metadata exceeds provider bounds.");
  }
  if (result.numberOfElements !== recordCount || recordCount > result.pageSize) {
    throw providerInvalid("Regulations.gov page counts do not match the response data.");
  }
  const expectedPages = Math.min(
    MAX_PROVIDER_PAGES,
    Math.ceil(result.totalElements / result.pageSize),
  );
  if (result.totalPages !== expectedPages) {
    throw providerInvalid("Regulations.gov totalPages is inconsistent with totalElements.");
  }
  const expectedHasPrevious = requestedPage > 1;
  const expectedHasNext = requestedPage < result.totalPages;
  if (
    result.hasPreviousPage !== expectedHasPrevious ||
    result.firstPage !== !expectedHasPrevious ||
    result.hasNextPage !== expectedHasNext ||
    result.lastPage !== !expectedHasNext
  ) {
    throw providerInvalid("Regulations.gov page-position flags are inconsistent.");
  }
  return result;
}

function validateProviderConsistency(current: ProviderMeta | null, next: ProviderMeta): void {
  if (!current) return;
  if (
    current.pageSize !== next.pageSize ||
    current.totalElements !== next.totalElements ||
    current.totalPages !== next.totalPages
  ) {
    throw providerInvalid("Regulations.gov pagination totals changed between pages.");
  }
}

function normalizeSearchRecord(
  value: unknown,
  pageNumber: number,
  recordIndex: number,
): SearchRecord {
  const resource = requireObject(value, `data[${recordIndex}]`);
  if (requireString(resource.type, "data.type") !== "comments") {
    throw providerInvalid("Regulations.gov search resources must have type comments.");
  }
  const attributes = requireObject(resource.attributes, "data.attributes");
  return {
    recordIndex,
    sourcePageNumber: pageNumber,
    commentId: requireString(resource.id, "data.id"),
    agencyId: nullableString(attributes.agencyId, "attributes.agencyId"),
    documentType: nullableString(attributes.documentType, "attributes.documentType"),
    highlightedContent: nullableString(
      attributes.highlightedContent,
      "attributes.highlightedContent",
    ),
    lastModifiedDateTime: nullableProviderRfc3339(
      attributes.lastModifiedDate,
      "attributes.lastModifiedDate",
    ),
    objectId: nullableString(attributes.objectId, "attributes.objectId"),
    postedDateTime: nullableProviderRfc3339(attributes.postedDate, "attributes.postedDate"),
    title: nullableString(attributes.title, "attributes.title"),
    withdrawn: nullableBoolean(attributes.withdrawn, "attributes.withdrawn"),
  };
}

function normalizeDetail(
  value: unknown,
  requestedCommentId: string,
  requestIndex: number,
  recordIndex: number,
  includeAttachments: boolean,
): DetailRecord {
  const payload = requireObject(value, "Regulations.gov detail response");
  const resource = requireObject(payload.data, "data");
  const commentId = requireString(resource.id, "data.id");
  if (commentId !== requestedCommentId) {
    throw providerInvalid("Regulations.gov returned a different comment ID than requested.");
  }
  if (requireString(resource.type, "data.type") !== "comments") {
    throw providerInvalid("Regulations.gov detail resource must have type comments.");
  }
  const attributes = requireObject(resource.attributes, "data.attributes");
  return {
    recordIndex,
    requestIndex,
    commentId,
    agencyId: requireString(attributes.agencyId, "attributes.agencyId"),
    commentText: requireString(attributes.comment, "attributes.comment", true),
    commentOnDocumentId: requireString(
      attributes.commentOnDocumentId,
      "attributes.commentOnDocumentId",
    ),
    docketId: requireString(attributes.docketId, "attributes.docketId"),
    documentType: requireString(attributes.documentType, "attributes.documentType"),
    postedDateTime: requireProviderRfc3339(attributes.postedDate, "attributes.postedDate"),
    modifiedDateTime: nullableProviderRfc3339(attributes.modifyDate, "attributes.modifyDate"),
    receivedDateTime: requireProviderRfc3339(attributes.receiveDate, "attributes.receiveDate"),
    title: requireString(attributes.title, "attributes.title", true),
    trackingNumber: requireString(attributes.trackingNbr, "attributes.trackingNbr", true),
    withdrawn: requireBoolean(attributes.withdrawn, "attributes.withdrawn"),
    reasonWithdrawn: nullableString(attributes.reasonWithdrawn, "attributes.reasonWithdrawn"),
    restriction: {
      type: nullableString(attributes.restrictReasonType, "attributes.restrictReasonType"),
      reason: nullableString(attributes.restrictReason, "attributes.restrictReason"),
    },
    submitterContext: {
      organization: nullableString(attributes.organization, "attributes.organization"),
      governmentAgency: nullableString(attributes.govAgency, "attributes.govAgency"),
      governmentAgencyType: nullableString(attributes.govAgencyType, "attributes.govAgencyType"),
    },
    duplicateComments: nullableNonNegativeInteger(
      attributes.duplicateComments,
      "attributes.duplicateComments",
    ),
    attachments: includeAttachments ? normalizeAttachments(payload, resource) : [],
  };
}

function normalizeAttachments(
  payload: Record<string, unknown>,
  resource: Record<string, unknown>,
): AttachmentRecord[] {
  const relationshipIds = attachmentRelationshipIds(resource.relationships);
  if (relationshipIds.length === 0) return [];
  const included = requireArray(payload.included, "included");
  const byId = new Map<string, AttachmentRecord>();
  for (const [index, value] of included.entries()) {
    const item = requireObject(value, `included[${index}]`);
    if (requireString(item.type, `included[${index}].type`) !== "attachments") continue;
    const id = requireString(item.id, `included[${index}].id`);
    byId.set(id, normalizeAttachment(item, id, index));
  }
  return relationshipIds.map((id) => {
    const attachment = byId.get(id);
    if (!attachment) {
      throw providerInvalid(`Included attachment metadata is missing for relationship ${id}.`);
    }
    return attachment;
  });
}

function attachmentRelationshipIds(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const relationships = requireObject(value, "data.relationships");
  if (relationships.attachments === null || relationships.attachments === undefined) return [];
  const attachments = requireObject(relationships.attachments, "data.relationships.attachments");
  const data = requireArray(attachments.data, "data.relationships.attachments.data");
  return data.map((value, index) => {
    const reference = requireObject(value, `data.relationships.attachments.data[${index}]`);
    if (
      requireString(reference.type, `data.relationships.attachments.data[${index}].type`) !==
      "attachments"
    ) {
      throw providerInvalid("Attachment relationships must use type attachments.");
    }
    return requireString(reference.id, `data.relationships.attachments.data[${index}].id`);
  });
}

function normalizeAttachment(
  value: Record<string, unknown>,
  attachmentId: string,
  includedIndex: number,
): AttachmentRecord {
  const attributes = requireObject(value.attributes, `included[${includedIndex}].attributes`);
  const fileFormats = requireArray(
    attributes.fileFormats ?? [],
    `included[${includedIndex}].attributes.fileFormats`,
  ).map((value, index) => {
    const item = requireObject(value, `fileFormats[${index}]`);
    return {
      url: nullableHttpsUrl(item.fileUrl, `fileFormats[${index}].fileUrl`),
      format: nullableString(item.format, `fileFormats[${index}].format`),
      sizeBytes: nullableNonNegativeInteger(item.size, `fileFormats[${index}].size`),
    };
  });
  const authors = requireArray(
    attributes.authors ?? [],
    `included[${includedIndex}].attributes.authors`,
  ).map((author, index) => requireString(author, `authors[${index}]`));
  return {
    attachmentId,
    title: nullableString(attributes.title, "attachment.title"),
    agencyNote: nullableString(attributes.agencyNote, "attachment.agencyNote"),
    authors,
    abstract: nullableString(attributes.docAbstract, "attachment.docAbstract"),
    order: nullableNonNegativeInteger(attributes.docOrder, "attachment.docOrder"),
    modifiedDateTime: nullableProviderRfc3339(attributes.modifyDate, "attachment.modifyDate"),
    publication: nullableString(attributes.publication, "attachment.publication"),
    restriction: {
      type: nullableString(attributes.restrictReasonType, "attachment.restrictReasonType"),
      reason: nullableString(attributes.restrictReason, "attachment.restrictReason"),
    },
    fileFormats,
  };
}

function sourceDescriptor(): {
  providerId: "regulations-gov";
  service: "Regulations.gov API";
  apiVersion: "v4";
  publicComments: true;
} {
  return {
    providerId: "regulations-gov",
    service: "Regulations.gov API",
    apiVersion: "v4",
    publicComments: true,
  };
}

function formatProviderWallTime(value: string): string {
  const instant = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PROVIDER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function parseExactDate(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DataRuntimeError("invalid-request", `${field} must use YYYY-MM-DD.`);
  }
  const instant = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value) {
    throw new DataRuntimeError("invalid-request", `${field} must be a valid calendar date.`);
  }
  return instant;
}

function parseRfc3339(value: string, field: string): number {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new DataRuntimeError("invalid-request", `${field} must be a valid RFC3339 timestamp.`);
  }
  return instant;
}

function requireProviderRfc3339(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!Number.isFinite(Date.parse(text))) throw providerInvalid(`${field} must be RFC3339.`);
  return text;
}

function nullableProviderRfc3339(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireProviderRfc3339(value, field);
}

function nullableTrimmed(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) throw new DataRuntimeError("invalid-request", `${field} must not be blank.`);
  return trimmed;
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

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw providerInvalid(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, field, true);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw providerInvalid(`${field} must be boolean.`);
  return value;
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  return requireBoolean(value, field);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw providerInvalid(`${field} must be a positive safe integer.`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw providerInvalid(`${field} must be a non-negative safe integer.`);
  }
  return value as number;
}

function nullableNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requireNonNegativeInteger(value, field);
}

function requireHttpsUrl(value: unknown, field: string): string {
  const text = requireString(value, field);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsafe URL");
    return url.toString();
  } catch {
    throw providerInvalid(`${field} must be a credential-free HTTPS URL.`);
  }
}

function nullableHttpsUrl(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireHttpsUrl(value, field);
}

function isCredentialFailure(error: unknown): boolean {
  return (
    error instanceof DataRuntimeError &&
    ["credential-missing", "credential-invalid", "provider-auth-blocked"].includes(error.code)
  );
}

function normalizeProviderFailure(error: unknown): DataRuntimeError {
  if (error instanceof DataRuntimeError) return error;
  return new DataRuntimeError(
    "provider-response-invalid",
    "The Regulations.gov response could not be retrieved or normalized.",
  );
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}
