import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { appendEvidenceLedgerEvent, listEvidenceCandidates } from "./evidence-ledger.js";
import { sanitizeResearchValue } from "./sanitization.js";
import { canonicalJson, isObject, readJsonFile, sha256Text, workspacePaths } from "./storage.js";
import { StructuredOutputError } from "./schemas.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const nativeActivityRecordSchema = {
  $id: "https://schemas.tiangong.ai/research/native-activity-v1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "channel",
    "input",
    "candidateIds",
    "resultCount",
    "status",
    "challenge",
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    kind: {
      type: "string",
      enum: ["web-search", "database-search", "browser-navigation", "download", "file-inspection"],
    },
    channel: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
    input: {
      type: "string",
      minLength: 1,
      maxLength: 4_000,
      description:
        "Search query or target reference. It is sanitized, hashed, and never persisted verbatim.",
    },
    candidateIds: {
      type: "array",
      uniqueItems: true,
      maxItems: 100,
      items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
    },
    resultCount: { type: "integer", minimum: 0 },
    status: { type: "string", enum: ["completed", "blocked", "failed"] },
    challenge: {
      type: "string",
      enum: [
        "none",
        "login",
        "mfa",
        "captcha",
        "turnstile",
        "paywall",
        "security-warning",
        "authorization",
      ],
    },
  },
} as const;

export interface NativeActivityReceipt {
  activityId: string;
  projectId: string;
  stage: "discover" | "acquire";
  kind: string;
  channel: string;
  status: string;
  challenge: string;
  candidateIds: string[];
  resultCount: number;
  inputSha256: string;
  recordedAt: string;
}

export async function recordNativeResearchActivity(input: {
  root: string;
  projectId: string;
  value: Record<string, unknown>;
}): Promise<NativeActivityReceipt> {
  const value = sanitizeResearchValue(input.value);
  if (!isObject(value)) throw activityError("Native activity record must be a JSON object.");
  const allowed = new Set([
    "schemaVersion",
    "kind",
    "channel",
    "input",
    "candidateIds",
    "resultCount",
    "status",
    "challenge",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (
    unknown.length ||
    value.schemaVersion !== 1 ||
    ![
      "web-search",
      "database-search",
      "browser-navigation",
      "download",
      "file-inspection",
    ].includes(String(value.kind)) ||
    typeof value.channel !== "string" ||
    !IDENTIFIER.test(value.channel) ||
    typeof value.input !== "string" ||
    value.input.length < 1 ||
    value.input.length > 4_000 ||
    !Array.isArray(value.candidateIds) ||
    value.candidateIds.length > 100 ||
    value.candidateIds.some(
      (candidateId) => typeof candidateId !== "string" || !IDENTIFIER.test(candidateId),
    ) ||
    new Set(value.candidateIds).size !== value.candidateIds.length ||
    !Number.isInteger(value.resultCount) ||
    Number(value.resultCount) < 0 ||
    !["completed", "blocked", "failed"].includes(String(value.status)) ||
    ![
      "none",
      "login",
      "mfa",
      "captcha",
      "turnstile",
      "paywall",
      "security-warning",
      "authorization",
    ].includes(String(value.challenge))
  ) {
    throw activityError("Native activity record failed validation.");
  }
  if (value.challenge !== "none" && value.status !== "blocked") {
    throw activityError("A native challenge must be recorded with blocked status.");
  }
  const project = await readJsonFile<Record<string, unknown>>(
    join(workspacePaths(input.root).projects, input.projectId, "project.json"),
    `Research project ${input.projectId}`,
  );
  const packages = Array.isArray(project.packages) ? project.packages : [];
  const active = packages.find(
    (workPackage) =>
      isObject(workPackage) &&
      (workPackage.stage === "discover" || workPackage.stage === "acquire") &&
      workPackage.status === "running" &&
      workPackage.executor === "producer",
  );
  if (!isObject(active) || (active.stage !== "discover" && active.stage !== "acquire")) {
    throw activityError(
      "Native activity may be recorded only during an active discover or acquire stage.",
    );
  }
  const stage = active.stage;
  const kind = String(value.kind);
  if (
    (stage === "discover" && ["download", "file-inspection"].includes(kind)) ||
    (stage === "acquire" && ["web-search", "database-search"].includes(kind))
  ) {
    throw activityError(`Native ${kind} activity is not valid during ${stage}.`);
  }
  const candidateIds = value.candidateIds as string[];
  const known = new Set(
    (await listEvidenceCandidates(input.root, input.projectId)).map((candidate) => candidate.id),
  );
  const missing = candidateIds.filter((candidateId) => !known.has(candidateId));
  if (missing.length) {
    throw activityError(`Native activity refers to unknown candidates: ${missing.join(", ")}.`);
  }
  const recordedAt = new Date().toISOString();
  const receipt: NativeActivityReceipt = {
    activityId: `activity-${randomUUID()}`,
    projectId: input.projectId,
    stage,
    kind,
    channel: value.channel,
    status: String(value.status),
    challenge: String(value.challenge),
    candidateIds,
    resultCount: Number(value.resultCount),
    inputSha256: sha256Text(value.input),
    recordedAt,
  };
  await appendEvidenceLedgerEvent(input.root, input.projectId, "activity.recorded", {
    ...receipt,
    receiptSha256: sha256Text(canonicalJson(receipt)),
  });
  return receipt;
}

function activityError(message: string): StructuredOutputError {
  return new StructuredOutputError(message, { validation: [message] });
}
