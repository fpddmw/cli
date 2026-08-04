import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { CliError } from "../../errors.js";
import { loadCapabilityDeclarations, verifyCapabilities } from "./capabilities.js";
import { appendJournalEvent } from "./journal.js";
import {
  ensureDirectory,
  isObject,
  pathExists,
  sha256Bytes,
  sha256Text,
  workspacePaths,
} from "./storage.js";
import type { CapabilityDeclaration } from "./types.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

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
  const credentialMap = await loadCredentialMap(root, declarations.capabilities);
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
              "Fetch one HTTPS candidate source through a locked capability and record a value-free receipt.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["capability_id", "url"],
              properties: {
                capability_id: { type: "string" },
                credential_id: { type: "string" },
                url: { type: "string" },
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
          arguments: params.arguments,
        });
        sendRpcResult(input.response, body, {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
        });
      } catch (error) {
        sendToolError(input.response, body, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    sendRpcError(input.response, body, -32601, "Method not found");
  } catch (error) {
    sendJson(input.response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function fetchCandidateSource(input: {
  root: string;
  projectId: string;
  capsuleProject: string;
  capabilities: CapabilityDeclaration[];
  credentialMap: Map<string, string>;
  arguments: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const capabilityId = input.arguments.capability_id;
  const credentialId = input.arguments.credential_id;
  const rawUrl = input.arguments.url;
  if (typeof capabilityId !== "string" || typeof rawUrl !== "string") {
    throw new Error("capability_id and url are required strings");
  }
  if (credentialId !== undefined && typeof credentialId !== "string") {
    throw new Error("credential_id must be a string when provided");
  }
  const capability = input.capabilities.find((candidate) => candidate.id === capabilityId);
  if (!capability)
    throw new Error(`capability is not admitted for brokered network: ${capabilityId}`);
  const target = validateHttpsUrl(rawUrl);
  const credential = credentialId
    ? capability.credentials.find((candidate) => candidate.id === credentialId)
    : undefined;
  if (credentialId && !credential) {
    throw new Error(`credential is not declared by capability ${capabilityId}: ${credentialId}`);
  }
  assertAllowedHost(target, capability.allowedHosts, "capability");
  if (credential) assertAllowedHost(target, credential.allowedHosts, "credential");
  const attemptId = randomUUID();
  await appendJournalEvent(
    workspacePaths(input.root).journal,
    "capability.fetch.attempted",
    input.projectId,
    {
      attemptId,
      projectId: input.projectId,
      capabilityId,
      credentialId: credentialId ?? null,
      targetSha256: sha256Text(target.toString()),
    },
  );
  try {
    const headers = new Headers({
      Accept: "text/plain, application/json, text/html;q=0.9, */*;q=0.1",
    });
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
    const announcedLength = Number(response.headers.get("content-length") ?? "0");
    if (announcedLength > MAX_RESPONSE_BYTES)
      throw new Error("response exceeds the broker size limit");
    const bytes = await readBoundedResponseBody(response);
    for (const secret of input.credentialMap.values()) {
      if (bytes.includes(Buffer.from(secret, "utf8"))) {
        throw new Error("response failed credential disclosure screening");
      }
    }
    if (!response.ok) throw new Error(`HTTPS source returned status ${response.status}`);
    const contentType =
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "application/octet-stream";
    const extension = contentType.includes("json")
      ? "json"
      : contentType.startsWith("text/")
        ? "txt"
        : "bin";
    const destination = join(input.capsuleProject, "inputs", "broker", `${attemptId}.${extension}`);
    await ensureDirectory(join(input.capsuleProject, "inputs", "broker"));
    await writeFile(destination, bytes, { mode: 0o600 });
    const receipt = {
      attemptId,
      capabilityId,
      credentialId: credentialId ?? null,
      status: response.status,
      contentType,
      bytes: bytes.length,
      sha256: sha256Bytes(bytes),
      sourceSha256: sha256Text(finalUrl.toString()),
      path: relative(input.capsuleProject, destination).replaceAll("\\", "/"),
    };
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "capability.fetch.completed",
      input.projectId,
      receipt,
    );
    return receipt;
  } catch (error) {
    await appendJournalEvent(
      workspacePaths(input.root).journal,
      "capability.fetch.failed",
      input.projectId,
      {
        attemptId,
        capabilityId,
        credentialId: credentialId ?? null,
        error: bounded(error instanceof Error ? error.message : String(error), 500),
      },
    );
    throw error;
  }
}

async function loadCredentialMap(
  root: string,
  capabilities: CapabilityDeclaration[],
): Promise<Map<string, string>> {
  const path = workspacePaths(root).env;
  if (!(await pathExists(path))) return new Map();
  const content = await readFile(path, "utf8");
  const configured = new Map<string, string>();
  let foundConfiguration = false;
  const declared = new Set(
    capabilities.flatMap((capability) => capability.credentials.map((credential) => credential.id)),
  );
  for (const sourceLine of content.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    const key = equals > 0 ? line.slice(0, equals).trim() : "";
    if (key !== "TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON") {
      throw new Error(`unsupported research environment key: ${key || "missing"}`);
    }
    if (foundConfiguration) throw new Error("research credential configuration is duplicated");
    foundConfiguration = true;
    const value = JSON.parse(line.slice(equals + 1).trim() || "{}") as unknown;
    if (!isObject(value)) throw new Error("capability credentials must be a JSON object");
    for (const [credentialId, credentialValue] of Object.entries(value)) {
      if (!declared.has(credentialId))
        throw new Error(`credential is not declared: ${credentialId}`);
      if (typeof credentialValue !== "string" || Buffer.byteLength(credentialValue, "utf8") < 8) {
        throw new Error(`credential value is invalid: ${credentialId}`);
      }
      configured.set(credentialId, credentialValue);
    }
  }
  return configured;
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

async function readBoundedResponseBody(response: Response): Promise<Buffer> {
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
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response exceeds the broker size limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
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
