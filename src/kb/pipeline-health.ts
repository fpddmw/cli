import { isObject, responseData, stringField } from "../data.js";
import { CliError, HttpError } from "../errors.js";
import { jsonRequest } from "../http.js";
import type { KbConfig } from "./config.js";

export interface BulkPipelineHealthSnapshot {
  healthy: boolean;
  pressure: "ok" | "degraded" | "paused" | "unknown";
  recommendedAction: "continue" | "slow_down" | "pause_top_up";
  recommendedPollAfterSeconds: number;
  checkedAt?: string | undefined;
  reason?: string | undefined;
  message?: string | undefined;
}

export async function readBulkPipelineHealth(
  config: KbConfig,
  fallbackPollAfterSeconds: number,
  selectorFields: Record<string, string> = {},
): Promise<BulkPipelineHealthSnapshot> {
  try {
    const payload = await jsonRequest(config, pipelineHealthPath(selectorFields));
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

function pipelineHealthPath(selectorFields: Record<string, string>) {
  const params = new URLSearchParams();
  for (const key of ["primary_collection_id", "collection_path", "collection_key"]) {
    const value = selectorFields[key];
    if (value) params.set(key, value);
  }

  const query = params.toString();
  return query ? `pipeline/health?${query}` : "pipeline/health";
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
    reason: stringField(data, "reason"),
    message:
      stringField(data, "message") ??
      stringField(data, "reason") ??
      (isObject(data.indexPreflight) ? stringField(data.indexPreflight, "message") : undefined),
  };
}
