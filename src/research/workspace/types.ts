export type ContextRole = "workspace" | "unmanaged" | "invalid";

export type ProjectStatus = "ready" | "running" | "blocked" | "complete";

export type PackageStatus = "pending" | "ready" | "running" | "retry" | "failed" | "complete";

export type PackageKind = "agent" | "verify";

export type AgentKind = "codex" | "claude";

export interface AgentRoute {
  agent: AgentKind;
  binary: string;
  model: string | null;
}

export interface ResearchBudget {
  maxTokens: number;
  maxCostUsd: number;
  maxWallSeconds: number;
  maxFilesPerPackage: number;
  maxBytesPerPackage: number;
  maxAttemptsPerPackage: number;
}

export interface WorkspaceMarker {
  schemaVersion: 1;
  kind: "tiangong-research-workspace";
  workspaceId: string;
  name: string;
  createdAt: string;
}

export interface WorkspaceConfig {
  schemaVersion: 1;
  producer: AgentRoute;
  reviewer: AgentRoute;
  budget: ResearchBudget;
}

export interface RuntimeLock {
  schemaVersion: 1;
  protocolVersion: 1;
  packageName: "@tiangong-ai/cli";
  packageVersion: string;
  workspaceId: string;
}

export interface CapabilityCredentialDeclaration {
  id: string;
  allowedHosts: string[];
  headerName: string;
  prefix: string;
}

export interface CapabilityDeclaration {
  id: string;
  skillPath: string;
  permissions: string[];
  allowedHosts: string[];
  credentials: CapabilityCredentialDeclaration[];
}

export interface CapabilityDeclarations {
  schemaVersion: 1;
  capabilities: CapabilityDeclaration[];
}

export interface CapabilityLockRecord {
  id: string;
  skillName: string;
  skillPath: string;
  treeSha256: string;
  policySha256: string;
  permissions: string[];
  credentialIds: string[];
}

export interface CapabilityLock {
  schemaVersion: 1;
  generatedAt: string;
  capabilities: CapabilityLockRecord[];
}

export interface ProjectInput {
  id: string;
  role: "primary" | "reference" | "replication";
  path: string;
  sha256: string;
  bytes: number;
  addedAt: string;
}

export interface WorkPackage {
  id: string;
  stage: "discover" | "analyze" | "synthesize" | "review" | "close";
  kind: PackageKind;
  executor: "producer" | "reviewer" | "mechanical";
  dependencies: string[];
  expectedOutputs: string[];
  status: PackageStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ProjectUsage {
  tokens: number;
  costUsd: number;
  wallSeconds: number;
}

export interface ProjectState {
  schemaVersion: 1;
  id: string;
  question: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  inputs: ProjectInput[];
  packages: WorkPackage[];
  usage: ProjectUsage;
}

export interface OutputRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  tokens: number;
  costUsd: number;
  wallSeconds: number;
}

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  packageId: string;
  executor: AgentKind | "mechanical";
  startedAt: string;
  completedAt: string;
  exitCode: number;
  tokens: number;
  costUsd: number;
  wallSeconds: number;
  outputs: OutputRecord[];
  stdoutSha256: string;
  stderrSha256: string;
}

export interface JournalEvent {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  type: string;
  scope: string;
  payload: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface ContextInspection {
  role: ContextRole;
  selectedPath: string;
  root: string | null;
  allowedOperations: string[];
  violations: Array<{ code: string; message: string }>;
}

export interface DoctorCheck {
  id: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

export interface WorkspaceDoctorResult {
  workspace: string;
  status: "ready" | "blocked";
  checks: DoctorCheck[];
}

export interface WorkspacePaths {
  root: string;
  control: string;
  marker: string;
  config: string;
  runtimeLock: string;
  capabilityDeclarations: string;
  capabilityLock: string;
  env: string;
  envExample: string;
  journal: string;
  projects: string;
  runtime: string;
  locks: string;
}
