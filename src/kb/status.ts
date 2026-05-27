import { isObject, responseData, stringField } from "../data.js";
import { HttpError } from "../errors.js";
import { jsonRequest } from "../http.js";
import type { KbConfig } from "./config.js";

const KB_DOCUMENT_STATUS_BATCH_LIMIT = 100;

export interface BulkStatusItem {
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

export async function batchDocumentStatuses(
  config: KbConfig,
  documentIds: string[],
): Promise<BulkStatusItem[]> {
  const statuses: BulkStatusItem[] = [];
  for (let index = 0; index < documentIds.length; index += KB_DOCUMENT_STATUS_BATCH_LIMIT) {
    const chunk = documentIds.slice(index, index + KB_DOCUMENT_STATUS_BATCH_LIMIT);
    try {
      const payload = await jsonRequest(config, "documents/status:batch", {
        method: "POST",
        body: JSON.stringify({ documentIds: chunk }),
      });
      statuses.push(...batchStatusItems(payload));
    } catch (error) {
      if (error instanceof HttpError && error.status && [404, 405, 501].includes(error.status)) {
        statuses.push(
          ...(await Promise.all(
            chunk.map(async (documentId) =>
              statusItemFromPayload(await getDocumentStatus(config, documentId), documentId),
            ),
          )),
        );
        continue;
      }
      throw error;
    }
  }
  return statuses;
}

export async function getDocumentStatus(config: KbConfig, documentId: string): Promise<unknown> {
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
