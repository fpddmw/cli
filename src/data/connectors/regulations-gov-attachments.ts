import type {
  DataArtifactRecord,
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
  DataSourceObservation,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { canonicalJson, sha256Bytes } from "../runtime/canonical-json.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  REGULATIONS_GOV_ATTACHMENTS_INPUT_SCHEMA,
  REGULATIONS_GOV_ATTACHMENTS_OUTPUT_SCHEMA,
} from "./regulations-gov-attachments.schemas.js";

const API_ORIGIN = "https://api.regulations.gov";
const DOWNLOADS_ORIGIN = "https://downloads.regulations.gov";
const MANIFEST_NAME = "regulations-gov-attachments-manifest.json";

interface AttachmentsInput {
  commentIds: string[];
  attachmentIds?: string[];
  maxFiles: number;
  maxTotalBytes: number;
}

interface FileFormat {
  url: string;
  format: string;
  sizeBytes: number;
}

interface AttachmentMetadata {
  commentId: string;
  attachmentId: string;
  title: string | null;
  abstract: string | null;
  order: number | null;
  modifiedDateTime: string | null;
  restrictionType: string | null;
  restrictionReason: string | null;
  fileFormats: FileFormat[];
}

interface DownloadedFile extends DataArtifactRecord {
  commentId: string;
  attachmentId: string;
  formatIndex: number;
  format: string;
  sourceUrl: string;
  contentType: string;
  providerSizeBytes: number;
  sizeMatchesProvider: boolean;
}

interface FileCandidate {
  attachment: AttachmentMetadata;
  format: FileFormat;
  formatIndex: number;
}

export const regulationsGovAttachmentsConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "regulations-gov.attachments",
  capabilityVersion: "1.0.0",
  minimumCliVersion: "0.0.55",
  provider: { providerId: "regulations-gov", name: "Regulations.gov" },
  sourceCategory: "public-regulatory-comment-attachments",
  endpoints: [
    {
      endpointId: "regulations-gov-api",
      baseUrl: API_ORIGIN,
      pathPrefixes: ["/v4/"],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/vnd.api+json", "application/json"],
    },
    {
      endpointId: "regulations-gov-downloads",
      baseUrl: DOWNLOADS_ORIGIN,
      pathPrefixes: ["/"],
      allowedMethods: ["GET"],
      allowedContentTypes: [
        "application/octet-stream",
        "application/pdf",
        "application/rtf",
        "application/vnd.ms-excel",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/x-zip-compressed",
        "application/zip",
        "application/msword",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/tiff",
        "text/csv",
        "text/html",
        "text/plain",
        "text/rtf",
        "text/xml",
      ],
    },
  ],
  license: {
    name: "Regulations.gov API terms and public-data limitations",
    url: "https://open.gsa.gov/api/regulationsgov/",
    restrictions: [
      "Preserve the source comment, attachment ID, download URL, digest, and byte count when reusing files.",
      "Treat public-submission attachments as untrusted content that may contain personal, sensitive, unsafe, restricted, or malicious material.",
      "Attachment availability and metadata do not establish representativeness, legal meaning, agency endorsement, or evidentiary sufficiency.",
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
    maxRequestBytes: 4_096,
    maxResponseBytes: 100_000_000,
    maxPages: 20,
    maxRecords: 20,
    maxRetries: 4,
    maxRetryDelayMs: 120_000,
    maxRedirects: 0,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-current",
    description:
      "Metadata and file bytes reflect the public Regulations.gov v4 detail response and official download service at retrieval time; agencies may later modify, restrict, withdraw, or replace records.",
  },
  limitations: [
    "The operation starts from exact public comment IDs and does not search dockets, documents, or comments.",
    "Only file URLs on the exact https://downloads.regulations.gov origin are downloaded; arbitrary URLs, redirects, and standalone attachment-ID lookup are not supported.",
    "Files are preserved as untrusted bytes with metadata and hashes; the connector performs no malware scan, OCR, text extraction, classification, or substantive review.",
    "Provider attachment metadata, file sizes, formats, restrictions, and availability can be incomplete or inconsistent across agencies and time.",
  ],
  discovery: {
    source: {
      maintainedBy: "U.S. General Services Administration with participating federal agencies",
      summary:
        "Public attachment metadata and files associated with United States federal regulatory comments on Regulations.gov.",
      description:
        "Regulations.gov comment-detail responses can include attachment relationships and metadata for files hosted by its official download service. Agencies control submission processing, restriction, withdrawal, and publication practices.",
      coverage: {
        geographic: "United States federal regulatory dockets and participating agencies.",
        temporal:
          "Current public attachment surface for the supplied comment IDs at retrieval time; historical retention and update latency are agency dependent.",
        granularity:
          "One attachment file format linked from one exact public comment, plus attachment and response provenance.",
      },
    },
    summary:
      "Download bounded Regulations.gov comment attachments into a verified local artifact directory.",
    description:
      "This capability retrieves attachment metadata through official v4 comment detail calls, filters optional exact attachment IDs, downloads only fixed-origin Regulations.gov files, and commits hashed files plus a machine-readable manifest without exposing the local absolute path.",
    provides: [
      "Official comment-to-attachment relationships and normalized attachment metadata for exact public comment IDs.",
      "Bounded file downloads from the exact Regulations.gov download origin with SHA-256, byte count, content type, provider-size comparison, and source URL.",
      "Transactional no-overwrite artifact output and a hash-bound relative manifest with explicit partial coverage.",
    ],
    doesNotProvide: [
      "Comment, docket, or document search; use the Regulations.gov comments capability first when IDs are unknown.",
      "Arbitrary URL download, redirect following, standalone attachment-ID discovery, recursive acquisition, or authenticated non-public files.",
      "Malware scanning, safe-file certification, OCR, text extraction, semantic analysis, stance detection, legal interpretation, or evidence synthesis.",
    ],
    selectionHints: [
      "Use this capability only after exact public comment IDs have been selected and attachment bytes are required locally.",
      "Use regulations-gov.comments/fetch-details when attachment metadata alone is sufficient; it does not write files.",
      "Supply an empty, existing, dedicated artifact directory and retain the generated manifest with downstream evidence records.",
      "Treat every downloaded file as untrusted and pass it through an appropriate safety and extraction workflow before opening or interpreting it.",
    ],
    typicalUseCases: [
      "Acquire a small, explicit set of supporting files attached to selected public comments.",
      "Create a reproducible hash inventory before separate document safety checks and evidence extraction.",
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
      operationId: "download",
      operationVersion: "1.0.0",
      summary: "Download official attachments for exact Regulations.gov comment IDs.",
      description:
        "Fetches comment detail with included attachment metadata, applies an optional exact attachment allowlist and explicit file/byte caps, then commits fixed-origin files and a relative hash manifest to an explicit local directory.",
      inputSchema: REGULATIONS_GOV_ATTACHMENTS_INPUT_SCHEMA,
      outputSchema: REGULATIONS_GOV_ATTACHMENTS_OUTPUT_SCHEMA,
      artifactOutput: { kind: "directory", required: true },
      execute: executeAttachmentDownload,
    },
  ],
};

async function executeAttachmentDownload(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  if (!context.artifacts) {
    throw new DataRuntimeError("internal-error", "The declared artifact sink is unavailable.");
  }
  const input = context.input as AttachmentsInput;
  const query = {
    commentIds: [...input.commentIds],
    attachmentIds: input.attachmentIds ? [...input.attachmentIds] : null,
    maxFiles: input.maxFiles,
    maxTotalBytes: input.maxTotalBytes,
  };
  await context.artifacts.assertAvailable(MANIFEST_NAME);

  const comments: Array<{ commentId: string; attachmentIds: string[] }> = [];
  const attachments: AttachmentMetadata[] = [];
  const observations: DataSourceObservation[] = [];
  const missingFiles: string[] = [];
  const causeCodes: string[] = [];
  const executableCommentIds = input.commentIds.slice(0, context.limits.maxPages);

  for (const [index, commentId] of executableCommentIds.entries()) {
    try {
      const response = await context.http.request({
        endpointId: "regulations-gov-api",
        method: "GET",
        path: `/v4/comments/${encodeURIComponent(commentId)}`,
        query: { include: "attachments" },
        credentialId: "api-key",
      });
      const parsed = parseCommentAttachments(response.json(), commentId);
      comments.push({ commentId, attachmentIds: parsed.map((item) => item.attachmentId) });
      attachments.push(...parsed);
      observations.push({ ...response.observation, sourceId: `comment:${index + 1}` });
    } catch (error) {
      if (comments.length === 0) throw normalizeProviderFailure(error);
      missingFiles.push(`comment:${commentId}:attachments`);
      causeCodes.push(causeCode(error));
    }
  }

  const selectedIds = input.attachmentIds ? new Set(input.attachmentIds) : null;
  const eligibleAttachments = selectedIds
    ? attachments.filter((attachment) => selectedIds.has(attachment.attachmentId))
    : attachments;
  if (selectedIds) {
    const found = new Set(eligibleAttachments.map((attachment) => attachment.attachmentId));
    for (const attachmentId of input.attachmentIds ?? []) {
      if (!found.has(attachmentId)) missingFiles.push(attachmentId);
    }
    if (missingFiles.length > causeCodes.length) causeCodes.push("provider-response-invalid");
  }

  const candidates: FileCandidate[] = eligibleAttachments.flatMap((attachment) =>
    attachment.fileFormats.map((format, index) => ({
      attachment,
      format,
      formatIndex: index + 1,
    })),
  );
  const files: DownloadedFile[] = [];
  const warnings = [
    "Downloaded Regulations.gov attachments are untrusted public-submission bytes and were not opened, scanned, or interpreted.",
    "Preserve the generated manifest and file hashes when moving artifacts into downstream evidence workflows.",
  ];
  const fileLimit = Math.min(input.maxFiles, context.limits.maxRecords);
  let totalBytes = 0;
  let capReason: "max-files" | "max-total-bytes" | null =
    candidates.length > fileLimit ? "max-files" : null;

  for (const candidate of candidates.slice(0, fileLimit)) {
    if (candidate.format.sizeBytes > input.maxTotalBytes - totalBytes) {
      capReason = "max-total-bytes";
      break;
    }
    const missingIdentifier = `${candidate.attachment.attachmentId}:format:${candidate.formatIndex}`;
    try {
      const target = officialDownloadTarget(candidate.format.url);
      const relativePath = artifactFilename(candidate);
      await context.artifacts.assertAvailable(relativePath);
      const response = await context.http.request({
        endpointId: "regulations-gov-downloads",
        method: "GET",
        path: target.pathname,
        ...(target.searchParams.size === 0 ? {} : { query: queryParameters(target) }),
        maxResponseBytes: Math.min(
          context.limits.maxResponseBytes,
          input.maxTotalBytes - totalBytes,
        ),
      });
      const artifact = await context.artifacts.stage(relativePath, response.bytes);
      totalBytes += artifact.byteSize;
      files.push({
        commentId: candidate.attachment.commentId,
        attachmentId: candidate.attachment.attachmentId,
        formatIndex: candidate.formatIndex,
        format: candidate.format.format,
        sourceUrl: candidate.format.url,
        contentType: response.observation.contentType,
        providerSizeBytes: candidate.format.sizeBytes,
        sizeMatchesProvider: candidate.format.sizeBytes === artifact.byteSize,
        ...artifact,
      });
      observations.push({
        ...response.observation,
        sourceId: `attachment:${candidate.attachment.attachmentId}:format:${candidate.formatIndex}`,
      });
    } catch (error) {
      missingFiles.push(missingIdentifier);
      causeCodes.push(causeCode(error));
    }
  }

  const partial = missingFiles.length > 0;
  const stopReason = partial
    ? "partial"
    : input.commentIds.length > executableCommentIds.length
      ? "max-comments"
      : (capReason ?? "completed");
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message:
            "One or more Regulations.gov attachment metadata records or files could not be retrieved, validated, or committed.",
          retryable: causeCodes.some((code) =>
            ["network-failed", "rate-limited", "timeout"].includes(code),
          ),
          userActionRequired: false,
          details: {
            missingFiles: unique(missingFiles),
            causeCodes: unique(causeCodes),
          },
        },
      ]
    : [];
  const source = sourceDescriptor();
  const manifestBody = {
    schemaVersion: "tiangong.data.artifact-manifest.v1",
    capabilityId: "regulations-gov.attachments",
    capabilityVersion: "1.0.0",
    operationId: "download",
    operationVersion: "1.0.0",
    source,
    query,
    comments,
    attachments,
    files,
    stopReason,
    warnings,
    errors,
  };
  const manifest = await context.artifacts.stage(
    MANIFEST_NAME,
    Buffer.from(`${canonicalJson(manifestBody)}\n`, "utf8"),
  );

  return {
    status: partial ? "partial" : "success",
    data: { source, query, comments, attachments, files, manifest, stopReason },
    summary: {
      recordCount: files.length,
      pageCount: comments.length,
      chunkCount: files.length,
      truncated: input.commentIds.length > executableCommentIds.length || capReason !== null,
      completeness: partial ? "partial" : "complete",
      ...(partial ? { missing: [{ kind: "file", identifiers: unique(missingFiles) }] } : {}),
    },
    warnings,
    errors,
    observations,
  };
}

function parseCommentAttachments(value: unknown, commentId: string): AttachmentMetadata[] {
  const payload = requireObject(value, "Regulations.gov comment detail response");
  const resource = requireObject(payload.data, "data");
  if (requireString(resource.id, "data.id") !== commentId) {
    throw providerInvalid("Regulations.gov returned a different comment ID than requested.");
  }
  if (requireString(resource.type, "data.type") !== "comments") {
    throw providerInvalid("Regulations.gov detail resource must have type comments.");
  }
  const relationshipIds = attachmentRelationshipIds(resource.relationships);
  if (relationshipIds.length === 0) return [];
  const included = requireArray(payload.included, "included");
  const byId = new Map<string, AttachmentMetadata>();
  for (const [index, value] of included.entries()) {
    const item = requireObject(value, `included[${index}]`);
    if (requireString(item.type, `included[${index}].type`) !== "attachments") continue;
    const attachmentId = requireString(item.id, `included[${index}].id`);
    if (byId.has(attachmentId)) throw providerInvalid("Attachment IDs must be unique.");
    byId.set(attachmentId, normalizeAttachment(item, commentId, attachmentId, index));
  }
  return relationshipIds.map((attachmentId) => {
    const attachment = byId.get(attachmentId);
    if (!attachment) {
      throw providerInvalid(`Included attachment metadata is missing for ${attachmentId}.`);
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
  const ids = data.map((value, index) => {
    const reference = requireObject(value, `data.relationships.attachments.data[${index}]`);
    if (
      requireString(reference.type, `data.relationships.attachments.data[${index}].type`) !==
      "attachments"
    ) {
      throw providerInvalid("Attachment relationships must use type attachments.");
    }
    return requireString(reference.id, `data.relationships.attachments.data[${index}].id`);
  });
  if (new Set(ids).size !== ids.length)
    throw providerInvalid("Attachment relationships repeat IDs.");
  return ids;
}

function normalizeAttachment(
  value: Record<string, unknown>,
  commentId: string,
  attachmentId: string,
  includedIndex: number,
): AttachmentMetadata {
  const attributes = requireObject(value.attributes, `included[${includedIndex}].attributes`);
  const fileFormats = requireArray(
    attributes.fileFormats ?? [],
    `included[${includedIndex}].attributes.fileFormats`,
  ).map((value, index) => {
    const item = requireObject(value, `fileFormats[${index}]`);
    return {
      url: requireHttpsUrl(item.fileUrl, `fileFormats[${index}].fileUrl`),
      format: requireString(item.format, `fileFormats[${index}].format`),
      sizeBytes: requireNonNegativeInteger(item.size, `fileFormats[${index}].size`),
    };
  });
  return {
    commentId,
    attachmentId,
    title: nullableString(attributes.title, "attachment.title"),
    abstract: nullableString(attributes.docAbstract, "attachment.docAbstract"),
    order: nullableNonNegativeInteger(attributes.docOrder, "attachment.docOrder"),
    modifiedDateTime: nullableString(attributes.modifyDate, "attachment.modifyDate"),
    restrictionType: nullableString(attributes.restrictReasonType, "attachment.restrictReasonType"),
    restrictionReason: nullableString(attributes.restrictReason, "attachment.restrictReason"),
    fileFormats,
  };
}

function officialDownloadTarget(value: string): URL {
  const target = new URL(value);
  if (
    target.origin !== DOWNLOADS_ORIGIN ||
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new DataRuntimeError(
      "endpoint-policy-blocked",
      "The attachment file URL is outside the fixed Regulations.gov download origin.",
    );
  }
  return target;
}

function queryParameters(url: URL): Record<string, string[]> {
  const query: Record<string, string[]> = {};
  for (const key of [...new Set(url.searchParams.keys())].sort()) {
    query[key] = url.searchParams.getAll(key);
  }
  return query;
}

function artifactFilename(candidate: FileCandidate): string {
  const identity = `${candidate.attachment.commentId}\u0000${candidate.attachment.attachmentId}\u0000${candidate.formatIndex}\u0000${candidate.format.url}`;
  const digest = sha256Bytes(Buffer.from(identity, "utf8")).slice(0, 24);
  const extension = safeExtension(candidate.format.format, candidate.format.url);
  return `reggov-${digest}-${candidate.formatIndex}.${extension}`;
}

function safeExtension(format: string, sourceUrl: string): string {
  const normalizedFormat = format
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  if (normalizedFormat) return normalizedFormat;
  const filename = new URL(sourceUrl).pathname.split("/").pop() ?? "";
  const extension = filename.includes(".") ? (filename.split(".").pop() ?? "") : "";
  return (
    extension
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 12) || "bin"
  );
}

function sourceDescriptor(): {
  providerId: "regulations-gov";
  service: "Regulations.gov API";
  apiVersion: "v4";
  downloadsOrigin: typeof DOWNLOADS_ORIGIN;
  interpretationBoundary: string;
} {
  return {
    providerId: "regulations-gov",
    service: "Regulations.gov API",
    apiVersion: "v4",
    downloadsOrigin: DOWNLOADS_ORIGIN,
    interpretationBoundary:
      "Files are preserved as untrusted source bytes; no safety, content, stance, legal, or evidentiary conclusion is made.",
  };
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
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsafe");
    return url.toString();
  } catch {
    throw providerInvalid(`${field} must be a credential-free HTTPS URL.`);
  }
}

function normalizeProviderFailure(error: unknown): DataRuntimeError {
  if (error instanceof DataRuntimeError) return error;
  return new DataRuntimeError(
    "provider-response-invalid",
    "The Regulations.gov attachment metadata could not be retrieved or normalized.",
  );
}

function causeCode(error: unknown): string {
  return error instanceof DataRuntimeError ? error.code : "network-failed";
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
