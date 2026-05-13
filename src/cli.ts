import { createHash, randomUUID } from "node:crypto";
import { createReadStream, openAsBlob, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  posix as pathPosix,
  relative,
  resolve,
  sep,
} from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import type { PDFDocument as PdfDocument } from "pdf-lib";
import sharp from "sharp";

export const DEFAULT_API_BASE_URL = "https://thuenv.tiangong.world:7300";
export const DEFAULT_API_PATH_PREFIX = "/api/v1/kb";

const DEFAULT_RETRIES = 3;
const DEFAULT_BULK_WINDOW_SIZE = 100;
const DEFAULT_BULK_TOP_UP_MAX = 50;
const DEFAULT_BULK_UPLOAD_CONCURRENCY = 4;
const DEFAULT_BULK_POLL_INTERVAL_SECONDS = 30;
const DEFAULT_BULK_MAX_POLLS = 0;
const DEFAULT_BULK_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const DEFAULT_BULK_DERIVED_DIR = ".tiangong-kb-ingest-derived";
const DOCX_TARGET_IMAGE_DPI = 300;
const DOCX_NORMALIZE_MIN_BYTES = 10 * 1024 * 1024;
const EMUS_PER_INCH = 914400;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const BULK_FAILED_STATUSES = new Set(["failed", "deleted", "dead", "timeout"]);
const BULK_IN_FLIGHT_STATUSES = new Set(["uploaded", "waiting_for_index_flags", "uploading"]);
const BULK_SUPPORTED_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".html",
  ".htm",
  ".json",
  ".md",
  ".pdf",
  ".ppt",
  ".pptx",
  ".rtf",
  ".txt",
  ".xls",
  ".xlsx",
]);
interface Output {
  write(text: string): unknown;
}

export interface CliIO {
  env: NodeJS.ProcessEnv;
  stdout: Output;
  stderr: Output;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

interface KbConfig {
  apiBaseUrl: string;
  apiPathPrefix: string;
  apiKey: string;
  timeoutSeconds: number;
}

interface CollectionSelector {
  field: "primary_collection_id" | "collection_path" | "collection_key" | "collection_name";
  value: string;
}

interface CollectionItem {
  id?: string;
  key?: string;
  path?: string;
  name?: string;
  [key: string]: unknown;
}

interface FilePlan {
  path: string;
  filename: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  uploadKey: string;
}

interface BulkFilePlan extends FilePlan {
  relativePath: string;
  ext: string;
  pathSegments: string[];
  pathDepth: number;
  originalPath: string;
  originalRelativePath: string;
  originalSize: number;
  originalMtimeMs: number;
  originalSha256: string;
  originalExt: string;
  classification: BulkPreflightClassification;
  ingestVariant: BulkIngestVariant;
  sourceDocumentKey: string;
  normalizeStrategy?: string | undefined;
  derivedPath?: string | undefined;
  derivedSize?: number | undefined;
  derivedSha256?: string | undefined;
  partIndex?: number | undefined;
  partCount?: number | undefined;
  pageStart?: number | undefined;
  pageEnd?: number | undefined;
  generatedMetadata: Record<string, unknown>;
  preflight: Record<string, unknown>;
}

interface UploadResult {
  key: string;
  path: string;
  sha256: string;
  status: "succeeded" | "failed";
  attempts?: number;
  documentId?: string;
  existingDocumentId?: string;
  duplicate?: boolean;
  error?: string;
  updatedAt: string;
  response?: unknown;
  requestId?: string;
  idempotencyKey?: string;
}

type SqlValue = string | number | bigint | null;

interface SqlStatement {
  run(...values: SqlValue[]): unknown;
  get(...values: SqlValue[]): Record<string, unknown> | undefined;
  all(...values: SqlValue[]): Record<string, unknown>[];
}

interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

interface BulkJobRecord {
  jobId: string;
  rootPath: string;
  statePath: string;
  status: string;
  collectionSelector: CollectionSelector;
  schemaSnapshot: unknown;
  metadataMap: MetadataMap;
  dryRunSummary: MetadataDryRunSummary | undefined;
  pipelineHealth: BulkPipelineHealthSnapshot | undefined;
  createdAt: string;
  updatedAt: string;
}

interface BulkFileRecord {
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  ext: string;
  pathSegments: string[];
  pathDepth: number;
  metadataJson: Record<string, unknown>;
  matchedRules: string[];
  status: string;
  documentId?: string | undefined;
  attempts: number;
  lastError?: string | undefined;
  originalPath: string;
  originalRelativePath: string;
  originalSize: number;
  originalMtimeMs: number;
  originalSha256: string;
  originalExt: string;
  classification: BulkPreflightClassification;
  ingestVariant: BulkIngestVariant;
  sourceDocumentKey: string;
  normalizeStrategy?: string | undefined;
  derivedPath?: string | undefined;
  derivedSize?: number | undefined;
  derivedSha256?: string | undefined;
  partIndex?: number | undefined;
  partCount?: number | undefined;
  pageStart?: number | undefined;
  pageEnd?: number | undefined;
  generatedMetadata: Record<string, unknown>;
  preflight: Record<string, unknown>;
}

interface MetadataMap {
  version?: number;
  rule_mode?: string;
  defaults?: Record<string, unknown>;
  layers?: MetadataLayer[];
}

interface MetadataLayer {
  name?: string;
  merge?: "all" | "first_match";
  overwrite?: boolean;
  rules?: MetadataRule[];
}

interface MetadataRule {
  name?: string;
  match?: MetadataMatch;
  fields?: Record<string, MetadataField | unknown>;
  overwrite?: boolean;
}

type MetadataMatch =
  | string
  | {
      path_prefix?: string;
      glob?: string;
      regex?: string;
      ext?: string | string[];
      all?: MetadataMatch[];
      any?: MetadataMatch[];
    };

interface MetadataField {
  const?: unknown;
  source?: string;
  index?: number;
  regex?: string;
  type?: string;
  map?: Record<string, unknown>;
  overwrite?: boolean;
}

interface MetadataEvaluation {
  metadata: Record<string, unknown>;
  matchedRules: string[];
}

interface MetadataDryRunSummary {
  totalFiles: number;
  validRate: number;
  requiredMissing: Record<string, number>;
  typeErrors: Record<string, number>;
  unknownRequired: Record<string, number>;
  fallbackRate: number;
  ruleCoverage: Record<string, number>;
  examples: {
    errors: Array<{ path: string; field: string; reason: string; value?: unknown }>;
  };
  preflight?: BulkPreflightSummary;
}

interface BulkStatusItem {
  documentId: string;
  status?: string | undefined;
  terminal?: boolean | undefined;
  opensearchIndexed?: boolean | undefined;
  pineconeIndexed?: boolean | undefined;
  indexRecordCount?: number | undefined;
  lastError?: string | undefined;
  lastErrorStage?: string | undefined;
  itemError?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  raw: unknown;
}

interface BulkPipelineHealthSnapshot {
  healthy: boolean;
  pressure: "ok" | "degraded" | "paused" | "unknown";
  recommendedAction: "continue" | "slow_down" | "pause_top_up";
  recommendedPollAfterSeconds: number;
  checkedAt?: string | undefined;
  message?: string | undefined;
}

type BulkPreflightClassification =
  | "direct_upload"
  | "unsupported"
  | "empty"
  | "oversize_docx_image_heavy"
  | "oversize_scanned_pdf"
  | "oversize_text_pdf"
  | "oversize_unknown";

type BulkIngestVariant = "direct_upload" | "compressed_docx" | "page_split_pdf" | "skipped";

interface BulkPreflightOptions {
  maxUploadBytes: number;
  workDir: string;
  generateDerived: boolean;
}

interface BulkMaterializeResult {
  uploadRows: BulkFileRecord[];
}

interface BulkPreflightSummary {
  maxUploadBytes: number;
  totalFiles: number;
  uploadFileCount: number;
  classificationCounts: Record<BulkPreflightClassification, number>;
  categoryCounts: {
    direct: number;
    unsupported: number;
    empty: number;
    oversize: number;
    imageHeavy: number;
  };
  planned: {
    directUploads: number;
    normalizedDocx: number;
    splitPdfParts: number;
    blocked: number;
  };
  generatedVariantCount: number;
  blockedCount: number;
  samples: Array<{
    path: string;
    classification: BulkPreflightClassification;
    ingestVariant: BulkIngestVariant;
    size: number;
    derivedSize?: number;
    partIndex?: number;
    partCount?: number;
    pageStart?: number;
    pageEnd?: number;
  }>;
}

interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  compressedData: Buffer;
  data: Buffer;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

class HttpError extends CliError {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryAfterSeconds: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  try {
    loadDotenv(io.env);

    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      write(io.stdout, topHelp());
      return 0;
    }

    const [command, subcommand, ...rest] = argv;

    if (command === "doctor") {
      if (subcommand === "--help" || subcommand === "-h") {
        write(io.stdout, "Usage: tiangong-ai doctor\n");
        return 0;
      }
      return await doctor(rest, io);
    }

    if (command === "kb") {
      if (!subcommand || subcommand === "--help" || subcommand === "-h") {
        write(io.stdout, kbHelp());
        return 0;
      }
      if (subcommand === "ingest" || subcommand === "upload") {
        if (rest[0] === "bulk") {
          return await kbIngestBulk(rest.slice(1), io);
        }
        if (rest[0] === "metadata" && rest[1] === "dry-run") {
          return await kbIngestBulkDryRun(rest.slice(2), io);
        }
        if (rest[0] === "normalize" && rest[1] === "dry-run") {
          return await kbIngestBulkPreflight(rest.slice(2), io);
        }
        if (rest[0] === "jobs") {
          return await kbIngestJobs(rest.slice(1), io);
        }
        if (rest[0] === "resume") {
          return await kbIngestResume(rest.slice(1), io);
        }
        if (rest[0] === "export") {
          return await kbIngestExport(rest.slice(1), io);
        }
        if (rest[0] === "status") {
          return await kbIngestStatus(rest.slice(1), io);
        }
        if (rest[0] === "upload") {
          return await kbIngest(rest.slice(1), io);
        }
        return await kbIngest(rest, io);
      }
      if (subcommand === "collections") {
        if (rest[0] === "schema") {
          return await kbCollectionSchema(rest.slice(1), io);
        }
        if (rest[0] === "list") {
          return await kbCollections(rest.slice(1), io);
        }
        return await kbCollections(rest, io);
      }
      if (subcommand === "status") {
        return await kbStatus(rest, io);
      }
      write(io.stdout, kbHelp());
      return 1;
    }

    throw new CliError(`Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof CliError) {
      write(io.stderr, `${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      flags.set(withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(withoutPrefix, next);
      index += 1;
    } else {
      flags.set(withoutPrefix, true);
    }
  }

  return { positionals, flags };
}

export function resolveCollectionSelector(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): CollectionSelector {
  const selectors: CollectionSelector[] = [];
  addSelector(selectors, "primary_collection_id", getString(args, "collection-id"));
  addSelector(selectors, "collection_path", getString(args, "collection-path"));
  addSelector(selectors, "collection_key", getString(args, "collection-key"));
  addSelector(selectors, "collection_name", getString(args, "collection-name"));

  if (selectors.length > 1) {
    throw new CliError("Provide exactly one collection selector.");
  }
  if (selectors.length === 1) return selectors[0] as CollectionSelector;

  const envName = firstEnv(env, "TIANGONG_KB_DEFAULT_COLLECTION_NAME");
  if (envName) return { field: "collection_name", value: envName };

  const legacyName = firstEnv(env, "TIANGONG_KB_DEFAULT_COLLECTION_ID");
  if (legacyName) {
    if (isUuid(legacyName)) {
      throw new CliError(
        "TIANGONG_KB_DEFAULT_COLLECTION_ID is treated as a collection name. Use --collection-id for UUID uploads.",
      );
    }
    return { field: "collection_name", value: legacyName };
  }

  const envPath = firstEnv(env, "TIANGONG_KB_DEFAULT_COLLECTION_PATH");
  if (envPath) return { field: "collection_path", value: envPath };

  const envKey = firstEnv(env, "TIANGONG_KB_DEFAULT_COLLECTION_KEY");
  if (envKey) return { field: "collection_key", value: envKey };

  throw new CliError(
    "Missing collection selector. Provide --collection-name, --collection-key, --collection-path, --collection-id, or set TIANGONG_KB_DEFAULT_COLLECTION_NAME.",
  );
}

async function doctor(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const config = resolveConfig(args, io.env, { requireKey: false });
  const collection =
    firstEnv(io.env, "TIANGONG_KB_DEFAULT_COLLECTION_NAME") ??
    firstEnv(io.env, "TIANGONG_KB_DEFAULT_COLLECTION_KEY") ??
    firstEnv(io.env, "TIANGONG_KB_DEFAULT_COLLECTION_PATH") ??
    "";
  const payload = {
    apiBaseUrl: config.apiBaseUrl,
    apiPathPrefix: config.apiPathPrefix,
    apiKeyPresent: Boolean(firstEnv(io.env, "TIANGONG_AI_API_KEY", "TIANGONG_KB_API_KEY")),
    defaultCollectionPresent: Boolean(collection),
  };

  write(io.stdout, `${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

async function kbCollections(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const config = resolveConfig(args, io.env);
  const capability = getString(args, "capability") ?? "upload";
  const limit = getPositiveInteger(args, "limit", 100);
  const collections = await listCollections(config, capability, limit);
  writeJsonOrText(io.stdout, args, collections, () =>
    collections
      .map(
        (item) =>
          `${item.name ?? ""}\t${collectionKey(item) ?? ""}\t${collectionPath(item) ?? ""}\t${item.id ?? ""}`,
      )
      .join("\n")
      .concat(collections.length ? "\n" : ""),
  );
  return 0;
}

async function kbCollectionSchema(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const config = resolveConfig(args, io.env);
  const selector = resolveCollectionSelector(args, io.env);
  const payload = await resolveCollection(config, selector, { includeSchema: true });
  writeJsonOrText(io.stdout, args, payload, () => `${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

async function kbStatus(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const [documentId] = args.positionals;
  if (!documentId) throw new CliError("Usage: tiangong-ai kb status <document-id>");

  const config = resolveConfig(args, io.env);
  const payload = await getDocumentStatus(config, documentId);
  writeJsonOrText(io.stdout, args, payload, () => `${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

async function kbIngestStatus(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const [id] = args.positionals;
  if (!id) throw new CliError("Usage: tiangong-ai kb ingest status <job-id-or-document-id>");

  const statePath = await resolveExistingJobStatePath(id, args);
  if (statePath) {
    const job = await readBulkJob(statePath);
    const summary = await bulkJobSummary(statePath);
    writeJsonOrText(io.stdout, args, { ...job, summary }, () =>
      [
        `Job ${job.jobId}`,
        `status=${job.status}`,
        `state=${job.statePath}`,
        `root=${job.rootPath}`,
        `pressure=${job.pipelineHealth?.pressure ?? "unknown"} action=${job.pipelineHealth?.recommendedAction ?? "continue"}`,
        `files=${summary.total} pending=${summary.pending} inflight=${summary.inflight} completed=${summary.completed} failed=${summary.failed}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  return await kbStatus(argv, io);
}

async function kbIngest(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has("manifest")) {
    throw new CliError(
      "The --manifest option was removed. Use kb ingest bulk --state for checkpoints.",
    );
  }
  return await kbIngestBulkRun(argv, io);
}

async function kbIngestBulk(argv: string[], io: CliIO): Promise<number> {
  const [verb, ...rest] = argv;
  if (!verb || verb === "--help" || verb === "-h") {
    write(io.stdout, bulkHelp());
    return 0;
  }
  if (verb === "scan") return await kbIngestBulkScan(rest, io);
  if (verb === "preflight") return await kbIngestBulkPreflight(rest, io);
  if (verb === "run") return await kbIngestBulkRun(rest, io);
  if (verb === "dry-run" || verb === "metadata-dry-run") {
    return await kbIngestBulkDryRun(rest, io);
  }
  if (verb === "status") return await kbIngestStatus(rest, io);
  if (verb === "jobs") return await kbIngestJobs(rest, io);
  if (verb === "resume") return await kbIngestResume(rest, io);
  if (verb === "export") return await kbIngestExport(rest, io);
  return await kbIngestBulkRun(argv, io);
}

async function kbIngestBulkScan(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const rootPath = args.positionals[0];
  if (!rootPath) throw new CliError("Usage: tiangong-ai kb ingest bulk scan <folder>");

  const root = resolve(rootPath);
  const recursive = getBoolean(args, "recursive") || true;
  const files = await collectBulkFilePlans(root, recursive, args);
  const summary = buildScanSummary(files, {
    scanBudget: getPositiveInteger(args, "scan-budget", 5000),
    minSamplesPerPattern: getPositiveInteger(args, "min-samples-per-pattern", 20),
    maxPatterns: getPositiveInteger(args, "max-patterns", 200),
  });

  writeJsonOrText(io.stdout, args, summary, () => `${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

async function kbIngestBulkDryRun(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const rootPath = args.positionals[0];
  if (!rootPath) throw new CliError("Usage: tiangong-ai kb ingest bulk dry-run <folder>");

  const root = resolve(rootPath);
  const metadataMap = await loadMetadataMap(args);
  const files = await collectBulkFilePlans(root, true, args);
  const schemaSnapshot = await loadSchemaSnapshot(args, io.env);
  const preflightPlans = await prepareBulkPreflightPlans(
    files,
    preflightOptionsFromArgs(args, schemaSnapshot, root, false),
  );
  const summary = metadataDryRun(preflightPlans.allPlans, metadataMap, schemaSnapshot);
  summary.preflight = buildPreflightSummary(preflightPlans.allPlans, preflightPlans.maxUploadBytes);
  writeJsonOrText(io.stdout, args, summary, () => `${JSON.stringify(summary, null, 2)}\n`);
  return metadataDryRunPassed(summary, args) ? 0 : 1;
}

async function kbIngestBulkPreflight(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const rootPath = args.positionals[0];
  if (!rootPath) throw new CliError("Usage: tiangong-ai kb ingest bulk preflight <folder>");

  const root = resolve(rootPath);
  const files = await collectBulkFilePlans(root, true, args);
  const schemaSnapshot = await loadOptionalSchemaSnapshot(args, io.env);
  const preflightPlans = await prepareBulkPreflightPlans(
    files,
    preflightOptionsFromArgs(args, schemaSnapshot, root, false),
  );
  const summary = buildPreflightSummary(preflightPlans.allPlans, preflightPlans.maxUploadBytes);
  writeJsonOrText(io.stdout, args, summary, () => `${JSON.stringify(summary, null, 2)}\n`);
  return summary.blockedCount > 0 ? 1 : 0;
}

async function kbIngestBulkRun(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const rootPath = args.positionals[0];
  if (!rootPath) throw new CliError("Usage: tiangong-ai kb ingest bulk <file-or-folder>");

  const config = resolveConfig(args, io.env);
  const root = resolve(rootPath);
  const selector = resolveCollectionSelector(args, io.env);
  const selectorFields = await resolveSelectorFields(config, selector);
  const statePath = await resolveBulkStatePath(args, getString(args, "job-id"));
  const jobId = jobIdFromStatePath(statePath);
  const metadataMap = await loadMetadataMap(args);
  const files = await collectBulkFilePlans(root, true, args);
  const schemaSnapshot = await loadSchemaSnapshot(args, io.env, config, selector);
  const preflightOptions = preflightOptionsFromArgs(args, schemaSnapshot, root, false);
  const preflightPlans = await prepareBulkPreflightPlans(files, preflightOptions);
  const dryRunSummary = metadataDryRun(preflightPlans.allPlans, metadataMap, schemaSnapshot);
  dryRunSummary.preflight = buildPreflightSummary(
    preflightPlans.allPlans,
    preflightPlans.maxUploadBytes,
  );

  await initializeBulkJob({
    statePath,
    jobId,
    rootPath: root,
    selector,
    schemaSnapshot,
    metadataMap,
    dryRunSummary,
    files: preflightPlans.allPlans,
  });

  const result = await runBulkLoop({
    args,
    config,
    selectorFields,
    statePath,
    metadataMap,
    env: io.env,
    stdout: io.stdout,
    preflightOptions,
  });

  writeJsonOrText(io.stdout, args, result, () => formatBulkRunSummary(result));
  return result.failed > 0 || result.blocked > 0 ? 1 : 0;
}

async function kbIngestJobs(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const jobsDir = getString(args, "jobs-dir")
    ? resolve(getString(args, "jobs-dir") ?? "")
    : appJobsDir();
  const entries = await readdir(jobsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const jobs = (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".sqlite"))
        .map(async (entry) => {
          const statePath = join(jobsDir, entry);
          try {
            const job = await readBulkJob(statePath);
            const summary = await bulkJobSummary(statePath);
            return { ...job, summary };
          } catch {
            return undefined;
          }
        }),
    )
  ).filter((job): job is BulkJobRecord & { summary: Awaited<ReturnType<typeof bulkJobSummary>> } =>
    Boolean(job),
  );

  writeJsonOrText(io.stdout, args, { jobs }, () =>
    jobs
      .map(
        (job) =>
          `${job.jobId}\t${job.status}\t${job.summary.completed}/${job.summary.total}\tpressure=${job.pipelineHealth?.pressure ?? "unknown"}\taction=${job.pipelineHealth?.recommendedAction ?? "continue"}\t${job.statePath}`,
      )
      .join("\n")
      .concat(jobs.length ? "\n" : ""),
  );
  return 0;
}

async function kbIngestResume(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const [jobId] = args.positionals;
  if (!jobId) throw new CliError("Usage: tiangong-ai kb ingest resume <job-id>");
  const statePath = await resolveExistingJobStatePath(jobId, args);
  if (!statePath) throw new CliError(`Bulk job not found: ${jobId}`);
  const job = await readBulkJob(statePath);
  const config = resolveConfig(args, io.env);
  const selectorFields = await resolveSelectorFields(config, job.collectionSelector);
  const preflightOptions = preflightOptionsFromArgs(args, job.schemaSnapshot, job.rootPath, false);
  const result = await runBulkLoop({
    args,
    config,
    selectorFields,
    statePath,
    metadataMap: job.metadataMap,
    env: io.env,
    stdout: io.stdout,
    preflightOptions,
  });
  writeJsonOrText(io.stdout, args, result, () => formatBulkRunSummary(result));
  return result.failed > 0 || result.blocked > 0 ? 1 : 0;
}

async function kbIngestExport(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const [jobId] = args.positionals;
  if (!jobId) throw new CliError("Usage: tiangong-ai kb ingest export <job-id>");
  const statePath = await resolveExistingJobStatePath(jobId, args);
  if (!statePath) throw new CliError(`Bulk job not found: ${jobId}`);

  const format = getString(args, "format") ?? "jsonl";
  const rows = await readBulkFiles(statePath);
  const job = await readBulkJob(statePath);
  if (format === "csv") {
    write(
      io.stdout,
      [
        csvLine([
          "relative_path",
          "sha256",
          "status",
          "document_id",
          "attempts",
          "last_error",
          "classification",
          "ingest_variant",
          "source_document_key",
          "original_relative_path",
          "part_index",
          "part_count",
          "page_start",
          "page_end",
          "metadata_json",
          "matched_rules",
        ]),
        ...rows.map((row) =>
          csvLine([
            row.relativePath,
            row.sha256,
            row.status,
            row.documentId ?? "",
            String(row.attempts),
            row.lastError ?? "",
            row.classification,
            row.ingestVariant,
            row.sourceDocumentKey,
            row.originalRelativePath,
            row.partIndex === undefined ? "" : String(row.partIndex),
            row.partCount === undefined ? "" : String(row.partCount),
            row.pageStart === undefined ? "" : String(row.pageStart),
            row.pageEnd === undefined ? "" : String(row.pageEnd),
            JSON.stringify(row.metadataJson),
            JSON.stringify(row.matchedRules),
          ]),
        ),
      ]
        .join("\n")
        .concat("\n"),
    );
    return 0;
  }
  if (format !== "jsonl" && format !== "json") {
    throw new CliError("--format must be jsonl, json, or csv.");
  }
  if (format === "json") {
    write(io.stdout, `${JSON.stringify({ job, files: rows }, null, 2)}\n`);
  } else {
    write(
      io.stdout,
      rows
        .map((row) => JSON.stringify(row))
        .join("\n")
        .concat(rows.length ? "\n" : ""),
    );
  }
  return 0;
}

async function runBulkLoop(input: {
  args: ParsedArgs;
  config: KbConfig;
  selectorFields: Record<string, string>;
  statePath: string;
  metadataMap: MetadataMap;
  env: NodeJS.ProcessEnv;
  stdout: Output;
  preflightOptions: BulkPreflightOptions;
}): Promise<{
  jobId: string;
  statePath: string;
  total: number;
  pending: number;
  inflight: number;
  completed: number;
  failed: number;
  waitingForIndexFlags: number;
  skipped: number;
  blocked: number;
  polls: number;
  pipelineHealth?: BulkPipelineHealthSnapshot | undefined;
}> {
  const windowSize = getPositiveInteger(input.args, "window-size", DEFAULT_BULK_WINDOW_SIZE);
  const topUpMax = getPositiveInteger(input.args, "top-up-max", DEFAULT_BULK_TOP_UP_MAX);
  const uploadConcurrency = positiveIntegerValue(
    getString(input.args, "upload-concurrency") ??
      getString(input.args, "concurrency") ??
      firstEnv(input.env, "TIANGONG_KB_UPLOAD_CONCURRENCY"),
    DEFAULT_BULK_UPLOAD_CONCURRENCY,
    "--upload-concurrency",
  );
  const pollInterval = positiveNumberValue(
    getString(input.args, "poll-interval") ?? firstEnv(input.env, "TIANGONG_KB_BULK_POLL_INTERVAL"),
    DEFAULT_BULK_POLL_INTERVAL_SECONDS,
    "--poll-interval",
  );
  const retries = nonNegativeIntegerValue(
    getString(input.args, "retries") ?? firstEnv(input.env, "TIANGONG_KB_UPLOAD_RETRIES"),
    DEFAULT_RETRIES,
    "--retries",
  );
  const maxPolls = getNonNegativeInteger(
    input.args,
    "max-polls",
    nonNegativeIntegerValue(
      firstEnv(input.env, "TIANGONG_KB_BULK_MAX_POLLS"),
      DEFAULT_BULK_MAX_POLLS,
      "TIANGONG_KB_BULK_MAX_POLLS",
    ),
  );
  let polls = 0;

  await resetInterruptedBulkUploads(input.statePath);
  await updateJobStatus(input.statePath, "running");
  let lastPipelineHealth: BulkPipelineHealthSnapshot | undefined;

  while (true) {
    polls += 1;
    await pollBulkStatuses(input.statePath, input.config);
    const summary = await bulkJobSummary(input.statePath);
    const capacity = Math.max(0, windowSize - summary.inflight);
    lastPipelineHealth = await readBulkPipelineHealth(input.config, pollInterval);
    await saveBulkPipelineHealth(input.statePath, lastPipelineHealth);
    const uploadLimit = bulkUploadLimitForHealth(Math.min(capacity, topUpMax), lastPipelineHealth);
    const effectiveUploadConcurrency =
      lastPipelineHealth.recommendedAction === "slow_down" ? 1 : uploadConcurrency;

    if (uploadLimit > 0) {
      const pending = await claimPendingBulkFiles(input.statePath, uploadLimit);
      await runPool(pending, effectiveUploadConcurrency, async (row) => {
        const materialized = await materializeBulkFileForUpload({
          statePath: input.statePath,
          metadataMap: input.metadataMap,
          preflightOptions: input.preflightOptions,
          row,
        });
        return await runPool(materialized.uploadRows, 1, async (uploadRow) => {
          const result = await uploadBulkFile({
            args: input.args,
            config: input.config,
            selectorFields: input.selectorFields,
            row: uploadRow,
            retries,
            env: input.env,
          });
          await saveBulkUploadResult(input.statePath, uploadRow.relativePath, result);
          return result;
        });
      });
    }

    const nextSummary = await bulkJobSummary(input.statePath);
    if (getBoolean(input.args, "verbose")) {
      write(
        input.stdout,
        `poll=${polls} pending=${nextSummary.pending} inflight=${nextSummary.inflight} completed=${nextSummary.completed} failed=${nextSummary.failed} waiting_for_index_flags=${nextSummary.waitingForIndexFlags} pressure=${lastPipelineHealth.pressure} action=${lastPipelineHealth.recommendedAction}\n`,
      );
    }
    if (nextSummary.pending === 0 && nextSummary.inflight === 0) {
      await updateJobStatus(
        input.statePath,
        nextSummary.failed > 0 || nextSummary.blocked > 0 ? "failed" : "completed",
      );
      return {
        ...nextSummary,
        jobId: jobIdFromStatePath(input.statePath),
        statePath: input.statePath,
        polls,
        pipelineHealth: lastPipelineHealth,
      };
    }
    if (maxPolls > 0 && polls >= maxPolls) {
      await updateJobStatus(input.statePath, "running");
      return {
        ...nextSummary,
        jobId: jobIdFromStatePath(input.statePath),
        statePath: input.statePath,
        polls,
        pipelineHealth: lastPipelineHealth,
      };
    }
    await sleep(bulkPollIntervalForHealth(pollInterval, lastPipelineHealth) * 1000);
  }
}

function bulkUploadLimitForHealth(limit: number, health: BulkPipelineHealthSnapshot): number {
  if (limit <= 0) return 0;
  if (health.recommendedAction === "pause_top_up") return 0;
  if (health.recommendedAction === "slow_down") return Math.max(1, Math.ceil(limit / 2));
  return limit;
}

function bulkPollIntervalForHealth(
  baseSeconds: number,
  health: BulkPipelineHealthSnapshot | undefined,
): number {
  if (!health) return baseSeconds;
  if (health.recommendedAction === "continue") return baseSeconds;
  return Math.max(baseSeconds, health.recommendedPollAfterSeconds);
}

async function uploadBulkFile(input: {
  args: ParsedArgs;
  config: KbConfig;
  selectorFields: Record<string, string>;
  row: BulkFileRecord;
  retries: number;
  env: NodeJS.ProcessEnv;
}): Promise<UploadResult> {
  const plan: FilePlan = {
    path: input.row.path,
    filename: basename(input.row.path),
    size: input.row.size,
    mtimeMs: input.row.mtimeMs,
    sha256: input.row.sha256,
    uploadKey: `${input.row.sha256}:${input.row.size}`,
  };
  return uploadWithRetries({
    args: input.args,
    config: input.config,
    selectorFields: input.selectorFields,
    plan,
    metadata: input.row.metadataJson,
    retries: input.retries,
    env: input.env,
  });
}

async function materializeBulkFileForUpload(input: {
  statePath: string;
  metadataMap: MetadataMap;
  preflightOptions: BulkPreflightOptions;
  row: BulkFileRecord;
}): Promise<BulkMaterializeResult> {
  if (input.row.ingestVariant === "direct_upload") {
    return { uploadRows: [input.row] };
  }

  try {
    const preflightOptions = materializeOptionsForRow(input.preflightOptions, input.row);
    if (input.row.ingestVariant === "compressed_docx") {
      const docxRow = await materializeDocxBulkRow(
        input.statePath,
        input.metadataMap,
        preflightOptions,
        input.row,
      );
      return { uploadRows: docxRow ? [docxRow] : [] };
    }

    if (input.row.ingestVariant === "page_split_pdf") {
      const pdfRows = await materializePdfBulkRow(
        input.statePath,
        input.metadataMap,
        preflightOptions,
        input.row,
      );
      return { uploadRows: pdfRows };
    }

    await markBulkFileFailed(input.statePath, input.row.relativePath, "UNSUPPORTED_INGEST_VARIANT");
    return { uploadRows: [] };
  } catch (error) {
    await markBulkFileFailed(
      input.statePath,
      input.row.relativePath,
      error instanceof Error ? error.message : String(error),
    );
    return { uploadRows: [] };
  }
}

function materializeOptionsForRow(
  options: BulkPreflightOptions,
  row: BulkFileRecord,
): BulkPreflightOptions {
  const rowMaxUploadBytes = Number(row.preflight.maxUploadBytes);
  return {
    ...options,
    maxUploadBytes:
      Number.isFinite(rowMaxUploadBytes) && rowMaxUploadBytes > 0
        ? rowMaxUploadBytes
        : options.maxUploadBytes,
  };
}

async function materializeDocxBulkRow(
  statePath: string,
  metadataMap: MetadataMap,
  options: BulkPreflightOptions,
  row: BulkFileRecord,
): Promise<BulkFileRecord | undefined> {
  if (row.derivedPath && row.derivedSize !== undefined && row.derivedSha256) {
    const existing = await stat(row.derivedPath).catch(() => undefined);
    if (existing?.isFile() && existing.size === row.derivedSize) return row;
  }

  const source = bulkRecordToOriginalPlan(row);
  const docx = await analyzeDocx(source.originalPath);
  if (isEmptyDocxAnalysis(docx)) {
    await markBulkFileSkipped(statePath, row.relativePath, "empty_docx");
    return undefined;
  }

  const materialized = await createDocxIngestCopy(source, options, docx, row.classification);
  return await updateMaterializedBulkRow(statePath, metadataMap, row.relativePath, materialized);
}

async function materializePdfBulkRow(
  statePath: string,
  metadataMap: MetadataMap,
  options: BulkPreflightOptions,
  row: BulkFileRecord,
): Promise<BulkFileRecord[]> {
  if (row.partIndex !== undefined && row.derivedPath) {
    const existing = await stat(row.derivedPath).catch(() => undefined);
    if (existing?.isFile() && existing.size === row.derivedSize) return [row];
  }

  const source = bulkRecordToOriginalPlan(row);
  const pdf = (await analyzePdf(source.originalPath).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    pageCount: 0,
    imageCount: 0,
    imageHeavy: false,
  }))) as PdfAnalysis;
  const partPlans = await createPdfPartPlans(source, options, pdf, row.classification);
  if (row.partIndex !== undefined) {
    const currentPart = partPlans.find((part) => part.relativePath === row.relativePath);
    if (!currentPart) {
      await markBulkFileFailed(statePath, row.relativePath, "PDF_SPLIT_PART_REGENERATION_MISMATCH");
      return [];
    }
    return [await updateMaterializedBulkRow(statePath, metadataMap, row.relativePath, currentPart)];
  }
  const now = new Date().toISOString();
  const db = await openSqlite(statePath);
  try {
    createBulkSchema(db);
    db.exec("BEGIN");
    try {
      for (const part of partPlans) {
        insertBulkFilePlan(db, metadataMap, part, bulkInitialStatus(part), now);
      }
      db.prepare("DELETE FROM files WHERE relative_path = ?").run(row.relativePath);
      touchJob(db, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
  return [];
}

async function updateMaterializedBulkRow(
  statePath: string,
  metadataMap: MetadataMap,
  relativePath: string,
  file: BulkFilePlan,
): Promise<BulkFileRecord> {
  const evaluated = evaluateMetadata(metadataMap, file);
  const now = new Date().toISOString();
  const db = await openSqlite(statePath);
  try {
    createBulkSchema(db);
    db.prepare(
      `UPDATE files
       SET path = ?, size = ?, mtime_ms = ?, sha256 = ?, ext = ?, path_segments_json = ?, path_depth = ?,
           metadata_json = ?, matched_rules_json = ?, classification = ?, ingest_variant = ?, source_document_key = ?,
           derived_path = ?, derived_size = ?, derived_sha256 = ?, normalize_strategy = ?, generated_metadata_json = ?,
           preflight_json = ?, updated_at = ?
       WHERE relative_path = ?`,
    ).run(
      file.path,
      file.size,
      file.mtimeMs,
      file.sha256,
      file.ext,
      JSON.stringify(file.pathSegments),
      file.pathDepth,
      JSON.stringify(evaluated.metadata),
      JSON.stringify(evaluated.matchedRules),
      file.classification,
      file.ingestVariant,
      file.sourceDocumentKey,
      file.derivedPath ?? null,
      file.derivedSize ?? null,
      file.derivedSha256 ?? null,
      file.normalizeStrategy ?? null,
      JSON.stringify(file.generatedMetadata),
      JSON.stringify(file.preflight),
      now,
      relativePath,
    );
    touchJob(db, now);
    const updated = db.prepare("SELECT * FROM files WHERE relative_path = ?").get(relativePath);
    if (!updated)
      throw new CliError(`Bulk row disappeared during materialization: ${relativePath}`);
    return rowToBulkFile(updated);
  } finally {
    db.close();
  }
}

async function markBulkFileFailed(
  statePath: string,
  relativePath: string,
  error: string,
): Promise<void> {
  const db = await openSqlite(statePath);
  const now = new Date().toISOString();
  try {
    createBulkSchema(db);
    db.prepare(
      "UPDATE files SET status = 'failed', last_error = ?, updated_at = ? WHERE relative_path = ?",
    ).run(error, now, relativePath);
    touchJob(db, now);
  } finally {
    db.close();
  }
}

async function markBulkFileSkipped(
  statePath: string,
  relativePath: string,
  reason: string,
): Promise<void> {
  const db = await openSqlite(statePath);
  const now = new Date().toISOString();
  try {
    createBulkSchema(db);
    db.prepare(
      "UPDATE files SET status = 'skipped', last_error = ?, updated_at = ? WHERE relative_path = ?",
    ).run(reason, now, relativePath);
    touchJob(db, now);
  } finally {
    db.close();
  }
}

async function pollBulkStatuses(statePath: string, config: KbConfig): Promise<void> {
  const inflight = await readInflightBulkFiles(statePath);
  const documentIds = inflight.map((row) => row.documentId).filter(Boolean) as string[];
  if (documentIds.length === 0) return;

  const statuses = await batchDocumentStatuses(config, documentIds);
  const byId = new Map(statuses.map((item) => [item.documentId, item]));
  const now = new Date().toISOString();
  const db = await openSqlite(statePath);
  try {
    const update = db.prepare(
      "UPDATE files SET status = ?, last_error = ?, updated_at = ? WHERE document_id = ?",
    );
    for (const id of documentIds) {
      const item = byId.get(id);
      if (!item) continue;
      const judged = judgeBulkStatus(item);
      update.run(judged.status, judged.lastError ?? null, now, id);
    }
    touchJob(db, now);
  } finally {
    db.close();
  }
}

function judgeBulkStatus(item: BulkStatusItem): { status: string; lastError?: string } {
  if (item.itemError) {
    const message = `${item.itemError.code}: ${item.itemError.message}`;
    return item.itemError.retryable
      ? { status: "uploaded", lastError: message }
      : { status: "failed", lastError: message };
  }

  const status = item.status ?? "";
  if (BULK_FAILED_STATUSES.has(status)) {
    return {
      status: "failed",
      lastError: item.lastError ?? item.lastErrorStage ?? `Remote status is ${status}`,
    };
  }
  if (status === "completed") {
    if (item.opensearchIndexed === true && item.pineconeIndexed === true) {
      return { status: "completed" };
    }
    return {
      status: "waiting_for_index_flags",
      lastError:
        item.opensearchIndexed === undefined || item.pineconeIndexed === undefined
          ? "Status API returned completed without opensearchIndexed/pineconeIndexed flags."
          : "Document completed but index flags are not both true.",
    };
  }
  if (item.terminal === true && status && !BULK_FAILED_STATUSES.has(status)) {
    return {
      status: "waiting_for_index_flags",
      lastError: `Terminal status ${status} has no index flags.`,
    };
  }
  return { status: "uploaded" };
}

async function batchDocumentStatuses(
  config: KbConfig,
  documentIds: string[],
): Promise<BulkStatusItem[]> {
  try {
    const payload = await jsonRequest(config, "documents/status:batch", {
      method: "POST",
      body: JSON.stringify({ documentIds }),
    });
    return batchStatusItems(payload);
  } catch (error) {
    if (error instanceof HttpError && error.status && [404, 405, 501].includes(error.status)) {
      return Promise.all(
        documentIds.map(async (documentId) =>
          statusItemFromPayload(await getDocumentStatus(config, documentId), documentId),
        ),
      );
    }
    throw error;
  }
}

async function getDocumentStatus(config: KbConfig, documentId: string): Promise<unknown> {
  return jsonRequest(config, `documents/${encodeURIComponent(documentId)}/status`);
}

function batchStatusItems(payload: unknown): BulkStatusItem[] {
  const data = responseData(payload);
  const items =
    isObject(data) && Array.isArray(data.documents)
      ? data.documents
      : isObject(data) && Array.isArray(data.results)
        ? data.results
        : Array.isArray(data)
          ? data
          : [];
  return items.filter(isObject).map((item) => batchStatusItemFromPayload(item));
}

function statusItemFromPayload(payload: unknown, fallbackDocumentId = ""): BulkStatusItem {
  const data = responseData(payload);
  const item = isObject(data) ? data : {};
  return {
    documentId:
      stringField(item, "documentId") ?? stringField(item, "document_id") ?? fallbackDocumentId,
    status: stringField(item, "status"),
    terminal: typeof item.terminal === "boolean" ? item.terminal : undefined,
    opensearchIndexed:
      typeof item.opensearchIndexed === "boolean" ? item.opensearchIndexed : undefined,
    pineconeIndexed: typeof item.pineconeIndexed === "boolean" ? item.pineconeIndexed : undefined,
    indexRecordCount: typeof item.indexRecordCount === "number" ? item.indexRecordCount : undefined,
    lastError: typeof item.lastError === "string" ? item.lastError : undefined,
    lastErrorStage: typeof item.lastErrorStage === "string" ? item.lastErrorStage : undefined,
    raw: payload,
  };
}

async function readBulkPipelineHealth(
  config: KbConfig,
  fallbackPollAfterSeconds: number,
): Promise<BulkPipelineHealthSnapshot> {
  try {
    const payload = await jsonRequest(config, "pipeline/health");
    return pipelineHealthFromPayload(payload, fallbackPollAfterSeconds);
  } catch (error) {
    if (error instanceof HttpError && error.status && [404, 405, 501].includes(error.status)) {
      return {
        healthy: true,
        pressure: "unknown",
        recommendedAction: "continue",
        recommendedPollAfterSeconds: fallbackPollAfterSeconds,
        message: "Pipeline health endpoint is unavailable; continuing without backpressure.",
      };
    }
    if (error instanceof HttpError) {
      return {
        healthy: false,
        pressure: "paused",
        recommendedAction: "pause_top_up",
        recommendedPollAfterSeconds:
          error.retryAfterSeconds ?? Math.max(fallbackPollAfterSeconds, 30),
        message: error.message,
      };
    }
    return {
      healthy: false,
      pressure: "paused",
      recommendedAction: "pause_top_up",
      recommendedPollAfterSeconds: Math.max(fallbackPollAfterSeconds, 30),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function pipelineHealthFromPayload(
  payload: unknown,
  fallbackPollAfterSeconds: number,
): BulkPipelineHealthSnapshot {
  const data = responseData(payload);
  if (!isObject(data)) {
    throw new CliError("Pipeline health response did not contain an object payload.");
  }
  const action = stringField(data, "recommendedAction");
  if (action !== "continue" && action !== "slow_down" && action !== "pause_top_up") {
    throw new CliError("Pipeline health response did not contain a valid recommendedAction.");
  }
  const pressure = stringField(data, "pressure");
  const pollAfter = Number(data.recommendedPollAfterSeconds);
  return {
    healthy: typeof data.healthy === "boolean" ? data.healthy : action === "continue",
    pressure:
      pressure === "ok" || pressure === "degraded" || pressure === "paused" ? pressure : "unknown",
    recommendedAction: action,
    recommendedPollAfterSeconds:
      Number.isFinite(pollAfter) && pollAfter > 0 ? pollAfter : fallbackPollAfterSeconds,
    checkedAt: stringField(data, "checkedAt"),
    message:
      stringField(data, "message") ??
      (isObject(data.indexPreflight) ? stringField(data.indexPreflight, "message") : undefined),
  };
}

async function saveBulkPipelineHealth(
  statePath: string,
  health: BulkPipelineHealthSnapshot,
): Promise<void> {
  const db = await openSqlite(statePath);
  const now = new Date().toISOString();
  try {
    createBulkSchema(db);
    db.prepare("UPDATE jobs SET pipeline_health_json = ?, updated_at = ?").run(
      JSON.stringify(health),
      now,
    );
  } finally {
    db.close();
  }
}

function batchStatusItemFromPayload(item: Record<string, unknown>): BulkStatusItem {
  const documentId = stringField(item, "documentId") ?? stringField(item, "document_id") ?? "";
  if (item.ok === true && isObject(item.status)) {
    return statusItemFromPayload(item.status, documentId);
  }
  if (item.ok === false && isObject(item.error)) {
    const error = item.error;
    return {
      documentId,
      itemError: {
        code: stringField(error, "code") ?? "STATUS_ITEM_ERROR",
        message: stringField(error, "message") ?? "Document status lookup failed.",
        retryable: typeof error.retryable === "boolean" ? error.retryable : false,
      },
      raw: item,
    };
  }
  return statusItemFromPayload(item, documentId);
}

async function initializeBulkJob(input: {
  statePath: string;
  jobId: string;
  rootPath: string;
  selector: CollectionSelector;
  schemaSnapshot: unknown;
  metadataMap: MetadataMap;
  dryRunSummary: MetadataDryRunSummary;
  files: BulkFilePlan[];
}): Promise<void> {
  await mkdir(dirname(input.statePath), { recursive: true });
  const db = await openSqlite(input.statePath);
  const now = new Date().toISOString();
  try {
    createBulkSchema(db);
    const existing = db.prepare("SELECT job_id FROM jobs LIMIT 1").get();
    if (!existing) {
      db.prepare(
        `INSERT INTO jobs (job_id, root_path, collection_selector_json, schema_snapshot_json, metadata_map_json, dry_run_summary_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
      ).run(
        input.jobId,
        input.rootPath,
        JSON.stringify(input.selector),
        JSON.stringify(input.schemaSnapshot ?? null),
        JSON.stringify(input.metadataMap),
        JSON.stringify(input.dryRunSummary),
        now,
        now,
      );
    }

    for (const file of input.files) {
      const status = bulkInitialStatus(file);
      insertBulkFilePlan(db, input.metadataMap, file, status, now);
    }
    touchJob(db, now);
  } finally {
    db.close();
  }
}

async function openSqlite(path: string): Promise<SqlDatabase> {
  const moduleName = "node:sqlite";
  const sqlite = (await import(moduleName)) as {
    DatabaseSync: new (path: string) => SqlDatabase;
  };
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}

function insertBulkFilePlan(
  db: SqlDatabase,
  metadataMap: MetadataMap,
  file: BulkFilePlan,
  status: string,
  now: string,
): void {
  const evaluated = evaluateMetadata(metadataMap, file);
  db.prepare(
    `INSERT OR IGNORE INTO files
     (path, relative_path, size, mtime_ms, sha256, ext, path_segments_json, path_depth, metadata_json, matched_rules_json, status, attempts, created_at, updated_at,
      original_path, original_relative_path, original_size, original_mtime_ms, original_sha256, original_ext, classification, ingest_variant, source_document_key,
      derived_path, derived_size, derived_sha256, normalize_strategy, part_index, part_count, page_start, page_end, generated_metadata_json, preflight_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    file.path,
    file.relativePath,
    file.size,
    file.mtimeMs,
    file.sha256,
    file.ext,
    JSON.stringify(file.pathSegments),
    file.pathDepth,
    JSON.stringify(evaluated.metadata),
    JSON.stringify(evaluated.matchedRules),
    status,
    now,
    now,
    file.originalPath,
    file.originalRelativePath,
    file.originalSize,
    file.originalMtimeMs,
    file.originalSha256,
    file.originalExt,
    file.classification,
    file.ingestVariant,
    file.sourceDocumentKey,
    file.derivedPath ?? null,
    file.derivedSize ?? null,
    file.derivedSha256 ?? null,
    file.normalizeStrategy ?? null,
    file.partIndex ?? null,
    file.partCount ?? null,
    file.pageStart ?? null,
    file.pageEnd ?? null,
    JSON.stringify(file.generatedMetadata),
    JSON.stringify(file.preflight),
  );
}

function createBulkSchema(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL,
      collection_selector_json TEXT NOT NULL,
      schema_snapshot_json TEXT,
      metadata_map_json TEXT NOT NULL,
      dry_run_summary_json TEXT,
      pipeline_health_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      relative_path TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      sha256 TEXT NOT NULL,
      ext TEXT NOT NULL,
      path_segments_json TEXT NOT NULL,
      path_depth INTEGER NOT NULL,
      metadata_json TEXT NOT NULL,
      matched_rules_json TEXT NOT NULL,
      status TEXT NOT NULL,
      document_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      original_path TEXT,
      original_relative_path TEXT,
      original_size INTEGER,
      original_mtime_ms REAL,
      original_sha256 TEXT,
      original_ext TEXT,
      classification TEXT,
      ingest_variant TEXT,
      source_document_key TEXT,
      derived_path TEXT,
      derived_size INTEGER,
      derived_sha256 TEXT,
      normalize_strategy TEXT,
      part_index INTEGER,
      part_count INTEGER,
      page_start INTEGER,
      page_end INTEGER,
      generated_metadata_json TEXT,
      preflight_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
    CREATE INDEX IF NOT EXISTS idx_files_document_id ON files(document_id);
  `);
  ensureBulkJobColumns(db);
  ensureBulkFileColumns(db);
}

function ensureBulkJobColumns(db: SqlDatabase): void {
  const rows = db.prepare("PRAGMA table_info(jobs)").all();
  const columns = new Set(rows.map((row) => String(row.name)));
  if (!columns.has("pipeline_health_json")) {
    db.exec("ALTER TABLE jobs ADD COLUMN pipeline_health_json TEXT;");
  }
}

function ensureBulkFileColumns(db: SqlDatabase): void {
  const rows = db.prepare("PRAGMA table_info(files)").all();
  const columns = new Set(rows.map((row) => String(row.name)));
  const additions: Array<[string, string]> = [
    ["original_path", "TEXT"],
    ["original_relative_path", "TEXT"],
    ["original_size", "INTEGER"],
    ["original_mtime_ms", "REAL"],
    ["original_sha256", "TEXT"],
    ["original_ext", "TEXT"],
    ["classification", "TEXT"],
    ["ingest_variant", "TEXT"],
    ["source_document_key", "TEXT"],
    ["derived_path", "TEXT"],
    ["derived_size", "INTEGER"],
    ["derived_sha256", "TEXT"],
    ["normalize_strategy", "TEXT"],
    ["part_index", "INTEGER"],
    ["part_count", "INTEGER"],
    ["page_start", "INTEGER"],
    ["page_end", "INTEGER"],
    ["generated_metadata_json", "TEXT"],
    ["preflight_json", "TEXT"],
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE files ADD COLUMN ${name} ${type};`);
  }
}

async function readBulkJob(statePath: string): Promise<BulkJobRecord> {
  const db = await openSqlite(statePath);
  try {
    createBulkSchema(db);
    const row = db.prepare("SELECT * FROM jobs LIMIT 1").get();
    if (!row) throw new CliError(`Bulk state has no job record: ${statePath}`);
    return {
      jobId: String(row.job_id),
      rootPath: String(row.root_path),
      statePath,
      status: String(row.status),
      collectionSelector: JSON.parse(String(row.collection_selector_json)) as CollectionSelector,
      schemaSnapshot: row.schema_snapshot_json
        ? JSON.parse(String(row.schema_snapshot_json))
        : undefined,
      metadataMap: JSON.parse(String(row.metadata_map_json)) as MetadataMap,
      dryRunSummary: row.dry_run_summary_json
        ? (JSON.parse(String(row.dry_run_summary_json)) as MetadataDryRunSummary)
        : undefined,
      pipelineHealth: row.pipeline_health_json
        ? (JSON.parse(String(row.pipeline_health_json)) as BulkPipelineHealthSnapshot)
        : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  } finally {
    db.close();
  }
}

async function bulkJobSummary(statePath: string): Promise<{
  total: number;
  pending: number;
  inflight: number;
  completed: number;
  failed: number;
  waitingForIndexFlags: number;
  skipped: number;
  blocked: number;
}> {
  const db = await openSqlite(statePath);
  try {
    createBulkSchema(db);
    const rows = db.prepare("SELECT status, COUNT(*) AS count FROM files GROUP BY status").all();
    const counts = new Map(rows.map((row) => [String(row.status), Number(row.count)]));
    const inflight = [...BULK_IN_FLIGHT_STATUSES].reduce(
      (sum, status) => sum + (counts.get(status) ?? 0),
      0,
    );
    const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
    return {
      total,
      pending: counts.get("pending") ?? 0,
      inflight,
      completed: counts.get("completed") ?? 0,
      failed: counts.get("failed") ?? 0,
      waitingForIndexFlags: counts.get("waiting_for_index_flags") ?? 0,
      skipped: counts.get("skipped") ?? 0,
      blocked: counts.get("blocked") ?? 0,
    };
  } finally {
    db.close();
  }
}

async function readBulkFiles(statePath: string): Promise<BulkFileRecord[]> {
  const db = await openSqlite(statePath);
  try {
    createBulkSchema(db);
    return db.prepare("SELECT * FROM files ORDER BY relative_path").all().map(rowToBulkFile);
  } finally {
    db.close();
  }
}

async function readInflightBulkFiles(statePath: string): Promise<BulkFileRecord[]> {
  const db = await openSqlite(statePath);
  try {
    createBulkSchema(db);
    return db
      .prepare(
        "SELECT * FROM files WHERE status IN ('uploaded', 'waiting_for_index_flags', 'uploading') AND document_id IS NOT NULL",
      )
      .all()
      .map(rowToBulkFile);
  } finally {
    db.close();
  }
}

async function claimPendingBulkFiles(statePath: string, limit: number): Promise<BulkFileRecord[]> {
  const db = await openSqlite(statePath);
  const now = new Date().toISOString();
  try {
    createBulkSchema(db);
    const rows = db
      .prepare("SELECT * FROM files WHERE status = 'pending' ORDER BY relative_path LIMIT ?")
      .all(limit)
      .map(rowToBulkFile);
    const update = db.prepare(
      "UPDATE files SET status = 'uploading', updated_at = ? WHERE relative_path = ?",
    );
    for (const row of rows) update.run(now, row.relativePath);
    touchJob(db, now);
    return rows;
  } finally {
    db.close();
  }
}

async function saveBulkUploadResult(
  statePath: string,
  relativePath: string,
  result: UploadResult,
): Promise<void> {
  const db = await openSqlite(statePath);
  const now = new Date().toISOString();
  try {
    const status = result.status === "succeeded" ? "uploaded" : "failed";
    db.prepare(
      "UPDATE files SET status = ?, document_id = ?, attempts = ?, last_error = ?, updated_at = ? WHERE relative_path = ?",
    ).run(
      status,
      result.documentId ?? result.existingDocumentId ?? null,
      result.attempts ?? 0,
      result.error ?? null,
      now,
      relativePath,
    );
    touchJob(db, now);
  } finally {
    db.close();
  }
}

async function resetInterruptedBulkUploads(statePath: string): Promise<void> {
  const db = await openSqlite(statePath);
  const now = new Date().toISOString();
  try {
    createBulkSchema(db);
    db.prepare(
      "UPDATE files SET status = 'pending', last_error = ?, updated_at = ? WHERE status IN ('uploading', 'planned') AND document_id IS NULL",
    ).run("Upload was interrupted before a document id was recorded.", now);
    touchJob(db, now);
  } finally {
    db.close();
  }
}

async function updateJobStatus(statePath: string, status: string): Promise<void> {
  const db = await openSqlite(statePath);
  try {
    db.prepare("UPDATE jobs SET status = ?, updated_at = ?").run(status, new Date().toISOString());
  } finally {
    db.close();
  }
}

function touchJob(db: SqlDatabase, now: string): void {
  db.prepare("UPDATE jobs SET updated_at = ?").run(now);
}

function rowToBulkFile(row: Record<string, unknown>): BulkFileRecord {
  const originalRelativePath = row.original_relative_path
    ? String(row.original_relative_path)
    : String(row.relative_path);
  const originalSha256 = row.original_sha256 ? String(row.original_sha256) : String(row.sha256);
  return {
    path: String(row.path),
    relativePath: String(row.relative_path),
    size: Number(row.size),
    mtimeMs: Number(row.mtime_ms),
    sha256: String(row.sha256),
    ext: String(row.ext),
    pathSegments: JSON.parse(String(row.path_segments_json)) as string[],
    pathDepth: Number(row.path_depth),
    metadataJson: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
    matchedRules: JSON.parse(String(row.matched_rules_json)) as string[],
    status: String(row.status),
    documentId: row.document_id ? String(row.document_id) : undefined,
    attempts: Number(row.attempts),
    lastError: row.last_error ? String(row.last_error) : undefined,
    originalPath: row.original_path ? String(row.original_path) : String(row.path),
    originalRelativePath,
    originalSize: row.original_size ? Number(row.original_size) : Number(row.size),
    originalMtimeMs: row.original_mtime_ms ? Number(row.original_mtime_ms) : Number(row.mtime_ms),
    originalSha256,
    originalExt: row.original_ext ? String(row.original_ext) : String(row.ext),
    classification: (row.classification
      ? String(row.classification)
      : "direct_upload") as BulkPreflightClassification,
    ingestVariant: (row.ingest_variant
      ? String(row.ingest_variant)
      : "direct_upload") as BulkIngestVariant,
    sourceDocumentKey: row.source_document_key
      ? String(row.source_document_key)
      : `sha256:${originalSha256}`,
    normalizeStrategy: row.normalize_strategy ? String(row.normalize_strategy) : undefined,
    derivedPath: row.derived_path ? String(row.derived_path) : undefined,
    derivedSize: row.derived_size ? Number(row.derived_size) : undefined,
    derivedSha256: row.derived_sha256 ? String(row.derived_sha256) : undefined,
    partIndex: row.part_index ? Number(row.part_index) : undefined,
    partCount: row.part_count ? Number(row.part_count) : undefined,
    pageStart: row.page_start ? Number(row.page_start) : undefined,
    pageEnd: row.page_end ? Number(row.page_end) : undefined,
    generatedMetadata: row.generated_metadata_json
      ? (JSON.parse(String(row.generated_metadata_json)) as Record<string, unknown>)
      : {},
    preflight: row.preflight_json
      ? (JSON.parse(String(row.preflight_json)) as Record<string, unknown>)
      : {},
  };
}

function bulkRecordToOriginalPlan(row: BulkFileRecord): BulkFilePlan {
  const pathSegments = row.originalRelativePath.split("/").filter(Boolean);
  return {
    path: row.originalPath,
    filename: basename(row.originalPath),
    size: row.originalSize,
    mtimeMs: row.originalMtimeMs,
    sha256: row.originalSha256,
    uploadKey: row.originalRelativePath,
    relativePath: row.originalRelativePath,
    ext: row.originalExt,
    pathSegments,
    pathDepth: pathSegments.length,
    originalPath: row.originalPath,
    originalRelativePath: row.originalRelativePath,
    originalSize: row.originalSize,
    originalMtimeMs: row.originalMtimeMs,
    originalSha256: row.originalSha256,
    originalExt: row.originalExt,
    classification: row.classification,
    ingestVariant: row.ingestVariant,
    sourceDocumentKey: row.sourceDocumentKey,
    generatedMetadata: row.generatedMetadata,
    preflight: row.preflight,
  };
}

async function resolveBulkStatePath(args: ParsedArgs, jobIdInput?: string): Promise<string> {
  const explicit = getString(args, "state");
  if (explicit) return resolve(explicit);
  const jobId =
    jobIdInput ??
    `kb-bulk-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  return join(appJobsDir(), `${jobId}.sqlite`);
}

async function resolveExistingJobStatePath(
  jobId: string,
  args: ParsedArgs,
): Promise<string | undefined> {
  const explicit = getString(args, "state");
  if (explicit) {
    const path = resolve(explicit);
    return (await stat(path).catch(() => undefined))?.isFile() ? path : undefined;
  }
  const direct = resolve(jobId);
  if ((await stat(direct).catch(() => undefined))?.isFile()) return direct;
  const defaultPath = join(appJobsDir(), jobId.endsWith(".sqlite") ? jobId : `${jobId}.sqlite`);
  return (await stat(defaultPath).catch(() => undefined))?.isFile() ? defaultPath : undefined;
}

function appJobsDir(): string {
  const system = platform();
  if (system === "darwin") {
    return join(homedir(), "Library", "Application Support", "tiangong-ai", "kb-ingest", "jobs");
  }
  if (system === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "tiangong-ai",
      "kb-ingest",
      "jobs",
    );
  }
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "tiangong-ai",
    "kb-ingest",
    "jobs",
  );
}

function jobIdFromStatePath(statePath: string): string {
  return basename(statePath).replace(/\.sqlite$/i, "");
}

async function collectBulkFilePlans(
  root: string,
  recursive: boolean,
  args?: ParsedArgs,
): Promise<BulkFilePlan[]> {
  const item = await stat(root).catch(() => undefined);
  if (!item) throw new CliError(`Path not found: ${root}`);

  const relativeRoot = item.isFile() ? dirname(root) : root;
  const files = item.isFile()
    ? [root]
    : await collectFiles(root, recursive, {
        excludeDirectories: bulkScanExcludeDirs(root, args),
      });
  return Promise.all(files.map((file) => fingerprintBulkFile(relativeRoot, file)));
}

function bulkScanExcludeDirs(root: string, args?: ParsedArgs): Set<string> {
  const excludeDirectories = new Set([resolve(root, DEFAULT_BULK_DERIVED_DIR)]);
  const workDir = args ? getString(args, "work-dir") : undefined;
  if (workDir) excludeDirectories.add(resolve(workDir));
  return excludeDirectories;
}

async function fingerprintBulkFile(root: string, path: string): Promise<BulkFilePlan> {
  const plan = await fingerprintFile(path);
  const relativePath = relative(root, path).split(sep).join("/");
  const pathSegments = relativePath.split("/").filter(Boolean);
  const ext = extname(path).toLowerCase();
  const sourceDocumentKey = `sha256:${plan.sha256}`;
  return {
    ...plan,
    relativePath,
    ext,
    pathSegments,
    pathDepth: pathSegments.length,
    originalPath: path,
    originalRelativePath: relativePath,
    originalSize: plan.size,
    originalMtimeMs: plan.mtimeMs,
    originalSha256: plan.sha256,
    originalExt: ext,
    classification: "direct_upload",
    ingestVariant: "direct_upload",
    sourceDocumentKey,
    generatedMetadata: generatedPreflightMetadata({
      classification: "direct_upload",
      ingestVariant: "direct_upload",
      sourceDocumentKey,
      originalPath: path,
      originalRelativePath: relativePath,
      originalSize: plan.size,
      originalSha256: plan.sha256,
      originalExt: ext,
    }),
    preflight: {},
  };
}

async function prepareBulkPreflightPlans(
  files: BulkFilePlan[],
  options: BulkPreflightOptions,
): Promise<{ allPlans: BulkFilePlan[]; uploadPlans: BulkFilePlan[]; maxUploadBytes: number }> {
  const allPlans: BulkFilePlan[] = [];
  for (const file of files) {
    allPlans.push(...(await preflightOneBulkFile(file, options)));
  }
  return {
    allPlans,
    uploadPlans: allPlans.filter((plan) => bulkInitialStatus(plan) === "pending"),
    maxUploadBytes: options.maxUploadBytes,
  };
}

async function preflightOneBulkFile(
  file: BulkFilePlan,
  options: BulkPreflightOptions,
): Promise<BulkFilePlan[]> {
  if (file.size === 0) {
    return [decorateBulkPlan(file, "empty", "skipped", { reason: "empty_file" })];
  }
  if (!BULK_SUPPORTED_EXTENSIONS.has(file.ext)) {
    return [
      decorateBulkPlan(file, "unsupported", "skipped", {
        reason: "unsupported_extension",
        ext: file.ext,
      }),
    ];
  }

  if (file.ext === ".docx") {
    const docx = await analyzeDocx(file.path).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    if (isEmptyDocxAnalysis(docx)) {
      return [
        decorateBulkPlan(file, "empty", "skipped", {
          ...docx,
          reason: "empty_docx",
          maxUploadBytes: options.maxUploadBytes,
        }),
      ];
    }
    if (file.size <= DOCX_NORMALIZE_MIN_BYTES) {
      return [
        decorateBulkPlan(file, "direct_upload", "direct_upload", {
          ...docx,
          maxUploadBytes: options.maxUploadBytes,
          normalizeThresholdBytes: DOCX_NORMALIZE_MIN_BYTES,
        }),
      ];
    }
    const classification =
      file.size > options.maxUploadBytes ? "oversize_docx_image_heavy" : "direct_upload";
    if (!options.generateDerived) {
      return [
        decorateBulkPlan(file, classification, "compressed_docx", {
          ...docx,
          maxUploadBytes: options.maxUploadBytes,
          normalizeThresholdBytes: DOCX_NORMALIZE_MIN_BYTES,
          normalizeStrategy: "docx_image_300dpi_normalize",
        }),
      ];
    }
    const derived = await createDocxIngestCopy(
      file,
      options,
      docx as Record<string, unknown>,
      classification,
    );
    return [derived];
  }

  if (file.size <= options.maxUploadBytes) {
    return [
      decorateBulkPlan(file, "direct_upload", "direct_upload", {
        maxUploadBytes: options.maxUploadBytes,
      }),
    ];
  }

  if (file.ext === ".pdf") {
    const pdf = await analyzePdf(file.path).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
      pageCount: 0,
      imageCount: 0,
      imageHeavy: false,
    }));
    const pageCount = isObject(pdf) && typeof pdf.pageCount === "number" ? pdf.pageCount : 0;
    const classification =
      pageCount > 0
        ? isObject(pdf) && pdf.imageHeavy === true
          ? "oversize_scanned_pdf"
          : "oversize_text_pdf"
        : "oversize_unknown";
    if (classification === "oversize_unknown") {
      return [
        decorateBulkPlan(file, "oversize_unknown", "skipped", {
          ...pdf,
          maxUploadBytes: options.maxUploadBytes,
        }),
      ];
    }
    if (!options.generateDerived) {
      return [
        decorateBulkPlan(file, classification, "page_split_pdf", {
          ...pdf,
          maxUploadBytes: options.maxUploadBytes,
        }),
      ];
    }
    try {
      return await createPdfPartPlans(file, options, pdf as PdfAnalysis, classification);
    } catch (error) {
      return [
        decorateBulkPlan(file, classification, "skipped", {
          ...pdf,
          reason: "pdf_split_failed",
          error: error instanceof Error ? error.message : String(error),
          maxUploadBytes: options.maxUploadBytes,
        }),
      ];
    }
  }

  return [
    decorateBulkPlan(file, "oversize_unknown", "skipped", {
      reason: "oversize_without_normalizer",
      maxUploadBytes: options.maxUploadBytes,
    }),
  ];
}

function decorateBulkPlan(
  file: BulkFilePlan,
  classification: BulkPreflightClassification,
  ingestVariant: BulkIngestVariant,
  preflight: Record<string, unknown>,
  overrides: Partial<BulkFilePlan> = {},
): BulkFilePlan {
  const originalRelativePath = overrides.originalRelativePath ?? file.originalRelativePath;
  const originalSha256 = overrides.originalSha256 ?? file.originalSha256;
  const sourceDocumentKey = overrides.sourceDocumentKey ?? `sha256:${originalSha256}`;
  const next: BulkFilePlan = {
    ...file,
    ...overrides,
    classification,
    ingestVariant,
    sourceDocumentKey,
    preflight,
  };
  next.generatedMetadata = {
    ...generatedPreflightMetadata({
      classification,
      ingestVariant,
      sourceDocumentKey,
      originalPath: next.originalPath,
      originalRelativePath,
      originalSize: next.originalSize,
      originalSha256,
      originalExt: next.originalExt,
      derivedPath: next.derivedPath,
      derivedSize: next.derivedSize,
      derivedSha256: next.derivedSha256,
      normalizeStrategy: next.normalizeStrategy,
      partIndex: next.partIndex,
      partCount: next.partCount,
      pageStart: next.pageStart,
      pageEnd: next.pageEnd,
      imageHeavy:
        classification === "oversize_docx_image_heavy" || classification === "oversize_scanned_pdf",
    }),
  };
  return next;
}

function generatedPreflightMetadata(input: {
  classification: BulkPreflightClassification;
  ingestVariant: BulkIngestVariant;
  sourceDocumentKey: string;
  originalPath: string;
  originalRelativePath: string;
  originalSize: number;
  originalSha256: string;
  originalExt: string;
  derivedPath?: string | undefined;
  derivedSize?: number | undefined;
  derivedSha256?: string | undefined;
  normalizeStrategy?: string | undefined;
  partIndex?: number | undefined;
  partCount?: number | undefined;
  pageStart?: number | undefined;
  pageEnd?: number | undefined;
  imageHeavy?: boolean | undefined;
}): Record<string, unknown> {
  return removeUndefined({
    ingest_variant: input.ingestVariant,
    preflight_classification: input.classification,
    source_document_key: input.sourceDocumentKey,
    source_original_path: input.originalRelativePath,
    source_original_abspath: input.originalPath,
    source_original_size: input.originalSize,
    source_original_sha256: input.originalSha256,
    source_original_ext: input.originalExt,
    source_derived_path: input.derivedPath,
    source_derived_size: input.derivedSize,
    source_derived_sha256: input.derivedSha256,
    normalize_strategy: input.normalizeStrategy,
    source_part_index: input.partIndex,
    source_part_count: input.partCount,
    source_page_start: input.pageStart,
    source_page_end: input.pageEnd,
    image_heavy: input.imageHeavy,
  });
}

function bulkInitialStatus(file: BulkFilePlan): string {
  if (file.classification === "empty") return "skipped";
  if (file.classification === "unsupported") return "skipped";
  if (file.ingestVariant === "skipped") return "blocked";
  if (file.ingestVariant === "compressed_docx" && file.derivedSize === undefined) return "pending";
  if (file.ingestVariant === "page_split_pdf" && file.derivedSize === undefined) return "pending";
  if (file.ingestVariant === "compressed_docx") {
    if (file.derivedSize !== undefined && file.derivedSize <= Number(file.preflight.maxUploadBytes))
      return "pending";
    return "blocked";
  }
  if (file.size > 0 && file.size <= Number(file.preflight.maxUploadBytes ?? Infinity))
    return "pending";
  if (file.derivedSize !== undefined && file.derivedSize <= Number(file.preflight.maxUploadBytes))
    return "pending";
  return "blocked";
}

function buildPreflightSummary(
  plans: BulkFilePlan[],
  maxUploadBytes: number,
): BulkPreflightSummary {
  const classificationCounts = emptyClassificationCounts();
  const originalPlans = new Map<string, BulkFilePlan>();
  let uploadFileCount = 0;
  let generatedVariantCount = 0;
  let blockedCount = 0;
  let directUploads = 0;
  let normalizedDocx = 0;
  let splitPdfParts = 0;
  for (const plan of plans) {
    if (!originalPlans.has(plan.originalRelativePath))
      originalPlans.set(plan.originalRelativePath, plan);
    const status = bulkInitialStatus(plan);
    if (status === "pending") uploadFileCount += 1;
    if (status === "blocked") blockedCount += 1;
    if (plan.ingestVariant !== "direct_upload" && plan.ingestVariant !== "skipped")
      generatedVariantCount += 1;
    if (plan.ingestVariant === "direct_upload" && status === "pending") directUploads += 1;
    if (plan.ingestVariant === "compressed_docx") normalizedDocx += 1;
    if (plan.ingestVariant === "page_split_pdf") splitPdfParts += 1;
  }
  for (const plan of originalPlans.values()) {
    classificationCounts[plan.classification] += 1;
  }
  return {
    maxUploadBytes,
    totalFiles: originalPlans.size,
    uploadFileCount,
    classificationCounts,
    categoryCounts: {
      direct: classificationCounts.direct_upload,
      unsupported: classificationCounts.unsupported,
      empty: classificationCounts.empty,
      oversize:
        classificationCounts.oversize_docx_image_heavy +
        classificationCounts.oversize_scanned_pdf +
        classificationCounts.oversize_text_pdf +
        classificationCounts.oversize_unknown,
      imageHeavy:
        classificationCounts.oversize_docx_image_heavy + classificationCounts.oversize_scanned_pdf,
    },
    planned: {
      directUploads,
      normalizedDocx,
      splitPdfParts,
      blocked: blockedCount,
    },
    generatedVariantCount,
    blockedCount,
    samples: plans.slice(0, 50).map(
      (plan) =>
        removeUndefined({
          path: plan.originalRelativePath,
          classification: plan.classification,
          ingestVariant: plan.ingestVariant,
          size: plan.originalSize,
          derivedSize: plan.derivedSize,
          partIndex: plan.partIndex,
          partCount: plan.partCount,
          pageStart: plan.pageStart,
          pageEnd: plan.pageEnd,
        }) as BulkPreflightSummary["samples"][number],
    ),
  };
}

function emptyClassificationCounts(): Record<BulkPreflightClassification, number> {
  return {
    direct_upload: 0,
    unsupported: 0,
    empty: 0,
    oversize_docx_image_heavy: 0,
    oversize_scanned_pdf: 0,
    oversize_text_pdf: 0,
    oversize_unknown: 0,
  };
}

function preflightOptionsFromArgs(
  args: ParsedArgs,
  schemaSnapshot: unknown,
  root: string,
  generateDerived: boolean,
): BulkPreflightOptions {
  const maxUploadBytes =
    getPositiveInteger(args, "max-upload-bytes", 0) ||
    getPositiveInteger(args, "target-bytes", 0) ||
    collectionMaxUploadBytes(schemaSnapshot) ||
    DEFAULT_BULK_MAX_UPLOAD_BYTES;
  const workDir = resolve(getString(args, "work-dir") ?? join(root, DEFAULT_BULK_DERIVED_DIR));
  return { maxUploadBytes, workDir, generateDerived };
}

function collectionMaxUploadBytes(schemaSnapshot: unknown): number | undefined {
  const data = responseData(schemaSnapshot);
  const candidates: unknown[] = [];
  if (isObject(data)) {
    candidates.push(data.maxUploadBytes, data.max_upload_bytes);
    if (isObject(data.collection)) {
      candidates.push(data.collection.maxUploadBytes, data.collection.max_upload_bytes);
    }
    if (isObject(data.upload)) {
      candidates.push(data.upload.maxUploadBytes, data.upload.max_upload_bytes);
    }
  }
  if (isObject(schemaSnapshot)) {
    candidates.push(schemaSnapshot.maxUploadBytes, schemaSnapshot.max_upload_bytes);
  }
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

async function analyzeDocx(path: string): Promise<Record<string, unknown>> {
  const entries = readZipEntries(await readFile(path));
  const media = entries.filter(
    (entry) => entry.name.startsWith("word/media/") && !entry.name.endsWith("/"),
  );
  const mediaSizes = media.map((entry) => entry.uncompressedSize);
  const documentXml = zipEntryText(entries, "word/document.xml") ?? "";
  const bodyText = extractDocxBodyText(documentXml);
  const appXml = zipEntryText(entries, "docProps/app.xml") ?? "";
  return {
    mediaCount: media.length,
    mediaTotalBytes: mediaSizes.reduce((sum, size) => sum + size, 0),
    mediaMaxBytes: mediaSizes.reduce((max, size) => Math.max(max, size), 0),
    textCharacterCount: bodyText.length,
    paragraphCount: countRegex(documentXml, /<w:p(?:\s|>)/g),
    drawingCount: countRegex(documentXml, /<w:drawing(?:\s|>)/g),
    pictCount: countRegex(documentXml, /<w:pict(?:\s|>)/g),
    appWords: xmlElementNumber(appXml, "Words"),
    appCharacters: xmlElementNumber(appXml, "Characters"),
    appParagraphs: xmlElementNumber(appXml, "Paragraphs"),
    zipEntryCount: entries.length,
  };
}

function isEmptyDocxAnalysis(docx: Record<string, unknown>): boolean {
  if (docx.error) return false;
  const mediaCount = Number(docx.mediaCount ?? 0);
  const textCharacterCount = Number(docx.textCharacterCount ?? 0);
  const appWords = Number(docx.appWords ?? 0);
  return mediaCount === 0 && textCharacterCount === 0 && appWords === 0;
}

function zipEntryText(entries: ZipEntry[], name: string): string | undefined {
  const entry = entries.find((candidate) => candidate.name === name);
  return entry?.data.toString("utf8");
}

function extractDocxBodyText(xml: string): string {
  const text = [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlText(match[1] ?? ""))
    .join("");
  return text.trim();
}

function countRegex(input: string, regex: RegExp): number {
  return (input.match(regex) ?? []).length;
}

function xmlElementNumber(xml: string, name: string): number | undefined {
  const match = new RegExp(`<${name}>(\\d+)</${name}>`).exec(xml);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function decodeXmlText(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

async function createDocxIngestCopy(
  file: BulkFilePlan,
  options: BulkPreflightOptions,
  docx: Record<string, unknown>,
  classification: BulkPreflightClassification,
): Promise<BulkFilePlan> {
  const derivedPath = join(
    options.workDir,
    "docx",
    `${safeDerivedName(file.originalRelativePath)}-${file.sha256.slice(0, 12)}.docx`,
  );
  await mkdir(dirname(derivedPath), { recursive: true });
  const originalBuffer = await readFile(file.path);
  const normalized = await rewriteDocxZipWithImageDpiLimit(originalBuffer, DOCX_TARGET_IMAGE_DPI);
  await writeFile(derivedPath, normalized.buffer);
  const normalizeSummary = normalized.summary;
  const resizedMediaCount = Number(normalizeSummary.resizedMediaCount ?? 0);
  const normalizeStrategy =
    resizedMediaCount > 0 ? "docx_image_300dpi_downsample" : "docx_image_300dpi_normalize";
  const derivedPlan = await fingerprintFile(derivedPath);
  const variantPreflight = {
    ...docx,
    maxUploadBytes: options.maxUploadBytes,
    derivedSize: derivedPlan.size,
    normalizeStrategy,
    normalizeSummary,
  };
  return decorateBulkPlan(file, classification, "compressed_docx", variantPreflight, {
    path: derivedPlan.path,
    filename: basename(derivedPlan.path),
    size: derivedPlan.size,
    mtimeMs: derivedPlan.mtimeMs,
    sha256: derivedPlan.sha256,
    uploadKey: derivedPlan.uploadKey,
    relativePath: file.originalRelativePath,
    pathSegments: file.pathSegments,
    pathDepth: file.pathDepth,
    ext: ".docx",
    normalizeStrategy,
    derivedPath,
    derivedSize: derivedPlan.size,
    derivedSha256: derivedPlan.sha256,
  });
}

interface PdfAnalysis {
  pageCount: number;
  imageCount: number;
  imageHeavy: boolean;
}

async function analyzePdf(path: string): Promise<PdfAnalysis> {
  const text = (await readFile(path)).toString("latin1");
  const pageMatches = text.match(/\/Type\s*\/Page\b/g) ?? [];
  const imageMatches = text.match(/\/Subtype\s*\/Image\b/g) ?? [];
  const fallbackCount = /\/Count\s+(\d+)/.exec(text);
  const pageCount = pageMatches.length || (fallbackCount ? Number(fallbackCount[1]) : 1);
  const imageCount = imageMatches.length;
  return {
    pageCount,
    imageCount,
    imageHeavy: pageCount > 0 && imageCount > 0 && imageCount / pageCount >= 0.8,
  };
}

async function createPdfPartPlans(
  file: BulkFilePlan,
  options: BulkPreflightOptions,
  pdf: PdfAnalysis,
  classification: BulkPreflightClassification,
): Promise<BulkFilePlan[]> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(await readFile(file.path), { ignoreEncryption: true });
  const pageCount = Math.max(1, source.getPageCount() || pdf.pageCount);
  const ranges: Array<{ pageStart: number; pageEnd: number; buffer: Buffer }> = [];
  let pageStart = 1;
  while (pageStart <= pageCount) {
    let low = pageStart;
    let high = pageCount;
    let best: { pageEnd: number; buffer: Buffer } | undefined;
    while (low <= high) {
      const candidateEnd = Math.floor((low + high) / 2);
      const buffer = await renderPdfPageRange(source, pageStart, candidateEnd);
      if (buffer.length <= options.maxUploadBytes) {
        best = { pageEnd: candidateEnd, buffer };
        low = candidateEnd + 1;
      } else {
        high = candidateEnd - 1;
      }
    }
    if (!best) {
      const singlePage = await renderPdfPageRange(source, pageStart, pageStart);
      throw new CliError(
        `PDF page ${pageStart} remains over max upload bytes after splitting (${singlePage.length} > ${options.maxUploadBytes}).`,
      );
    }
    ranges.push({ pageStart, pageEnd: best.pageEnd, buffer: best.buffer });
    pageStart = best.pageEnd + 1;
  }

  const parts: BulkFilePlan[] = [];
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    const partIndex = index + 1;
    const partCount = ranges.length;
    const partFilename = `${safePdfPartName(file.originalRelativePath, partIndex, partCount, range.pageStart, range.pageEnd)}.pdf`;
    const derivedPath = join(
      options.workDir,
      "pdf",
      pdfPartParentPath(file.originalRelativePath),
      partFilename,
    );
    await mkdir(dirname(derivedPath), { recursive: true });
    await writeFile(derivedPath, range.buffer);
    const derivedPlan = await fingerprintFile(derivedPath);
    const logicalRelativePath = pdfPartRelativePath(
      file.originalRelativePath,
      basename(derivedPlan.path),
    );
    const logicalPathSegments = logicalRelativePath.split("/").filter(Boolean);
    const plan = decorateBulkPlan(
      file,
      classification,
      "page_split_pdf",
      {
        ...pdf,
        maxUploadBytes: options.maxUploadBytes,
        derivedSize: derivedPlan.size,
        partIndex,
        partCount,
        pageStart: range.pageStart,
        pageEnd: range.pageEnd,
      },
      {
        path: derivedPlan.path,
        filename: basename(derivedPlan.path),
        size: derivedPlan.size,
        mtimeMs: derivedPlan.mtimeMs,
        sha256: derivedPlan.sha256,
        uploadKey: derivedPlan.uploadKey,
        relativePath: logicalRelativePath,
        pathSegments: logicalPathSegments,
        pathDepth: logicalPathSegments.length,
        ext: ".pdf",
        normalizeStrategy: "pdf_page_split",
        derivedPath,
        derivedSize: derivedPlan.size,
        derivedSha256: derivedPlan.sha256,
        partIndex,
        partCount,
        pageStart: range.pageStart,
        pageEnd: range.pageEnd,
      },
    );
    plan.generatedMetadata = {};
    parts.push(plan);
  }
  return parts;
}

async function renderPdfPageRange(
  source: PdfDocument,
  pageStart: number,
  pageEnd: number,
): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const partDocument = await PDFDocument.create();
  const copiedPages = await partDocument.copyPages(
    source,
    Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart - 1 + index),
  );
  for (const page of copiedPages) partDocument.addPage(page);
  return Buffer.from(await partDocument.save());
}

function pdfPartRelativePath(originalRelativePath: string, partFilename: string): string {
  const parent = pathPosix.dirname(originalRelativePath);
  return parent === "." ? partFilename : `${parent}/${partFilename}`;
}

function pdfPartParentPath(originalRelativePath: string): string {
  const parent = pathPosix.dirname(originalRelativePath);
  return parent === "." ? "" : parent;
}

function safePdfPartName(
  originalRelativePath: string,
  partIndex: number,
  partCount: number,
  pageStart: number,
  pageEnd: number,
): string {
  const ext = extname(originalRelativePath);
  const filename = basename(originalRelativePath);
  const base = safeDerivedName(filename.slice(0, -ext.length) || filename);
  const width = Math.max(3, String(partCount).length);
  return `${base}.part${String(partIndex).padStart(width, "0")}-p${String(pageStart).padStart(3, "0")}-p${String(pageEnd).padStart(3, "0")}`;
}

function rewriteDocxZip(input: Buffer): Buffer {
  return writeZipEntries(readZipEntries(input));
}

async function rewriteDocxZipWithImageDpiLimit(
  input: Buffer,
  targetDpi: number,
): Promise<{ buffer: Buffer; summary: Record<string, unknown> }> {
  const entries = readZipEntries(input);
  const constraints = collectDocxImageConstraints(entries, targetDpi);
  let resizedMediaCount = 0;
  let skippedMediaCount = 0;
  let unconstrainedMediaCount = 0;
  let originalMediaBytes = 0;
  let normalizedMediaBytes = 0;
  const normalizedEntries: ZipEntry[] = [];

  for (const entry of entries) {
    if (!isDocxMediaEntry(entry.name)) {
      normalizedEntries.push(entry);
      continue;
    }
    originalMediaBytes += entry.data.length;
    const constraint = constraints.get(entry.name);
    if (!constraint) {
      unconstrainedMediaCount += 1;
      normalizedMediaBytes += entry.data.length;
      normalizedEntries.push(entry);
      continue;
    }
    const normalized = await normalizeDocxMediaImage(entry, constraint, targetDpi).catch(
      () => undefined,
    );
    if (!normalized) {
      skippedMediaCount += 1;
      normalizedMediaBytes += entry.data.length;
      normalizedEntries.push(entry);
      continue;
    }
    resizedMediaCount += normalized.resized ? 1 : 0;
    normalizedMediaBytes += normalized.data.length;
    normalizedEntries.push({ ...entry, data: normalized.data });
  }

  return {
    buffer: writeZipEntries(normalizedEntries),
    summary: {
      targetDpi,
      constrainedMediaCount: constraints.size,
      resizedMediaCount,
      skippedMediaCount,
      unconstrainedMediaCount,
      originalMediaBytes,
      normalizedMediaBytes,
      savedMediaBytes: Math.max(0, originalMediaBytes - normalizedMediaBytes),
    },
  };
}

interface DocxImageConstraint {
  maxWidthPx: number;
  maxHeightPx: number;
  references: number;
}

interface NormalizedDocxMediaImage {
  data: Buffer;
  resized: boolean;
}

function collectDocxImageConstraints(
  entries: ZipEntry[],
  targetDpi: number,
): Map<string, DocxImageConstraint> {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const constraints = new Map<string, DocxImageConstraint>();
  for (const entry of entries) {
    if (!isDocxXmlEntry(entry.name)) continue;
    const rels = parseDocxRelationships(byName.get(docxRelsPath(entry.name))?.data);
    if (rels.size === 0) continue;
    const xml = entry.data.toString("utf8");
    for (const drawing of xml.matchAll(
      /<wp:(?:inline|anchor)\b[\s\S]*?<\/wp:(?:inline|anchor)>/g,
    )) {
      const block = drawing[0];
      const extent = /<wp:extent\b([^>]*)\/?>/.exec(block);
      const blip = /<a:blip\b([^>]*)\/?>/.exec(block);
      if (!extent || !blip) continue;
      const extentAttributes = parseXmlAttributes(extent[1] ?? "");
      const blipAttributes = parseXmlAttributes(blip[1] ?? "");
      const relId = blipAttributes.get("r:embed") ?? blipAttributes.get("r:link");
      if (!relId) continue;
      const target = rels.get(relId);
      if (!target) continue;
      const cx = Number(extentAttributes.get("cx"));
      const cy = Number(extentAttributes.get("cy"));
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx <= 0 || cy <= 0) continue;
      const mediaPath = resolveDocxRelationshipTarget(entry.name, target);
      if (!mediaPath || !isDocxMediaEntry(mediaPath)) continue;
      const maxWidthPx = Math.max(1, Math.ceil((cx / EMUS_PER_INCH) * targetDpi));
      const maxHeightPx = Math.max(1, Math.ceil((cy / EMUS_PER_INCH) * targetDpi));
      const existing = constraints.get(mediaPath);
      constraints.set(mediaPath, {
        maxWidthPx: Math.max(existing?.maxWidthPx ?? 0, maxWidthPx),
        maxHeightPx: Math.max(existing?.maxHeightPx ?? 0, maxHeightPx),
        references: (existing?.references ?? 0) + 1,
      });
    }
  }
  return constraints;
}

function isDocxXmlEntry(path: string): boolean {
  return path.startsWith("word/") && path.endsWith(".xml") && !path.includes("/_rels/");
}

function isDocxMediaEntry(path: string): boolean {
  return path.startsWith("word/media/") && !path.endsWith("/");
}

function docxRelsPath(sourcePath: string): string {
  return pathPosix.join(
    pathPosix.dirname(sourcePath),
    "_rels",
    `${pathPosix.basename(sourcePath)}.rels`,
  );
}

function parseDocxRelationships(input: Buffer | undefined): Map<string, string> {
  const relationships = new Map<string, string>();
  if (!input) return relationships;
  const xml = input.toString("utf8");
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attributes = parseXmlAttributes(match[1] ?? "");
    if (attributes.get("TargetMode") === "External") continue;
    const id = attributes.get("Id");
    const target = attributes.get("Target");
    if (id && target) relationships.set(id, target);
  }
  return relationships;
}

function parseXmlAttributes(input: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of input.matchAll(/([\w:.-]+)\s*=\s*["']([^"']*)["']/g)) {
    attributes.set(match[1]!, match[2]!);
  }
  return attributes;
}

function resolveDocxRelationshipTarget(sourcePath: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  return pathPosix
    .normalize(pathPosix.join(pathPosix.dirname(sourcePath), target))
    .replace(/^\/+/, "");
}

async function normalizeDocxMediaImage(
  entry: ZipEntry,
  constraint: DocxImageConstraint,
  targetDpi: number,
): Promise<NormalizedDocxMediaImage | undefined> {
  const ext = extname(entry.name).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"].includes(ext)) return undefined;
  const image = sharp(entry.data, { animated: false, limitInputPixels: false });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) return undefined;
  const shouldResize =
    metadata.width > constraint.maxWidthPx || metadata.height > constraint.maxHeightPx;
  let pipeline = image.rotate();
  if (shouldResize) {
    pipeline = pipeline.resize({
      width: constraint.maxWidthPx,
      height: constraint.maxHeightPx,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  pipeline = pipeline.withMetadata({ density: targetDpi });
  if (ext === ".jpg" || ext === ".jpeg") {
    pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
  } else if (ext === ".png") {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  } else if (ext === ".webp") {
    pipeline = pipeline.webp({ quality: 82 });
  } else {
    pipeline = pipeline.tiff({ quality: 82, compression: "jpeg" });
  }
  const data = await pipeline.toBuffer();
  if (!shouldResize && data.length >= entry.data.length) {
    return { data: entry.data, resized: false };
  }
  return { data, resized: shouldResize };
}

function readZipEntries(input: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(input);
  if (eocdOffset < 0) throw new CliError("DOCX zip central directory was not found.");
  const entryCount = input.readUInt16LE(eocdOffset + 10);
  const centralOffset = input.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (input.readUInt32LE(cursor) !== 0x02014b50) throw new CliError("Invalid ZIP directory.");
    const method = input.readUInt16LE(cursor + 10);
    const crc = input.readUInt32LE(cursor + 16);
    const compressedSize = input.readUInt32LE(cursor + 20);
    const uncompressedSize = input.readUInt32LE(cursor + 24);
    const nameLength = input.readUInt16LE(cursor + 28);
    const extraLength = input.readUInt16LE(cursor + 30);
    const commentLength = input.readUInt16LE(cursor + 32);
    const localOffset = input.readUInt32LE(cursor + 42);
    const name = input.slice(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (input.readUInt32LE(localOffset) !== 0x04034b50) throw new CliError("Invalid ZIP entry.");
    const localNameLength = input.readUInt16LE(localOffset + 26);
    const localExtraLength = input.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressedData = input.slice(dataStart, dataStart + compressedSize);
    const data =
      method === 0
        ? Buffer.from(compressedData)
        : method === 8
          ? inflateRawSync(compressedData)
          : Buffer.from(compressedData);
    entries.push({
      name,
      method,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      compressedData,
      data,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function writeZipEntries(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.name.endsWith("/") ? 0 : 8;
    const data = entry.name.endsWith("/") ? Buffer.alloc(0) : entry.data;
    const compressed = method === 0 ? data : deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, eocd]);
}

function findEndOfCentralDirectory(input: Buffer): number {
  const start = Math.max(0, input.length - 65557);
  for (let offset = input.length - 22; offset >= start; offset -= 1) {
    if (input.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function safeDerivedName(input: string): string {
  return input.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120) || "document";
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function buildScanSummary(
  files: BulkFilePlan[],
  options: { scanBudget: number; minSamplesPerPattern: number; maxPatterns: number },
): unknown {
  const pathDepths: Record<string, number> = {};
  const extensions: Record<string, number> = {};
  const topLevelDirs: Record<string, number> = {};
  const filenamePatterns: Record<string, number> = {};
  const patternMap = new Map<string, { pattern: string; count: number; samples: string[] }>();

  for (const file of files) {
    pathDepths[String(file.pathDepth)] = (pathDepths[String(file.pathDepth)] ?? 0) + 1;
    extensions[file.ext || "(none)"] = (extensions[file.ext || "(none)"] ?? 0) + 1;
    const top = file.pathSegments[0] ?? "(root)";
    topLevelDirs[top] = (topLevelDirs[top] ?? 0) + 1;
    const filenamePattern = normalizePathToken(basename(file.relativePath));
    filenamePatterns[filenamePattern] = (filenamePatterns[filenamePattern] ?? 0) + 1;
    const pattern = file.pathSegments
      .map((segment, index) =>
        index === file.pathSegments.length - 1 ? "{file}" : normalizePathToken(segment),
      )
      .join("/");
    const entry = patternMap.get(pattern) ?? { pattern, count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < options.minSamplesPerPattern) entry.samples.push(file.relativePath);
    patternMap.set(pattern, entry);
  }

  const patterns = [...patternMap.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, options.maxPatterns)
    .map((entry) => ({ ...entry, samples: entry.samples.slice(0, options.scanBudget) }));

  return {
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    pathDepths,
    extensions,
    topLevelDirs,
    filenamePatterns,
    patterns,
    samples: files.slice(0, Math.min(options.scanBudget, files.length)).map((file) => ({
      path: file.relativePath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      sha256: file.sha256,
      ext: file.ext,
      pathDepth: file.pathDepth,
      pathSegments: file.pathSegments,
    })),
  };
}

function normalizePathToken(value: string): string {
  return value
    .replace(/\d{4}[-_]\d{2}/g, "{year-month}")
    .replace(/\d+/g, "{n}")
    .replace(/[0-9a-f]{8,}/gi, "{hex}");
}

async function loadSchemaSnapshot(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  existingConfig?: KbConfig,
  existingSelector?: CollectionSelector,
): Promise<unknown> {
  const schemaFile = getString(args, "schema-file");
  if (schemaFile) return JSON.parse(await readFile(resolve(schemaFile), "utf8")) as unknown;
  const config = existingConfig ?? resolveConfig(args, env);
  const selector = existingSelector ?? resolveCollectionSelector(args, env);
  return resolveCollection(config, selector, { includeSchema: true });
}

async function loadOptionalSchemaSnapshot(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  try {
    return await loadSchemaSnapshot(args, env);
  } catch (error) {
    if (
      error instanceof CliError &&
      (error.message.startsWith("Missing collection selector") ||
        error.message.startsWith("Missing API key"))
    ) {
      return {};
    }
    throw error;
  }
}

async function resolveCollection(
  config: KbConfig,
  selector: CollectionSelector,
  options: { includeSchema: boolean },
): Promise<unknown> {
  const params = new URLSearchParams({ action: "upload" });
  params.set(selector.field, selector.value);
  if (options.includeSchema) params.set("include_schema", "true");
  return jsonRequest(config, `collections/resolve?${params.toString()}`);
}

async function loadMetadataMap(args: ParsedArgs): Promise<MetadataMap> {
  const metadataMapFile = getString(args, "metadata-map");
  if (!metadataMapFile) {
    return {
      version: 1,
      rule_mode: "layered",
      defaults: { source: "local_bulk_upload" },
      layers: [
        {
          name: "base",
          merge: "all",
          rules: [
            {
              name: "filesystem",
              match: { glob: "**/*" },
              fields: {
                relative_path: { source: "relative_path" },
                filename: { source: "filename" },
                filename_stem: { source: "filename_stem" },
                ext: { source: "ext" },
                path_depth: { source: "path_depth" },
                top_dir: { source: "top_dir" },
                parent_dir: { source: "parent_dir" },
              },
            },
          ],
        },
      ],
    };
  }
  const raw = await readFile(resolve(metadataMapFile), "utf8");
  const parsed = parseStructuredConfig(raw, metadataMapFile);
  if (!isObject(parsed)) throw new CliError("metadata-map must be an object.");
  return parsed as MetadataMap;
}

function metadataDryRun(
  files: BulkFilePlan[],
  metadataMap: MetadataMap,
  schemaSnapshot: unknown,
): MetadataDryRunSummary {
  const requiredMissing: Record<string, number> = {};
  const typeErrors: Record<string, number> = {};
  const ruleCoverage: Record<string, number> = {};
  const errors: Array<{ path: string; field: string; reason: string; value?: unknown }> = [];
  const fields = metadataSchemaFields(schemaSnapshot);
  let valid = 0;
  let fallback = 0;

  for (const file of files) {
    const evaluated = evaluateMetadata(metadataMap, file);
    for (const rule of evaluated.matchedRules) ruleCoverage[rule] = (ruleCoverage[rule] ?? 0) + 1;
    if (evaluated.matchedRules.length === 0 || evaluated.matchedRules.includes("fallback"))
      fallback += 1;
    let fileValid = true;
    for (const field of fields) {
      const key = stringField(field, "key");
      if (!key) continue;
      const value = evaluated.metadata[key];
      if (field.required === true && (value === undefined || value === null || value === "")) {
        requiredMissing[key] = (requiredMissing[key] ?? 0) + 1;
        fileValid = false;
        if (errors.length < 50)
          errors.push({ path: file.relativePath, field: key, reason: "required_missing" });
        continue;
      }
      if (
        value !== undefined &&
        value !== null &&
        !metadataValueMatchesType(value, stringField(field, "type"))
      ) {
        typeErrors[key] = (typeErrors[key] ?? 0) + 1;
        fileValid = false;
        if (errors.length < 50)
          errors.push({ path: file.relativePath, field: key, reason: "type_error", value });
      }
      const enumValues = Array.isArray(field.values)
        ? field.values
        : Array.isArray(field.enum)
          ? field.enum
          : undefined;
      if (enumValues && value !== undefined && !enumValues.includes(value)) {
        typeErrors[key] = (typeErrors[key] ?? 0) + 1;
        fileValid = false;
        if (errors.length < 50)
          errors.push({ path: file.relativePath, field: key, reason: "enum_error", value });
      }
    }
    if (fileValid) valid += 1;
  }

  return {
    totalFiles: files.length,
    validRate: files.length === 0 ? 1 : valid / files.length,
    requiredMissing,
    typeErrors,
    unknownRequired: {},
    fallbackRate: files.length === 0 ? 0 : fallback / files.length,
    ruleCoverage,
    examples: { errors },
  };
}

function metadataDryRunPassed(summary: MetadataDryRunSummary, args: ParsedArgs): boolean {
  const minimumValidRate = Number(getString(args, "min-valid-rate") ?? "0.99");
  const maximumFallbackRate = Number(getString(args, "max-fallback-rate") ?? "0.05");

  return (
    summary.validRate >= minimumValidRate &&
    summary.fallbackRate <= maximumFallbackRate &&
    countMapValues(summary.requiredMissing) === 0 &&
    countMapValues(summary.typeErrors) === 0 &&
    countMapValues(summary.unknownRequired) === 0
  );
}

function countMapValues(input: Record<string, number>): number {
  return Object.values(input).reduce((sum, value) => sum + value, 0);
}

function evaluateMetadata(metadataMap: MetadataMap, file: BulkFilePlan): MetadataEvaluation {
  const metadata: Record<string, unknown> = { ...(metadataMap.defaults ?? {}) };
  const matchedRules: string[] = [];
  for (const layer of metadataMap.layers ?? []) {
    const merge = layer.merge ?? "all";
    for (const rule of layer.rules ?? []) {
      if (!metadataRuleMatches(rule.match, file)) continue;
      matchedRules.push(rule.name ?? "unnamed");
      applyMetadataFields(
        metadata,
        file,
        rule.fields ?? {},
        Boolean(layer.overwrite || rule.overwrite),
      );
      if (merge === "first_match") break;
    }
  }
  return { metadata, matchedRules };
}

function applyMetadataFields(
  metadata: Record<string, unknown>,
  file: BulkFilePlan,
  fields: Record<string, MetadataField | unknown>,
  overwrite: boolean,
): void {
  for (const [key, rawField] of Object.entries(fields)) {
    const field = isObject(rawField) ? (rawField as MetadataField) : { const: rawField };
    const value = metadataFieldValue(field, file);
    if (value === undefined) continue;
    if (Object.hasOwn(metadata, key) && metadata[key] !== value && !(overwrite || field.overwrite))
      continue;
    metadata[key] = value;
  }
}

function metadataFieldValue(field: MetadataField, file: BulkFilePlan): unknown {
  let value = Object.hasOwn(field, "const")
    ? field.const
    : metadataSourceValue(field.source ?? "relative_path", file, field.index);
  if (field.regex && typeof value === "string") {
    const match = new RegExp(field.regex).exec(value);
    value = match?.[1];
  }
  if (field.map && typeof value === "string" && Object.hasOwn(field.map, value))
    value = field.map[value];
  return coerceMetadataValue(value, field.type);
}

function metadataSourceValue(source: string, file: BulkFilePlan, index?: number): unknown {
  if (source === "relative_path") return file.relativePath;
  if (source === "path_segment") return file.pathSegments[index ?? 0];
  if (source === "filename") return basename(file.relativePath);
  if (source === "filename_stem") return basename(file.relativePath, extname(file.relativePath));
  if (source === "parent_dir") return file.pathSegments.at(-2) ?? "";
  if (source === "top_dir") return file.pathSegments[0] ?? "";
  if (source === "ext") return file.ext;
  if (source === "path_depth") return file.pathDepth;
  if (source === "mtime") return file.mtimeMs;
  if (source === "size") return file.size;
  return undefined;
}

function coerceMetadataValue(value: unknown, type: string | undefined): unknown {
  if (value === undefined || !type) return value;
  if (type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  if (type === "string" && value !== null) return String(value);
  return value;
}

function metadataRuleMatches(match: MetadataMatch | undefined, file: BulkFilePlan): boolean {
  if (!match) return true;
  if (typeof match === "string") return globMatches(match, file.relativePath);
  if (match.all) return match.all.every((child) => metadataRuleMatches(child, file));
  if (match.any) return match.any.some((child) => metadataRuleMatches(child, file));
  if (match.path_prefix && !file.relativePath.startsWith(match.path_prefix)) return false;
  if (match.glob && !globMatches(match.glob, file.relativePath)) return false;
  if (match.regex && !new RegExp(match.regex).test(file.relativePath)) return false;
  if (match.ext) {
    const expected = Array.isArray(match.ext) ? match.ext : [match.ext];
    if (!expected.map((item) => item.toLowerCase()).includes(file.ext.toLowerCase())) return false;
  }
  return true;
}

function globMatches(glob: string, value: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(value);
}

function metadataSchemaFields(schemaSnapshot: unknown): Record<string, unknown>[] {
  const data = responseData(schemaSnapshot);
  const collection = isObject(data) ? data.collection : undefined;
  const schema =
    (isObject(collection) ? collection.metadataSchema : undefined) ??
    (isObject(data) ? data.metadataSchema : undefined) ??
    (isObject(schemaSnapshot) ? schemaSnapshot.metadataSchema : undefined) ??
    schemaSnapshot;
  if (isObject(schema) && Array.isArray(schema.fields)) return schema.fields.filter(isObject);
  return [];
}

function metadataValueMatchesType(value: unknown, type: string | undefined): boolean {
  if (!type) return true;
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  return true;
}

function parseStructuredConfig(raw: string, path: string): unknown {
  if (path.endsWith(".json")) return JSON.parse(raw) as unknown;
  return parseYamlLite(raw);
}

function parseYamlLite(raw: string): unknown {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "  "))
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
  let index = 0;

  function parseBlock(indent: number): unknown {
    const current = lines[index];
    if (!current) return {};
    const isArray = current.slice(countIndent(current)).startsWith("- ");
    return isArray ? parseArray(indent) : parseObject(indent);
  }

  function parseObject(indent: number): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    while (index < lines.length) {
      const line = lines[index] as string;
      const currentIndent = countIndent(line);
      if (currentIndent < indent) break;
      if (currentIndent > indent) {
        index += 1;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) break;
      const colon = trimmed.indexOf(":");
      if (colon < 0) throw new CliError(`Invalid YAML line: ${trimmed}`);
      const key = trimmed.slice(0, colon).trim();
      const rest = trimmed.slice(colon + 1).trim();
      index += 1;
      object[key] = rest ? parseYamlScalar(rest) : parseBlock(indent + 2);
    }
    return object;
  }

  function parseArray(indent: number): unknown[] {
    const array: unknown[] = [];
    while (index < lines.length) {
      const line = lines[index] as string;
      const currentIndent = countIndent(line);
      if (currentIndent < indent) break;
      if (currentIndent !== indent || !line.trim().startsWith("- ")) break;
      const rest = line.trim().slice(2).trim();
      index += 1;
      if (!rest) {
        array.push(parseBlock(indent + 2));
        continue;
      }
      if (rest.includes(":")) {
        const [key, ...valueParts] = rest.split(":");
        const object: Record<string, unknown> = {};
        object[(key ?? "").trim()] = valueParts.join(":").trim()
          ? parseYamlScalar(valueParts.join(":").trim())
          : parseBlock(indent + 2);
        const child = parseBlock(indent + 2);
        if (isObject(child)) Object.assign(object, child);
        array.push(object);
      } else {
        array.push(parseYamlScalar(rest));
      }
    }
    return array;
  }

  return parseBlock(0);
}

function parseYamlScalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    return inner ? inner.split(",").map((item) => parseYamlScalar(item.trim())) : [];
  }
  return raw;
}

function countIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function csvLine(values: string[]): string {
  return values.map((value) => `"${value.replace(/"/g, '""')}"`).join(",");
}

function formatBulkRunSummary(summary: {
  jobId: string;
  statePath: string;
  total: number;
  pending: number;
  inflight: number;
  completed: number;
  failed: number;
  waitingForIndexFlags: number;
  skipped: number;
  blocked: number;
  polls: number;
  pipelineHealth?: BulkPipelineHealthSnapshot | undefined;
}): string {
  const pressure = summary.pipelineHealth?.pressure ?? "unknown";
  const action = summary.pipelineHealth?.recommendedAction ?? "continue";
  return `Bulk job ${summary.jobId}: completed=${summary.completed} failed=${summary.failed} skipped=${summary.skipped} blocked=${summary.blocked} pending=${summary.pending} inflight=${summary.inflight} waiting_for_index_flags=${summary.waitingForIndexFlags} pressure=${pressure} action=${action} state=${summary.statePath}\n`;
}

async function uploadWithRetries(input: {
  args: ParsedArgs;
  config: KbConfig;
  selectorFields: Record<string, string>;
  plan: FilePlan;
  metadata: Record<string, unknown>;
  retries: number;
  env: NodeJS.ProcessEnv;
}): Promise<UploadResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= input.retries + 1; attempt += 1) {
    const requestId = randomUUID();
    const idempotencyKey = `tiangong-kb-ingest:${input.plan.sha256}:${input.plan.size}`;

    try {
      const response = await uploadOne({
        ...input,
        requestId,
        idempotencyKey,
      });
      const documentId = documentIdFromUpload(response);
      const existingDocumentId = existingDocumentIdFromUpload(response);

      const result: UploadResult = {
        key: input.plan.uploadKey,
        path: input.plan.path,
        sha256: input.plan.sha256,
        status: "succeeded",
        attempts: attempt,
        response,
        requestId,
        idempotencyKey,
        updatedAt: new Date().toISOString(),
      };
      if (documentId) result.documentId = documentId;
      if (existingDocumentId) result.existingDocumentId = existingDocumentId;
      const duplicate = duplicateFromUpload(response);
      if (duplicate !== undefined) result.duplicate = duplicate;
      return result;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof HttpError ? error.retryable : true;
      if (!retryable || attempt > input.retries) break;
      await sleep(retryDelay(error, attempt) * 1000);
    }
  }

  return {
    key: input.plan.uploadKey,
    path: input.plan.path,
    sha256: input.plan.sha256,
    status: "failed",
    attempts: input.retries + 1,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    updatedAt: new Date().toISOString(),
  };
}

async function uploadOne(input: {
  args: ParsedArgs;
  config: KbConfig;
  selectorFields: Record<string, string>;
  plan: FilePlan;
  metadata: Record<string, unknown>;
  requestId: string;
  idempotencyKey: string;
}): Promise<unknown> {
  const form = new FormData();
  for (const [key, value] of Object.entries(input.selectorFields)) {
    form.set(key, value);
  }
  form.set(
    "metadata_json",
    JSON.stringify({
      ...input.metadata,
      client_filename: input.plan.filename,
      client_size: input.plan.size,
      client_mtime_ms: input.plan.mtimeMs,
    }),
  );
  form.set("request_id", input.requestId);

  const dedupeScope = getString(input.args, "dedupe-scope");
  if (dedupeScope) form.set("dedupe_scope", dedupeScope);
  const visibility = getString(input.args, "visibility");
  if (visibility) form.set("visibility", visibility);

  const blob = await openAsBlob(input.plan.path, { type: mimeType(input.plan.path) });
  form.set("file", blob, input.plan.filename);

  return jsonRequest(input.config, "documents", {
    method: "POST",
    body: form,
    headers: {
      "Idempotency-Key": input.idempotencyKey,
      "X-Request-Id": input.requestId,
    },
  });
}

async function resolveSelectorFields(
  config: KbConfig,
  selector: CollectionSelector,
): Promise<Record<string, string>> {
  if (selector.field !== "collection_name") {
    return { [selector.field]: selector.value };
  }

  const matches = (await listCollections(config, "upload", 100)).filter(
    (item) => item.name === selector.value,
  );
  if (matches.length === 0)
    throw new CliError(`No uploadable collection matched name: ${selector.value}`);
  if (matches.length > 1) {
    const choices = matches.map((item) => item.key ?? item.path ?? item.id ?? "").join(", ");
    throw new CliError(
      `Collection name is not unique: ${selector.value}. Use --collection-key or --collection-path. Matches: ${choices}`,
    );
  }

  const match = matches[0] as CollectionItem;
  const key = collectionKey(match);
  if (key) return { collection_key: key };
  const path = collectionPath(match);
  if (path) return { collection_path: path };
  if (typeof match.id === "string" && match.id) return { primary_collection_id: match.id };
  throw new CliError(
    `Collection matched name ${selector.value}, but response had no key, path, or id.`,
  );
}

async function listCollections(
  config: KbConfig,
  capability: string,
  limit: number,
): Promise<CollectionItem[]> {
  const collections: CollectionItem[] = [];
  let offset = 0;

  while (true) {
    const payload = await jsonRequest(
      config,
      `collections?${new URLSearchParams({
        capability,
        limit: String(limit),
        offset: String(offset),
      }).toString()}`,
    );
    const page = collectionItems(payload);
    collections.push(...page);
    if (page.length < limit) return collections;
    offset += limit;
  }
}

async function jsonRequest(
  config: KbConfig,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<unknown> {
  const url = `${config.apiBaseUrl}${config.apiPathPrefix}/${path.replace(/^\/+/, "")}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.apiKey}`);
  headers.set("Accept", "application/json");
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
    });
  } catch (error) {
    throw new HttpError(
      `Request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      undefined,
      true,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      `HTTP ${response.status} from ${url}: ${text}`,
      response.status,
      retryAfterSeconds(response.headers),
      RETRYABLE_HTTP_STATUSES.has(response.status),
    );
  }

  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
  }
}

function resolveConfig(
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

async function collectFiles(
  path: string,
  recursive: boolean,
  options: { excludeDirectories?: Set<string> } = {},
): Promise<string[]> {
  const item = await stat(path).catch(() => undefined);
  if (!item) throw new CliError(`Path not found: ${path}`);
  if (item.isFile()) return [path];
  if (!item.isDirectory()) throw new CliError(`Path is not a file or directory: ${path}`);
  if (!recursive)
    throw new CliError(`Path is a directory and recursive traversal is disabled: ${path}`);

  const { readdir } = await import("node:fs/promises");
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (options.excludeDirectories?.has(child)) continue;
        await walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }
  await walk(path);
  if (files.length === 0) throw new CliError(`No files found: ${path}`);
  return files.sort();
}

async function fingerprintFile(path: string): Promise<FilePlan> {
  const info = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolvePromise);
  });
  const sha256 = hash.digest("hex");
  return {
    path,
    filename: basename(path),
    size: info.size,
    mtimeMs: info.mtimeMs,
    sha256,
    uploadKey: `${sha256}:${info.size}`,
  };
}

async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index] as T;
      index += 1;
      results.push(await worker(item));
    }
  });
  await Promise.all(workers);
  return results;
}

function collectionItems(payload: unknown): CollectionItem[] {
  const data = responseData(payload);
  if (Array.isArray(data)) return data.filter(isObject) as CollectionItem[];
  if (isObject(data) && Array.isArray(data.collections))
    return data.collections.filter(isObject) as CollectionItem[];
  if (isObject(data) && Array.isArray(data.data))
    return data.data.filter(isObject) as CollectionItem[];
  if (isObject(payload) && Array.isArray(payload.data))
    return payload.data.filter(isObject) as CollectionItem[];
  throw new CliError("Collection list response did not contain a data array.");
}

function collectionKey(item: CollectionItem): string | undefined {
  return (
    stringField(item, "key") ??
    stringField(item, "collectionKey") ??
    stringField(item, "collection_key")
  );
}

function collectionPath(item: CollectionItem): string | undefined {
  return (
    stringField(item, "path") ??
    stringField(item, "collectionPath") ??
    stringField(item, "collection_path")
  );
}

function responseData(payload: unknown): unknown {
  if (
    isObject(payload) &&
    "data" in payload &&
    ("api_version" in payload || "request_id" in payload || isObject(payload.data))
  ) {
    return payload.data;
  }
  return payload;
}

function documentIdFromUpload(payload: unknown): string | undefined {
  const data = responseData(payload);
  if (!isObject(data)) return undefined;
  return (
    stringField(data, "document_id") ??
    stringField(data, "documentId") ??
    existingDocumentIdFromUpload(payload)
  );
}

function existingDocumentIdFromUpload(payload: unknown): string | undefined {
  const data = responseData(payload);
  if (!isObject(data)) return undefined;
  return stringField(data, "existing_document_id") ?? stringField(data, "existingDocumentId");
}

function duplicateFromUpload(payload: unknown): boolean | undefined {
  const data = responseData(payload);
  if (!isObject(data)) return undefined;
  const value = data.duplicate ?? data.isDuplicate;
  return typeof value === "boolean" ? value : undefined;
}

function writeJsonOrText(
  stdout: Output,
  args: ParsedArgs,
  payload: unknown,
  text: () => string,
): void {
  write(stdout, getBoolean(args, "json") ? `${JSON.stringify(payload, null, 2)}\n` : text());
}

function formatUploadLine(result: UploadResult): string {
  if (result.status === "failed") return `FAIL ${result.path}: ${result.error}\n`;
  const duplicate = result.duplicate === undefined ? "" : ` duplicate=${result.duplicate}`;
  const existing = result.existingDocumentId ? ` existing=${result.existingDocumentId}` : "";
  return `OK ${result.path} document=${result.documentId ?? ""}${duplicate}${existing}\n`;
}

function addSelector(
  selectors: CollectionSelector[],
  field: CollectionSelector["field"],
  value: string | undefined,
): void {
  if (value) selectors.push({ field, value });
}

function getString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

function getBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === "true";
}

function getPositiveInteger(args: ParsedArgs, name: string, defaultValue: number): number {
  return positiveIntegerValue(getString(args, name), defaultValue, `--${name}`);
}

function positiveIntegerValue(
  value: string | undefined,
  defaultValue: number,
  label: string,
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new CliError(`${label} must be a positive integer.`);
  return parsed;
}

function getNonNegativeInteger(args: ParsedArgs, name: string, defaultValue: number): number {
  return nonNegativeIntegerValue(getString(args, name), defaultValue, `--${name}`);
}

function nonNegativeIntegerValue(
  value: string | undefined,
  defaultValue: number,
  label: string,
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new CliError(`${label} must be a non-negative integer.`);
  return parsed;
}

function getPositiveNumber(args: ParsedArgs, name: string, defaultValue: number): number {
  return positiveNumberValue(getString(args, name), defaultValue, `--${name}`);
}

function positiveNumberValue(
  value: string | undefined,
  defaultValue: number,
  label: string,
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new CliError(`${label} must be a positive number.`);
  return parsed;
}

function firstEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizePrefix(value: string): string {
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const value = headers.get("Retry-After");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function retryDelay(error: unknown, attempt: number): number {
  if (error instanceof HttpError && error.retryAfterSeconds)
    return Math.min(error.retryAfterSeconds, 30);
  return Math.min(2 * 2 ** Math.max(0, attempt - 1), 30);
}

function mimeType(path: string): string {
  if (path.endsWith(".pdf")) return "application/pdf";
  if (path.endsWith(".txt")) return "text/plain";
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (path.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (path.endsWith(".pptx")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  return "application/octet-stream";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function write(output: Output, text: string): void {
  output.write(text);
}

function loadDotenv(env: NodeJS.ProcessEnv): void {
  const cwd = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(process.cwd(), ".env"), resolve(cwd, "../.env")];
  for (const candidate of candidates) {
    const content = readEnvFile(candidate);
    if (!content) continue;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rawValue] = trimmed.replace(/^export\s+/, "").split("=");
      const key = rawKey?.trim();
      if (!key || env[key]) continue;
      env[key] = rawValue
        .join("=")
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
}

function readEnvFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function topHelp(): string {
  return `Tiangong AI CLI

Usage:
  tiangong-ai doctor [--json]
  tiangong-ai kb ingest bulk <file-or-folder> [--window-size 100] [--top-up-max 50]
  tiangong-ai kb ingest jobs
  tiangong-ai kb ingest status <document-id>
  tiangong-ai kb collections list [--capability upload]

Run "tiangong-ai kb --help" for KB options.
`;
}

function kbHelp(): string {
  return `Tiangong KB commands

Usage:
  tiangong-ai kb ingest bulk <file-or-folder> [options]
  tiangong-ai kb ingest bulk scan <folder> [--json]
  tiangong-ai kb ingest bulk preflight <folder> [--json]
  tiangong-ai kb ingest bulk dry-run <folder> --metadata-map <path> [--json]
  tiangong-ai kb ingest normalize dry-run <folder> [--json]
  tiangong-ai kb ingest metadata dry-run <folder> --metadata-map <path> [--json]
  tiangong-ai kb ingest jobs [--json]
  tiangong-ai kb ingest status <job-id-or-document-id> [--json]
  tiangong-ai kb ingest resume <job-id> [options]
  tiangong-ai kb ingest export <job-id> [--format jsonl|json|csv]
  tiangong-ai kb collections list [--capability upload] [--json]
  tiangong-ai kb collections schema --collection-path <path> [--json]

Common options:
  --api-key <token>
  --api-base-url <url>
  --api-path-prefix <path>
  --collection-name <name>
  --collection-key <key>
  --collection-path <path>
  --collection-id <uuid>
  --json

Ingest options:
  --state <path>
  --metadata-map <path>
  --schema-file <path>
  --window-size <n>
  --top-up-max <n>
  --upload-concurrency <n>
  --retries <n>
  --poll-interval <seconds>
  --max-polls <n> (default 0, no client-side polling limit)
`;
}

function bulkHelp(): string {
  return `Tiangong KB bulk ingest

Usage:
  tiangong-ai kb ingest bulk <file-or-folder> --collection-path <path> [options]
	  tiangong-ai kb ingest bulk run <file-or-folder> --collection-path <path> [options]
	  tiangong-ai kb ingest bulk scan <folder> --json
	  tiangong-ai kb ingest bulk preflight <folder> --json
	  tiangong-ai kb ingest bulk dry-run <folder> --metadata-map metadata-map.yaml --json
  tiangong-ai kb ingest bulk resume <job-id>
  tiangong-ai kb ingest bulk export <job-id> --format csv

Bulk options:
  --state <path>
  --metadata-map <path>
  --schema-file <path>
  --window-size <n>
  --top-up-max <n>
  --upload-concurrency <n>
  --poll-interval <seconds>
  --max-polls <n> (default 0, no client-side polling limit)
  --json
`;
}
