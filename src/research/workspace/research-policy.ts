import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { parseDocument } from "yaml";

import { CliError } from "../../errors.js";
import { appendJournalEvent } from "./journal.js";
import {
  canonicalJson,
  hashRegularTree,
  isObject,
  pathExists,
  readJsonFile,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "./storage.js";
import type { ResearchPolicyBinding, ResearchVerdictCeiling } from "./types.js";

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const POLICY_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,127}$/;
const MAX_POLICY_DOCUMENT_BYTES = 256 * 1024;
const MAX_POLICY_STACK_BYTES = 2 * 1024 * 1024;
const PLACEHOLDER_PATTERN = /__[A-Z0-9_]+__|\b(?:TODO|TBD)\b/;

const KNOWN_RULES = new Set([
  "all-material-claims-traceable",
  "alternative-explanations-tested",
  "authoritative-synthesis-required",
  "availability-contract-required",
  "baseline-comparison-required",
  "benchmark-comparison-required",
  "biological-or-clinical-relevance-required",
  "broad-editorial-significance-required",
  "central-claim-directly-supported",
  "central-claims-directly-supported",
  "central-outcome-observed",
  "characterization-and-uncertainty-required",
  "closest-prior-work-compared",
  "complete-candidate-disposition-required",
  "complete-domain-comparison-required",
  "conceptual-contribution-required",
  "construct-validity-required",
  "contribution-non-incremental",
  "counterargument-required",
  "cross-field-accessibility-required",
  "cross-field-significance-required",
  "design-supports-central-claim",
  "economic-significance-required",
  "empirical-boundaries-explicit",
  "ethics-and-governance-reviewed",
  "evidence-composition-reported",
  "exact-journal-article-type-confirmed",
  "exact-journal-guidelines-verified",
  "exact-journal-scope-confirmed",
  "field-agenda-contribution-required",
  "field-shaping-contribution-required",
  "final-frozen-manuscript-required",
  "final-manuscript-reviewed",
  "identification-and-context-required",
  "identification-strategy-required",
  "independent-recall-challenge-required",
  "independent-reuse-demonstrated",
  "independent-validation-required",
  "interpretive-contribution-required",
  "material-results-reproduced",
  "model-calibrated-or-justified",
  "novelty-comparison-required",
  "physical-mechanism-tested",
  "primary-material-context-required",
  "project-brief-complete",
  "protocol-required",
  "readiness-language-bounded",
  "realistic-operating-conditions-required",
  "recall-audit-required",
  "reuse-value-demonstrated",
  "risk-of-bias-required",
  "robustness-and-uncertainty-reviewed",
  "robustness-evidence-required",
  "scale-and-boundary-effects-tested",
  "spatial-temporal-applicability-required",
  "specialist-methods-scrutiny-required",
  "specialist-state-of-art-advance-required",
  "strong-baseline-required",
  "synthesis-method-justified",
  "target-fit-reviewed",
  "terminology-accessible-across-fields",
  "uncertainty-propagated",
]);

const KNOWN_REVIEWERS = new Set([
  "evidence",
  "methods-reproducibility",
  "domain-novelty",
  "journal-editor",
]);

const POLICY_KINDS = new Set([
  "baseline",
  "article-type",
  "field",
  "journal-class",
  "exact-journal",
  "reviewer-rubric",
  "publication-brief",
]);

const KNOWN_CONSTRAINTS = new Map<string, "boolean" | "integer">([
  ["minDirectPeerReviewedFullText", "integer"],
  ["minDirectEmpiricalFullText", "integer"],
  ["minDirectModelFullText", "integer"],
  ["requireCompleteCandidateDisposition", "boolean"],
  ["requireRecallAudit", "boolean"],
  ["requireCentralDimensionsCovered", "boolean"],
  ["requireIndependentReproduction", "boolean"],
]);

export type ResearchPolicyStatusKind =
  | "missing"
  | "default-unapproved"
  | "default-approved"
  | "custom-draft"
  | "custom-approved"
  | "conflict"
  | "stale"
  | "changed"
  | "invalid";

interface ParsedPolicyDocument {
  id: string;
  kind: string;
  templateClass: "bundled-default" | "exact-journal-template" | "project-template";
  metadata: Record<string, unknown>;
  body: string;
  content: string;
  sha256: string;
  rules: string[];
  constraints: Record<string, boolean | number>;
  requiredReviewers: string[];
  reviewAfterDays: number;
}

interface PolicyManifestDocument {
  logicalPath: string;
  id: string;
  kind: string;
  templateClass: ParsedPolicyDocument["templateClass"];
  templateSha256: string;
}

interface PolicyTemplateManifest {
  schemaVersion: 1;
  projectId: string;
  initializedAt: string;
  sourceTreeSha256: string;
  selection: {
    articleType: string;
    field: string;
    journalClass: string;
    exactJournal: boolean;
  };
  documents: PolicyManifestDocument[];
}

interface PolicyApproval extends ResearchPolicyBinding {
  schemaVersion: 1;
  policySetSha256: string;
}

export interface ResearchPolicyStatus {
  schemaVersion: 1;
  projectId: string;
  status: ResearchPolicyStatusKind;
  policyDirectory: string;
  defaultDocuments: number;
  customDocuments: number;
  invalidDocuments: string[];
  conflicts: string[];
  approvedAt: string | null;
  expiresAt: string | null;
  resolvedPolicySha256: string | null;
  verdictCeiling: ResearchVerdictCeiling | null;
  targetJournal: string | null;
  guidance: string;
}

export async function inspectResearchPolicyCatalog(sourceRoot: string): Promise<{
  schemaVersion: 1;
  sourceTreeSha256: string;
  categories: {
    articleTypes: string[];
    fields: string[];
    journalClasses: string[];
  };
  defaults: { baseline: string; reviewers: string[]; publicationBrief: string };
}> {
  const root = await requirePolicySourceRoot(sourceRoot);
  const policyRoot = policyTemplateRoot(root);
  const baseline = join(policyRoot, "baseline", "top-journal.md");
  const brief = join(policyRoot, "project", "publication-brief.md");
  const reviewers = await markdownBasenames(join(policyRoot, "reviewer-rubrics"));
  await Promise.all([
    parsePolicyFile(baseline, false),
    parsePolicyFile(brief, false),
    ...reviewers.map((name) =>
      parsePolicyFile(join(policyRoot, "reviewer-rubrics", `${name}.md`), false),
    ),
  ]);
  return {
    schemaVersion: 1,
    sourceTreeSha256: await hashRegularTree(root),
    categories: {
      articleTypes: await markdownBasenames(join(policyRoot, "article-types")),
      fields: await markdownBasenames(join(policyRoot, "fields")),
      journalClasses: await markdownBasenames(join(policyRoot, "journal-classes")),
    },
    defaults: {
      baseline: "top-journal",
      reviewers,
      publicationBrief: "publication-brief",
    },
  };
}

export async function initializeResearchPolicy(input: {
  root: string;
  projectId: string;
  sourceRoot: string;
  articleType: string;
  field: string;
  journalClass: string;
  includeExactJournalTemplate?: boolean;
}): Promise<ResearchPolicyStatus> {
  validateProjectId(input.projectId);
  const root = resolve(input.root);
  const sourceRoot = await requirePolicySourceRoot(input.sourceRoot);
  const catalog = await inspectResearchPolicyCatalog(sourceRoot);
  requireCatalogSelection("article type", input.articleType, catalog.categories.articleTypes);
  requireCatalogSelection("field", input.field, catalog.categories.fields);
  requireCatalogSelection("journal class", input.journalClass, catalog.categories.journalClasses);
  const userRoot = policyUserRoot(root, input.projectId);
  if (await pathExists(userRoot)) {
    throw policyError(
      "RESEARCH_POLICY_EXISTS",
      `Research Policy directory already exists for ${input.projectId}.`,
      2,
    );
  }
  const templateRoot = policyTemplateRoot(sourceRoot);
  const selections = [
    ["baseline/top-journal.md", "baseline.md"],
    [`article-types/${input.articleType}.md`, "article-type.md"],
    [`fields/${input.field}.md`, "field.md"],
    [`journal-classes/${input.journalClass}.md`, "journal-class.md"],
    ...(await markdownBasenames(join(templateRoot, "reviewer-rubrics"))).map((reviewer) => [
      `reviewer-rubrics/${reviewer}.md`,
      `reviewers/${reviewer}.md`,
    ]),
    ["project/publication-brief.md", "publication-brief.md"],
    ...(input.includeExactJournalTemplate
      ? [["journals/exact-journal-template.md", "journal.md"]]
      : []),
  ] as Array<[string, string]>;
  const manifestDocuments: PolicyManifestDocument[] = [];
  let totalBytes = 0;
  for (const [sourceLogicalPath, destinationLogicalPath] of selections) {
    const source = join(templateRoot, sourceLogicalPath);
    const parsed = await parsePolicyFile(source, false);
    totalBytes += Buffer.byteLength(parsed.content, "utf8");
    if (totalBytes > MAX_POLICY_STACK_BYTES) {
      throw policyError(
        "RESEARCH_POLICY_INVALID",
        "Research Policy defaults exceed the stack limit.",
      );
    }
    await writeTextAtomic(join(userRoot, destinationLogicalPath), parsed.content, 0o600);
    manifestDocuments.push({
      logicalPath: destinationLogicalPath,
      id: parsed.id,
      kind: parsed.kind,
      templateClass: parsed.templateClass,
      templateSha256: parsed.sha256,
    });
  }
  const manifest: PolicyTemplateManifest = {
    schemaVersion: 1,
    projectId: input.projectId,
    initializedAt: new Date().toISOString(),
    sourceTreeSha256: catalog.sourceTreeSha256,
    selection: {
      articleType: input.articleType,
      field: input.field,
      journalClass: input.journalClass,
      exactJournal: input.includeExactJournalTemplate === true,
    },
    documents: manifestDocuments.sort((left, right) =>
      left.logicalPath.localeCompare(right.logicalPath),
    ),
  };
  await writeJsonAtomic(policyManifestPath(root, input.projectId), manifest);
  await appendJournalEvent(
    workspacePaths(root).journal,
    "research.policy.initialized",
    input.projectId,
    {
      projectId: input.projectId,
      sourceTreeSha256: manifest.sourceTreeSha256,
      articleType: input.articleType,
      field: input.field,
      journalClass: input.journalClass,
      documentCount: manifest.documents.length,
    },
  );
  return inspectResearchPolicyStatus(root, input.projectId);
}

export async function inspectResearchPolicyStatus(
  rootInput: string,
  projectId: string,
  options: { now?: Date } = {},
): Promise<ResearchPolicyStatus> {
  validateProjectId(projectId);
  const root = resolve(rootInput);
  const userRoot = policyUserRoot(root, projectId);
  const manifestPath = policyManifestPath(root, projectId);
  if (!(await pathExists(userRoot)) || !(await pathExists(manifestPath))) {
    return statusResult(root, projectId, "missing", [], [], null, ["Research Policy is missing."]);
  }
  let manifest: PolicyTemplateManifest;
  let documents: Array<ParsedPolicyDocument & { logicalPath: string; sourceClass: string }> = [];
  const invalidDocuments: string[] = [];
  try {
    manifest = await loadPolicyManifest(root, projectId);
    documents = await loadCurrentPolicyDocuments(root, manifest);
  } catch (error) {
    invalidDocuments.push(error instanceof Error ? error.message : String(error));
    return statusResult(root, projectId, "invalid", [], invalidDocuments, null, [
      "Repair the reported policy file and validate again.",
    ]);
  }
  const conflicts = policyConflicts(manifest, documents);
  if (conflicts.length) {
    return statusResult(
      root,
      projectId,
      "conflict",
      documents,
      invalidDocuments,
      null,
      ["Resolve the conflicting policy identities before approval."],
      conflicts,
    );
  }
  const approval = await loadPolicyApproval(root, projectId);
  const policySetSha256 = policySetHash(manifest, documents);
  if (!approval) {
    const status = documents.some((document) => document.sourceClass === "human-customized")
      ? "custom-draft"
      : "default-unapproved";
    return statusResult(root, projectId, status, documents, invalidDocuments, null, [
      "Review the generic defaults, complete publication-brief.md, customize the field or target-journal requirements where needed, then explicitly approve the exact policy hash.",
    ]);
  }
  if (approval.policySetSha256 !== policySetSha256) {
    return statusResult(root, projectId, "changed", documents, invalidDocuments, approval, [
      "Policy content changed after approval. Review the diff and approve the new exact hash before continuing.",
    ]);
  }
  if (Date.parse(approval.expiresAt) <= (options.now ?? new Date()).getTime()) {
    return statusResult(root, projectId, "stale", documents, invalidDocuments, approval, [
      "The approved policy review window expired. Verify current field and journal requirements, then approve a refreshed policy.",
    ]);
  }
  return statusResult(
    root,
    projectId,
    documents.some((document) => document.sourceClass === "human-customized")
      ? "custom-approved"
      : "default-approved",
    documents,
    invalidDocuments,
    approval,
    approval.targetJournal
      ? [
          "The exact target-journal policy is approved; final readiness still requires all bound reviewers to pass the final frozen manuscript.",
        ]
      : [
          "No exact target journal is approved. This policy cannot establish target-journal submission readiness.",
        ],
  );
}

export async function approveResearchPolicy(
  rootInput: string,
  projectId: string,
  options: { confirm: boolean; acknowledgeDefaults?: boolean },
): Promise<ResearchPolicyStatus> {
  validateProjectId(projectId);
  if (!options.confirm) {
    throw policyError(
      "RESEARCH_POLICY_UNAPPROVED",
      "Research Policy approval requires explicit confirmation of the exact current content.",
      2,
    );
  }
  const root = resolve(rootInput);
  const manifest = await loadPolicyManifest(root, projectId);
  const documents = await loadCurrentPolicyDocuments(root, manifest, false);
  const conflicts = policyConflicts(manifest, documents);
  if (conflicts.length) {
    throw policyError(
      "RESEARCH_POLICY_CONFLICT",
      "Research Policy identities conflict with the reviewed selection.",
      2,
      { conflicts },
    );
  }
  const brief = documents.find((document) => document.kind === "publication-brief");
  if (!brief || PLACEHOLDER_PATTERN.test(brief.content)) {
    throw policyError(
      "RESEARCH_PUBLICATION_BRIEF_INCOMPLETE",
      "The project publication brief is missing or contains unresolved placeholders.",
      2,
    );
  }
  for (const field of ["centralQuestion", "centralClaim", "centralOutcome", "contributionType"]) {
    if (!nonPlaceholderString(brief.metadata[field])) {
      throw policyError(
        "RESEARCH_PUBLICATION_BRIEF_INCOMPLETE",
        `The project publication brief must define ${field}.`,
        2,
      );
    }
  }
  const defaultDocuments = documents.filter(
    (document) => document.sourceClass === "bundled-default",
  );
  if (defaultDocuments.length && !options.acknowledgeDefaults) {
    throw policyError(
      "RESEARCH_POLICY_UNAPPROVED",
      "Bundled default policies require explicit acknowledgement that they are generic and not target-journal endorsement.",
      2,
      { defaultDocumentIds: defaultDocuments.map((document) => document.id) },
    );
  }
  const exactJournal = documents.find((document) => document.kind === "exact-journal");
  const targetJournal = normalizeTargetJournal(exactJournal?.metadata.journalName);
  if (exactJournal && !targetJournal) {
    throw policyError(
      "RESEARCH_POLICY_TARGET_MISMATCH",
      "An exact-journal policy must name the exact target journal.",
      2,
    );
  }
  const unresolvedDocuments = documents.filter((document) =>
    PLACEHOLDER_PATTERN.test(document.content),
  );
  if (unresolvedDocuments.length) {
    throw policyError(
      "RESEARCH_POLICY_INVALID",
      "Research Policy documents contain unresolved placeholders.",
      2,
      { documentIds: unresolvedDocuments.map((document) => document.id) },
    );
  }
  const policySetSha256 = policySetHash(manifest, documents);
  const approvedAt = new Date().toISOString();
  const reviewAfterDays = Math.min(...documents.map((document) => document.reviewAfterDays));
  const expiresAt = new Date(Date.parse(approvedAt) + reviewAfterDays * 86_400_000).toISOString();
  const resolvedRules = [...new Set(documents.flatMap((document) => document.rules))].sort();
  const resolvedConstraints = mergePolicyConstraints(documents);
  const requiredReviewers = [
    ...new Set(documents.flatMap((document) => document.requiredReviewers)),
  ].sort();
  const objectDocuments: ResearchPolicyBinding["documents"] = [];
  for (const document of documents) {
    const locator = join("policies", "objects", "sha256", `${document.sha256}.md`).replaceAll(
      "\\",
      "/",
    );
    const objectPath = join(workspacePaths(root).control, locator);
    if (!(await pathExists(objectPath))) await writeTextAtomic(objectPath, document.content, 0o444);
    else if (sha256Text(await readFile(objectPath, "utf8")) !== document.sha256) {
      throw policyError(
        "RESEARCH_POLICY_INVALID",
        `Research Policy object failed its content hash: ${document.id}.`,
      );
    }
    objectDocuments.push({
      id: document.id,
      kind: document.kind,
      logicalPath: document.logicalPath,
      sha256: document.sha256,
      sourceClass:
        document.sourceClass === "bundled-default" ? "bundled-default" : "human-customized",
      objectLocator: locator,
    });
  }
  const customizedKinds = new Set(
    documents
      .filter((document) => document.sourceClass === "human-customized")
      .map((document) => document.kind),
  );
  const classPolicyCustomized = [
    "article-type",
    "field",
    "journal-class",
    "publication-brief",
  ].every((kind) => customizedKinds.has(kind));
  const verdictCeiling: ResearchVerdictCeiling =
    targetJournal && classPolicyCustomized && customizedKinds.has("exact-journal")
      ? "target-journal-submission-ready"
      : classPolicyCustomized
        ? "top-journal-class-ready"
        : "top-journal-candidate";
  const bindingBase: Omit<PolicyApproval, "approvalSha256"> = {
    schemaVersion: 1,
    goal: "top-journal",
    projectId,
    articleType: manifest.selection.articleType,
    field: manifest.selection.field,
    journalClass: manifest.selection.journalClass,
    targetJournal,
    policySetSha256,
    resolvedPolicySha256: sha256Text(
      canonicalJson({
        policySetSha256,
        resolvedRules,
        resolvedConstraints,
        requiredReviewers,
        articleType: manifest.selection.articleType,
        field: manifest.selection.field,
        journalClass: manifest.selection.journalClass,
        targetJournal,
      }),
    ),
    verdictCeiling,
    documents: objectDocuments,
    resolvedRules,
    resolvedConstraints,
    requiredReviewers,
    approvedAt,
    expiresAt,
  };
  const approval: PolicyApproval = {
    ...bindingBase,
    approvalSha256: sha256Text(canonicalJson(bindingBase)),
  };
  await writeJsonAtomic(policyApprovalPath(root, projectId), approval, 0o444);
  await appendJournalEvent(workspacePaths(root).journal, "research.policy.approved", projectId, {
    projectId,
    policySetSha256,
    resolvedPolicySha256: approval.resolvedPolicySha256,
    approvalSha256: approval.approvalSha256,
    defaultDocuments: defaultDocuments.length,
    customDocuments: documents.length - defaultDocuments.length,
    targetJournalDeclared: targetJournal !== null,
    verdictCeiling,
    expiresAt,
  });
  return inspectResearchPolicyStatus(root, projectId);
}

export async function loadApprovedResearchPolicy(
  root: string,
  projectId: string,
): Promise<ResearchPolicyBinding> {
  const status = await inspectResearchPolicyStatus(root, projectId);
  if (status.status === "missing") {
    throw policyError(
      "RESEARCH_POLICY_REQUIRED",
      `Top-journal project ${projectId} requires an initialized Research Policy.`,
      2,
      {
        minimumAction: `Initialize and review research-policy/${projectId} before project creation.`,
      },
    );
  }
  if (status.status === "changed") {
    throw policyError(
      "RESEARCH_POLICY_CHANGED",
      `Research Policy for ${projectId} changed after approval.`,
      3,
      { minimumAction: "Review the changed Markdown and approve its new exact hash." },
    );
  }
  if (status.status === "stale") {
    throw policyError("RESEARCH_POLICY_STALE", `Research Policy for ${projectId} is stale.`, 3, {
      minimumAction: "Verify current field and journal requirements, then reapprove.",
    });
  }
  if (status.status === "invalid") {
    throw policyError(
      "RESEARCH_POLICY_INVALID",
      `Research Policy for ${projectId} is invalid.`,
      2,
      { invalidDocuments: status.invalidDocuments },
    );
  }
  if (status.status === "conflict") {
    throw policyError(
      "RESEARCH_POLICY_CONFLICT",
      `Research Policy for ${projectId} contains conflicting identities.`,
      2,
      { conflicts: status.conflicts },
    );
  }
  if (status.status !== "custom-approved" && status.status !== "default-approved") {
    throw policyError(
      "RESEARCH_POLICY_UNAPPROVED",
      `Research Policy for ${projectId} has not been approved.`,
      2,
      { minimumAction: "Complete the publication brief and explicitly approve the current hash." },
    );
  }
  const approval = await loadPolicyApproval(resolve(root), projectId);
  if (!approval) throw policyError("RESEARCH_POLICY_UNAPPROVED", "Policy approval is missing.");
  const { schemaVersion: _schemaVersion, policySetSha256: _policySetSha256, ...binding } = approval;
  return binding;
}

export async function assertResearchPolicyBinding(
  root: string,
  binding: ResearchPolicyBinding,
): Promise<void> {
  const current = await loadApprovedResearchPolicy(root, binding.projectId);
  if (
    current.resolvedPolicySha256 !== binding.resolvedPolicySha256 ||
    current.approvalSha256 !== binding.approvalSha256
  ) {
    throw policyError(
      "RESEARCH_POLICY_CHANGED",
      `Research Policy binding changed for ${binding.projectId}.`,
      3,
    );
  }
}

function policyTemplateRoot(sourceRoot: string): string {
  return join(sourceRoot, "assets", "research-policy", "defaults");
}

function policyUserRoot(root: string, projectId: string): string {
  return join(resolve(root), "research-policy", projectId);
}

function policyControlRoot(root: string, projectId: string): string {
  return join(workspacePaths(root).control, "policies", "projects", projectId);
}

function policyManifestPath(root: string, projectId: string): string {
  return join(policyControlRoot(root, projectId), "template-manifest.json");
}

function policyApprovalPath(root: string, projectId: string): string {
  return join(policyControlRoot(root, projectId), "approval.json");
}

async function requirePolicySourceRoot(input: string): Promise<string> {
  if (resolve(input) !== input) {
    throw policyError(
      "RESEARCH_POLICY_SOURCE_INVALID",
      "Research Policy source root must be an absolute path.",
      2,
    );
  }
  const info = await lstat(input).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw policyError(
      "RESEARCH_POLICY_SOURCE_INVALID",
      "Research Policy source root must be a regular non-symlink directory.",
      2,
    );
  }
  const policyRootInfo = await lstat(policyTemplateRoot(input)).catch(() => undefined);
  if (!policyRootInfo?.isDirectory() || policyRootInfo.isSymbolicLink()) {
    throw policyError(
      "RESEARCH_POLICY_SOURCE_INVALID",
      "Research Policy source does not contain a regular default policy directory.",
      2,
    );
  }
  return input;
}

async function markdownBasenames(directory: string): Promise<string[]> {
  const info = await lstat(directory).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw policyError("RESEARCH_POLICY_SOURCE_INVALID", "Policy category directory is invalid.");
  }
  const names: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    names.push(basename(entry.name, ".md"));
  }
  return names.sort();
}

async function parsePolicyFile(
  path: string,
  requireComplete: boolean,
): Promise<ParsedPolicyDocument> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_POLICY_DOCUMENT_BYTES) {
    throw policyError(
      "RESEARCH_POLICY_INVALID",
      `Policy document is not a bounded regular file: ${basename(path)}`,
    );
  }
  const content = await readFile(path, "utf8");
  if (/\u0000/.test(content)) {
    throw policyError(
      "RESEARCH_POLICY_INVALID",
      `Policy document contains invalid bytes: ${basename(path)}`,
    );
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match) {
    throw policyError(
      "RESEARCH_POLICY_INVALID",
      `Policy frontmatter is missing: ${basename(path)}`,
    );
  }
  const document = parseDocument(match[1]!, {
    schema: "core",
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length || document.warnings.length) {
    throw policyError(
      "RESEARCH_POLICY_INVALID",
      `Policy frontmatter is invalid: ${basename(path)}`,
      2,
      {
        diagnostics: [...document.errors, ...document.warnings].map((item) => item.code),
      },
    );
  }
  let metadata: unknown;
  try {
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw policyError(
      "RESEARCH_POLICY_INVALID",
      `Policy aliases are not allowed: ${basename(path)}`,
    );
  }
  if (!isObject(metadata)) {
    throw policyError(
      "RESEARCH_POLICY_INVALID",
      `Policy frontmatter must be a mapping: ${basename(path)}`,
    );
  }
  const id = metadata.id;
  const kind = metadata.kind;
  const templateClass = metadata.templateClass;
  if (
    metadata.schemaVersion !== 1 ||
    typeof id !== "string" ||
    !POLICY_ID_PATTERN.test(id) ||
    typeof kind !== "string" ||
    !POLICY_KINDS.has(kind) ||
    !["bundled-default", "exact-journal-template", "project-template"].includes(
      String(templateClass),
    ) ||
    metadata.policyVersion !== 1 ||
    metadata.targetTier !== "top"
  ) {
    throw policyError("RESEARCH_POLICY_INVALID", `Policy identity is invalid: ${basename(path)}`);
  }
  const rules = stringArray(metadata.rules, "rules", basename(path));
  const constraints = policyConstraints(metadata.constraints, basename(path));
  const requiredReviewers = stringArray(
    metadata.requiredReviewers ?? [],
    "requiredReviewers",
    basename(path),
  );
  for (const rule of rules) {
    if (!RULE_ID_PATTERN.test(rule) || !KNOWN_RULES.has(rule)) {
      throw policyError("RESEARCH_POLICY_INVALID", `Policy contains an unknown rule ID: ${rule}`);
    }
  }
  for (const reviewer of requiredReviewers) {
    if (!KNOWN_REVIEWERS.has(reviewer)) {
      throw policyError(
        "RESEARCH_POLICY_INVALID",
        `Policy contains an unknown reviewer role: ${reviewer}`,
      );
    }
  }
  const reviewAfterDays = metadata.reviewAfterDays;
  if (
    typeof reviewAfterDays !== "number" ||
    !Number.isInteger(reviewAfterDays) ||
    reviewAfterDays < 1 ||
    reviewAfterDays > 3650
  ) {
    throw policyError(
      "RESEARCH_POLICY_INVALID",
      `Policy reviewAfterDays is invalid: ${basename(path)}`,
    );
  }
  const body = match[2]!.trim();
  if (!body.startsWith("# ") || body.length < 20) {
    throw policyError("RESEARCH_POLICY_INVALID", `Policy body is incomplete: ${basename(path)}`);
  }
  if (requireComplete && PLACEHOLDER_PATTERN.test(content)) {
    throw policyError("RESEARCH_POLICY_INVALID", `Policy contains unresolved placeholders: ${id}`);
  }
  return {
    id,
    kind,
    templateClass: templateClass as ParsedPolicyDocument["templateClass"],
    metadata,
    body,
    content,
    sha256: sha256Text(content),
    rules,
    constraints,
    requiredReviewers,
    reviewAfterDays,
  };
}

function stringArray(value: unknown, label: string, file: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw policyError("RESEARCH_POLICY_INVALID", `Policy ${label} must be a string array: ${file}`);
  }
  if (new Set(value).size !== value.length) {
    throw policyError("RESEARCH_POLICY_INVALID", `Policy ${label} contains duplicates: ${file}`);
  }
  return [...value].sort();
}

async function loadPolicyManifest(
  root: string,
  projectId: string,
): Promise<PolicyTemplateManifest> {
  const manifest = await readJsonFile<PolicyTemplateManifest>(
    policyManifestPath(root, projectId),
    "Research Policy template manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.projectId !== projectId ||
    !Array.isArray(manifest.documents) ||
    !isObject(manifest.selection) ||
    typeof manifest.sourceTreeSha256 !== "string"
  ) {
    throw policyError("RESEARCH_POLICY_INVALID", "Research Policy template manifest is invalid.");
  }
  return manifest;
}

async function loadCurrentPolicyDocuments(
  root: string,
  manifest: PolicyTemplateManifest,
  requireComplete = false,
): Promise<Array<ParsedPolicyDocument & { logicalPath: string; sourceClass: string }>> {
  let totalBytes = 0;
  const ids = new Set<string>();
  const documents = [];
  for (const expected of manifest.documents) {
    const parsed = await parsePolicyFile(
      join(policyUserRoot(root, manifest.projectId), expected.logicalPath),
      requireComplete,
    );
    totalBytes += Buffer.byteLength(parsed.content, "utf8");
    if (totalBytes > MAX_POLICY_STACK_BYTES) {
      throw policyError("RESEARCH_POLICY_INVALID", "Research Policy stack exceeds its byte limit.");
    }
    if (parsed.id !== expected.id || parsed.kind !== expected.kind || ids.has(parsed.id)) {
      throw policyError(
        "RESEARCH_POLICY_INVALID",
        `Policy identity changed or is duplicated: ${expected.id}`,
      );
    }
    ids.add(parsed.id);
    documents.push({
      ...parsed,
      logicalPath: expected.logicalPath,
      sourceClass:
        parsed.sha256 === expected.templateSha256 ? "bundled-default" : "human-customized",
    });
  }
  return documents.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

function policySetHash(
  manifest: PolicyTemplateManifest,
  documents: Array<ParsedPolicyDocument & { logicalPath: string }>,
): string {
  return sha256Text(
    canonicalJson({
      projectId: manifest.projectId,
      selection: manifest.selection,
      documents: documents.map((document) => ({
        id: document.id,
        kind: document.kind,
        logicalPath: document.logicalPath,
        sha256: document.sha256,
      })),
    }),
  );
}

async function loadPolicyApproval(root: string, projectId: string): Promise<PolicyApproval | null> {
  const path = policyApprovalPath(root, projectId);
  if (!(await pathExists(path))) return null;
  const approval = await readJsonFile<PolicyApproval>(path, "Research Policy approval");
  if (
    approval.schemaVersion !== 1 ||
    approval.goal !== "top-journal" ||
    approval.projectId !== projectId ||
    !/^[a-f0-9]{64}$/.test(approval.policySetSha256) ||
    !/^[a-f0-9]{64}$/.test(approval.resolvedPolicySha256) ||
    !/^[a-f0-9]{64}$/.test(approval.approvalSha256) ||
    !Array.isArray(approval.documents) ||
    !isObject(approval.resolvedConstraints)
  ) {
    throw policyError("RESEARCH_POLICY_INVALID", "Research Policy approval is invalid.");
  }
  const { approvalSha256, ...base } = approval;
  if (sha256Text(canonicalJson(base)) !== approvalSha256) {
    throw policyError("RESEARCH_POLICY_INVALID", "Research Policy approval hash is invalid.");
  }
  return approval;
}

function statusResult(
  root: string,
  projectId: string,
  status: ResearchPolicyStatusKind,
  documents: Array<{ sourceClass: string }>,
  invalidDocuments: string[],
  approval: PolicyApproval | null,
  guidanceParts: string[],
  conflicts: string[] = [],
): ResearchPolicyStatus {
  const defaultDocuments = documents.filter(
    (document) => document.sourceClass === "bundled-default",
  ).length;
  return {
    schemaVersion: 1,
    projectId,
    status,
    policyDirectory: policyUserRoot(root, projectId),
    defaultDocuments,
    customDocuments: documents.length - defaultDocuments,
    invalidDocuments,
    conflicts,
    approvedAt: approval?.approvedAt ?? null,
    expiresAt: approval?.expiresAt ?? null,
    resolvedPolicySha256: approval?.resolvedPolicySha256 ?? null,
    verdictCeiling: approval?.verdictCeiling ?? null,
    targetJournal: approval?.targetJournal ?? null,
    guidance: guidanceParts.join(" "),
  };
}

function policyConstraints(value: unknown, file: string): Record<string, boolean | number> {
  if (value === undefined) return {};
  if (!isObject(value)) {
    throw policyError("RESEARCH_POLICY_INVALID", `Policy constraints must be a mapping: ${file}`);
  }
  const result: Record<string, boolean | number> = {};
  for (const [key, constraint] of Object.entries(value)) {
    const kind = KNOWN_CONSTRAINTS.get(key);
    if (!kind) {
      throw policyError("RESEARCH_POLICY_INVALID", `Policy contains an unknown constraint: ${key}`);
    }
    if (
      (kind === "boolean" && typeof constraint !== "boolean") ||
      (kind === "integer" &&
        (typeof constraint !== "number" ||
          !Number.isInteger(constraint) ||
          constraint < 0 ||
          constraint > 10_000))
    ) {
      throw policyError("RESEARCH_POLICY_INVALID", `Policy constraint is invalid: ${key}`);
    }
    result[key] = constraint as boolean | number;
  }
  return result;
}

function mergePolicyConstraints(
  documents: Array<Pick<ParsedPolicyDocument, "constraints">>,
): Record<string, boolean | number> {
  const resolved: Record<string, boolean | number> = {};
  for (const document of documents) {
    for (const [key, value] of Object.entries(document.constraints)) {
      const current = resolved[key];
      resolved[key] =
        typeof value === "number"
          ? Math.max(typeof current === "number" ? current : 0, value)
          : Boolean(current) || value;
    }
  }
  return Object.fromEntries(
    Object.entries(resolved).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function policyConflicts(
  manifest: PolicyTemplateManifest,
  documents: Array<ParsedPolicyDocument & { logicalPath: string }>,
): string[] {
  const conflicts: string[] = [];
  const expectedIdentity: Array<[string, string, string]> = [
    ["article-type", "articleType", manifest.selection.articleType],
    ["field", "field", manifest.selection.field],
    ["journal-class", "journalClass", manifest.selection.journalClass],
  ];
  for (const [kind, key, expected] of expectedIdentity) {
    const document = documents.find((candidate) => candidate.kind === kind);
    const actual = document?.metadata[key];
    if (!document || typeof actual !== "string" || actual !== expected) {
      conflicts.push(`${kind}.${key} must equal ${expected}.`);
    }
  }
  const brief = documents.find((document) => document.kind === "publication-brief");
  for (const [key, expected] of [
    ["articleType", manifest.selection.articleType],
    ["field", manifest.selection.field],
    ["journalClass", manifest.selection.journalClass],
  ] as Array<[string, string]>) {
    const actual = brief?.metadata[key];
    if (typeof actual === "string" && PLACEHOLDER_PATTERN.test(actual)) continue;
    if (!brief || actual !== expected)
      conflicts.push(`publication-brief.${key} must equal ${expected}.`);
  }
  const exactJournal = documents.find((document) => document.kind === "exact-journal");
  const exactTarget = normalizeTargetJournal(exactJournal?.metadata.journalName);
  const briefTarget = normalizeTargetJournal(brief?.metadata.targetJournal);
  if (exactJournal && exactTarget && briefTarget && exactTarget !== briefTarget) {
    conflicts.push("publication-brief.targetJournal must match exact-journal.journalName.");
  }
  return conflicts.sort();
}

function normalizeTargetJournal(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "none") return null;
  if (PLACEHOLDER_PATTERN.test(normalized) || normalized.length > 200) return null;
  return normalized;
}

function nonPlaceholderString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length >= 3 && !PLACEHOLDER_PATTERN.test(value);
}

function requireCatalogSelection(label: string, selected: string, values: string[]): void {
  if (!values.includes(selected)) {
    throw policyError(
      "RESEARCH_POLICY_INVALID",
      `Unsupported Research Policy ${label}: ${selected}`,
      2,
      {
        supported: values,
      },
    );
  }
}

function validateProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw policyError("RESEARCH_POLICY_INVALID", "Research Policy project ID is invalid.", 2);
  }
}

function policyError(
  code: string,
  message: string,
  exitCode = 2,
  details?: Record<string, unknown>,
): CliError {
  return new CliError(message, { code, exitCode, ...(details ? { details } : {}) });
}
