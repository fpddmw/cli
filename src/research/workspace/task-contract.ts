import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import { loadBoundAcquisitionDesign } from "./acquisition-routes.js";
import { appendJournalEvent, readVerifiedJournal } from "./journal.js";
import { assertProjectAuthority, projectAuthorityIndex } from "./project-authority.js";
import {
  beginProjectMutation,
  prepareProjectMutation,
  projectMutationBinding,
  settleProjectMutation,
} from "./project-mutations.js";
import { loadProject } from "./projects.js";
import {
  prepareRequestProvenance,
  requestProvenanceInputSchema,
  unrecordedRequestProvenance,
  verifyRequestProvenance,
  type RequestProvenance,
  type RequestSource,
} from "./request-provenance.js";
import { configuredResearchSecrets, sanitizeResearchValue } from "./sanitization.js";
import {
  canonicalJson,
  isObject,
  pathExists,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "./storage.js";
import type { JournalEvent, ProjectState } from "./types.js";
import { withWorkspaceLock } from "./workspace.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const MAX_BYTES = 4 * 1024 * 1024;
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const ids = {
  type: "array",
  maxItems: 256,
  uniqueItems: true,
  items: { type: "string", pattern: ID },
};
const requirement = object({
  id: { type: "string", pattern: ID },
  text: { type: "string", minLength: 8, maxLength: 2000 },
  acceptance: { type: "string", minLength: 8, maxLength: 4000 },
  checkKind: { enum: ["evidence", "computation", "proof"] },
  designClaimIds: ids,
  coverageDimensionIds: ids,
});
const requirements = { type: "array", minItems: 1, maxItems: 256, items: requirement };
const inputSchemas = {
  "task-contract": {
    ...object({
      schemaVersion: { const: 1 },
      originalRequest: { type: "string", minLength: 8 },
      requirements,
      requestProvenance: requestProvenanceInputSchema,
    }),
    required: ["schemaVersion", "originalRequest", "requirements"],
  },
  "task-scope-change": object({
    schemaVersion: { const: 1 },
    reason: { type: "string", minLength: 8, maxLength: 4000 },
    requirements,
  }),
};
type TaskSchemaName = keyof typeof inputSchemas;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map<TaskSchemaName, ValidateFunction>();

export interface TaskRequirement {
  id: string;
  text: string;
  acceptance: string;
  checkKind: "evidence" | "computation" | "proof";
  designClaimIds: string[];
  coverageDimensionIds: string[];
}

export interface TaskContract {
  schemaVersion: 1;
  kind: "tiangong-research-task";
  projectId: string;
  version: number;
  questionSha256: string;
  originalRequest: string;
  requestProvenance?: RequestProvenance;
  requirements: TaskRequirement[];
  parentContractSha256: string | null;
  originalContractSha256: string | null;
  origin: { projectId: string; contractSha256: string } | null;
  authorization: { kind: "operator-confirmation"; proposalSha256: string } | null;
  contractSha256: string;
}

interface ScopeProposal {
  schemaVersion: 1;
  projectId: string;
  parentContractSha256: string;
  reason: string;
  requirements: TaskRequirement[];
  proposalSha256: string;
}

export interface ProjectTaskView {
  current: TaskContract;
  original: TaskContract;
  contracts: TaskContract[];
  events: JournalEvent[];
}

export type TaskObjectReader = <T>(group: string, hash: string, hashField: string) => Promise<T>;

export function latestTaskBinding(
  events: Array<Pick<JournalEvent, "scope" | "type" | "payload">>,
  projectId: string,
) {
  const latest = events.findLast(
    (event) =>
      event.scope === projectId &&
      (["project.task.defined", "project.task.scope.approved"].includes(event.type) ||
        (["project.forked", "project.addendum.created"].includes(event.type) &&
          isObject(event.payload.taskContract))),
  );
  return latest
    ? isObject(latest.payload.taskContract)
      ? latest.payload.taskContract
      : latest.payload
    : null;
}

export function isTaskSchemaName(value: string): value is TaskSchemaName {
  return Object.hasOwn(inputSchemas, value);
}

export function taskInputSchema(name: TaskSchemaName): Record<string, unknown> {
  return structuredClone({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:tiangong:research:${name}:v1`,
    ...inputSchemas[name],
  });
}

function validateInput(name: TaskSchemaName, value: unknown) {
  const validate = validators.get(name) ?? ajv.compile(taskInputSchema(name));
  validators.set(name, validate);
  if (
    Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_BYTES ||
    !validate(value) ||
    !isObject(value) ||
    canonicalJson(sanitizeResearchValue(value, configuredResearchSecrets(process.env))) !==
      canonicalJson(value)
  ) {
    throw invalid("Task input must match its closed schema and contain no credentials.");
  }
  const items = value.requirements as TaskRequirement[];
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some((item) => item.text.trim().length < 8 || item.acceptance.trim().length < 8)
  ) {
    throw invalid("Task requirements need unique stable IDs and meaningful acceptance conditions.");
  }
  return value;
}

export function taskRequirementSha256(item: TaskRequirement): string {
  return sha256Text(canonicalJson(item));
}

export async function loadProjectTask(
  root: string,
  projectId: string,
  knownEvents?: JournalEvent[],
): Promise<ProjectTaskView | null> {
  if (
    knownEvents === undefined &&
    !(await pathExists(join(workspacePaths(root).projects, projectId, "task")))
  )
    return null;
  const events = (knownEvents ?? (await readVerifiedJournal(workspacePaths(root).journal))).filter(
    (event) => event.scope === projectId,
  );
  const binding = latestTaskBinding(events, projectId);
  if (!binding) return null;
  const history = await loadTaskHistory(
    projectId,
    String(binding.contractSha256),
    <T>(group: string, hash: string, hashField: string) =>
      readTaskObject<T>(root, projectId, group, hash, hashField),
  );
  return { ...history, events };
}

/** Shared live/audit relationship validation over already hash-verified immutable objects. */
export async function loadTaskHistory(
  projectId: string,
  currentHash: string,
  read: TaskObjectReader,
) {
  const readContract = async (hash: string) =>
    validateTaskContract(await read<TaskContract>("contracts", hash, "contractSha256"));
  const current = await readContract(currentHash);
  if (current.projectId !== projectId)
    throw invalid("Current task contract belongs to another project.");
  const contracts = [current];
  const seen = new Set([current.contractSha256]);
  let cursor = current;
  while (cursor.parentContractSha256) {
    if (seen.has(cursor.parentContractSha256) || contracts.length >= 1000)
      throw invalid("Task history is cyclic or exceeds its bound.");
    const parent = await readContract(cursor.parentContractSha256);
    if (
      cursor.version !== parent.version + 1 ||
      cursor.originalRequest !== parent.originalRequest ||
      canonicalJson(cursor.requestProvenance ?? unrecordedRequestProvenance()) !==
        canonicalJson(parent.requestProvenance ?? unrecordedRequestProvenance()) ||
      (cursor.projectId !== parent.projectId &&
        (cursor.origin?.projectId !== parent.projectId ||
          cursor.origin.contractSha256 !== parent.contractSha256))
    ) {
      throw invalid("Task history parent identity is inconsistent.");
    }
    contracts.push(parent);
    seen.add(parent.contractSha256);
    cursor = parent;
  }
  const original = contracts.at(-1)!;
  await verifyRequestProvenance(original.originalRequest, original.requestProvenance, read);
  if (
    current.originalContractSha256 !== null &&
    current.originalContractSha256 !== original.contractSha256
  )
    throw invalid("Task original requirement binding drifted.");
  for (const contract of contracts) {
    if (!contract.authorization) continue;
    const proposal = await read<ScopeProposal>(
      "proposals",
      contract.authorization.proposalSha256,
      "proposalSha256",
    );
    if (
      proposal.parentContractSha256 !== contract.parentContractSha256 ||
      canonicalJson(proposal.requirements) !== canonicalJson(contract.requirements)
    )
      throw invalid("Task scope authorization does not bind this exact change.");
  }
  return { current, original, contracts };
}

export async function defineProjectTask(
  root: string,
  projectId: string,
  value: Record<string, unknown>,
) {
  const input = validateInput("task-contract", value);
  const provenance = prepareRequestProvenance(
    input.originalRequest as string,
    input.requestProvenance,
  );
  return withWorkspaceLock(root, "research.task.define", async () => {
    const project = await loadProject(root, projectId);
    const events = await readVerifiedJournal(workspacePaths(root).journal);
    assertProjectAuthority(project, projectAuthorityIndex(events));
    const existing = await loadProjectTask(root, projectId, events);
    if (existing) {
      if (
        existing.original.originalRequest !== input.originalRequest ||
        canonicalJson(existing.original.requestProvenance ?? unrecordedRequestProvenance()) !==
          canonicalJson(provenance.binding) ||
        canonicalJson(existing.original.requirements) !== canonicalJson(input.requirements)
      )
        throw invalid(
          "Original requirements cannot be overwritten; propose an explicit scope change.",
        );
      return taskBinding(existing.current, existing.original);
    }
    await assertTaskWindow(root, project, true);
    await validateTaskBindings(root, project, input.requirements as TaskRequirement[]);
    const contract = bindContract({
      schemaVersion: 1,
      kind: "tiangong-research-task",
      projectId,
      version: 1,
      questionSha256: sha256Text(project.question),
      originalRequest: input.originalRequest as string,
      requestProvenance: provenance.binding,
      requirements: input.requirements as TaskRequirement[],
      parentContractSha256: null,
      originalContractSha256: null,
      origin: null,
      authorization: null,
    });
    if (provenance.sourceObject) {
      await writeTaskObject(
        root,
        projectId,
        "request-sources",
        provenance.sourceObject.objectSha256,
        provenance.sourceObject,
      );
    }
    await writeTaskObject(root, projectId, "contracts", contract.contractSha256, contract);
    await appendJournalEvent(
      workspacePaths(root).journal,
      "project.task.defined",
      projectId,
      taskBinding(contract, contract),
    );
    return taskBinding(contract, contract);
  });
}

export async function proposeProjectTaskScope(
  root: string,
  projectId: string,
  expectedContractSha256: string,
  value: Record<string, unknown>,
) {
  const input = validateInput("task-scope-change", value);
  return withWorkspaceLock(root, "research.task.scope.propose", async () => {
    const project = await loadProject(root, projectId);
    const events = await readVerifiedJournal(workspacePaths(root).journal);
    assertProjectAuthority(project, projectAuthorityIndex(events));
    await assertTaskWindow(root, project, false);
    const view = await requireTask(root, projectId, events);
    if (view.current.contractSha256 !== expectedContractSha256) throw scopeConflict();
    const nextRequirements = input.requirements as TaskRequirement[];
    await validateTaskBindings(root, project, nextRequirements);
    const changes = scopeChanges(view.current.requirements, nextRequirements);
    if (
      ![
        changes.addedRequirementIds,
        changes.changedRequirementIds,
        changes.withdrawnRequirementIds,
      ].some((items) => items.length)
    ) {
      return {
        status: "unchanged",
        requiresApproval: false,
        contractSha256: view.current.contractSha256,
        changes,
      };
    }
    const core = {
      schemaVersion: 1 as const,
      projectId,
      parentContractSha256: expectedContractSha256,
      reason: input.reason as string,
      requirements: nextRequirements,
    };
    const proposal: ScopeProposal = { ...core, proposalSha256: sha256Text(canonicalJson(core)) };
    await writeTaskObject(root, projectId, "proposals", proposal.proposalSha256, proposal);
    if (
      !events.some(
        (event) =>
          event.scope === projectId &&
          event.type === "project.task.scope.proposed" &&
          event.payload.proposalSha256 === proposal.proposalSha256,
      )
    ) {
      await appendJournalEvent(
        workspacePaths(root).journal,
        "project.task.scope.proposed",
        projectId,
        { proposalSha256: proposal.proposalSha256, parentContractSha256: expectedContractSha256 },
      );
    }
    return {
      status: "proposed",
      requiresApproval: true,
      proposalSha256: proposal.proposalSha256,
      parentContractSha256: expectedContractSha256,
      changes,
    };
  });
}

export async function approveProjectTaskScope(
  root: string,
  projectId: string,
  proposalSha256: string,
  confirmation: string | undefined,
) {
  if (!HASH.test(proposalSha256) || confirmation !== proposalSha256) {
    throw new CliError(
      "Explicit operator authorization must name the exact reviewed scope-change hash; a producer approval field or generic continue instruction is not sufficient.",
      { code: "RESEARCH_TASK_SCOPE_APPROVAL_REQUIRED", exitCode: 3 },
    );
  }
  return withWorkspaceLock(root, "research.task.scope.approve", async () => {
    const project = await loadProject(root, projectId);
    const events = await readVerifiedJournal(workspacePaths(root).journal);
    assertProjectAuthority(project, projectAuthorityIndex(events));
    const replay = events.find(
      (event) =>
        event.scope === projectId &&
        event.type === "project.task.scope.approved" &&
        event.payload.proposalSha256 === proposalSha256,
    );
    if (replay) return { ...replay.payload, replayed: true };
    await assertTaskWindow(root, project, false);
    const view = await requireTask(root, projectId, events);
    const proposal = await readTaskObject<ScopeProposal>(
      root,
      projectId,
      "proposals",
      proposalSha256,
      "proposalSha256",
    );
    if (
      proposal.projectId !== projectId ||
      proposal.parentContractSha256 !== view.current.contractSha256 ||
      !events.some(
        (event) =>
          event.scope === projectId &&
          event.type === "project.task.scope.proposed" &&
          event.payload.proposalSha256 === proposalSha256,
      )
    )
      throw scopeConflict();
    validateInput("task-scope-change", {
      schemaVersion: 1,
      reason: proposal.reason,
      requirements: proposal.requirements,
    });
    await validateTaskBindings(root, project, proposal.requirements);
    const contract = bindContract({
      ...view.current,
      version: view.current.version + 1,
      requirements: proposal.requirements,
      parentContractSha256: view.current.contractSha256,
      originalContractSha256: view.original.contractSha256,
      authorization: { kind: "operator-confirmation", proposalSha256 },
    });
    await writeTaskObject(root, projectId, "contracts", contract.contractSha256, contract);
    const binding = {
      projectId,
      ...taskBinding(contract, view.original),
      proposalSha256,
      authorizationKind: "operator-confirmation",
    };
    if (project.scientificDesign) {
      let mutation = await beginProjectMutation(root, "task-scope", project, proposalSha256);
      try {
        const invalidatedScientificReviews = Object.entries(project.scientificDesign.gates)
          .filter(([, gate]) => gate.packetSha256 !== null)
          .map(([role, gate]) => ({ role, packetSha256: gate.packetSha256 }));
        for (const role of ["research-design", "evidence-construct", "pilot-methods"] as const) {
          project.scientificDesign.gates[role] = {
            status: "pending",
            packetSha256: null,
            assessmentSha256: null,
            reviewSha256: null,
            reviewerSessionSha256: null,
          };
        }
        project.updatedAt = new Date().toISOString();
        mutation = await prepareProjectMutation(root, mutation, project);
        await appendJournalEvent(
          workspacePaths(root).journal,
          "project.task.scope.approved",
          projectId,
          { ...binding, invalidatedScientificReviews, mutation: projectMutationBinding(mutation) },
        );
        await settleProjectMutation(root, mutation);
      } catch (error) {
        if (!(await settleProjectMutation(root, mutation))) throw error;
      }
    } else {
      await appendJournalEvent(
        workspacePaths(root).journal,
        "project.task.scope.approved",
        projectId,
        binding,
      );
    }
    return { ...binding, replayed: false };
  });
}

/** Materialize before a fork/addendum's existing commit; never copy completion claims. */
export async function inheritProjectTask(root: string, source: ProjectState, target: ProjectState) {
  const view = await loadProjectTask(root, source.id);
  if (!view) return null;
  const requestSource = view.original.requestProvenance?.source;
  if (requestSource) {
    const object = await readTaskObject<RequestSource>(
      root,
      source.id,
      "request-sources",
      requestSource.objectSha256,
      "objectSha256",
    );
    await writeTaskObject(root, target.id, "request-sources", object.objectSha256, object);
  }
  for (const contract of view.contracts) {
    await writeTaskObject(root, target.id, "contracts", contract.contractSha256, contract);
    if (contract.authorization) {
      const proposal = await readTaskObject<ScopeProposal>(
        root,
        source.id,
        "proposals",
        contract.authorization.proposalSha256,
        "proposalSha256",
      );
      await writeTaskObject(root, target.id, "proposals", proposal.proposalSha256, proposal);
    }
  }
  const contract = bindContract({
    ...view.current,
    projectId: target.id,
    questionSha256: sha256Text(target.question),
    version: view.current.version + 1,
    parentContractSha256: view.current.contractSha256,
    originalContractSha256: view.original.contractSha256,
    origin: { projectId: source.id, contractSha256: view.current.contractSha256 },
    authorization: null,
  });
  await writeTaskObject(root, target.id, "contracts", contract.contractSha256, contract);
  return taskBinding(contract, view.original);
}

export async function taskContext(root: string, projectId: string, knownEvents?: JournalEvent[]) {
  const view = await loadProjectTask(root, projectId, knownEvents);
  const active = new Set(view?.current.requirements.map(taskRequirementSha256));
  return view
    ? {
        ...taskBinding(view.current, view.original),
        originalRequest: view.original.originalRequest,
        requestProvenance: view.original.requestProvenance ?? unrecordedRequestProvenance(),
        requirements: view.current.requirements,
        originalRequirementRefs: view.original.requirements.map((item) => ({
          id: item.id,
          requirementSha256: taskRequirementSha256(item),
        })),
        originalOnlyRequirements: view.original.requirements.filter(
          (item) => !active.has(taskRequirementSha256(item)),
        ),
        origin: view.current.origin,
        executionCertified: false,
      }
    : null;
}

function taskBinding(current: TaskContract, original: TaskContract) {
  return {
    contractSha256: current.contractSha256,
    originalContractSha256: original.contractSha256,
    version: current.version,
  };
}

function bindContract(
  input: Omit<TaskContract, "contractSha256"> & { contractSha256?: string },
): TaskContract {
  const { contractSha256: _old, ...core } = input;
  return { ...core, contractSha256: sha256Text(canonicalJson(core)) };
}

function scopeChanges(previous: TaskRequirement[], next: TaskRequirement[]) {
  const prior = new Map(previous.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const nextIds = new Set(next.map((item) => item.id));
  return {
    details: [...new Set([...prior.keys(), ...nextById.keys()])]
      .filter(
        (id) => canonicalJson(prior.get(id) ?? null) !== canonicalJson(nextById.get(id) ?? null),
      )
      .map((id) => ({ id, before: prior.get(id) ?? null, after: nextById.get(id) ?? null })),
    addedRequirementIds: next.filter((item) => !prior.has(item.id)).map((item) => item.id),
    changedRequirementIds: next
      .filter(
        (item) => prior.has(item.id) && canonicalJson(prior.get(item.id)) !== canonicalJson(item),
      )
      .map((item) => item.id),
    withdrawnRequirementIds: previous
      .filter((item) => !nextIds.has(item.id))
      .map((item) => item.id),
  };
}

async function assertTaskWindow(root: string, project: ProjectState, initial: boolean) {
  if (
    project.handoff.state !== "agent-actionable" ||
    project.status === "complete" ||
    (initial &&
      project.scientificDesign &&
      Object.values(project.scientificDesign.gates).some(
        (gate) => gate.status !== "pending" || gate.packetSha256 !== null,
      )) ||
    (await pathExists(join(workspacePaths(root).projects, project.id, "native", "active.json"))) ||
    project.packages.some(
      (item) =>
        (initial || ["analyze", "synthesize", "review", "close"].includes(item.stage)) &&
        item.attempts > 0,
    )
  ) {
    throw new CliError(
      "Task definition/scope changes require an idle pre-analysis boundary. Original requirements must be recorded before execution or scientific review; use a new generation for later scientific changes.",
      { code: "RESEARCH_TASK_WINDOW_REQUIRED", exitCode: 3 },
    );
  }
}

async function validateTaskBindings(root: string, project: ProjectState, items: TaskRequirement[]) {
  const dimensions = new Set(project.evidenceRequirements.dimensions);
  if (items.some((item) => item.coverageDimensionIds.some((id) => !dimensions.has(id))))
    throw invalid(
      "Task coverage bindings must use the existing project dimensions; task scope approval cannot rewrite evidence requirements.",
    );
  if (!project.scientificDesign && items.some((item) => item.designClaimIds.length))
    throw invalid("Task design claims require a declared scientific design.");
  if (project.scientificDesign) {
    const claims = new Set(
      (await loadBoundAcquisitionDesign(root, project)).claims.map((claim) => claim.id),
    );
    if (items.some((item) => item.designClaimIds.some((id) => !claims.has(id))))
      throw invalid(
        "Task requirements must bind declared scientific claims; a scope change cannot invent a new design.",
      );
  }
}

async function requireTask(root: string, projectId: string, events: JournalEvent[]) {
  const view = await loadProjectTask(root, projectId, events);
  if (!view) throw invalid("Define the original task before proposing a scope change.");
  return view;
}

function validateTaskContract(record: TaskContract) {
  validateInput("task-contract", {
    schemaVersion: record.schemaVersion,
    originalRequest: record.originalRequest,
    requirements: record.requirements,
  });
  if (
    record.kind !== "tiangong-research-task" ||
    !Number.isInteger(record.version) ||
    record.version < 1 ||
    !HASH.test(record.questionSha256) ||
    (record.parentContractSha256 !== null && !HASH.test(record.parentContractSha256)) ||
    (record.originalContractSha256 !== null && !HASH.test(record.originalContractSha256)) ||
    (record.authorization !== null &&
      (record.authorization.kind !== "operator-confirmation" ||
        !HASH.test(record.authorization.proposalSha256)))
  )
    throw invalid("Stored task contract identity is invalid.");
  return record;
}

export async function writeTaskObject(
  root: string,
  projectId: string,
  group: string,
  hash: string,
  value: object,
) {
  if (!HASH.test(hash) || !/^[a-z-]+$/.test(group))
    throw invalid("Task object address is invalid.");
  const directory = await taskDirectory(root, projectId, group, true);
  const path = join(directory, `${hash}.json`);
  if (await pathExists(path)) {
    const existing = await readRegularJson(path);
    if (canonicalJson(existing) !== canonicalJson(value))
      throw invalid("Immutable task object changed; preserved bytes were not overwritten.");
  } else await writeJsonAtomic(path, value, 0o444);
}

export async function readTaskObject<T>(
  root: string,
  projectId: string,
  group: string,
  hash: string,
  hashField: string,
): Promise<T> {
  if (!HASH.test(hash) || !/^[a-z-]+$/.test(group))
    throw invalid("Task object address is invalid.");
  const directory = await taskDirectory(root, projectId, group, false);
  const record = await readRegularJson(join(directory, `${hash}.json`));
  return validateTaskObject<T>(record, hash, hashField);
}

export function validateTaskObject<T>(record: unknown, hash: string, hashField: string): T {
  if (!isObject(record)) throw invalid("Stored task object must be an object.");
  const { [hashField]: declared, ...core } = record;
  if (declared !== hash || sha256Text(canonicalJson(core)) !== hash)
    throw invalid("Stored task object failed its hash binding.");
  return record as T;
}

export async function taskDirectory(
  root: string,
  projectId: string,
  group: string,
  create: boolean,
) {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(projectId))
    throw invalid("Task project identity is invalid.");
  const paths = workspacePaths(root);
  const directories = [
    paths.control,
    paths.projects,
    join(paths.projects, projectId),
    join(paths.projects, projectId, "task"),
    join(paths.projects, projectId, "task", group),
  ];
  for (const directory of directories) {
    let info = await lstat(directory).catch(() => undefined);
    if (!info && create) {
      await mkdir(directory, { mode: 0o700 });
      info = await lstat(directory);
    }
    if (!info?.isDirectory() || info.isSymbolicLink())
      throw invalid("Task storage must use existing regular directories without symlinks.");
  }
  return directories.at(-1)!;
}

async function readRegularJson(path: string): Promise<unknown> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES)
    throw invalid("Task record must be a bounded regular file.");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw invalid("Task record is not valid JSON.");
  }
}

function invalid(message: string): CliError {
  return new CliError(message, { code: "RESEARCH_TASK_INVALID", exitCode: 3 });
}
function scopeConflict(): CliError {
  return new CliError("Task scope proposal no longer matches the current committed contract.", {
    code: "RESEARCH_TASK_SCOPE_CONFLICT",
    exitCode: 3,
  });
}
