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
  USBR_PROJECT_RECORDS_INPUT_SCHEMA,
  USBR_PROJECT_RECORDS_OUTPUT_SCHEMA,
} from "./usbr-project-records.schemas.js";

const PROVIDER_ORIGIN = "https://www.usbr.gov";
const DEFAULT_MAX_LINKED_RECORDS = 50;

interface UsbrProjectRecordsInput {
  urls: string[];
  maxLinkedRecordsPerPage?: number;
}

interface PlannedPage {
  url: string;
  path: string;
  query: Record<string, string | string[]>;
}

interface ProjectLink {
  url: string;
  text: string;
}

interface ParsedProjectPage {
  title: string;
  summary: string | null;
  links: ProjectLink[];
}

interface ProjectRecord {
  recordId: string;
  recordType: "project-page" | "linked-document";
  title: string;
  summary: string | null;
  url: string;
  documentUrl: string;
  documentType: string;
  sourcePageUrl: string | null;
  linkIndex: number | null;
  links: ProjectLink[];
  contentSha256: string | null;
  contentByteLength: number | null;
  contentType: string | null;
  lastModified: string | null;
  etag: string | null;
}

interface HtmlState {
  inTitle: boolean;
  titleParts: string[];
  description: string | null;
  activeHref: string | null;
  activeTextParts: string[];
  links: ProjectLink[];
}

export const usbrProjectRecordsConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "usbr.project-records",
  capabilityVersion: "1.0.0",
  minimumCliVersion: "0.0.55",
  provider: {
    providerId: "usbr-project-records",
    name: "U.S. Bureau of Reclamation project and program pages",
  },
  sourceCategory: "water-project-document-inventory",
  endpoints: [
    {
      endpointId: "usbr-project-pages",
      baseUrl: PROVIDER_ORIGIN,
      pathPrefixes: ["/"],
      allowedMethods: ["GET"],
      allowedContentTypes: ["text/html", "application/xhtml+xml", "text/plain"],
    },
  ],
  license: {
    name: "U.S. Bureau of Reclamation public information",
    url: PROVIDER_ORIGIN,
    restrictions: [
      "Preserve the supplied USBR page URL and link-level provenance when reusing this inventory.",
      "A linked record is an availability cue and does not establish that the linked document was downloaded, reviewed, or remains current.",
      "Project-page content does not itself determine operating policy, legal compliance, environmental effects, or governance responsibility.",
    ],
  },
  credentials: [],
  limits: {
    timeoutMs: 60_000,
    maxRequestBytes: 16_384,
    maxResponseBytes: 20_000_000,
    maxPages: 10,
    maxRecords: 1_000,
    maxRetries: 3,
    maxRetryDelayMs: 60_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-current",
    description:
      "Page metadata and links reflect each supplied official USBR page at request time and may change without notice.",
  },
  limitations: [
    "The capability inventories only caller-supplied pages on the exact www.usbr.gov origin; it is not USBR-wide search or crawling.",
    "Only same-origin links present in fetched HTML are returned, in document order and subject to explicit page, record, byte, and timeout limits.",
    "Linked files are not downloaded, hashed, parsed, or checked for continued availability by this operation.",
    "Missing links or sparse metadata can reflect page design, provider changes, or bounded selection and are not proof that records do not exist.",
  ],
  discovery: {
    source: {
      maintainedBy: "United States Bureau of Reclamation",
      summary:
        "Official USBR project and program web pages plus their same-origin linked-record inventory.",
      description:
        "The Bureau of Reclamation publishes project, program, planning, operations, and public-information pages across www.usbr.gov, often linking reports, notices, spreadsheets, and related HTML records.",
      coverage: {
        geographic:
          "Bureau of Reclamation projects, regions, basins, and programs represented by the exact caller-supplied pages.",
        temporal:
          "Current page response and linked-record surface at retrieval time; historical coverage is page-specific.",
        granularity:
          "One supplied official page plus up to the selected number of same-origin links on that page.",
      },
    },
    summary: "Inventory supplied official USBR pages and their bounded same-origin record links.",
    description:
      "This capability fetches exact caller-supplied www.usbr.gov pages, preserves response provenance, and emits normalized page and link records without following or downloading the links.",
    provides: [
      "Page title, meta description, response digest, response byte length, content type, ETag, and last-modified metadata when supplied.",
      "Deduplicated same-origin linked records with anchor text, document-order index, and extension-derived document type.",
      "Explicit page, global-record, per-page-link, failure, and completeness signaling.",
    ],
    doesNotProvide: [
      "USBR-wide search, site ranking, recursive crawling, cross-origin links, or proof of record completeness.",
      "Linked-document bodies, download verification, document parsing, OCR, or substantive evidence extraction.",
      "Legal meaning, policy interpretation, operating conclusions, environmental-effects analysis, or report-ready synthesis.",
    ],
    selectionHints: [
      "Use this capability after an official USBR project or program URL has been grounded from another source or supplied by the user.",
      "Use USBR RISE instead when the task requires operational time-series catalog items or values rather than project-page records.",
      "Treat linked records as acquisition candidates; fetch and review needed documents in a separately governed artifact workflow.",
      "If a per-page link cap is reached, refine the source page set or raise the approved cap before claiming coverage.",
    ],
    typicalUseCases: [
      "Build a bounded inventory of reports and notices linked from known USBR project pages.",
      "Capture page-level provenance and candidate documents before an evidence review.",
    ],
    sourceDocumentation: [
      {
        title: "U.S. Bureau of Reclamation",
        url: PROVIDER_ORIGIN,
      },
    ],
  },
  operations: [
    {
      operationId: "fetch",
      operationVersion: "1.0.0",
      summary: "Fetch supplied USBR pages and inventory bounded same-origin links.",
      description:
        "Retrieves caller-ordered exact www.usbr.gov URLs, records page response provenance, extracts title and description metadata, and emits same-origin links without following them.",
      inputSchema: USBR_PROJECT_RECORDS_INPUT_SCHEMA,
      outputSchema: USBR_PROJECT_RECORDS_OUTPUT_SCHEMA,
      execute: executeUsbrProjectRecordsFetch,
    },
  ],
};

async function executeUsbrProjectRecordsFetch(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const input = context.input as UsbrProjectRecordsInput;
  const plan = normalizePlan(input.urls);
  const maxLinkedRecordsPerPage = input.maxLinkedRecordsPerPage ?? DEFAULT_MAX_LINKED_RECORDS;
  const executablePlan = plan.slice(0, context.limits.maxPages);
  const pages: Array<{
    pageNumber: number;
    url: string;
    title: string;
    linkCount: number;
    recordCount: number;
    responseBytes: number;
    responseDigest: string;
  }> = [];
  const records: ProjectRecord[] = [];
  const observations: DataSourceObservation[] = [];
  const warnings = [
    "USBR linked records are inventory candidates only; linked content was not downloaded or reviewed.",
  ];
  let stopReason: "completed" | "max-pages" | "max-records" | "max-linked-records" | "partial" =
    "completed";
  let perPageLinkCapHit = false;
  let failedPage: number | null = null;
  let failure: unknown;

  for (let index = 0; index < executablePlan.length; index += 1) {
    const planned = executablePlan[index];
    if (!planned) continue;
    if (records.length >= context.limits.maxRecords) {
      stopReason = "max-records";
      break;
    }
    try {
      const response = await context.http.request({
        endpointId: "usbr-project-pages",
        method: "GET",
        path: planned.path,
        query: planned.query,
      });
      const parsed = parseProjectPage(response.text(), planned.url);
      const remainingAfterPage = context.limits.maxRecords - records.length - 1;
      const selectedCount = Math.min(
        parsed.links.length,
        maxLinkedRecordsPerPage,
        Math.max(0, remainingAfterPage),
      );
      const selectedLinks = parsed.links.slice(0, selectedCount);
      const pageRecords = [
        projectPageRecord(planned.url, parsed, selectedLinks, response),
        ...selectedLinks.map((link, linkIndex) => linkedRecord(link, planned.url, linkIndex + 1)),
      ];
      records.push(...pageRecords);
      observations.push({ ...response.observation, sourceId: `url:${index + 1}` });
      pages.push({
        pageNumber: index + 1,
        url: planned.url,
        title: parsed.title,
        linkCount: selectedLinks.length,
        recordCount: pageRecords.length,
        responseBytes: response.observation.responseBytes,
        responseDigest: response.observation.responseDigest,
      });

      const limitedByRecordCap =
        selectedLinks.length < Math.min(parsed.links.length, maxLinkedRecordsPerPage);
      if (
        limitedByRecordCap ||
        (records.length >= context.limits.maxRecords && index + 1 < plan.length)
      ) {
        stopReason = "max-records";
        break;
      }
      if (parsed.links.length > maxLinkedRecordsPerPage) perPageLinkCapHit = true;
    } catch (error) {
      if (pages.length === 0) throw normalizeProviderFailure(error);
      failedPage = index + 1;
      failure = error;
      stopReason = "partial";
      break;
    }
  }

  if (failedPage === null && stopReason === "completed" && plan.length > executablePlan.length) {
    stopReason = "max-pages";
  } else if (failedPage === null && stopReason === "completed" && perPageLinkCapHit) {
    stopReason = "max-linked-records";
  }

  const partial = failedPage !== null;
  const truncated = ["max-pages", "max-records", "max-linked-records"].includes(stopReason);
  if (truncated) {
    warnings.push(
      "The USBR project-record inventory stopped at an explicit page, record, or per-page link limit.",
    );
  }
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message: "A later supplied USBR project page could not be retrieved or validated.",
          retryable:
            failure instanceof DataRuntimeError ? (failure.options.retryable ?? false) : false,
          userActionRequired: false,
          details: {
            missingPages: [`url:${failedPage}`],
            causeCode:
              failure instanceof DataRuntimeError ? failure.code : "provider-response-invalid",
          },
        },
      ]
    : [];

  return {
    status: partial ? "partial" : "success",
    data: {
      source: {
        providerId: "usbr-project-records",
        endpoint: PROVIDER_ORIGIN,
        interpretationBoundary:
          "Official page metadata and same-origin link inventory only; linked content and substantive conclusions are outside this operation.",
      },
      query: {
        urls: plan.map((item) => item.url),
        maxLinkedRecordsPerPage,
      },
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
        ? { missing: [{ kind: "page" as const, identifiers: [`url:${failedPage}`] }] }
        : {}),
    },
    warnings,
    errors,
    observations,
  };
}

function normalizePlan(values: string[]): PlannedPage[] {
  const seen = new Set<string>();
  const plan: PlannedPage[] = [];
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new DataRuntimeError("invalid-request", "USBR project-record urls must be valid URLs.");
    }
    if (
      url.protocol !== "https:" ||
      url.origin !== PROVIDER_ORIGIN ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new DataRuntimeError(
        "invalid-request",
        `USBR project-record urls must use the exact ${PROVIDER_ORIGIN} origin without credentials, a custom port, or a fragment.`,
      );
    }
    url.searchParams.sort();
    const canonicalUrl = url.toString();
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    plan.push({
      url: canonicalUrl,
      path: url.pathname,
      query: searchParamsToQuery(url.searchParams),
    });
  }
  return plan;
}

function parseProjectPage(html: string, sourcePageUrl: string): ParsedProjectPage {
  const state: HtmlState = {
    inTitle: false,
    titleParts: [],
    description: null,
    activeHref: null,
    activeTextParts: [],
    links: [],
  };
  for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (!token.startsWith("<")) {
      if (state.inTitle) state.titleParts.push(token);
      if (state.activeHref !== null) state.activeTextParts.push(token);
      continue;
    }
    const tag = parseTag(token);
    if (!tag) continue;
    if (!tag.closing) {
      if (tag.name === "title") state.inTitle = true;
      if (
        tag.name === "meta" &&
        tag.attributes.name?.toLowerCase() === "description" &&
        state.description === null
      ) {
        state.description = nullableText(tag.attributes.content);
      }
      if (tag.name === "a" && tag.attributes.href) {
        state.activeHref = tag.attributes.href;
        state.activeTextParts = [];
      }
    } else {
      if (tag.name === "title") state.inTitle = false;
      if (tag.name === "a" && state.activeHref !== null) {
        const resolved = resolveSameOriginLink(state.activeHref, sourcePageUrl);
        if (resolved) {
          state.links.push({
            url: resolved,
            text: normalizeText(state.activeTextParts.join(" ")),
          });
        }
        state.activeHref = null;
        state.activeTextParts = [];
      }
    }
  }
  const uniqueLinks: ProjectLink[] = [];
  const seen = new Set<string>();
  for (const link of state.links) {
    if (link.url === sourcePageUrl || seen.has(link.url)) continue;
    seen.add(link.url);
    uniqueLinks.push(link);
  }
  return {
    title: normalizeText(state.titleParts.join(" ")) || titleFromUrl(sourcePageUrl),
    summary: state.description,
    links: uniqueLinks,
  };
}

function projectPageRecord(
  url: string,
  page: ParsedProjectPage,
  links: ProjectLink[],
  response: {
    safeHeaders: Record<string, string>;
    observation: DataSourceObservation;
  },
): ProjectRecord {
  return {
    recordId: url,
    recordType: "project-page",
    title: page.title,
    summary: page.summary,
    url,
    documentUrl: url,
    documentType: documentType(url),
    sourcePageUrl: null,
    linkIndex: null,
    links,
    contentSha256: response.observation.responseDigest,
    contentByteLength: response.observation.responseBytes,
    contentType: response.safeHeaders["content-type"] ?? response.observation.contentType ?? null,
    lastModified: response.safeHeaders["last-modified"] ?? null,
    etag: response.safeHeaders.etag ?? null,
  };
}

function linkedRecord(link: ProjectLink, sourcePageUrl: string, linkIndex: number): ProjectRecord {
  return {
    recordId: link.url,
    recordType: "linked-document",
    title: link.text || titleFromUrl(link.url),
    summary: null,
    url: link.url,
    documentUrl: link.url,
    documentType: documentType(link.url),
    sourcePageUrl,
    linkIndex,
    links: [],
    contentSha256: null,
    contentByteLength: null,
    contentType: null,
    lastModified: null,
    etag: null,
  };
}

function resolveSameOriginLink(value: string, sourcePageUrl: string): string | null {
  try {
    const url = new URL(value, sourcePageUrl);
    if (
      url.protocol !== "https:" ||
      url.origin !== PROVIDER_ORIGIN ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function documentType(value: string): string {
  const pathname = new URL(value).pathname.toLowerCase();
  const extension = /\.([a-z0-9]+)$/.exec(pathname)?.[1];
  return extension &&
    ["pdf", "html", "htm", "doc", "docx", "xls", "xlsx", "txt"].includes(extension)
    ? extension
    : "linked-page";
}

function titleFromUrl(value: string): string {
  const url = new URL(value);
  const lastSegment = url.pathname.split("/").filter(Boolean).at(-1);
  if (!lastSegment) return url.hostname;
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}

function parseTag(token: string): {
  name: string;
  closing: boolean;
  attributes: Record<string, string>;
} | null {
  const match = /^<\s*(\/?)\s*([^\s/>]+)/.exec(token);
  if (!match?.[2]) return null;
  const attributes: Record<string, string> = {};
  const attributeText = token.slice(match[0].length, token.length - 1);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const attribute of attributeText.matchAll(pattern)) {
    const key = attribute[1]?.toLowerCase();
    if (!key) continue;
    attributes[key] = decodeHtmlEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
  }
  return { name: match[2].toLowerCase(), closing: match[1] === "/", attributes };
}

function nullableText(value: string | undefined): string | null {
  const normalized = normalizeText(value ?? "");
  return normalized || null;
}

function normalizeText(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const point = Number.parseInt(code.slice(2), 16);
      return validCodePoint(point) ? String.fromCodePoint(point) : entity;
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return validCodePoint(point) ? String.fromCodePoint(point) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function validCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function searchParamsToQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [name, value] of searchParams) {
    const current = query[name];
    if (current === undefined) query[name] = value;
    else if (Array.isArray(current)) current.push(value);
    else query[name] = [current, value];
  }
  return query;
}

function normalizeProviderFailure(error: unknown): DataRuntimeError {
  if (error instanceof DataRuntimeError) return error;
  return new DataRuntimeError(
    "provider-response-invalid",
    "The USBR project-page response could not be retrieved, parsed, or validated.",
  );
}
