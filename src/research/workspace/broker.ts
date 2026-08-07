import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { CliError } from "../../errors.js";
import { loadCapabilityDeclarations, verifyCapabilities } from "./capabilities.js";
import { loadCapabilityCredentialMap } from "./credentials.js";
import {
  loadBrokerEvidenceCache,
  persistBrokerEvidence,
  storeBrokerEvidenceCache,
} from "./evidence.js";
import { appendJournalEvent } from "./journal.js";
import { sanitizeResearchRecord, sanitizeResearchText } from "./sanitization.js";
import {
  canonicalJson,
  ensureDirectory,
  isObject,
  pathExists,
  resolveContained,
  sha256Text,
  workspacePaths,
} from "./storage.js";
import type { CapabilityDeclaration } from "./types.js";
import { loadWorkspaceConfig } from "./workspace.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const BROKER_CONTEXT_BYTES_PER_TOKEN = 3;

export interface CapabilityBroker {
  url: string;
  stop(): Promise<void>;
}

export async function startCapabilityBroker(
  root: string,
  projectId: string,
  capsuleProject: string,
): Promise<CapabilityBroker | undefined> {
  const declarations = await loadCapabilityDeclarations(root);
  const networkCapabilities = declarations.capabilities.filter((capability) =>
    capability.permissions.includes("brokered-network"),
  );
  if (!networkCapabilities.length) return undefined;
  const verification = await verifyCapabilities(root);
  if (verification.status !== "verified") {
    throw new CliError("Capability broker requires verified capability locks.", {
      code: "RESEARCH_CAPABILITY_DRIFT",
      exitCode: 3,
      details: verification,
    });
  }
  const credentialMap = await loadCapabilityCredentialMap(root, declarations.capabilities);
  const config = await loadWorkspaceConfig(root);
  const routeToken = randomUUID().replaceAll("-", "");
  const route = `/mcp/${routeToken}`;
  const server = createServer((request, response) => {
    void handleMcpRequest({
      request,
      response,
      route,
      root,
      projectId,
      capsuleProject,
      capabilities: networkCapabilities,
      credentialMap,
      workspaceResponseBytes: config.budget.maxBrokerResponseBytes,
      workspaceContextTokens: config.budget.maxBrokerContextTokens,
      workspaceMaxItems: config.budget.maxBrokerItems,
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Capability broker did not receive a TCP address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}${route}`,
    stop: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

async function handleMcpRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  route: string;
  root: string;
  projectId: string;
  capsuleProject: string;
  capabilities: CapabilityDeclaration[];
  credentialMap: Map<string, string>;
  workspaceResponseBytes: number;
  workspaceContextTokens: number;
  workspaceMaxItems: number;
}): Promise<void> {
  try {
    if (input.request.method !== "POST" || input.request.url !== input.route) {
      sendJson(input.response, 404, { error: "not_found" });
      return;
    }
    const body = await readRequestJson(input.request);
    if (!isObject(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      sendRpcError(input.response, body, -32600, "Invalid Request");
      return;
    }
    if (body.method === "notifications/initialized") {
      input.response.writeHead(202).end();
      return;
    }
    if (body.method === "initialize") {
      sendRpcResult(input.response, body, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "tiangong-research-broker", version: "1" },
      });
      return;
    }
    if (body.method === "tools/list") {
      sendRpcResult(input.response, body, {
        tools: [
          {
            name: "fetch_candidate_source",
            description:
              "Fetch one bounded HTTPS candidate source through a locked capability, persist the raw response, and return content-addressed provenance plus a bounded context view.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["capability_id", "url"],
              properties: {
                capability_id: { type: "string" },
                credential_id: {
                  type: "string",
                  description:
                    "Logical credential ID. It is selected automatically when the capability declares exactly one credential.",
                },
                url: { type: "string" },
                json_pointer: { type: "string" },
                item_offset: { type: "integer", minimum: 0 },
                max_items: { type: "integer", minimum: 1 },
                cache_mode: {
                  enum: ["prefer", "bypass"],
                  description:
                    "Defaults to bypass for credentialed requests and prefer for public requests. Credentialed responses are never cached.",
                },
              },
            },
          },
        ],
      });
      return;
    }
    if (body.method === "tools/call") {
      const params = body.params;
      if (
        !isObject(params) ||
        params.name !== "fetch_candidate_source" ||
        !isObject(params.arguments)
      ) {
        sendToolError(input.response, body, "Unsupported tool call.");
        return;
      }
      try {
        const receipt = await fetchCandidateSource({
          root: input.root,
          projectId: input.projectId,
          capsuleProject: input.capsuleProject,
          capabilities: input.capabilities,
          credentialMap: input.credentialMap,
          workspaceResponseBytes: input.workspaceResponseBytes,
          workspaceContextTokens: input.workspaceContextTokens,
          workspaceMaxItems: input.workspaceMaxItems,
          arguments: params.arguments,
        });
        sendRpcResult(input.response, body, {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
        });
      } catch (error) {
        const detail =
          error instanceof CliError
            ? JSON.stringify({ code: error.code, message: error.message, details: error.details })
            : error instanceof Error
              ? error.message
              : String(error);
        sendToolError(
          input.response,
          body,
          sanitizeResearchText(detail, [...input.credentialMap.values()]),
        );
      }
      return;
    }
    sendRpcError(input.response, body, -32601, "Method not found");
  } catch (error) {
    sendJson(input.response, 500, {
      error: sanitizeResearchText(error instanceof Error ? error.message : String(error), [
        ...input.credentialMap.values(),
      ]),
    });
  }
}

async function fetchCandidateSource(input: {
  root: string;
  projectId: string;
  capsuleProject: string;
  capabilities: CapabilityDeclaration[];
  credentialMap: Map<string, string>;
  workspaceResponseBytes: number;
  workspaceContextTokens: number;
  workspaceMaxItems: number;
  arguments: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const capabilityId = input.arguments.capability_id;
  const credentialId = input.arguments.credential_id;
  const rawUrl = input.arguments.url;
  const jsonPointer = input.arguments.json_pointer;
  const requestedItemOffset = input.arguments.item_offset ?? 0;
  const requestedMaxItems = input.arguments.max_items;
  const requestedCacheMode = input.arguments.cache_mode;
  if (typeof capabilityId !== "string" || typeof rawUrl !== "string") {
    throw new Error("capability_id and url are required strings");
  }
  if (credentialId !== undefined && typeof credentialId !== "string") {
    throw new Error("credential_id must be a string when provided");
  }
  if (
    jsonPointer !== undefined &&
    (typeof jsonPointer !== "string" || !validJsonPointer(jsonPointer))
  ) {
    throw new Error("json_pointer must be an RFC 6901 JSON Pointer when provided");
  }
  if (
    typeof requestedItemOffset !== "number" ||
    !Number.isInteger(requestedItemOffset) ||
    requestedItemOffset < 0
  ) {
    throw new Error("item_offset must be a non-negative integer when provided");
  }
  if (
    requestedMaxItems !== undefined &&
    (typeof requestedMaxItems !== "number" ||
      !Number.isInteger(requestedMaxItems) ||
      requestedMaxItems < 1)
  ) {
    throw new Error("max_items must be a positive integer when provided");
  }
  if (
    requestedCacheMode !== undefined &&
    requestedCacheMode !== "prefer" &&
    requestedCacheMode !== "bypass"
  ) {
    throw new Error('cache_mode must be "prefer" or "bypass"');
  }
  const capability = input.capabilities.find((candidate) => candidate.id === capabilityId);
  if (!capability)
    throw new Error(`capability is not admitted for brokered network: ${capabilityId}`);
  const target = validateHttpsUrl(rawUrl);
  if (!capability.http) throw new Error(`capability has no broker HTTP policy: ${capabilityId}`);
  const credential = credentialId
    ? capability.credentials.find((candidate) => candidate.id === credentialId)
    : capability.credentials.length === 1
      ? capability.credentials[0]
      : undefined;
  if (credentialId && !credential) {
    throw new Error(`credential is not declared by capability ${capabilityId}: ${credentialId}`);
  }
  if (!credentialId && capability.credentials.length > 1) {
    throw new Error(`credential_id is required by capability ${capabilityId}`);
  }
  const effectiveCredentialId = credential?.id ?? null;
  const cacheMode = requestedCacheMode ?? (credential ? "bypass" : "prefer");
  if (credential && cacheMode === "prefer") {
    throw new Error("credentialed broker requests require cache_mode=bypass");
  }
  assertAllowedHost(target, capability.allowedHosts, "capability");
  if (credential) assertAllowedHost(target, credential.allowedHosts, "credential");
  const attemptId = randomUUID();
  const maxItems = Math.min(
    (requestedMaxItems as number | undefined) ?? capability.http.maxItems,
    capability.http.maxItems,
    input.workspaceMaxItems,
  );
  const cacheKeySha256 = sha256Text(
    canonicalJson({
      capabilityId,
      targetSha256: sha256Text(target.toString()),
      accept: capability.http.accept,
    }),
  );
  await appendJournalEvent(
    workspacePaths(input.root).journal,
    "capability.fetch.attempted",
    input.projectId,
    {
      attemptId,
      projectId: input.projectId,
      capabilityId,
      credentialId: effectiveCredentialId,
      targetSha256: sha256Text(target.toString()),
      cacheMode,
      cacheKeySha256,
    },
  );
  try {
    if (cacheMode === "prefer") {
      const cached = await loadBrokerEvidenceCache(input.root, cacheKeySha256);
      if (cached) {
        const raw = await readFile(
          resolveContained(workspacePaths(input.root).control, cached.locator),
        );
        const context = buildContextView(
          raw,
          cached.contentType,
          jsonPointer as string | undefined,
          requestedItemOffset,
          maxItems,
          input.workspaceContextTokens * BROKER_CONTEXT_BYTES_PER_TOKEN,
        );
        const receipt = await persistBrokerEvidence(
          input.root,
          {
            attemptId,
            projectId: input.projectId,
            capabilityId,
            credentialId: null,
            status: cached.status,
            contentType: cached.contentType,
            sourceSha256: cached.sourceSha256,
            contextItems: context.items,
            contextOffset: context.offset,
            contextTotalItems: context.totalItems,
            contextNextOffset: context.nextOffset,
            contextTruncated: context.truncated,
            retrievedAt: cached.retrievedAt,
            cacheHit: true,
          },
          raw,
          context.bytes,
        );
        await stageContextObject(input.capsuleProject, receipt.contextLocator, context.bytes);
        await appendCompletedReceipt(input.root, input.projectId, receipt, cacheKeySha256);
        return brokerToolResult(receipt, context.bytes, cached.contentType);
      }
    }
    const headers = new Headers({ Accept: capability.http.accept });
    if (credential) {
      const value = input.credentialMap.get(credential.id);
      if (!value) throw new Error(`credential value is not configured: ${credential.id}`);
      headers.set(credential.headerName, `${credential.prefix}${value}`);
    }
    const { response, finalUrl } = await fetchWithRedirectPolicy(
      target,
      headers,
      capability.allowedHosts,
      credential?.allowedHosts,
    );
    const responseLimit = Math.min(capability.http.maxResponseBytes, input.workspaceResponseBytes);
    const announcedLength = Number(response.headers.get("content-length") ?? "0");
    if (response.ok && announcedLength > responseLimit)
      throw new Error("response exceeds the broker size limit");
    const bytes = await readBoundedResponseBody(
      response,
      response.ok ? responseLimit : Math.min(responseLimit, MAX_ERROR_RESPONSE_BYTES),
      !response.ok,
    );
    for (const secret of input.credentialMap.values()) {
      if (bytes.includes(Buffer.from(secret, "utf8"))) {
        throw new Error("response failed credential disclosure screening");
      }
    }
    const contentType =
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "application/octet-stream";
    if (!response.ok) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      const excerpt = safeResponseExcerpt(bytes, contentType, [...input.credentialMap.values()]);
      throw new CliError(`HTTPS source returned status ${response.status}.`, {
        code: "RESEARCH_BROKER_HTTP_ERROR",
        exitCode: 3,
        details: {
          status: response.status,
          retryAfterSeconds,
          responseExcerpt: excerpt,
          requestId: safeResponseId(response.headers),
        },
      });
    }
    if (!contentTypeAllowed(contentType, capability.http.allowedContentTypes)) {
      throw new CliError(`HTTPS source returned unsupported content type ${contentType}.`, {
        code: "RESEARCH_BROKER_CONTENT_TYPE_INVALID",
        exitCode: 3,
        details: { contentType, allowedContentTypes: capability.http.allowedContentTypes },
      });
    }
    assertNoSensitiveResponseMaterial(bytes, contentType);
    const context = buildContextView(
      bytes,
      contentType,
      jsonPointer as string | undefined,
      requestedItemOffset,
      maxItems,
      input.workspaceContextTokens * BROKER_CONTEXT_BYTES_PER_TOKEN,
    );
    const receipt = await persistBrokerEvidence(
      input.root,
      {
        attemptId,
        projectId: input.projectId,
        capabilityId,
        credentialId: effectiveCredentialId,
        status: response.status,
        contentType,
        sourceSha256: sha256Text(finalUrl.toString()),
        contextItems: context.items,
        contextOffset: context.offset,
        contextTotalItems: context.totalItems,
        contextNextOffset: context.nextOffset,
        contextTruncated: context.truncated,
        retrievedAt: new Date().toISOString(),
        cacheHit: false,
      },
      bytes,
      context.bytes,
    );
    await stageContextObject(input.capsuleProject, receipt.contextLocator, context.bytes);
    if (!credential) await storeBrokerEvidenceCache(input.root, cacheKeySha256, receipt);
    await appendCompletedReceipt(input.root, input.projectId, receipt, cacheKeySha256);
    return brokerToolResult(receipt, context.bytes, contentType);
  } catch (error) {
    const safeDetails =
      error instanceof CliError && isObject(error.details)
        ? sanitizeResearchRecord(error.details, [...input.credentialMap.values()])
        : {};
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "capability.fetch.failed",
      input.projectId,
      {
        attemptId,
        capabilityId,
        credentialId: effectiveCredentialId,
        error: bounded(
          sanitizeResearchText(error instanceof Error ? error.message : String(error), [
            ...input.credentialMap.values(),
          ]),
          500,
        ),
        failureKind: brokerFailureKind(error),
        ...safeDetails,
      },
    );
    throw error;
  }
}

function brokerToolResult(
  receipt: object,
  context: Buffer,
  contentType: string,
): Record<string, unknown> {
  const inline = contentType.includes("json") || contentType.startsWith("text/");
  return {
    ...Object.fromEntries(Object.entries(receipt)),
    boundedContext: {
      encoding: inline ? "utf8" : "not-inlined",
      text: inline ? context.toString("utf8") : null,
    },
  };
}

function assertNoSensitiveResponseMaterial(bytes: Buffer, contentType: string): void {
  if (!contentType.includes("json") && !contentType.startsWith("text/")) return;
  const text = bytes.toString("utf8");
  if (
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/i.test(text) ||
    /\b(authorization|cookie|set-cookie|x-api-key|api-key)\s*:/i.test(text) ||
    /\b(access_token|api[_-]?key|apikey|password|secret|session|token)\s*=/i.test(text)
  ) {
    throw new Error("response contains credential-like material and was not persisted");
  }
  if (!contentType.includes("json")) return;
  try {
    const value = JSON.parse(text) as unknown;
    if (containsSensitiveJsonField(value)) {
      throw new Error("response contains credential-like material and was not persisted");
    }
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

function containsSensitiveJsonField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveJsonField);
  if (!isObject(value)) return false;
  const sensitive =
    /^(access_token|api[_-]?key|apikey|authorization|cookie|password|secret|session|token)$/i;
  return Object.entries(value).some(
    ([key, item]) =>
      (sensitive.test(key) && item !== null && item !== "") || containsSensitiveJsonField(item),
  );
}

async function stageContextObject(
  capsuleProject: string,
  locator: string,
  bytes: Uint8Array,
): Promise<void> {
  const destination = resolveContained(capsuleProject, locator);
  await ensureDirectory(dirname(destination));
  try {
    await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!Buffer.from(await readFile(destination)).equals(Buffer.from(bytes))) {
      throw new Error("staged broker context object failed its integrity check");
    }
  }
}

async function appendCompletedReceipt(
  root: string,
  projectId: string,
  receipt: Awaited<ReturnType<typeof persistBrokerEvidence>>,
  cacheKeySha256: string,
): Promise<void> {
  await appendJournalEvent(workspacePaths(root).journal, "capability.fetch.completed", projectId, {
    attemptId: receipt.attemptId,
    projectId: receipt.projectId,
    capabilityId: receipt.capabilityId,
    credentialId: receipt.credentialId,
    status: receipt.status,
    contentType: receipt.contentType,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    sourceSha256: receipt.sourceSha256,
    locator: receipt.locator,
    contextLocator: receipt.contextLocator,
    contextSha256: receipt.contextSha256,
    contextBytes: receipt.contextBytes,
    contextEstimatedTokens: receipt.contextEstimatedTokens,
    contextItems: receipt.contextItems,
    contextOffset: receipt.contextOffset ?? 0,
    contextTotalItems: receipt.contextTotalItems ?? null,
    contextNextOffset: receipt.contextNextOffset ?? null,
    contextTruncated: receipt.contextTruncated,
    retrievedAt: receipt.retrievedAt,
    servedAt: receipt.servedAt,
    cacheHit: receipt.cacheHit,
    cacheKeySha256,
  });
}

async function fetchWithRedirectPolicy(
  initialUrl: URL,
  headers: Headers,
  capabilityHosts: string[],
  credentialHosts: string[] | undefined,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertAllowedHost(current, capabilityHosts, "capability");
    if (credentialHosts) assertAllowedHost(current, credentialHosts, "credential");
    const response = await fetch(current, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current };
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("HTTPS source returned a redirect without a location");
    if (redirects === 5) throw new Error("HTTPS source exceeded the redirect limit");
    current = validateHttpsUrl(new URL(location, current).toString());
  }
  throw new Error("HTTPS source exceeded the redirect limit");
}

function assertAllowedHost(url: URL, allowedHosts: string[], scope: string): void {
  if (!allowedHosts.includes(url.host)) {
    throw new Error(`target host is outside ${scope} scope: ${url.host}`);
  }
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  truncate = false,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        await reader.cancel();
        if (truncate) {
          const remaining = maxBytes - chunks.reduce((sum, item) => sum + item.length, 0);
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          break;
        }
        throw new Error("response exceeds the broker size limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function buildContextView(
  bytes: Buffer,
  contentType: string,
  jsonPointer: string | undefined,
  itemOffset: number,
  maxItems: number,
  maxContextBytes: number,
): {
  bytes: Buffer;
  items: number | null;
  offset: number;
  totalItems: number | null;
  nextOffset: number | null;
  truncated: boolean;
} {
  if (!Number.isInteger(maxContextBytes) || maxContextBytes < 1) {
    throw new Error("broker context byte limit is invalid");
  }
  if (!contentType.includes("json")) {
    if (itemOffset !== 0) throw new Error("item_offset is supported only for JSON collections");
    const boundedBytes = contentType.startsWith("text/")
      ? truncateUtf8(bytes, maxContextBytes)
      : bytes.subarray(0, maxContextBytes);
    return {
      bytes: boundedBytes,
      items: null,
      offset: 0,
      totalItems: null,
      nextOffset: null,
      truncated: boundedBytes.byteLength < bytes.byteLength,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("JSON response body is not valid JSON");
  }
  const selected = jsonPointer === undefined ? parsed : resolveJsonPointer(parsed, jsonPointer);
  if (Array.isArray(selected)) {
    const limited: unknown[] = [];
    for (const item of selected.slice(itemOffset, itemOffset + maxItems)) {
      const candidate = [...limited, item];
      if (jsonBytes(candidate).byteLength > maxContextBytes) break;
      limited.push(item);
    }
    const nextOffset =
      itemOffset + limited.length < selected.length ? itemOffset + limited.length : null;
    return {
      bytes: jsonBytes(limited),
      items: limited.length,
      offset: itemOffset,
      totalItems: selected.length,
      nextOffset,
      truncated: itemOffset > 0 || nextOffset !== null,
    };
  }
  if (isObject(selected)) {
    const entries = Object.entries(selected);
    const limited: Array<[string, unknown]> = [];
    for (const entry of entries.slice(itemOffset, itemOffset + maxItems)) {
      const candidate = [...limited, entry];
      if (jsonBytes(Object.fromEntries(candidate)).byteLength > maxContextBytes) break;
      limited.push(entry);
    }
    const nextOffset =
      itemOffset + limited.length < entries.length ? itemOffset + limited.length : null;
    return {
      bytes: jsonBytes(Object.fromEntries(limited)),
      items: limited.length,
      offset: itemOffset,
      totalItems: entries.length,
      nextOffset,
      truncated: itemOffset > 0 || nextOffset !== null,
    };
  }
  if (itemOffset !== 0) throw new Error("item_offset is supported only for JSON collections");
  const encoded = jsonBytes(selected);
  if (encoded.byteLength <= maxContextBytes) {
    return {
      bytes: encoded,
      items: 1,
      offset: 0,
      totalItems: 1,
      nextOffset: null,
      truncated: false,
    };
  }
  if (typeof selected !== "string") {
    throw new Error("selected JSON scalar exceeds the broker context token limit");
  }
  const characters = [...selected];
  let lower = 0;
  let upper = characters.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (jsonBytes(characters.slice(0, middle).join("")).byteLength <= maxContextBytes) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return {
    bytes: jsonBytes(characters.slice(0, lower).join("")),
    items: 1,
    offset: 0,
    totalItems: 1,
    nextOffset: null,
    truncated: true,
  };
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function truncateUtf8(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.byteLength <= maxBytes) return bytes;
  let end = maxBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    const candidate = bytes.subarray(0, end);
    try {
      decoder.decode(candidate);
      return Buffer.from(candidate);
    } catch {
      end -= 1;
    }
  }
  return Buffer.alloc(0);
}

function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let selected = value;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      Array.isArray(selected) &&
      /^(0|[1-9][0-9]*)$/.test(part) &&
      Number(part) < selected.length
    ) {
      selected = selected[Number(part)];
    } else if (isObject(selected) && Object.hasOwn(selected, part)) {
      selected = selected[part];
    } else {
      throw new Error("json_pointer does not resolve within the response");
    }
  }
  return selected;
}

function validJsonPointer(value: string): boolean {
  return value === "" || (value.startsWith("/") && !/~(?:[^01]|$)/.test(value));
}

function contentTypeAllowed(contentType: string, allowed: string[]): boolean {
  const normalized = contentType.toLowerCase();
  return allowed.some((pattern) => {
    const candidate = pattern.toLowerCase();
    if (candidate === "*/*" || candidate === normalized) return true;
    const escaped = candidate.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`).test(normalized);
  });
}

function safeResponseExcerpt(bytes: Buffer, contentType: string, secrets: string[]): string {
  if (!contentType.includes("json") && !contentType.startsWith("text/")) {
    return `[${bytes.length} non-text byte(s)]`;
  }
  return bounded(sanitizeResearchText(bytes.toString("utf8"), secrets).replace(/\s+/g, " "), 1000);
}

function safeResponseId(headers: Headers): string | null {
  for (const name of ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"]) {
    const value = headers.get(name)?.trim();
    if (value && /^[A-Za-z0-9._:-]{1,200}$/.test(value)) return value;
  }
  return null;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

function brokerFailureKind(error: unknown): string {
  if (error instanceof CliError && error.code === "RESEARCH_BROKER_HTTP_ERROR") {
    const status = isObject(error.details) ? error.details.status : undefined;
    if (status === 429) return "rate-limit";
    if (typeof status === "number" && status >= 500) return "server";
    return "deterministic";
  }
  return error instanceof TypeError ? "transient" : "deterministic";
}

function validateHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error("broker URL must be credential-free HTTPS");
  }
  return url;
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("MCP request exceeds its size limit");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendRpcResult(
  response: ServerResponse,
  request: Record<string, unknown>,
  result: unknown,
): void {
  sendJson(response, 200, { jsonrpc: "2.0", id: request.id ?? null, result });
}

function sendRpcError(
  response: ServerResponse,
  request: unknown,
  code: number,
  message: string,
): void {
  const id = isObject(request) ? (request.id ?? null) : null;
  sendJson(response, 200, { jsonrpc: "2.0", id, error: { code, message } });
}

function sendToolError(
  response: ServerResponse,
  request: Record<string, unknown>,
  message: string,
): void {
  sendRpcResult(response, request, {
    content: [{ type: "text", text: message }],
    isError: true,
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function bounded(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}
