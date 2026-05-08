import { createHash, randomUUID } from "node:crypto";
import { createReadStream, openAsBlob, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_API_BASE_URL = "https://thuenv.tiangong.world:7300";
export const DEFAULT_API_PATH_PREFIX = "/api/v1/kb";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRIES = 3;
const DEFAULT_MANIFEST = ".tiangong-kb-ingest-manifest.jsonl";
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "deleted"]);
const DEFAULT_POLL_INTERVAL_SECONDS = 2;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 300;

type Output = Pick<NodeJS.WriteStream, "write">;

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
  manifestKey: string;
}

interface ManifestRecord {
  key: string;
  path: string;
  sha256: string;
  status: "planned" | "skipped" | "succeeded" | "failed";
  attempts?: number;
  documentId?: string;
  existingDocumentId?: string;
  duplicate?: boolean;
  error?: string;
  updatedAt: string;
}

interface UploadResult extends ManifestRecord {
  response?: unknown;
  requestId?: string;
  idempotencyKey?: string;
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
        write(io.stdout, "Usage: tiangong doctor\n");
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
        return await kbIngest(rest, io);
      }
      if (subcommand === "collections") {
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
      .map((item) => `${item.name ?? ""}\t${item.key ?? ""}\t${item.path ?? ""}\t${item.id ?? ""}`)
      .join("\n")
      .concat(collections.length ? "\n" : ""),
  );
  return 0;
}

async function kbStatus(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const [documentId] = args.positionals;
  if (!documentId) throw new CliError("Usage: tiangong kb status <document-id>");

  const config = resolveConfig(args, io.env);
  const payload = await jsonRequest(config, `documents/${encodeURIComponent(documentId)}`);
  writeJsonOrText(io.stdout, args, payload, () => `${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

async function kbIngest(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  const config = resolveConfig(args, io.env);
  const targetPath = args.positionals[0];
  if (!targetPath) throw new CliError("Usage: tiangong kb ingest <file-or-folder>");

  const selector = resolveCollectionSelector(args, io.env);
  const selectorFields = await resolveSelectorFields(config, selector);
  const recursive = getBoolean(args, "recursive");
  const force = getBoolean(args, "force");
  const waitForTerminal = getBoolean(args, "wait");
  const concurrency = positiveIntegerValue(
    getString(args, "concurrency") ?? firstEnv(io.env, "TIANGONG_KB_UPLOAD_CONCURRENCY"),
    DEFAULT_CONCURRENCY,
    "--concurrency",
  );
  const retries = nonNegativeIntegerValue(
    getString(args, "retries") ?? firstEnv(io.env, "TIANGONG_KB_UPLOAD_RETRIES"),
    DEFAULT_RETRIES,
    "--retries",
  );
  const manifestPath = resolve(
    getString(args, "manifest") ??
      firstEnv(io.env, "TIANGONG_KB_MANIFEST_PATH") ??
      DEFAULT_MANIFEST,
  );
  const metadata = await loadMetadata(args);

  const files = await collectFiles(resolve(targetPath), recursive);
  const manifest = await loadManifest(manifestPath);
  const plans = await Promise.all(files.map((file) => fingerprintFile(file)));
  const uploadPlans = plans.filter(
    (plan) => force || manifest.get(plan.manifestKey)?.status !== "succeeded",
  );

  await mkdir(dirname(manifestPath), { recursive: true });

  if (uploadPlans.length === 0) {
    const summary = { total: plans.length, uploaded: 0, skipped: plans.length, failed: 0 };
    writeJsonOrText(
      io.stdout,
      args,
      summary,
      () => `No files to upload; ${plans.length} already succeeded.\n`,
    );
    return 0;
  }

  const results = await runPool(uploadPlans, concurrency, async (plan) => {
    const result = await uploadWithRetries({
      args,
      config,
      selectorFields,
      plan,
      metadata,
      retries,
      waitForTerminal,
      env: io.env,
    });
    await appendManifest(manifestPath, result);
    if (!getBoolean(args, "json")) {
      write(io.stdout, formatUploadLine(result));
    }
    return result;
  });

  const failed = results.filter((item) => item.status === "failed").length;
  const summary = {
    total: plans.length,
    uploaded: results.filter((item) => item.status === "succeeded").length,
    skipped: plans.length - uploadPlans.length,
    failed,
    manifest: manifestPath,
    results,
  };

  if (getBoolean(args, "json")) {
    write(io.stdout, `${JSON.stringify(summary, null, 2)}\n`);
  } else {
    write(
      io.stdout,
      `Summary: uploaded=${summary.uploaded} skipped=${summary.skipped} failed=${failed}\n`,
    );
  }

  return failed > 0 ? 1 : 0;
}

async function uploadWithRetries(input: {
  args: ParsedArgs;
  config: KbConfig;
  selectorFields: Record<string, string>;
  plan: FilePlan;
  metadata: Record<string, unknown>;
  retries: number;
  waitForTerminal: boolean;
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
      let finalResponse: unknown = response;
      if (input.waitForTerminal && documentId) {
        finalResponse = await waitForStatus(input.config, documentId, input.args, input.env);
      }

      const result: UploadResult = {
        key: input.plan.manifestKey,
        path: input.plan.path,
        sha256: input.plan.sha256,
        status: "succeeded",
        attempts: attempt,
        response: finalResponse,
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
    key: input.plan.manifestKey,
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
  if (typeof match.key === "string" && match.key) return { collection_key: match.key };
  if (typeof match.path === "string" && match.path) return { collection_path: match.path };
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

async function waitForStatus(
  config: KbConfig,
  documentId: string,
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const timeoutSeconds = positiveNumberValue(
    getString(args, "wait-timeout") ?? firstEnv(env, "TIANGONG_KB_WAIT_TIMEOUT"),
    DEFAULT_WAIT_TIMEOUT_SECONDS,
    "--wait-timeout",
  );
  const intervalSeconds = positiveNumberValue(
    getString(args, "poll-interval") ?? firstEnv(env, "TIANGONG_KB_POLL_INTERVAL"),
    DEFAULT_POLL_INTERVAL_SECONDS,
    "--poll-interval",
  );
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutSeconds * 1000) {
    const payload = await jsonRequest(config, `documents/${encodeURIComponent(documentId)}`);
    const status = statusFromPayload(payload);
    if (status && TERMINAL_STATUSES.has(status)) return payload;
    await sleep(intervalSeconds * 1000);
  }

  throw new CliError(`Timed out waiting for document ${documentId}.`);
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

async function collectFiles(path: string, recursive: boolean): Promise<string[]> {
  const item = await stat(path).catch(() => undefined);
  if (!item) throw new CliError(`Path not found: ${path}`);
  if (item.isFile()) return [path];
  if (!item.isDirectory()) throw new CliError(`Path is not a file or directory: ${path}`);
  if (!recursive)
    throw new CliError(`Path is a directory. Pass --recursive to upload its files: ${path}`);

  const { readdir } = await import("node:fs/promises");
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = resolve(dir, entry.name);
      if (entry.isDirectory()) {
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
    manifestKey: `${sha256}:${info.size}`,
  };
}

async function loadManifest(path: string): Promise<Map<string, ManifestRecord>> {
  const records = new Map<string, ManifestRecord>();
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as ManifestRecord;
    records.set(record.key, record);
  }
  return records;
}

async function appendManifest(path: string, record: ManifestRecord): Promise<void> {
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

async function loadMetadata(args: ParsedArgs): Promise<Record<string, unknown>> {
  const metadataFile = getString(args, "metadata-file");
  const metadataJson = getString(args, "metadata-json");
  if (metadataFile && metadataJson)
    throw new CliError("Use only one of --metadata-file or --metadata-json.");
  if (!metadataFile && !metadataJson) return {};
  const raw = metadataFile ? await readFile(resolve(metadataFile), "utf8") : metadataJson;
  const parsed = JSON.parse(raw ?? "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("Metadata must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
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
  if (isObject(data) && Array.isArray(data.data))
    return data.data.filter(isObject) as CollectionItem[];
  if (isObject(payload) && Array.isArray(payload.data))
    return payload.data.filter(isObject) as CollectionItem[];
  throw new CliError("Collection list response did not contain a data array.");
}

function responseData(payload: unknown): unknown {
  if (isObject(payload) && "data" in payload && "api_version" in payload) return payload.data;
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

function statusFromPayload(payload: unknown): string | undefined {
  const data = responseData(payload);
  if (!isObject(data)) return undefined;
  return stringField(data, "status");
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
  tiangong doctor [--json]
  tiangong kb ingest <file-or-folder> [--recursive] [--concurrency 3]
  tiangong kb collections [--capability upload]
  tiangong kb status <document-id>

Run "tiangong kb --help" for KB options.
`;
}

function kbHelp(): string {
  return `Tiangong KB commands

Usage:
  tiangong kb ingest <file-or-folder> [options]
  tiangong kb collections [--capability upload] [--json]
  tiangong kb status <document-id> [--json]

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
  --recursive
  --manifest <path>
  --concurrency <n>
  --retries <n>
  --force
  --wait
  --metadata-json <json>
  --metadata-file <path>
`;
}
