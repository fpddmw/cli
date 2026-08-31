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
  "action",
  "agencies",
  "agency_names",
  "body_html_url",
  "citation",
  "comments_close_on",
  "dates",
  "docket_id",
  "docket_ids",
  "document_number",
  "effective_on",
  "full_text_xml_url",
  "html_url",
  "json_url",
  "pdf_url",
  "public_inspection_pdf_url",
  "publication_date",
  "raw_text_url",
  "regulation_id_numbers",
  "regulations_dot_gov_url",
  "significant",
  "title",
  "topics",
  "type",
] as const;

interface FederalRegisterInput {
  term?: string;
  publicationDate?: { from?: string; to?: string };
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
  action: string | null;
  documentNumber: string;
  htmlUrl: string | null;
  jsonUrl: string | null;
  pdfUrl: string | null;
  publicInspectionPdfUrl: string | null;
  bodyHtmlUrl: string | null;
  fullTextXmlUrl: string | null;
  rawTextUrl: string | null;
  regulationsGovUrl: string | null;
  citation: string | null;
  commentsCloseOn: string | null;
  publicationDate: string;
  effectiveOn: string | null;
  agencies: Array<{ id: number | null; name: string; slug: string }>;
  agencyNames: string[];
  topics: string[];
  docketIds: string[];
  regulationIdNumbers: string[];
  significant: boolean | null;
  sourcePageNumber: number;
}

interface ParsedProviderPage {
  description: string;
  count: number | null;
  totalPages: number | null;
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
    description:
      "Search or provider-wide listing metadata reflects the FederalRegister.gov API at request time.",
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
    summary: "Retrieve bounded Federal Register document metadata with optional filters.",
    description:
      "This capability queries the FederalRegister.gov documents API with optional publication-date and regulatory filters, then returns metadata under explicit page and record limits.",
    provides: [
      "Document titles, numbers, publication/effective/comment dates, agencies, topics, dockets, RINs, citations, and provider-supplied content links when available.",
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
      "Omit filters only for a bounded newest-document listing; use term, agency, type, topic, docket, RIN, or date filters for evidence questions.",
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
        "Retrieve bounded FederalRegister.gov document metadata with optional narrowing filters.",
      description:
        "Builds a stable provider query from optional filters, follows validated same-origin pagination metadata, and emits metadata only within runtime page and record limits.",
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
  let provider: {
    description: string;
    count: number | null;
    totalPages: number | null;
  } | null = null;
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
        records.length,
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
  const publicationDate = input.publicationDate ?? {};
  const from = publicationDate.from
    ? parseExactDate(publicationDate.from, "publicationDate.from")
    : undefined;
  const to = publicationDate.to
    ? parseExactDate(publicationDate.to, "publicationDate.to")
    : undefined;
  if (from && to && from > to) {
    throw new DataRuntimeError(
      "invalid-request",
      "Federal Register publicationDate.from must not follow publicationDate.to.",
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
  recordOffset: number,
): ParsedProviderPage {
  const payload = requireObject(value, "Federal Register response");
  const description = looseString(payload.description);
  const count = optionalNonNegativeInteger(payload.count);
  const totalPages = optionalNonNegativeInteger(payload.total_pages);
  if (count !== null && totalPages !== null && (count === 0) !== (totalPages === 0)) {
    throw providerInvalid("Federal Register count and total_pages are inconsistent.");
  }
  if (!Array.isArray(payload.results)) {
    throw providerInvalid("Federal Register results must be an array.");
  }
  const nextPageUrl = nullableProviderString(payload.next_page_url, "next_page_url");
  validateNextPageUrl(nextPageUrl, pageNumber, totalPages);
  if (count !== null && payload.results.length > count) {
    throw providerInvalid("Federal Register page records exceed the provider count.");
  }
  const records = payload.results
    .filter(isRecord)
    .slice(0, remainingRecords)
    .map((record, index) =>
      normalizeProviderRecord(record, pageNumber, recordOffset + index),
    );
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
  record: Record<string, unknown>,
  pageNumber: number,
  index: number,
): FederalRegisterRecord {
  const documentNumber = looseString(record.document_number) || `federal-register-${index}`;
  const agencies = Array.isArray(record.agencies)
    ? record.agencies.flatMap((value) => {
        if (!isRecord(value)) return [];
        const name = looseString(value.name) || looseString(value.raw_name);
        if (!name) return [];
        return [
          {
            id: optionalNonNegativeInteger(value.id),
            name,
            slug: looseString(value.slug),
          },
        ];
      })
    : [];
  const agencyNames = uniqueStrings([
    ...looseStringArray(record.agency_names),
    ...agencies.map((agency) => agency.name),
  ]);
  return {
    title: looseString(record.title) || `Federal Register document ${documentNumber}`,
    type: looseString(record.type),
    abstract: nullableLooseString(record.abstract),
    action: nullableLooseString(record.action),
    documentNumber,
    htmlUrl: nullableLooseString(record.html_url),
    jsonUrl: nullableLooseString(record.json_url),
    pdfUrl: nullableLooseString(record.pdf_url),
    publicInspectionPdfUrl: nullableLooseString(record.public_inspection_pdf_url),
    bodyHtmlUrl: nullableLooseString(record.body_html_url),
    fullTextXmlUrl: nullableLooseString(record.full_text_xml_url),
    rawTextUrl: nullableLooseString(record.raw_text_url),
    regulationsGovUrl: nullableLooseString(record.regulations_dot_gov_url),
    citation: nullableLooseString(record.citation),
    commentsCloseOn: optionalProviderDate(record.comments_close_on),
    publicationDate: optionalProviderDate(record.publication_date) ?? "",
    effectiveOn: optionalProviderDate(record.effective_on),
    agencies,
    agencyNames,
    topics: looseStringArray(record.topics),
    docketIds: uniqueStrings([
      ...looseStringArray(record.docket_ids),
      ...looseStringArray(record.docket_id),
    ]),
    regulationIdNumbers: looseStringArray(record.regulation_id_numbers),
    significant: typeof record.significant === "boolean" ? record.significant : null,
    sourcePageNumber: pageNumber,
  };
}

function validateProviderConsistency(
  current: { description: string; count: number | null; totalPages: number | null } | null,
  next: ParsedProviderPage,
): void {
  if (!current) return;
  if (
    (current.count !== null && next.count !== null && current.count !== next.count) ||
    (current.totalPages !== null &&
      next.totalPages !== null &&
      current.totalPages !== next.totalPages) ||
    (current.description && next.description && current.description !== next.description)
  ) {
    throw providerInvalid("Federal Register pagination metadata changed between pages.");
  }
}

function providerHasMore(page: ParsedProviderPage, pageNumber: number): boolean {
  if (page.totalPages !== null) return pageNumber < page.totalPages;
  return page.rawRecordCount > 0;
}

function validateNextPageUrl(
  nextPageUrl: string | null,
  pageNumber: number,
  totalPages: number | null,
): void {
  if (totalPages === null) {
    if (nextPageUrl) validateNextPageTarget(nextPageUrl, pageNumber);
    return;
  }
  const shouldHaveNext = pageNumber < totalPages;
  if (shouldHaveNext !== Boolean(nextPageUrl)) {
    throw providerInvalid("Federal Register next_page_url does not match total_pages.");
  }
  if (!nextPageUrl) return;
  validateNextPageTarget(nextPageUrl, pageNumber);
}

function validateNextPageTarget(nextPageUrl: string, pageNumber: number): void {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looseString(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function nullableLooseString(value: unknown): string | null {
  return looseString(value) || null;
}

function looseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(looseString).filter(Boolean);
  const item = looseString(value);
  return item ? [item] : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function optionalProviderDate(value: unknown): string | null {
  const text = looseString(value);
  if (!text) return null;
  try {
    return parseExactDate(text, "provider date");
  } catch {
    return null;
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
