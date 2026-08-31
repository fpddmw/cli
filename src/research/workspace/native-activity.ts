import { randomUUID } from "node:crypto";

import { CliError } from "../../errors.js";
import { resolveAgentAcquisitionRoute } from "./acquisition-routes.js";
import { activeDiscoveryRecovery, inspectDiscoveryRecoveryFloor } from "./discovery-recovery.js";
import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  listEvidenceCandidates,
} from "./evidence-ledger.js";
import { readJournal } from "./journal.js";
import { loadProject } from "./projects.js";
import { sanitizeResearchValue } from "./sanitization.js";
import { canonicalJson, isObject, sha256Text } from "./storage.js";
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
    acquisitionRouteId: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      description:
        "Required for a project with a frozen scientific design; binds this event to one exact planned agent route.",
    },
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
    seedCandidateIds: {
      type: "array",
      uniqueItems: true,
      minItems: 1,
      maxItems: 100,
      items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
      description:
        "Required only during a bounded Discover recovery; every value must be a frozen legal seed candidate.",
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
  acquisitionRouteId: string | null;
  stage: "discover" | "acquire";
  kind: string;
  channel: string;
  status: string;
  challenge: string;
  candidateIds: string[];
  seedCandidateIds: string[];
  recoveryContractSha256: string | null;
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
    "acquisitionRouteId",
    "kind",
    "channel",
    "input",
    "candidateIds",
    "seedCandidateIds",
    "resultCount",
    "status",
    "challenge",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (
    unknown.length ||
    value.schemaVersion !== 1 ||
    (value.acquisitionRouteId !== undefined &&
      (typeof value.acquisitionRouteId !== "string" ||
        !IDENTIFIER.test(value.acquisitionRouteId))) ||
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
    (value.seedCandidateIds !== undefined &&
      (!Array.isArray(value.seedCandidateIds) ||
        value.seedCandidateIds.length < 1 ||
        value.seedCandidateIds.length > 100 ||
        value.seedCandidateIds.some(
          (candidateId) => typeof candidateId !== "string" || !IDENTIFIER.test(candidateId),
        ) ||
        new Set(value.seedCandidateIds).size !== value.seedCandidateIds.length)) ||
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
  const project = await loadProject(input.root, input.projectId);
  const active = project.packages.find(
    (workPackage) =>
      (workPackage.stage === "discover" || workPackage.stage === "acquire") &&
      workPackage.status === "running" &&
      workPackage.executor === "producer",
  );
  if (!active || (active.stage !== "discover" && active.stage !== "acquire")) {
    throw activityError(
      "Native activity may be recorded only during an active discover or acquire stage.",
    );
  }
  const stage = active.stage;
  const kind = String(value.kind);
  if (stage === "discover" && ["download", "file-inspection"].includes(kind)) {
    throw activityError(`Native ${kind} activity is not valid during ${stage}.`);
  }
  const discoveryActivity = ["web-search", "database-search"].includes(kind);
  const routeClasses = discoveryActivity
    ? (["native-discovery"] as const)
    : kind === "browser-navigation"
      ? (["authorized-browser"] as const)
      : (["open-access-download", "authorized-browser"] as const);
  const route = await resolveAgentAcquisitionRoute({
    root: input.root,
    project,
    routeId: value.acquisitionRouteId,
    routeClasses: [...routeClasses],
    ...(discoveryActivity
      ? {
          activityKind: value.kind as "web-search" | "database-search",
          activityChannel: value.channel,
        }
      : {}),
  });
  const candidateIds = value.candidateIds as string[];
  const recovery = activeDiscoveryRecovery(project);
  const seedCandidateIds = (value.seedCandidateIds ?? []) as string[];
  if (recovery) {
    if ((await inspectDiscoveryRecoveryFloor(input.root, project)).minimumSatisfied) {
      throw recoveryActivityError(
        "The closest-work recovery floor is already satisfied; no further citation chase is allowed.",
      );
    }
    if (!recovery.activeRouteIds.includes(route!.id)) {
      throw recoveryActivityError("Native activity is outside the frozen citation-chase routes.");
    }
    if (
      seedCandidateIds.length < 1 ||
      seedCandidateIds.some((candidateId) => !recovery.seedCandidateIds.includes(candidateId))
    ) {
      throw recoveryActivityError(
        "Bounded citation-chase activity must identify one or more frozen legal seed candidates.",
      );
    }
    const priorRecoveryActivities = (
      await readJournal(evidenceLedgerPath(input.root, project.id))
    ).filter(
      (event) =>
        event.type === "activity.recorded" &&
        event.payload.recoveryContractSha256 === recovery.contractSha256,
    ).length;
    if (priorRecoveryActivities >= recovery.maxNativeCitationChaseActivities) {
      throw recoveryActivityError("The bounded citation-chase activity allowance is exhausted.");
    }
  } else if (seedCandidateIds.length) {
    throw recoveryActivityError(
      "seedCandidateIds are valid only during an active bounded Discover recovery.",
    );
  }
  const known = new Set(
    (await listEvidenceCandidates(input.root, input.projectId)).map((candidate) => candidate.id),
  );
  const missing = candidateIds.filter((candidateId) => !known.has(candidateId));
  missing.push(...seedCandidateIds.filter((candidateId) => !known.has(candidateId)));
  if (missing.length) {
    throw activityError(`Native activity refers to unknown candidates: ${missing.join(", ")}.`);
  }
  const recordedAt = new Date().toISOString();
  const receipt: NativeActivityReceipt = {
    activityId: `activity-${randomUUID()}`,
    projectId: input.projectId,
    acquisitionRouteId: route?.id ?? null,
    stage,
    kind,
    channel: value.channel,
    status: String(value.status),
    challenge: String(value.challenge),
    candidateIds,
    seedCandidateIds,
    recoveryContractSha256: recovery?.contractSha256 ?? null,
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

function recoveryActivityError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_DISCOVERY_RECOVERY_SCOPE_VIOLATION",
    exitCode: 3,
  });
}
