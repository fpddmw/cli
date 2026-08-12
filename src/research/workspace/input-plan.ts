import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import { RESEARCH_CONTROL_DIRECTORY } from "./constants.js";
import { canonicalJson, fileSize, sha256File, sha256Text } from "./storage.js";
import type {
  ProjectInput,
  ProjectInputPlan,
  ProjectInputPlanEntry,
  ProjectInputTrustStatus,
  VerifiedProjectInputPlan,
  VerifiedProjectInputPlanEntry,
} from "./types.js";

const REQUIREMENT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export async function readAndVerifyProjectInputPlan(
  inputPlanPath: string,
): Promise<VerifiedProjectInputPlan> {
  if (!isAbsolute(inputPlanPath) || resolve(inputPlanPath) !== inputPlanPath) {
    throw new CliError("--input-plan must be an absolute JSON file path.", {
      code: "RESEARCH_INPUT_PLAN_INVALID",
      exitCode: 2,
    });
  }
  const info = await lstat(inputPlanPath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new CliError("Research input plan must be a regular JSON file.", {
      code: "RESEARCH_INPUT_PLAN_INVALID",
      exitCode: 2,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(inputPlanPath, "utf8"));
  } catch {
    throw new CliError("Research input plan is missing or invalid JSON.", {
      code: "RESEARCH_INPUT_PLAN_INVALID",
      exitCode: 2,
    });
  }
  if (!isProjectInputPlan(parsed)) {
    throw new CliError("Research input plan has an unsupported shape.", {
      code: "RESEARCH_INPUT_PLAN_INVALID",
      exitCode: 2,
    });
  }
  const normalized: ProjectInputPlan = {
    schemaVersion: 1,
    inputs: parsed.inputs.map(normalizeInputPlanEntry).sort(compareInputPlanEntries),
  };
  const inputs: VerifiedProjectInputPlanEntry[] = [];
  const hashes = new Set<string>();
  const contextHashes = new Set<string>();
  for (const entry of normalized.inputs) {
    const verified = await verifyInputPlanEntry(entry);
    if (hashes.has(verified.sha256)) {
      throw new CliError("Research input plan cannot count the same content more than once.", {
        code: "RESEARCH_INPUT_PLAN_DUPLICATE",
        exitCode: 2,
        details: { sha256: verified.sha256 },
      });
    }
    hashes.add(verified.sha256);
    if (verified.contextSha256 && contextHashes.has(verified.contextSha256)) {
      throw new CliError("Research input plan cannot reuse the same bounded context.", {
        code: "RESEARCH_INPUT_PLAN_DUPLICATE",
        exitCode: 2,
        details: { sha256: verified.contextSha256 },
      });
    }
    if (verified.contextSha256) contextHashes.add(verified.contextSha256);
    inputs.push(verified);
  }
  inputs.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    sha256: sha256Text(canonicalJson(normalized)),
    inputs,
  };
}

export async function reverifyProjectInputPlan(
  plan: VerifiedProjectInputPlan,
): Promise<VerifiedProjectInputPlan> {
  const normalized: ProjectInputPlan = {
    schemaVersion: 1,
    inputs: plan.inputs
      .map((entry) =>
        normalizeInputPlanEntry({
          path: entry.path,
          contextPath: entry.contextPath ?? null,
          contextRanges: entry.contextRanges ?? null,
          role: entry.role,
          dimensions: entry.dimensions,
          sourceType: entry.sourceType,
          fullText: entry.fullText,
          publicationDate: entry.publicationDate,
          ...(entry.trustStatus ? { trustStatus: entry.trustStatus } : {}),
          ...(entry.independentlyReproduced !== undefined
            ? { independentlyReproduced: entry.independentlyReproduced }
            : {}),
        }),
      )
      .sort(compareInputPlanEntries),
  };
  const planSha256 = sha256Text(canonicalJson(normalized));
  if (planSha256 !== plan.sha256) {
    throw new CliError("Research input plan metadata changed before project admission.", {
      code: "RESEARCH_INPUT_PLAN_CHANGED",
      exitCode: 3,
    });
  }
  const inputs: VerifiedProjectInputPlanEntry[] = [];
  const hashes = new Set<string>();
  const contextHashes = new Set<string>();
  for (const entry of normalized.inputs) {
    const verified = await verifyInputPlanEntry(entry);
    const expected = plan.inputs.find((candidate) => candidate.id === verified.id);
    if (
      !expected ||
      expected.sha256 !== verified.sha256 ||
      expected.bytes !== verified.bytes ||
      expected.contextSha256 !== verified.contextSha256 ||
      expected.contextBytes !== verified.contextBytes ||
      (verified.contextSha256 !== null && contextHashes.has(verified.contextSha256)) ||
      hashes.has(verified.sha256)
    ) {
      throw new CliError("Research input plan content changed before project admission.", {
        code: "RESEARCH_INPUT_PLAN_CHANGED",
        exitCode: 3,
      });
    }
    hashes.add(verified.sha256);
    if (verified.contextSha256) contextHashes.add(verified.contextSha256);
    inputs.push(verified);
  }
  inputs.sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: 1, sha256: planSha256, inputs };
}

export function projectInputsFromPlan(
  plan: VerifiedProjectInputPlan,
  addedAt: string,
): ProjectInput[] {
  return plan.inputs.map((entry) => ({
    id: entry.id,
    role: entry.role,
    path: entry.path,
    sha256: entry.sha256,
    bytes: entry.bytes,
    ...((entry.contextPath || entry.contextRanges?.length) &&
    entry.contextSha256 &&
    entry.contextBytes !== null
      ? {
          ...(entry.contextPath ? { contextPath: entry.contextPath } : {}),
          contextSha256: entry.contextSha256,
          contextBytes: entry.contextBytes,
        }
      : {}),
    ...(entry.contextRanges && entry.contextRanges.length
      ? { contextRanges: entry.contextRanges.map((range) => ({ ...range })) }
      : {}),
    sourceType: entry.sourceType,
    dimensions: [...entry.dimensions],
    fullText: entry.fullText,
    publicationDate: entry.publicationDate,
    trustStatus: entry.trustStatus ?? defaultInputTrustStatus(entry.role),
    independentlyReproduced: entry.independentlyReproduced ?? false,
    addedAt,
  }));
}

function isProjectInputPlan(value: unknown): value is ProjectInputPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ProjectInputPlan>;
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.inputs) &&
    candidate.inputs.length > 0 &&
    candidate.inputs.every(isProjectInputPlanEntry)
  );
}

function isProjectInputPlanEntry(value: unknown): value is ProjectInputPlanEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ProjectInputPlanEntry>;
  return (
    typeof candidate.path === "string" &&
    (candidate.contextPath === undefined ||
      candidate.contextPath === null ||
      typeof candidate.contextPath === "string") &&
    (candidate.contextRanges === undefined ||
      candidate.contextRanges === null ||
      (Array.isArray(candidate.contextRanges) &&
        candidate.contextRanges.length > 0 &&
        candidate.contextRanges.length <= 128 &&
        candidate.contextRanges.every(isInputLineRange))) &&
    (candidate.role === "primary" ||
      candidate.role === "reference" ||
      candidate.role === "replication") &&
    Array.isArray(candidate.dimensions) &&
    candidate.dimensions.length > 0 &&
    candidate.dimensions.every((item) => typeof item === "string") &&
    typeof candidate.sourceType === "string" &&
    typeof candidate.fullText === "boolean" &&
    (candidate.publicationDate === null || typeof candidate.publicationDate === "string") &&
    (candidate.trustStatus === undefined || validTrustStatus(candidate.trustStatus)) &&
    (candidate.independentlyReproduced === undefined ||
      typeof candidate.independentlyReproduced === "boolean")
  );
}

function normalizeInputPlanEntry(entry: ProjectInputPlanEntry): ProjectInputPlanEntry {
  const dimensions = [...new Set(entry.dimensions.map(normalizeRequirementId))].sort();
  const sourceType = normalizeRequirementId(entry.sourceType);
  if (
    dimensions.length === 0 ||
    dimensions.some((item) => !REQUIREMENT_ID_PATTERN.test(item)) ||
    !REQUIREMENT_ID_PATTERN.test(sourceType) ||
    !validDate(entry.publicationDate)
  ) {
    throw new CliError("Research input plan contains invalid coverage metadata.", {
      code: "RESEARCH_INPUT_PLAN_INVALID",
      exitCode: 2,
    });
  }
  const contextRanges = entry.contextRanges
    ? [...entry.contextRanges]
        .map((range) => ({ ...range }))
        .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
    : null;
  if (entry.contextPath && contextRanges) {
    throw new CliError("Use either contextPath or contextRanges for a research input, not both.", {
      code: "RESEARCH_INPUT_PLAN_INVALID",
      exitCode: 2,
    });
  }
  if (
    contextRanges?.some(
      (range, index) => index > 0 && range.startLine <= contextRanges[index - 1]!.endLine,
    )
  ) {
    throw new CliError("Research input context line ranges must not overlap.", {
      code: "RESEARCH_INPUT_PLAN_INVALID",
      exitCode: 2,
    });
  }
  return {
    ...entry,
    contextPath: entry.contextPath ?? null,
    contextRanges,
    dimensions,
    sourceType,
    trustStatus: entry.trustStatus ?? defaultInputTrustStatus(entry.role),
    independentlyReproduced: entry.independentlyReproduced ?? false,
  };
}

function defaultInputTrustStatus(role: ProjectInput["role"]): ProjectInputTrustStatus {
  if (role === "reference") return "reference-only";
  if (role === "replication") return "replication-candidate";
  return "unverified-owner-input";
}

function validTrustStatus(value: unknown): boolean {
  return [
    "verified-owner-input",
    "unverified-owner-input",
    "reference-only",
    "replication-candidate",
  ].includes(String(value));
}

async function verifyInputPlanEntry(
  entry: ProjectInputPlanEntry,
): Promise<VerifiedProjectInputPlanEntry> {
  const source = await verifyRegularInputFile(entry.path);
  const context = entry.contextPath
    ? await verifyRegularInputFile(entry.contextPath)
    : entry.contextRanges
      ? await verifiedLineContext(entry.path, entry.contextRanges)
      : null;
  const stableSource = await verifyRegularInputFile(entry.path);
  if (stableSource.sha256 !== source.sha256 || stableSource.bytes !== source.bytes) {
    throw new CliError("A research input changed while its context was being verified.", {
      code: "RESEARCH_INPUT_PLAN_CHANGED",
      exitCode: 3,
    });
  }
  if (
    context &&
    (entry.contextPath === entry.path ||
      context.sha256 === source.sha256 ||
      context.bytes >= source.bytes)
  ) {
    throw new CliError(
      "A bounded input context must be distinct from and smaller than its full evidence file.",
      { code: "RESEARCH_INPUT_PLAN_INVALID", exitCode: 2 },
    );
  }
  return {
    ...entry,
    id: `input-${source.sha256.slice(0, 16)}`,
    sha256: source.sha256,
    bytes: source.bytes,
    contextSha256: context?.sha256 ?? null,
    contextBytes: context?.bytes ?? null,
  };
}

export async function renderInputLineContext(
  path: string,
  ranges: NonNullable<ProjectInputPlanEntry["contextRanges"]>,
): Promise<string> {
  const lines = (await readFile(path, "utf8")).replaceAll("\r\n", "\n").split("\n");
  const selected: string[] = [];
  for (const range of ranges) {
    if (range.endLine > lines.length) {
      throw new CliError("A research input context line range exceeds the source file.", {
        code: "RESEARCH_INPUT_PLAN_INVALID",
        exitCode: 2,
      });
    }
    selected.push(...lines.slice(range.startLine - 1, range.endLine));
  }
  return `${selected.join("\n")}\n`;
}

async function verifiedLineContext(
  path: string,
  ranges: NonNullable<ProjectInputPlanEntry["contextRanges"]>,
): Promise<{ sha256: string; bytes: number }> {
  const content = await renderInputLineContext(path, ranges);
  return { sha256: sha256Text(content), bytes: Buffer.byteLength(content, "utf8") };
}

async function verifyRegularInputFile(path: string): Promise<{ sha256: string; bytes: number }> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new CliError("Every research input plan path must be absolute.", {
      code: "RESEARCH_INPUT_PLAN_INVALID",
      exitCode: 2,
    });
  }
  if (path.split(sep).includes(RESEARCH_CONTROL_DIRECTORY)) {
    throw new CliError("Research input plans cannot reference a research control directory.", {
      code: "RESEARCH_INPUT_PLAN_INVALID",
      exitCode: 2,
    });
  }
  const before = await lstat(path).catch(() => undefined);
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new CliError("Every research input plan path must be a regular file.", {
      code: "RESEARCH_INPUT_PLAN_INVALID",
      exitCode: 2,
    });
  }
  const sha256 = await sha256File(path);
  const after = await lstat(path).catch(() => undefined);
  if (
    !after?.isFile() ||
    after.isSymbolicLink() ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new CliError("A research input changed while its plan was being verified.", {
      code: "RESEARCH_INPUT_PLAN_CHANGED",
      exitCode: 3,
    });
  }
  return { sha256, bytes: await fileSize(path) };
}

function normalizeRequirementId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-");
}

function isInputLineRange(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const range = value as Record<string, unknown>;
  return (
    Number.isInteger(range.startLine) &&
    Number(range.startLine) >= 1 &&
    Number.isInteger(range.endLine) &&
    Number(range.endLine) >= Number(range.startLine)
  );
}

function compareInputPlanEntries(
  left: ProjectInputPlanEntry,
  right: ProjectInputPlanEntry,
): number {
  return left.path.localeCompare(right.path);
}

function validDate(value: string | null): boolean {
  if (value === null) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
