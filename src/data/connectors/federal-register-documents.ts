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
  FEDERAL_REGISTER_INPUT_SCHEMA,
  FEDERAL_REGISTER_OUTPUT_SCHEMA,
} from "./federal-register-documents.schemas.js";

const DOCUMENTS_PATH = "/api/v1/documents.json";
const DOCUMENTS_NEXT_PATHS = new Set([DOCUMENTS_PATH, "/api/v1/documents"]);
const DOCUMENT_FIELDS = [
  "abstract",
  "agencies",
  "docket_ids",
  "document_number",
  "effective_on",
  "html_url",
  "pdf_url",
  "public_inspection_pdf_url",
  "publication_date",
  "regulation_id_numbers",
  "significant",
  "title",
  "topics",
  "type",
] as const;

interface FederalRegisterInput {
  term?: string;
  publicationDate: { from?: string; to?: string };
  agencies?: string[];
  documentTypes?: string[];
  topics?: string[];
  docketId?: string;
  regulationIdNumber?: string;
  order?: "newest" | "oldest" | "relevance";
  pageSize?: number;
}

interface NormalizedFederalRegisterQuery {
  term: string | null;
  publicationDate: { from?: string; to?: string };
  agencies: string[];
  documentTypes: string[];
  topics: string[];
  docketId: string | null;
  regulationIdNumber: string | null;
  order: "newest" | "oldest" | "relevance";
  pageSize: number;
}

interface FederalRegisterRecord {
  title: string;
  type: string;
  abstract: string | null;
  documentNumber: string;
  htmlUrl: string | null;
  pdfUrl: string | null;
  publicInspectionPdfUrl: string | null;
  publicationDate: string;
  effectiveOn: string | null;
  agencies: Array<{ id: number | null; name: string; slug: string }>;
  topics: string[];
  docketIds: string[];
  regulationIdNumbers: string[];
  significant: boolean | null;
  sourcePageNumber: number;
}

interface ParsedProviderPage {
  description: string;
  count: number;
  totalPages: number;
  nextPageUrl: string | null;
  rawRecordCount: number;
  records: FederalRegisterRecord[];
}

export const federalRegisterDocumentsConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "federal-register.documents",
  capabilityVersion: "1.0.0",
  minimumCliVersion: "0.0.55",
  provider: {
    providerId: "federal-register",
    name: "FederalRegister.gov",
  },
  sourceCategory: "government-publication-metadata",
  endpoints: [
    {
      endpointId: "federal-register-api",
      baseUrl: "https://www.federalregister.gov",
      pathPrefixes: ["/api/v1/"],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/json"],
    },
  ],
  license: {
    name: "Federal Register public metadata",
    url: "https://www.federalregister.gov/reader-aids/government-policy-and-ofr-procedures/about-this-site",
    restrictions: [
      "FederalRegister.gov is an informational resource and does not replace an official edition.",
      "Legal research should verify metadata and linked material against the official Federal Register edition.",
      "This connector returns search metadata only and does not retrieve linked document full text.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 45_000,
    maxRequestBytes: 1_024,
    maxResponseBytes: 10_000_000,
    maxPages: 10,
    maxRecords: 250,
    maxRetries: 4,
    maxRetryDelayMs: 120_000,
    maxRedirects: 2,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-current",
    description: "Search metadata reflects the FederalRegister.gov API at request time.",
  },
  limitations: [
    "The connector does not fetch document body, raw text, XML, or linked PDF content.",
    "The connector does not provide legal interpretation or determine the current force of law.",
    "FederalRegister.gov metadata should be verified against an official edition for legal reliance.",
  ],
  discovery: {
    source: {
      maintainedBy: "Office of the Federal Register, National Archives and Records Administration",
      summary:
        "Official FederalRegister.gov metadata for documents published in the Federal Register.",
      description:
        "FederalRegister.gov exposes searchable metadata for notices, proposed rules, final rules, and presidential documents published by the United States federal government.",
      coverage: {
        geographic: "United States federal-government publications.",
        temporal:
          "Publication-date searchable holdings exposed by the FederalRegister.gov documents API.",
        granularity: "One published Federal Register document metadata record.",
      },
    },
    summary: "Search bounded Federal Register document metadata by date and regulatory filters.",
    description:
      "This capability queries the FederalRegister.gov documents API with an explicit publication-date bound and at least one narrowing filter, then returns validated metadata under page and record limits.",
    provides: [
      "Document titles, numbers, publication/effective dates, agencies, topics, dockets, and RIN metadata when available.",
      "Bounded pagination with explicit empty, truncated, and later-page partial states.",
      "Links supplied in provider metadata for subsequent separately governed retrieval.",
    ],
    doesNotProvide: [
      "Document body text, XML, PDF bytes, public comments, or docket attachments.",
      "Legal interpretation, current legal force, compliance advice, or completeness beyond the provider API.",
      "Regulations.gov comment evidence or public sentiment about a rulemaking.",
    ],
    selectionHints: [
      "Choose this capability to identify official notices, rules, proposed rules, or presidential documents and their publication metadata.",
      "Choose Regulations.gov for docket comments and attachments rather than Federal Register publication metadata.",
      "Use a separately reviewed content-retrieval workflow when full document text is required.",
    ],
    typicalUseCases: [
      "Find EPA rules published within a bounded quarter and capture their document numbers and dockets.",
      "Verify whether a federal agency published a notice or proposed rule in a specified period.",
    ],
    sourceDocumentation: [
      {
        title: "FederalRegister.gov API v1 documentation",
        url: "https://www.federalregister.gov/developers/documentation/api/v1",
      },
      {
        title: "About FederalRegister.gov",
        url: "https://www.federalregister.gov/reader-aids/government-policy-and-ofr-procedures/about-this-site",
      },
    ],
  },
  operations: [
    {
      operationId: "search",
      operationVersion: "1.0.0",
      summary:
        "Search bounded FederalRegister.gov document metadata by date and explicit narrowing filters.",
      description:
        "Builds a stable provider query from publication dates and explicit narrowing filters, follows validated same-origin pagination, and emits metadata only within runtime page and record limits.",
      inputSchema: FEDERAL_REGISTER_INPUT_SCHEMA,
      outputSchema: FEDERAL_REGISTER_OUTPUT_SCHEMA,
      execute: executeFederalRegisterSearch,
    },
  ],
};

async function executeFederalRegisterSearch(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeQuery(context.input as FederalRegisterInput, context.limits.maxRecords);
  const records: FederalRegisterRecord[] = [];
  const pages: Array<{ pageNumber: number; recordCount: number }> = [];
  const observations: DataSourceObservation[] = [];
  let provider: { description: string; count: number; totalPages: number } | null = null;
  let stopReason: "completed" | "max-pages" | "max-records" | "no-results" | "partial" =
    "completed";
  let failedPage: number | null = null;
  let failure: unknown;

  for (let pageNumber = 1; pageNumber <= context.limits.maxPages; pageNumber += 1) {
    try {
      const response = await context.http.request({
        endpointId: "federal-register-api",
        method: "GET",
        path: DOCUMENTS_PATH,
        query: buildQueryParameters(query, pageNumber),
      });
      const parsed = parseProviderPage(
        response.json(),
        pageNumber,
        context.limits.maxRecords - records.length,
      );
      validateProviderConsistency(provider, parsed);
      provider ??= {
        description: parsed.description,
        count: parsed.count,
        totalPages: parsed.totalPages,
      };
      observations.push({ ...response.observation, sourceId: `page:${pageNumber}` });
      const remaining = context.limits.maxRecords - records.length;
      records.push(...parsed.records.slice(0, remaining));
      pages.push({ pageNumber, recordCount: parsed.records.length });

      const hasMore = providerHasMore(parsed, pageNumber);
      if (
        records.length >= context.limits.maxRecords &&
        (hasMore || parsed.rawRecordCount > parsed.records.length)
      ) {
        stopReason = "max-records";
        break;
      }
      if (!hasMore) {
        stopReason = pageNumber === 1 && parsed.records.length === 0 ? "no-results" : "completed";
        break;
      }
      if (pageNumber >= context.limits.maxPages) {
        stopReason = "max-pages";
        break;
      }
    } catch (error) {
      if (pages.length === 0) throw normalizeProviderFailure(error);
      failedPage = pageNumber;
      failure = error;
      stopReason = "partial";
      break;
    }
  }

  if (!provider) {
    throw new DataRuntimeError(
      "provider-response-invalid",
      "Federal Register search completed without provider metadata.",
    );
  }
  const partial = failedPage !== null;
  const missingPage = failedPage ?? 1;
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message: "A later Federal Register result page could not be retrieved or validated.",
          retryable:
            failure instanceof DataRuntimeError ? (failure.options.retryable ?? false) : false,
          userActionRequired: false,
          details: {
            missingPages: [missingPage],
            causeCode:
              failure instanceof DataRuntimeError ? failure.code : "provider-response-invalid",
          },
        },
      ]
    : [];
  const truncated = stopReason === "max-pages" || stopReason === "max-records";
  return {
    status: partial ? "partial" : "success",
    data: {
      source: {
        providerId: "federal-register",
        endpoint: DOCUMENTS_PATH,
        metadataOnly: true,
        legalStatus:
          "Informational metadata; verify legal reliance against an official Federal Register edition.",
      },
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
        ? { missing: [{ kind: "page" as const, identifiers: [String(missingPage)] }] }
        : {}),
    },
    warnings: [
      "FederalRegister.gov search metadata is informational and is not a legal interpretation.",
      ...(truncated ? ["The result stopped at an explicit page or record limit."] : []),
    ],
    errors,
    observations,
  };
}

function normalizeQuery(
  input: FederalRegisterInput,
  maxRecords: number,
): NormalizedFederalRegisterQuery {
  const term = nullableText(input.term);
  const agencies = normalizeList(input.agencies);
  const documentTypes = normalizeList(input.documentTypes);
  const topics = normalizeList(input.topics);
  const docketId = nullableText(input.docketId);
  const regulationIdNumber = nullableText(input.regulationIdNumber);
  const from = input.publicationDate.from
    ? parseExactDate(input.publicationDate.from, "publicationDate.from")
    : undefined;
  const to = input.publicationDate.to
    ? parseExactDate(input.publicationDate.to, "publicationDate.to")
    : undefined;
  if (!from && !to) {
    throw new DataRuntimeError(
      "invalid-request",
      "Federal Register search requires at least one publication-date bound.",
    );
  }
  if (from && to && from > to) {
    throw new DataRuntimeError(
      "invalid-request",
      "Federal Register publicationDate.from must not follow publicationDate.to.",
    );
  }
  if (
    !term &&
    agencies.length === 0 &&
    documentTypes.length === 0 &&
    topics.length === 0 &&
    !docketId &&
    !regulationIdNumber
  ) {
    throw new DataRuntimeError(
      "invalid-request",
      "Federal Register search requires at least one narrowing filter.",
    );
  }
  const order = input.order ?? "newest";
  if (order === "relevance" && !term) {
    throw new DataRuntimeError(
      "invalid-request",
      "Federal Register order=relevance requires a term filter.",
    );
  }
  return {
    term,
    publicationDate: {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
    agencies,
    documentTypes,
    topics,
    docketId,
    regulationIdNumber,
    order,
    pageSize: Math.min(input.pageSize ?? 25, maxRecords),
  };
}

function buildQueryParameters(
  query: NormalizedFederalRegisterQuery,
  page: number,
): Record<string, string | number | string[]> {
  return {
    "fields[]": [...DOCUMENT_FIELDS],
    order: query.order,
    page,
    per_page: query.pageSize,
    ...(query.term ? { "conditions[term]": query.term } : {}),
    ...(query.publicationDate.from
      ? { "conditions[publication_date][gte]": query.publicationDate.from }
      : {}),
    ...(query.publicationDate.to
      ? { "conditions[publication_date][lte]": query.publicationDate.to }
      : {}),
    ...(query.agencies.length > 0 ? { "conditions[agencies][]": query.agencies } : {}),
    ...(query.documentTypes.length > 0 ? { "conditions[type][]": query.documentTypes } : {}),
    ...(query.topics.length > 0 ? { "conditions[topics][]": query.topics } : {}),
    ...(query.docketId ? { "conditions[docket_id]": query.docketId } : {}),
    ...(query.regulationIdNumber
      ? { "conditions[regulation_id_number]": query.regulationIdNumber }
      : {}),
  };
}

function parseProviderPage(
  value: unknown,
  pageNumber: number,
  remainingRecords: number,
): ParsedProviderPage {
  const payload = requireObject(value, "Federal Register response");
  const description = requireString(payload.description, "description", true);
  const count = requireNonNegativeInteger(payload.count, "count");
  const totalPages = requireNonNegativeInteger(payload.total_pages, "total_pages");
  if ((count === 0) !== (totalPages === 0)) {
    throw providerInvalid("Federal Register count and total_pages are inconsistent.");
  }
  if (!Array.isArray(payload.results)) {
    throw providerInvalid("Federal Register results must be an array.");
  }
  const nextPageUrl = nullableProviderString(payload.next_page_url, "next_page_url");
  validateNextPageUrl(nextPageUrl, pageNumber, totalPages);
  if (payload.results.length > count) {
    throw providerInvalid("Federal Register page records exceed the provider count.");
  }
  const records = payload.results
    .slice(0, remainingRecords)
    .map((record, index) => normalizeProviderRecord(record, pageNumber, index));
  return {
    description,
    count,
    totalPages,
    nextPageUrl,
    rawRecordCount: payload.results.length,
    records,
  };
}

function normalizeProviderRecord(
  value: unknown,
  pageNumber: number,
  index: number,
): FederalRegisterRecord {
  const record = requireObject(value, `results[${index}]`);
  const publicationDate = parseProviderDate(record.publication_date, "publication_date");
  const effectiveOn =
    record.effective_on === null || record.effective_on === undefined
      ? null
      : parseProviderDate(record.effective_on, "effective_on");
  const agencies = requireArray(record.agencies, "agencies").map((agency, agencyIndex) => {
    const item = requireObject(agency, `agencies[${agencyIndex}]`);
    const name = nonBlankProviderString(item.name) ?? nonBlankProviderString(item.raw_name);
    if (!name) {
      throw providerInvalid(`agencies[${agencyIndex}].name must be a non-empty string.`);
    }
    return {
      id:
        item.id === null || item.id === undefined
          ? null
          : requireNonNegativeInteger(item.id, `agencies[${agencyIndex}].id`),
      name,
      slug: requireString(item.slug, `agencies[${agencyIndex}].slug`),
    };
  });
  return {
    title: requireString(record.title, "title"),
    type: requireString(record.type, "type"),
    abstract: nullableProviderString(record.abstract, "abstract"),
    documentNumber: requireString(record.document_number, "document_number"),
    htmlUrl: nullableProviderString(record.html_url, "html_url"),
    pdfUrl: nullableProviderString(record.pdf_url, "pdf_url"),
    publicInspectionPdfUrl: nullableProviderString(
      record.public_inspection_pdf_url,
      "public_inspection_pdf_url",
    ),
    publicationDate,
    effectiveOn,
    agencies,
    topics: requireStringArray(record.topics, "topics"),
    docketIds: requireStringArray(record.docket_ids, "docket_ids"),
    regulationIdNumbers: requireStringArray(record.regulation_id_numbers, "regulation_id_numbers"),
    significant:
      record.significant === null || record.significant === undefined
        ? null
        : requireBoolean(record.significant, "significant"),
    sourcePageNumber: pageNumber,
  };
}

function validateProviderConsistency(
  current: { description: string; count: number; totalPages: number } | null,
  next: ParsedProviderPage,
): void {
  if (!current) return;
  if (
    current.count !== next.count ||
    current.totalPages !== next.totalPages ||
    current.description !== next.description
  ) {
    throw providerInvalid("Federal Register pagination metadata changed between pages.");
  }
}

function providerHasMore(page: ParsedProviderPage, pageNumber: number): boolean {
  if (page.totalPages === 0) return false;
  return pageNumber < page.totalPages;
}

function validateNextPageUrl(
  nextPageUrl: string | null,
  pageNumber: number,
  totalPages: number,
): void {
  const shouldHaveNext = pageNumber < totalPages;
  if (shouldHaveNext !== Boolean(nextPageUrl)) {
    throw providerInvalid("Federal Register next_page_url does not match total_pages.");
  }
  if (!nextPageUrl) return;
  let parsed: URL;
  try {
    parsed = new URL(nextPageUrl);
  } catch {
    throw providerInvalid("Federal Register next_page_url is not a valid URL.");
  }
  if (
    parsed.origin !== "https://www.federalregister.gov" ||
    !DOCUMENTS_NEXT_PATHS.has(parsed.pathname) ||
    parsed.searchParams.get("page") !== String(pageNumber + 1)
  ) {
    throw providerInvalid("Federal Register next_page_url is outside the declared page sequence.");
  }
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
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw providerInvalid(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value.trim().replace(/\s+/g, " ");
}

function nullableProviderString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, field, true) || null;
}

function nonBlankProviderString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : null;
}

function requireStringArray(value: unknown, field: string): string[] {
  return requireArray(value, field).map((item, index) => requireString(item, `${field}[${index}]`));
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw providerInvalid(`${field} must be a non-negative integer.`);
  }
  return value as number;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw providerInvalid(`${field} must be a boolean.`);
  return value;
}

function parseProviderDate(value: unknown, field: string): string {
  if (typeof value !== "string") throw providerInvalid(`${field} must be a date string.`);
  try {
    return parseExactDate(value, field);
  } catch {
    throw providerInvalid(`${field} must be a valid YYYY-MM-DD date.`);
  }
}

function parseExactDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DataRuntimeError("invalid-request", `${field} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new DataRuntimeError("invalid-request", `${field} must be a valid calendar date.`);
  }
  return value;
}

function nullableText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new DataRuntimeError(
      "invalid-request",
      "Federal Register string filters cannot be blank.",
    );
  }
  return normalized;
}

function normalizeList(values: string[] | undefined): string[] {
  if (!values) return [];
  const normalized = values.map((value) => {
    const item = value.trim().replace(/\s+/g, " ");
    if (!item) {
      throw new DataRuntimeError(
        "invalid-request",
        "Federal Register array filters cannot contain blank values.",
      );
    }
    return item;
  });
  return [...new Set(normalized)].sort(codePointOrder);
}

function normalizeProviderFailure(error: unknown): DataRuntimeError {
  if (error instanceof DataRuntimeError) return error;
  return new DataRuntimeError(
    "provider-response-invalid",
    "The Federal Register response could not be parsed or validated.",
  );
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}

function codePointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
