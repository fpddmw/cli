import { CliError } from "../../errors.js";
import { canonicalJson, isObject, sha256Text } from "./storage.js";
import type { TaskObjectReader } from "./task-contract.js";

const HASH = /^[a-f0-9]{64}$/;
export const requestProvenanceInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "source", "explanation"],
  properties: {
    mode: { enum: ["verbatim", "interpreted", "reconstructed"] },
    source: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text", "locator"],
          properties: {
            kind: { enum: ["user-message", "user-file"] },
            text: { type: "string", minLength: 1 },
            locator: { type: ["string", "null"], minLength: 1 },
          },
        },
      ],
    },
    explanation: { type: "string", minLength: 8, maxLength: 4000 },
  },
};

export interface RequestProvenance {
  mode: "verbatim" | "interpreted" | "reconstructed" | "unrecorded";
  source: {
    kind: "user-message" | "user-file";
    objectSha256: string;
    textSha256: string;
    bytes: number;
    locatorSha256: string | null;
  } | null;
  explanation: string;
  authorshipVerified: false;
}

export interface RequestSource {
  schemaVersion: 1;
  kind: "tiangong-request-source";
  text: string;
  objectSha256: string;
}

export function unrecordedRequestProvenance(): RequestProvenance {
  return {
    mode: "unrecorded",
    source: null,
    explanation:
      "Original request source was not recorded; no retrospective provenance is inferred.",
    authorshipVerified: false,
  };
}

/** Intake is schema/sanitization checked by the task contract before this projection. */
export function prepareRequestProvenance(
  originalRequest: string,
  value: unknown,
): {
  binding: RequestProvenance;
  sourceObject: RequestSource | null;
} {
  if (value === undefined) return { binding: unrecordedRequestProvenance(), sourceObject: null };
  if (
    !isObject(value) ||
    typeof value.explanation !== "string" ||
    value.explanation.trim().length < 8
  )
    throw invalid();
  const source = isObject(value.source) ? value.source : null;
  if (
    ((value.mode === "verbatim" || value.mode === "interpreted") && !source) ||
    (value.mode === "verbatim" && source?.text !== originalRequest)
  )
    throw invalid();
  const core = source
    ? {
        schemaVersion: 1 as const,
        kind: "tiangong-request-source" as const,
        text: source.text as string,
      }
    : null;
  const sourceObject = core ? { ...core, objectSha256: sha256Text(canonicalJson(core)) } : null;
  return {
    binding: {
      mode: value.mode as RequestProvenance["mode"],
      source:
        source && sourceObject
          ? {
              kind: source.kind as "user-message" | "user-file",
              objectSha256: sourceObject.objectSha256,
              textSha256: sha256Text(sourceObject.text),
              bytes: Buffer.byteLength(sourceObject.text),
              locatorSha256: typeof source.locator === "string" ? sha256Text(source.locator) : null,
            }
          : null,
      explanation: value.explanation as string,
      authorshipVerified: false,
    },
    sourceObject,
  };
}

/** Shared live/fork/portable-audit validation; a hash proves bytes, not who authored them. */
export async function verifyRequestProvenance(
  originalRequest: string,
  provenance: RequestProvenance | undefined,
  read: TaskObjectReader,
) {
  if (!provenance) return;
  if (
    !["verbatim", "interpreted", "reconstructed", "unrecorded"].includes(provenance.mode) ||
    provenance.authorshipVerified !== false ||
    typeof provenance.explanation !== "string" ||
    provenance.explanation.trim().length < 8 ||
    Object.keys(provenance).sort().join(",") !== "authorshipVerified,explanation,mode,source"
  )
    throw invalid();
  const source = provenance.source;
  if (!source) {
    if (source !== null || !["reconstructed", "unrecorded"].includes(provenance.mode))
      throw invalid();
    return;
  }
  if (
    provenance.mode === "unrecorded" ||
    !["user-message", "user-file"].includes(source.kind) ||
    !HASH.test(source.objectSha256) ||
    !HASH.test(source.textSha256) ||
    !Number.isSafeInteger(source.bytes) ||
    source.bytes < 1 ||
    (source.locatorSha256 !== null && !HASH.test(source.locatorSha256)) ||
    Object.keys(source).sort().join(",") !== "bytes,kind,locatorSha256,objectSha256,textSha256"
  )
    throw invalid();
  const object = await read<RequestSource>("request-sources", source.objectSha256, "objectSha256");
  if (
    object.schemaVersion !== 1 ||
    object.kind !== "tiangong-request-source" ||
    typeof object.text !== "string" ||
    sha256Text(object.text) !== source.textSha256 ||
    Buffer.byteLength(object.text) !== source.bytes ||
    Object.keys(object).sort().join(",") !== "kind,objectSha256,schemaVersion,text" ||
    (provenance.mode === "verbatim" && object.text !== originalRequest)
  )
    throw invalid();
}

function invalid() {
  return new CliError(
    "Request provenance must bind its exact supplied source. Verbatim means byte-identical wording; reconstruction is not authenticated authorship.",
    {
      code: "RESEARCH_REQUEST_PROVENANCE_INVALID",
      exitCode: 3,
    },
  );
}
