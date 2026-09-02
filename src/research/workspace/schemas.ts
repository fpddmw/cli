import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { CliError } from "../../errors.js";
import { sanitizeResearchValue } from "./sanitization.js";
import { canonicalJson, isObject } from "./storage.js";
import type { AgentPackageStage } from "./types.js";

export type StructuredStage = AgentPackageStage | "doctor";
export type JsonSchema = Record<string, unknown>;

export interface StageSchemaContext {
  inputOnlyProvenanceIds?: string[];
}

const IDENTIFIER = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const SHA256 = "^[0-9a-f]{64}$";
const nonEmptyString = { type: "string", minLength: 1 } as const;
const nullableString = { type: ["string", "null"] } as const;
const nullablePublicationDate = {
  type: ["string", "null"],
  pattern: "^[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?$",
} as const;
const nullableDateOnly = {
  type: ["string", "null"],
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
} as const;

const provenanceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id"],
  properties: {
    kind: { type: "string", enum: ["input", "broker", "data"] },
    id: { type: "string", pattern: IDENTIFIER },
  },
} as const;

const evidenceSourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "title",
    "locator",
    "relevance",
    "provenance",
    "sourceType",
    "retrievedAt",
    "fullTextAvailable",
    "url",
    "doi",
    "publicationDate",
    "excerpt",
    "jsonPointer",
    "quality",
    "applicability",
    "coverageDimensions",
  ],
  properties: {
    id: { type: "string", pattern: IDENTIFIER },
    title: nonEmptyString,
    locator: nonEmptyString,
    relevance: nonEmptyString,
    provenance: provenanceSchema,
    sourceType: { type: "string", pattern: IDENTIFIER },
    retrievedAt: nonEmptyString,
    fullTextAvailable: {
      type: "boolean",
      description:
        "True when an exact full source is permanently registered for review; bounded producer staging does not make this false.",
    },
    url: nullableString,
    doi: nullableString,
    publicationDate: nullablePublicationDate,
    excerpt: nullableString,
    jsonPointer: nullableString,
    quality: {
      type: "object",
      additionalProperties: false,
      required: ["level", "rationale"],
      properties: {
        level: {
          type: "string",
          enum: ["primary", "secondary", "tertiary", "unknown"],
        },
        rationale: nonEmptyString,
      },
    },
    applicability: nonEmptyString,
    coverageDimensions: {
      type: "array",
      items: { type: "string", pattern: IDENTIFIER },
    },
  },
} as const;

const evidenceSchema: JsonSchema = {
  $id: "https://schemas.tiangong.ai/research/evidence-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "sources", "limitations", "coverage"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    sources: { type: "array", items: evidenceSourceSchema },
    limitations: { type: "array", items: { type: "string" } },
    coverage: {
      type: "object",
      additionalProperties: false,
      required: [
        "dimensions",
        "sourceTypes",
        "fullTextSources",
        "datedSources",
        "publicationDateRange",
        "decision",
        "gaps",
      ],
      properties: {
        dimensions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "status", "sourceIds"],
            properties: {
              id: { type: "string", pattern: IDENTIFIER },
              status: { type: "string", enum: ["covered", "partial", "missing"] },
              sourceIds: {
                type: "array",
                items: { type: "string", pattern: IDENTIFIER },
              },
            },
          },
        },
        sourceTypes: {
          type: "array",
          items: { type: "string", pattern: IDENTIFIER },
        },
        fullTextSources: { type: "integer", minimum: 0 },
        datedSources: {
          type: "integer",
          minimum: 0,
          description: "Number of admitted sources with a non-null valid publicationDate.",
        },
        publicationDateRange: {
          type: "object",
          description:
            "Normalized admitted publication range: YYYY expands to Jan 1/Dec 31 and YYYY-MM expands to the first/last day of that month.",
          additionalProperties: false,
          required: ["earliest", "latest"],
          properties: {
            earliest: nullableDateOnly,
            latest: nullableDateOnly,
          },
        },
        decision: { type: "string", enum: ["pass", "insufficient"] },
        gaps: { type: "array", items: { type: "string" } },
      },
    },
  },
};

const discoveryCloseoutSchema: JsonSchema = {
  $id: "https://schemas.tiangong.ai/research/discovery-closeout-v2.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "limitations", "dimensionJudgments", "gaps"],
  properties: {
    schemaVersion: { type: "integer", const: 2 },
    limitations: { type: "array", items: { type: "string" } },
    dimensionJudgments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status"],
        properties: {
          id: { type: "string", pattern: IDENTIFIER },
          status: { type: "string", enum: ["covered", "partial", "missing"] },
        },
      },
    },
    gaps: { type: "array", items: { type: "string" } },
  },
};

const discoveryAssessmentBatchSchema: JsonSchema = {
  $id: "https://schemas.tiangong.ai/research/discovery-assessment-batch-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "assessments"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    assessments: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: [
              "decision",
              "candidateId",
              "sourceId",
              "sourceType",
              "relevance",
              "quality",
              "applicability",
              "coverageDimensions",
              "limitations",
            ],
            properties: {
              decision: { type: "string", const: "admit" },
              candidateId: { type: "string", pattern: IDENTIFIER },
              sourceId: { type: "string", pattern: IDENTIFIER },
              sourceType: { type: "string", pattern: IDENTIFIER },
              relevance: nonEmptyString,
              quality: {
                type: "object",
                additionalProperties: false,
                required: ["level", "rationale"],
                properties: {
                  level: {
                    type: "string",
                    enum: ["primary", "secondary", "tertiary", "unknown"],
                  },
                  rationale: nonEmptyString,
                },
              },
              applicability: nonEmptyString,
              coverageDimensions: {
                type: "array",
                items: { type: "string", pattern: IDENTIFIER },
              },
              limitations: { type: "array", items: { type: "string" } },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["decision", "candidateId", "reasonCode", "rationale"],
            properties: {
              decision: { type: "string", const: "reject" },
              candidateId: { type: "string", pattern: IDENTIFIER },
              reasonCode: { type: "string", pattern: IDENTIFIER },
              rationale: nonEmptyString,
            },
          },
        ],
      },
    },
  },
};

const acquisitionAuditSchema: JsonSchema = {
  $id: "https://schemas.tiangong.ai/research/acquisition-audit-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "decisions", "limitations", "gaps"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourceId", "candidateId", "artifactIds", "status", "rationale", "limitations"],
        properties: {
          sourceId: { type: "string", pattern: IDENTIFIER },
          candidateId: { type: "string", pattern: IDENTIFIER },
          artifactIds: {
            type: "array",
            items: { type: "string", pattern: IDENTIFIER },
          },
          status: { type: "string", enum: ["accepted", "limited", "rejected"] },
          rationale: nonEmptyString,
          limitations: { type: "array", items: { type: "string" } },
        },
      },
    },
    limitations: {
      type: "array",
      items: { type: "string" },
      description:
        "Non-blocking scope limits or intentional outcome blinding. Sealed result values are not missing evidence; future Policy obligations belong in the scientific design.",
    },
    gaps: {
      type: "array",
      items: { type: "string" },
      description:
        "Unresolved blocking acquisition or coverage deficiencies. Every non-empty entry stops inference but does not prevent preserving an honest immutable acquisition audit.",
    },
  },
};

const analysisSchema: JsonSchema = {
  $id: "https://schemas.tiangong.ai/research/analysis-v2.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "inferenceSnapshotSha256", "analysisRun", "findings", "limitations"],
  properties: {
    schemaVersion: { type: "integer", const: 2 },
    inferenceSnapshotSha256: { type: "string", pattern: SHA256 },
    analysisRun: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "mode",
        "status",
        "implementationSha256s",
        "environmentSha256s",
        "inputArtifactSha256s",
        "command",
        "randomSeed",
        "limitations",
      ],
      properties: {
        id: { type: "string", pattern: IDENTIFIER },
        mode: { type: "string", enum: ["qualitative", "computational", "mixed"] },
        status: { type: "string", enum: ["reproduced", "not-applicable"] },
        implementationSha256s: {
          type: "array",
          items: { type: "string", pattern: SHA256 },
        },
        environmentSha256s: {
          type: "array",
          items: { type: "string", pattern: SHA256 },
        },
        inputArtifactSha256s: {
          type: "array",
          items: { type: "string", pattern: SHA256 },
        },
        command: { type: ["string", "null"] },
        randomSeed: { type: ["string", "null"] },
        limitations: { type: "array", items: { type: "string" } },
      },
    },
    findings: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "statement",
          "evidence",
          "evidenceAtomIds",
          "claimIds",
          "analysisArtifactSha256s",
          "uncertainty",
          "applicability",
        ],
        properties: {
          id: { type: "string", pattern: IDENTIFIER },
          statement: nonEmptyString,
          evidence: {
            type: "array",
            minItems: 1,
            items: { type: "string", pattern: IDENTIFIER },
          },
          evidenceAtomIds: {
            type: "array",
            items: { type: "string", pattern: IDENTIFIER },
          },
          claimIds: {
            type: "array",
            items: { type: "string", pattern: IDENTIFIER },
          },
          analysisArtifactSha256s: {
            type: "array",
            items: { type: "string", pattern: SHA256 },
          },
          uncertainty: nonEmptyString,
          applicability: nonEmptyString,
        },
      },
    },
    limitations: { type: "array", items: { type: "string" } },
  },
};

const synthesisSchema: JsonSchema = {
  $id: "https://schemas.tiangong.ai/research/synthesis-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "reportMarkdown"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    reportMarkdown: {
      type: "string",
      minLength: 20,
      description:
        "Complete Markdown with actual line-feed characters after JSON parsing. Encode JSON newlines once; never emit literal /n or double-escaped \\n markers.",
    },
  },
};

const reviewIssueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "severity", "message", "artifact"],
  properties: {
    code: { type: "string", pattern: IDENTIFIER },
    severity: { type: "string", enum: ["blocking", "major", "minor"] },
    message: nonEmptyString,
    artifact: nonEmptyString,
  },
} as const;

const doctorSchema: JsonSchema = {
  $id: "https://schemas.tiangong.ai/research/doctor-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean", const: true } },
};

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const validators = new Map<string, ValidateFunction>();

export class StructuredOutputError extends CliError {
  constructor(message: string, details?: unknown) {
    super(message, {
      code: "RESEARCH_STRUCTURED_OUTPUT_INVALID",
      exitCode: 3,
      details,
    });
  }
}

export function schemaForStage(
  stage: StructuredStage,
  reviewPacketSha256: string | null = null,
  context: StageSchemaContext = {},
): JsonSchema {
  if (stage === "discover") {
    void context;
    return structuredClone(discoveryCloseoutSchema);
  }
  if (stage === "acquire") return structuredClone(acquisitionAuditSchema);
  if (stage === "analyze") return structuredClone(analysisSchema);
  if (stage === "synthesize") return structuredClone(synthesisSchema);
  if (stage === "doctor") return structuredClone(doctorSchema);
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "packetSha256", "decision", "issues", "rationale"],
    properties: {
      schemaVersion: { type: "integer", const: 1 },
      packetSha256: reviewPacketSha256
        ? { type: "string", const: reviewPacketSha256 }
        : { type: "string", pattern: SHA256 },
      decision: { type: "string", enum: ["pass", "revise"] },
      issues: { type: "array", items: reviewIssueSchema },
      rationale: nonEmptyString,
    },
  };
  return schema;
}

export function schemaForDiscoveryAssessmentBatch(): JsonSchema {
  return structuredClone(discoveryAssessmentBatchSchema);
}

export function parseDiscoveryAssessmentBatch(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = sanitizeResearchValue(value);
  if (!isObject(sanitized)) {
    throw new StructuredOutputError("Discovery assessment batch must be a JSON object.");
  }
  const key = canonicalJson(discoveryAssessmentBatchSchema);
  const validate = validators.get(key) ?? compileValidator(key, discoveryAssessmentBatchSchema);
  if (!validate(sanitized)) {
    throw new StructuredOutputError("Discovery assessment batch failed its JSON Schema.", {
      validation: formatValidationErrors(validate.errors),
    });
  }
  const assessments = sanitized.assessments as Array<Record<string, unknown>>;
  const candidateIds = assessments.map((assessment) => assessment.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new StructuredOutputError(
      "Discovery assessment batch cannot assess one candidate more than once.",
    );
  }
  for (const [index, assessment] of assessments.entries()) {
    if (assessment.decision !== "admit") continue;
    const dimensions = assessment.coverageDimensions as unknown[];
    if (new Set(dimensions).size !== dimensions.length) {
      throw new StructuredOutputError(
        `Discovery assessment /assessments/${index}/coverageDimensions contains duplicates.`,
      );
    }
  }
  return sanitized;
}

export function parseStructuredStageOutput(
  stage: StructuredStage,
  raw: string,
  reviewPacketSha256: string | null = null,
): {
  value: Record<string, unknown>;
  fileContent: string;
  normalizations: Array<{ rule: string; replacements: number }>;
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new StructuredOutputError(`${stage} output is not valid JSON.`, {
      validation: error instanceof Error ? error.message : String(error),
    });
  }
  value = sanitizeResearchValue(value);
  if (!isObject(value)) {
    throw new StructuredOutputError(`${stage} output must be a JSON object.`);
  }
  const schema = schemaForStage(stage, reviewPacketSha256);
  const key = canonicalJson(schema);
  const validate = validators.get(key) ?? compileValidator(key, schema);
  if (!validate(value)) {
    throw new StructuredOutputError(`${stage} output failed its JSON Schema.`, {
      validation: formatValidationErrors(validate.errors),
    });
  }
  assertUniqueStringCollections(stage, value);
  if (stage === "synthesize") {
    const normalized = normalizeSynthesisMarkdown(String(value.reportMarkdown));
    value.reportMarkdown = normalized.content;
    return {
      value,
      fileContent: `${normalized.content.trimEnd()}\n`,
      normalizations:
        normalized.replacements > 0
          ? [
              {
                rule: "synthesis-markdown-newline-artifacts",
                replacements: normalized.replacements,
              },
            ]
          : [],
    };
  }
  return { value, fileContent: `${JSON.stringify(value, null, 2)}\n`, normalizations: [] };
}

export function parseEvidenceRecord(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new StructuredOutputError("Materialized evidence record is not valid JSON.", {
      validation: error instanceof Error ? error.message : String(error),
    });
  }
  value = sanitizeResearchValue(value);
  if (!isObject(value)) {
    throw new StructuredOutputError("Materialized evidence record must be a JSON object.");
  }
  const key = canonicalJson(evidenceSchema);
  const validate = validators.get(key) ?? compileValidator(key, evidenceSchema);
  if (!validate(value)) {
    throw new StructuredOutputError("Materialized evidence record failed its JSON Schema.", {
      validation: formatValidationErrors(validate.errors),
    });
  }
  const sources = value.sources as Array<Record<string, unknown>>;
  const sourceIds = sources.map((source) => source.id);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new StructuredOutputError("Materialized evidence source IDs must be unique.");
  }
  for (const [index, source] of sources.entries()) {
    const dimensions = source.coverageDimensions as unknown[];
    if (new Set(dimensions).size !== dimensions.length) {
      throw new StructuredOutputError(
        `Materialized evidence /sources/${index}/coverageDimensions contains duplicates.`,
      );
    }
  }
  return value;
}

function normalizeSynthesisMarkdown(markdown: string): {
  content: string;
  replacements: number;
} {
  let replacements = 0;
  const content = markdown.replace(
    /(?:\/n|\\n){1,3}(?=(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\|))/gm,
    (artifact) => {
      const markers = artifact.match(/(?:\/n|\\n)/g)?.length ?? 0;
      replacements += markers;
      return "\n".repeat(markers);
    },
  );
  return { content, replacements };
}

function assertUniqueStringCollections(stage: StructuredStage, value: Record<string, unknown>) {
  const collections: Array<{ path: string; value: unknown }> = [];
  if (stage === "discover") {
    const dimensions = Array.isArray(value.dimensionJudgments) ? value.dimensionJudgments : [];
    collections.push({
      path: "/dimensionJudgments/ids",
      value: dimensions.map((item) => (isObject(item) ? item.id : null)),
    });
  }
  if (stage === "acquire") {
    const decisions = Array.isArray(value.decisions) ? value.decisions : [];
    collections.push({
      path: "/decisions/sourceIds",
      value: decisions.map((item) => (isObject(item) ? item.sourceId : null)),
    });
    for (const [index, decision] of decisions.entries()) {
      if (isObject(decision)) {
        collections.push({
          path: `/decisions/${index}/artifactIds`,
          value: decision.artifactIds,
        });
      }
    }
  }
  if (stage === "analyze") {
    const analysisRun = isObject(value.analysisRun) ? value.analysisRun : {};
    collections.push({
      path: "/analysisRun/implementationSha256s",
      value: analysisRun.implementationSha256s,
    });
    collections.push({
      path: "/analysisRun/environmentSha256s",
      value: analysisRun.environmentSha256s,
    });
    collections.push({
      path: "/analysisRun/inputArtifactSha256s",
      value: analysisRun.inputArtifactSha256s,
    });
    const findings = Array.isArray(value.findings) ? value.findings : [];
    for (const [index, finding] of findings.entries()) {
      if (isObject(finding)) {
        collections.push({ path: `/findings/${index}/evidence`, value: finding.evidence });
        collections.push({
          path: `/findings/${index}/evidenceAtomIds`,
          value: finding.evidenceAtomIds,
        });
        collections.push({ path: `/findings/${index}/claimIds`, value: finding.claimIds });
        collections.push({
          path: `/findings/${index}/analysisArtifactSha256s`,
          value: finding.analysisArtifactSha256s,
        });
      }
    }
  }
  const duplicates = collections
    .filter(({ value: collection }) => {
      if (!Array.isArray(collection)) return false;
      return new Set(collection).size !== collection.length;
    })
    .map(({ path }) => `${path} must not contain duplicates`);
  if (duplicates.length > 0) {
    throw new StructuredOutputError(`${stage} output failed semantic validation.`, {
      validation: duplicates,
    });
  }
}

function compileValidator(key: string, schema: JsonSchema): ValidateFunction {
  const validate = ajv.compile(schema);
  validators.set(key, validate);
  return validate;
}

export function formatValidationErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 20).map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message ?? "is invalid"}`;
  });
}
