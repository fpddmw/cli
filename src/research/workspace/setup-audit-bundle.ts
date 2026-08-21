import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import { parseCapabilityDeclarations, verifyCapabilities } from "./capabilities.js";
import { configuredResearchSecrets, sanitizeResearchText } from "./sanitization.js";
import { loadAndVerifyResearchSetupPlan, type ResearchSetupPlan } from "./setup.js";
import {
  canonicalJson,
  isObject,
  pathExists,
  regularTreeFiles,
  resolveContained,
  safeRelativePath,
  sha256Bytes,
  sha256File,
  sha256Text,
  workspacePaths,
  writeBytesAtomic,
  writeJsonAtomic,
} from "./storage.js";
import type {
  CapabilityDeclarations,
  CapabilityLock,
  RuntimeLock,
  WorkspaceDoctorAttestation,
} from "./types.js";
import { verifyDoctorAttestation, withWorkspaceLock } from "./workspace.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TEXT_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_SECRET_STORE_BYTES = 64 * 1024;

export interface SetupAuditManifest {
  schemaVersion: 1;
  kind: "tiangong-setup-audit-bundle";
  createdAt: string;
  setup: {
    planId: string;
    planSha256: string;
    cliVersion: string;
    mode: ResearchSetupPlan["workspace"]["mode"];
    selectedSkillIds: string[];
  };
  readiness: {
    setupState: string;
    research: string;
    preprocessing: string;
    acquisition: string;
    authoring: string;
    overall: string;
    checkedAt: string | null;
  };
  sourceBindings: {
    setupPlan: { planSha256: string; sourceFileSha256: string };
    setupStateFileSha256: string;
    setupReportFileSha256: string | null;
    runtimeLockFileSha256: string | null;
    capabilityDeclarationsFileSha256: string | null;
    capabilityLockFileSha256: string | null;
    doctorAttestation: {
      attestationSha256: string;
      sourceFileSha256: string;
      verificationStatus: "verified" | "expired" | "drifted";
    } | null;
    setupDeclarationBindingFileSha256: string | null;
    sourceWorkspacePathSha256: string;
  };
  availability: {
    setupReport: boolean;
    runtimeLock: boolean;
    capabilityDeclarations: boolean;
    capabilityLock: boolean;
    doctorAttestation: boolean;
    setupDeclarationBinding: boolean;
  };
  exclusions: string[];
  files: Array<{ path: string; sha256: string; bytes: number }>;
  manifestSha256: string;
}

export async function exportSetupAuditBundle(input: {
  root: string;
  destination: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<SetupAuditManifest> {
  return withWorkspaceLock(input.root, "research.setup.audit.export", async () => {
    const root = await realpath(resolve(input.root));
    const destination = await validateNewDestination(input.destination);
    const paths = workspacePaths(root);
    const secrets = await setupAuditSecrets(paths, input.environment ?? process.env);
    const temporary = join(
      dirname(destination),
      `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await mkdir(temporary, { mode: 0o700 });
    try {
      const sources = {
        setupPlan: await requiredSourceSnapshot(paths.setupPlan, "setup plan"),
        setupState: await requiredSourceSnapshot(paths.setupState, "setup state"),
        setupReport: await optionalSourceSnapshot(paths.setupReport, "setup report"),
        runtimeLock: await optionalSourceSnapshot(paths.runtimeLock, "runtime lock"),
        capabilityDeclarations: await optionalSourceSnapshot(
          paths.capabilityDeclarations,
          "capability declarations",
        ),
        capabilityLock: await optionalSourceSnapshot(paths.capabilityLock, "capability lock"),
        doctorAttestation: await optionalSourceSnapshot(
          paths.doctorAttestation,
          "doctor attestation",
        ),
        setupDeclarationBinding: await optionalSourceSnapshot(
          paths.setupDeclarationBinding,
          "setup declaration binding",
        ),
      };

      const planSnapshotPath = join(temporary, ".source-setup-plan.json");
      await writeBytesAtomic(planSnapshotPath, sources.setupPlan.bytes, 0o600);
      const plan = await loadAndVerifyResearchSetupPlan(planSnapshotPath);
      await rm(planSnapshotPath, { force: true });
      if (resolve(plan.workspace.path) !== root) {
        throw setupAuditError("Setup plan workspace binding does not match the export workspace.");
      }
      const stateProof = portableSetupState(sources.setupState.value, sources.setupState.sha256);
      const reportProof = sources.setupReport
        ? portableSetupReport(sources.setupReport.value, sources.setupReport.sha256)
        : null;

      await writeJsonAtomic(
        join(temporary, "control", "setup-plan.portable.json"),
        portableSetupPlan(plan, sources.setupPlan.sha256),
        0o444,
      );
      await writeJsonAtomic(
        join(temporary, "control", "setup-state.portable.json"),
        stateProof,
        0o444,
      );
      if (reportProof) {
        await writeJsonAtomic(
          join(temporary, "control", "setup-report.portable.json"),
          reportProof,
          0o444,
        );
      }
      if (sources.runtimeLock) {
        parseRuntimeLock(sources.runtimeLock.value);
        await writeBytesAtomic(
          join(temporary, "control", "runtime-lock.json"),
          sources.runtimeLock.bytes,
          0o444,
        );
      }
      if (sources.capabilityDeclarations) {
        const declarations = parseCapabilityDeclarations(sources.capabilityDeclarations.value);
        await writeJsonAtomic(
          join(temporary, "control", "capabilities.portable.json"),
          portableCapabilities(declarations, sources.capabilityDeclarations.sha256),
          0o444,
        );
      }
      if (sources.capabilityLock) {
        if (!sources.capabilityDeclarations) {
          throw setupAuditError("Capability lock exists without capability declarations.");
        }
        const verification = await verifyCapabilities(root);
        if (verification.status !== "verified") {
          throw setupAuditError("Capability lock is not verified and cannot be exported.");
        }
        await Promise.all([
          assertSourceUnchanged(
            paths.capabilityDeclarations,
            sources.capabilityDeclarations,
            "capability declarations",
          ),
          assertSourceUnchanged(paths.capabilityLock, sources.capabilityLock, "capability lock"),
        ]);
        const lock = parseCapabilityLock(sources.capabilityLock.value);
        await writeJsonAtomic(
          join(temporary, "control", "capabilities-lock.portable.json"),
          portableCapabilityLock(lock, sources.capabilityLock.sha256),
          0o444,
        );
      }

      let doctorBinding: SetupAuditManifest["sourceBindings"]["doctorAttestation"] = null;
      if (sources.doctorAttestation) {
        const attestation = parseDoctorAttestation(sources.doctorAttestation.value);
        const verification = await verifyDoctorAttestation(root);
        if (
          verification.status === "missing" ||
          verification.status === "invalid" ||
          !verification.attestation
        ) {
          throw new CliError("Doctor attestation is invalid and cannot be exported.", {
            code: "RESEARCH_SETUP_AUDIT_ATTESTATION_INVALID",
            exitCode: 3,
          });
        }
        if (verification.attestation.attestationSha256 !== attestation.attestationSha256) {
          throw setupAuditError("Doctor attestation changed during setup audit export.");
        }
        await assertSourceUnchanged(
          paths.doctorAttestation,
          sources.doctorAttestation,
          "doctor attestation",
        );
        await writeJsonAtomic(
          join(temporary, "control", "doctor-attestation.json"),
          portableDoctorAttestation(attestation, sources.doctorAttestation.sha256),
          0o444,
        );
        doctorBinding = {
          attestationSha256: attestation.attestationSha256,
          sourceFileSha256: sources.doctorAttestation.sha256,
          verificationStatus: verification.status,
        };
      }
      if (sources.setupDeclarationBinding) {
        assertPortableJsonValue(sources.setupDeclarationBinding.value, [], secrets);
        parseSetupDeclarationBinding(sources.setupDeclarationBinding.value);
        await writeBytesAtomic(
          join(temporary, "control", "setup-declaration-binding.json"),
          sources.setupDeclarationBinding.bytes,
          0o444,
        );
      }

      await assertPortableTextFiles(
        temporary,
        [root, ...plan.install.targets.map((item) => item.root)],
        secrets,
      );
      const files = await bundleFileRecords(temporary);
      const reportReadiness = portableReadiness(reportProof, stateProof.status);
      const manifestCore = {
        schemaVersion: 1 as const,
        kind: "tiangong-setup-audit-bundle" as const,
        createdAt: new Date().toISOString(),
        setup: {
          planId: plan.planId,
          planSha256: plan.planSha256,
          cliVersion: plan.cli.version,
          mode: plan.workspace.mode,
          selectedSkillIds: [...plan.selection.skillIds],
        },
        readiness: reportReadiness,
        sourceBindings: {
          setupPlan: {
            planSha256: plan.planSha256,
            sourceFileSha256: sources.setupPlan.sha256,
          },
          setupStateFileSha256: sources.setupState.sha256,
          setupReportFileSha256: sources.setupReport?.sha256 ?? null,
          runtimeLockFileSha256: sources.runtimeLock?.sha256 ?? null,
          capabilityDeclarationsFileSha256: sources.capabilityDeclarations?.sha256 ?? null,
          capabilityLockFileSha256: sources.capabilityLock?.sha256 ?? null,
          doctorAttestation: doctorBinding,
          setupDeclarationBindingFileSha256: sources.setupDeclarationBinding?.sha256 ?? null,
          sourceWorkspacePathSha256: sha256Text(root),
        },
        availability: {
          setupReport: sources.setupReport !== null,
          runtimeLock: sources.runtimeLock !== null,
          capabilityDeclarations: sources.capabilityDeclarations !== null,
          capabilityLock: sources.capabilityLock !== null,
          doctorAttestation: sources.doctorAttestation !== null,
          setupDeclarationBinding: sources.setupDeclarationBinding !== null,
        },
        exclusions: [
          "credential values and credential environment names",
          "setup.env, setup-adapters.env, .env, and other owner secret stores",
          "setup source caches and installed Skill trees",
          "browser profiles, cookies, sessions, and authentication material",
          "host-specific absolute paths and mutable setup lock state",
          "raw provider responses and command stdout/stderr",
          "unrelated workspace and project files",
        ],
        files,
      };
      const manifest: SetupAuditManifest = {
        ...manifestCore,
        manifestSha256: sha256Text(canonicalJson(manifestCore)),
      };
      await writeJsonAtomic(join(temporary, "manifest.json"), manifest, 0o444);
      await assertPortableTextFiles(
        temporary,
        [root, ...plan.install.targets.map((item) => item.root)],
        secrets,
      );
      await verifySetupAuditBundle(temporary, {
        expectedManifestSha256: manifest.manifestSha256,
      });
      await rename(temporary, destination);
      return manifest;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function verifySetupAuditBundle(
  bundlePath: string,
  options: {
    expectedManifestSha256: string;
    afterSnapshotBound?: () => Promise<void>;
  },
): Promise<{
  status: "verified";
  planSha256: string;
  manifestSha256: string;
  files: number;
}> {
  if (!SHA256.test(options.expectedManifestSha256)) {
    throw setupAuditPathError(
      "Setup audit verification requires a valid external expected manifest SHA-256.",
    );
  }
  if (!isAbsolute(bundlePath) || resolve(bundlePath) !== bundlePath) {
    throw setupAuditPathError("Setup audit bundle path must be absolute and normalized.");
  }
  const info = await lstat(bundlePath).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw setupAuditPathError(
      "Setup audit bundle must be a regular directory and not a symbolic link.",
    );
  }
  const manifestPath = join(bundlePath, "manifest.json");
  const manifestSnapshot = await requiredSourceSnapshot(manifestPath, "bundle manifest");
  const manifest = parseManifest(manifestSnapshot.value);
  if (manifest.manifestSha256 !== options.expectedManifestSha256) {
    throw setupAuditError("Setup audit manifest does not match the external expected digest.");
  }
  const { manifestSha256, ...core } = manifest;
  if (sha256Text(canonicalJson(core)) !== manifestSha256) {
    throw setupAuditError("Setup audit manifest failed its hash binding.");
  }
  const initialFiles = await setupAuditTreeFiles(bundlePath);
  const actualFiles = initialFiles.map((path) => relative(bundlePath, path).split(sep).join("/"));
  const expectedPaths = manifest.files.map((file) => file.path);
  const expectedTreePaths = ["manifest.json", ...expectedPaths].sort();
  if (
    actualFiles.length !== expectedTreePaths.length ||
    actualFiles.some((path, index) => path !== expectedTreePaths[index])
  ) {
    throw setupAuditError("Setup audit bundle contains missing, extra, or unordered files.");
  }
  const snapshots = new Map<string, SetupAuditSourceSnapshot>([
    ["manifest.json", manifestSnapshot],
  ]);
  for (const record of manifest.files) {
    const path = resolveContained(bundlePath, record.path);
    const snapshot = await requiredSourceSnapshot(path, "bound bundle file");
    if (snapshot.bytes.length !== record.bytes || snapshot.sha256 !== record.sha256) {
      throw setupAuditError(`Setup audit file failed its exact binding: ${record.path}`);
    }
    snapshots.set(record.path, snapshot);
  }
  const allowedPaths = setupAuditAllowedPaths(manifest);
  if (
    expectedPaths.length !== allowedPaths.length ||
    expectedPaths.some((path, index) => path !== allowedPaths[index])
  ) {
    throw setupAuditError("Setup audit manifest does not match the closed file allowlist.");
  }
  await options.afterSnapshotBound?.();
  for (const snapshot of snapshots.values()) {
    assertPortableSnapshot(snapshot, [], []);
  }
  verifySetupAuditSemantics(manifest, snapshots);
  const finalInfo = await lstat(bundlePath).catch(() => null);
  if (!finalInfo?.isDirectory() || !sameSourceIdentity(info, finalInfo)) {
    throw setupAuditError("Setup audit bundle directory changed during verification.");
  }
  const finalFiles = (await setupAuditTreeFiles(bundlePath)).map((path) =>
    relative(bundlePath, path).split(sep).join("/"),
  );
  if (
    finalFiles.length !== expectedTreePaths.length ||
    finalFiles.some((path, index) => path !== expectedTreePaths[index])
  ) {
    throw setupAuditError("Setup audit bundle tree changed during verification.");
  }
  await Promise.all(
    [...snapshots].map(([logical, snapshot]) =>
      assertSourceUnchanged(resolveContained(bundlePath, logical), snapshot, "bound bundle file"),
    ),
  );
  return {
    status: "verified",
    planSha256: manifest.setup.planSha256,
    manifestSha256,
    files: manifest.files.length,
  };
}

function portableSetupPlan(plan: ResearchSetupPlan, sourceFileSha256: string) {
  return {
    schemaVersion: 1,
    kind: "tiangong-setup-plan-proof",
    sourceFileSha256,
    planId: plan.planId,
    planSha256: plan.planSha256,
    createdAt: plan.createdAt,
    cli: plan.cli,
    workspace: {
      nameSha256: sha256Text(plan.workspace.name),
      mode: plan.workspace.mode,
    },
    install: {
      scope: plan.install.scope,
      agents: plan.install.agents,
      mode: plan.install.mode,
      installer: plan.install.installer,
      targets: plan.install.targets.map((target) => ({
        agent: target.agent,
        rootSha256: sha256Text(target.root),
      })),
    },
    selection: plan.selection,
    sources: plan.sources,
    skills: plan.skills,
    acceptedLicenses: plan.acceptedLicenses,
    credentialSources: plan.credentialSources.map((source) => ({
      id: source.id,
      storage: source.storage,
      configured: true,
    })),
    settings: Object.entries(plan.settings).map(([id, value]) => ({
      id,
      valueSha256: sha256Text(value),
    })),
    agentRoutes: plan.agentRoutes,
    reviewerExecution: plan.reviewerExecution,
    checks: plan.checks,
    confirmations: plan.confirmations,
    mutations: plan.mutations.map((mutation) => ({
      step: mutation.step,
      targetSha256: sha256Text(mutation.target),
      reason: mutation.reason,
    })),
  };
}

function portableSetupState(value: unknown, sourceFileSha256: string) {
  if (!isObject(value)) throw setupAuditError("Setup state proof source is invalid.");
  const lastError = isObject(value.lastError) ? value.lastError : null;
  const proof = {
    schemaVersion: 1,
    kind: "tiangong-setup-state-proof",
    sourceFileSha256,
    planSha256: stringOrNull(value.planSha256),
    status: stringOrNull(value.status),
    currentStep: stringOrNull(value.currentStep),
    completedSteps: stringArray(value.completedSteps),
    attempts: Number.isSafeInteger(value.attempts) ? value.attempts : null,
    updatedAt: stringOrNull(value.updatedAt),
    lastError:
      lastError === null
        ? null
        : {
            code: stringOrNull(lastError.code),
            step: stringOrNull(lastError.step),
            reasonSha256:
              typeof lastError.reason === "string" ? sha256Text(lastError.reason) : null,
            minimumActionSha256:
              typeof lastError.minimumAction === "string"
                ? sha256Text(lastError.minimumAction)
                : null,
          },
  };
  parsePortableSetupState(proof);
  return proof as typeof proof & { status: string };
}

function portableSetupReport(value: unknown, sourceFileSha256: string) {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.checks)) {
    throw setupAuditError("Setup report proof source is invalid.");
  }
  return {
    schemaVersion: 1,
    kind: "tiangong-setup-report-proof",
    sourceFileSha256,
    planSha256: stringOrNull(value.planSha256),
    checkedAt: stringOrNull(value.checkedAt),
    mode: stringOrNull(value.mode),
    readiness: stringOrNull(value.readiness),
    researchReadiness: stringOrNull(value.researchReadiness),
    preprocessingReadiness: stringOrNull(value.preprocessingReadiness),
    acquisitionReadiness: stringOrNull(value.acquisitionReadiness),
    authoringReadiness: stringOrNull(value.authoringReadiness),
    overallReadiness: stringOrNull(value.overallReadiness),
    checks: value.checks.map((check) => portableSetupCheck(check)),
    summary: isObject(value.summary)
      ? {
          pass: numberOrNull(value.summary.pass),
          warn: numberOrNull(value.summary.warn),
          fail: numberOrNull(value.summary.fail),
        }
      : null,
  };
}

function portableSetupCheck(value: unknown) {
  if (!isObject(value)) throw setupAuditError("Setup report contains an invalid check.");
  const diagnostics = isObject(value.diagnostics) ? value.diagnostics : null;
  return {
    id: stringOrNull(value.id),
    category: stringOrNull(value.category),
    status: stringOrNull(value.status),
    scope: stringOrNull(value.scope),
    componentIds: stringArray(value.componentIds),
    requiredFor: stringArray(value.requiredFor),
    blocking: typeof value.blocking === "boolean" ? value.blocking : null,
    componentGate: typeof value.componentGate === "boolean" ? value.componentGate : null,
    skippedBecauseSha256:
      typeof value.skippedBecause === "string" ? sha256Text(value.skippedBecause) : null,
    diagnostics:
      diagnostics === null
        ? null
        : {
            code: stringOrNull(diagnostics.code),
            executionMode: stringOrNull(diagnostics.executionMode),
            credentialScope: stringOrNull(diagnostics.credentialScope),
            networkAttempted:
              typeof diagnostics.networkAttempted === "boolean"
                ? diagnostics.networkAttempted
                : null,
            httpStatus: numberOrNull(diagnostics.httpStatus),
            retryAfterSeconds: numberOrNull(diagnostics.retryAfterSeconds),
          },
  };
}

function portableCapabilities(value: CapabilityDeclarations, sourceFileSha256: string) {
  return {
    schemaVersion: 1,
    kind: "tiangong-capability-declarations-proof",
    sourceFileSha256,
    capabilities: value.capabilities.map((capability) => ({
      id: capability.id,
      skillPath: `skills/${basename(capability.skillPath)}`,
      source: portableCapabilitySource(capability.source),
      requiredForDiscovery: capability.requiredForDiscovery,
      permissions: capability.permissions,
      allowedHosts: capability.allowedHosts,
      http: portableCapabilityHttp(capability.http),
      coverage: capability.coverage,
      credentials: capability.credentials.map((credential) => ({
        id: credential.id,
        allowedHosts: credential.allowedHosts,
        headerName: credential.headerName,
        prefixSha256: sha256Text(credential.prefix),
      })),
      healthCheck:
        capability.healthCheck === null
          ? null
          : {
              targetSha256: sha256Text(capability.healthCheck.url),
              credentialId: capability.healthCheck.credentialId,
              expectedContentTypes: capability.healthCheck.expectedContentTypes,
              method: capability.healthCheck.method,
              bodySha256:
                capability.healthCheck.body === null
                  ? null
                  : sha256Text(canonicalJson(capability.healthCheck.body)),
            },
    })),
  };
}

function portableCapabilityHttp(value: CapabilityDeclarations["capabilities"][number]["http"]) {
  return value === null
    ? null
    : {
        endpoint: value.endpoint,
        method: value.method,
        accept: value.accept,
        allowedContentTypes: value.allowedContentTypes,
        staticHeaderBindings: Object.entries(value.staticHeaders)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, headerValue]) => ({
            name,
            valueSha256: sha256Text(headerValue),
          })),
        maxRequestBytes: value.maxRequestBytes,
        maxResponseBytes: value.maxResponseBytes,
        maxItems: value.maxItems,
      };
}

function portableCapabilityLock(value: CapabilityLock, sourceFileSha256: string) {
  return {
    schemaVersion: 1,
    kind: "tiangong-capability-lock-proof",
    sourceFileSha256,
    generatedAt: value.generatedAt,
    capabilities: value.capabilities.map(({ skillPath: _skillPath, ...record }) => ({
      ...record,
      source: portableCapabilitySource(record.source),
      skillPath: `skills/${record.skillName}`,
    })),
  };
}

function portableCapabilitySource(value: CapabilityLock["capabilities"][number]["source"]) {
  return value === null
    ? null
    : {
        type: value.type,
        locatorSha256: sha256Text(value.locator),
        immutableRef: value.immutableRef,
        expectedTreeSha256: value.expectedTreeSha256,
        license: value.license,
        catalogId: value.catalogId,
      };
}

function portableDoctorAttestation(value: WorkspaceDoctorAttestation, sourceFileSha256: string) {
  return {
    schemaVersion: 1,
    kind: "tiangong-doctor-attestation-proof",
    sourceFileSha256,
    attestationSha256: value.attestationSha256,
    workspaceIdSha256: sha256Text(value.workspaceId),
    checkedAt: value.checkedAt,
    expiresAt: value.expiresAt,
    configSha256: value.configSha256,
    runtimeLockSha256: value.runtimeLockSha256,
    capabilityDeclarationsSha256: value.capabilityDeclarationsSha256,
    capabilityLockSha256: value.capabilityLockSha256,
    doctorSchemaSha256: value.doctorSchemaSha256,
    reviewerExecution: value.reviewerExecution,
    runtimes: value.runtimes.map((runtime) => ({
      agent: runtime.agent,
      modelSha256: runtime.model === null ? null : sha256Text(runtime.model),
      effort: runtime.effort ?? null,
      verbosity: runtime.verbosity ?? null,
      binarySha256: runtime.binarySha256,
      wrapperSha256: runtime.wrapperSha256,
      adapterSha256: runtime.adapterSha256,
      binaryVersionSha256: sha256Text(runtime.binaryVersion),
      platform: runtime.platform,
      architecture: runtime.architecture,
    })),
    capabilitySmoke: value.capabilitySmoke.map((row) => ({
      id: row.id,
      status: row.status,
      code: row.code,
      hostSha256: row.host === null ? null : sha256Text(row.host),
      targetSha256: row.targetSha256,
      httpStatus: row.httpStatus,
    })),
    smokeUsage: value.smokeUsage.map(({ telemetry, ...usage }) => ({
      ...usage,
      telemetrySha256: telemetry === undefined ? null : sha256Text(canonicalJson(telemetry)),
    })),
  };
}

function portableReadiness(report: unknown, setupState: string): SetupAuditManifest["readiness"] {
  if (!isObject(report)) {
    return {
      setupState,
      research: "NOT_CHECKED",
      preprocessing: "NOT_CHECKED",
      acquisition: "NOT_CHECKED",
      authoring: "NOT_CHECKED",
      overall: "NOT_CHECKED",
      checkedAt: null,
    };
  }
  return {
    setupState,
    research: String(report.researchReadiness ?? report.readiness ?? "NOT_CHECKED"),
    preprocessing: String(report.preprocessingReadiness ?? "NOT_CHECKED"),
    acquisition: String(report.acquisitionReadiness ?? "NOT_CHECKED"),
    authoring: String(report.authoringReadiness ?? "NOT_CHECKED"),
    overall: String(report.overallReadiness ?? "NOT_CHECKED"),
    checkedAt: typeof report.checkedAt === "string" ? report.checkedAt : null,
  };
}

async function bundleFileRecords(
  root: string,
): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const files = await setupAuditTreeFiles(root);
  return Promise.all(
    files
      .map((path) => ({ path, logical: relative(root, path).split(sep).join("/") }))
      .filter((item) => item.logical !== "manifest.json")
      .map(async ({ path, logical }) => {
        const info = await lstat(path);
        return { path: logical, sha256: await sha256File(path), bytes: info.size };
      }),
  );
}

async function setupAuditSecrets(
  paths: ReturnType<typeof workspacePaths>,
  environment: NodeJS.ProcessEnv,
): Promise<string[]> {
  const values = new Set(configuredResearchSecrets(environment));
  for (const path of [paths.env, paths.setupDeclarationEnv, paths.setupAdapterEnv]) {
    const info = await lstat(path).catch(() => undefined);
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SECRET_STORE_BYTES) {
      throw setupAuditError("A setup credential store is unsafe or oversized.");
    }
    const text = await readFile(path, "utf8");
    for (const line of text.split(/\r?\n/u)) {
      const separator = line.indexOf("=");
      if (separator < 0) continue;
      const raw = line.slice(separator + 1).trim();
      if (raw.length >= 8) values.add(raw);
      try {
        collectStringLeaves(JSON.parse(raw) as unknown, values);
      } catch {
        // Literal non-JSON environment values are already included above.
      }
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function collectStringLeaves(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    if (value.length >= 8) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, output);
    return;
  }
  if (!isObject(value)) return;
  for (const item of Object.values(value)) collectStringLeaves(item, output);
}

async function assertPortableTextFiles(
  root: string,
  forbiddenRoots: readonly string[],
  secrets: readonly string[],
): Promise<void> {
  for (const path of await setupAuditTreeFiles(root)) {
    assertPortableSnapshot(
      await requiredSourceSnapshot(path, "portable bundle file"),
      forbiddenRoots,
      secrets,
    );
  }
}

function assertPortableSnapshot(
  snapshot: SetupAuditSourceSnapshot,
  forbiddenRoots: readonly string[],
  secrets: readonly string[],
): void {
  const text = snapshot.bytes.toString("utf8");
  if (forbiddenRoots.some((item) => item.length > 1 && text.includes(item))) {
    throw new CliError("Setup audit bundle contains a host-specific path.", {
      code: "RESEARCH_SETUP_AUDIT_BUNDLE_NONPORTABLE",
      exitCode: 3,
    });
  }
  if (sanitizeResearchText(text, secrets) !== text) {
    throw new CliError("Setup audit bundle contains sensitive text.", {
      code: "RESEARCH_SETUP_AUDIT_BUNDLE_SENSITIVE",
      exitCode: 3,
    });
  }
  assertPortableJsonValue(snapshot.value, forbiddenRoots, secrets);
}

function assertPortableJsonValue(
  value: unknown,
  forbiddenRoots: readonly string[],
  secrets: readonly string[],
): void {
  if (typeof value === "string") {
    if (forbiddenRoots.some((item) => item.length > 1 && value.includes(item))) {
      throw new CliError("Setup audit bundle contains a host-specific path.", {
        code: "RESEARCH_SETUP_AUDIT_BUNDLE_NONPORTABLE",
        exitCode: 3,
      });
    }
    if (sanitizeResearchText(value, secrets) !== value) {
      throw new CliError("Setup audit bundle contains sensitive text.", {
        code: "RESEARCH_SETUP_AUDIT_BUNDLE_SENSITIVE",
        exitCode: 3,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertPortableJsonValue(item, forbiddenRoots, secrets);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    assertPortableJsonValue(key, forbiddenRoots, secrets);
    assertPortableJsonValue(item, forbiddenRoots, secrets);
  }
}

async function setupAuditTreeFiles(root: string): Promise<string[]> {
  try {
    return await regularTreeFiles(root);
  } catch {
    throw setupAuditError("Setup audit bundle contains an unsupported filesystem entry.");
  }
}

type SetupAuditSourceSnapshot = {
  bytes: Buffer;
  sha256: string;
  value: unknown;
};

async function requiredSourceSnapshot(
  path: string,
  label: string,
): Promise<SetupAuditSourceSnapshot> {
  const value = await optionalSourceSnapshot(path, label);
  if (!value) throw setupAuditError(`Required setup audit source is missing: ${label}.`);
  return value;
}

async function optionalSourceSnapshot(
  path: string,
  label: string,
): Promise<SetupAuditSourceSnapshot | null> {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (before === null) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_TEXT_SCAN_BYTES) {
    throw setupAuditError(`Setup audit source is not a regular non-symlink file: ${label}.`);
  }
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameSourceIdentity(before, opened)) {
      throw setupAuditError(`Setup audit source changed before it could be read: ${label}.`);
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      !sameSourceIdentity(opened, after) ||
      after.size !== bytes.length ||
      after.size > MAX_TEXT_SCAN_BYTES
    ) {
      throw setupAuditError(`Setup audit source changed while it was read: ${label}.`);
    }
  } finally {
    await handle.close();
  }
  const current = await lstat(path).catch(() => null);
  if (!current || current.isSymbolicLink() || !sameSourceIdentity(before, current)) {
    throw setupAuditError(`Setup audit source changed after it was read: ${label}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw setupAuditError(`Setup audit source is not valid JSON: ${label}.`);
  }
  return { bytes, sha256: sha256Bytes(bytes), value };
}

function sameSourceIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  const inodeMatches = left.ino === 0 || right.ino === 0 || left.ino === right.ino;
  return (
    inodeMatches &&
    left.dev === right.dev &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function assertSourceUnchanged(
  path: string,
  snapshot: SetupAuditSourceSnapshot,
  label: string,
): Promise<void> {
  const current = await requiredSourceSnapshot(path, label);
  if (current.sha256 !== snapshot.sha256) {
    throw setupAuditError(`Setup audit source changed during export: ${label}.`);
  }
}

async function validateNewDestination(value: string): Promise<string> {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw setupAuditPathError("Setup audit export destination must be absolute and normalized.");
  }
  if (await pathExists(value)) {
    throw setupAuditPathError("Setup audit export destination must not already exist.");
  }
  const parent = dirname(value);
  const parentInfo = await lstat(parent).catch(() => undefined);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    throw setupAuditPathError("Setup audit export parent must be an existing regular directory.");
  }
  return value;
}

function parseManifest(value: unknown): SetupAuditManifest {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "createdAt",
      "setup",
      "readiness",
      "sourceBindings",
      "availability",
      "exclusions",
      "files",
      "manifestSha256",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-setup-audit-bundle" ||
    typeof value.createdAt !== "string" ||
    !isObject(value.setup) ||
    !hasExactKeys(value.setup, [
      "planId",
      "planSha256",
      "cliVersion",
      "mode",
      "selectedSkillIds",
    ]) ||
    typeof value.setup.planId !== "string" ||
    typeof value.setup.planSha256 !== "string" ||
    !SHA256.test(value.setup.planSha256) ||
    typeof value.setup.cliVersion !== "string" ||
    !["smoke-test", "production-research"].includes(String(value.setup.mode)) ||
    !Array.isArray(value.setup.selectedSkillIds) ||
    value.setup.selectedSkillIds.some((item) => typeof item !== "string") ||
    !isObject(value.readiness) ||
    !hasExactKeys(value.readiness, [
      "setupState",
      "research",
      "preprocessing",
      "acquisition",
      "authoring",
      "overall",
      "checkedAt",
    ]) ||
    !["pending", "applying", "partially-ready", "ready", "blocked"].includes(
      String(value.readiness.setupState),
    ) ||
    !["READY", "BLOCKED", "NOT_CHECKED"].includes(String(value.readiness.research)) ||
    [value.readiness.preprocessing, value.readiness.acquisition, value.readiness.authoring].some(
      (item) =>
        !["READY", "DEGRADED", "BLOCKED", "NOT_REQUIRED", "NOT_CHECKED"].includes(String(item)),
    ) ||
    !["READY", "PARTIALLY_READY", "BLOCKED", "NOT_CHECKED"].includes(
      String(value.readiness.overall),
    ) ||
    !(value.readiness.checkedAt === null || typeof value.readiness.checkedAt === "string") ||
    !isObject(value.sourceBindings) ||
    !validSourceBindings(value.sourceBindings) ||
    !isObject(value.availability) ||
    !hasExactKeys(value.availability, [
      "setupReport",
      "runtimeLock",
      "capabilityDeclarations",
      "capabilityLock",
      "doctorAttestation",
      "setupDeclarationBinding",
    ]) ||
    Object.values(value.availability).some((item) => typeof item !== "boolean") ||
    !Array.isArray(value.exclusions) ||
    value.exclusions.some((item) => typeof item !== "string") ||
    !Array.isArray(value.files) ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256.test(value.manifestSha256)
  ) {
    throw setupAuditError("Setup audit manifest shape is invalid.");
  }
  const files = value.files as unknown[];
  if (
    files.some(
      (file) =>
        !isObject(file) ||
        !hasExactKeys(file, ["path", "sha256", "bytes"]) ||
        typeof file.path !== "string" ||
        safePathOrNull(file.path) === null ||
        typeof file.sha256 !== "string" ||
        !SHA256.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        Number(file.bytes) < 0,
    )
  ) {
    throw setupAuditError("Setup audit manifest file records are invalid.");
  }
  const paths = files.map((file) => String((file as Record<string, unknown>).path));
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => index > 0 && paths[index - 1]! >= path)
  ) {
    throw setupAuditError("Setup audit manifest file paths must be unique and sorted.");
  }
  const manifest = value as unknown as SetupAuditManifest;
  if (
    manifest.sourceBindings.setupPlan.planSha256 !== manifest.setup.planSha256 ||
    manifest.availability.setupReport !==
      (manifest.sourceBindings.setupReportFileSha256 !== null) ||
    manifest.availability.runtimeLock !==
      (manifest.sourceBindings.runtimeLockFileSha256 !== null) ||
    manifest.availability.capabilityDeclarations !==
      (manifest.sourceBindings.capabilityDeclarationsFileSha256 !== null) ||
    manifest.availability.capabilityLock !==
      (manifest.sourceBindings.capabilityLockFileSha256 !== null) ||
    manifest.availability.doctorAttestation !==
      (manifest.sourceBindings.doctorAttestation !== null) ||
    manifest.availability.setupDeclarationBinding !==
      (manifest.sourceBindings.setupDeclarationBindingFileSha256 !== null)
  ) {
    throw setupAuditError("Setup audit availability and source bindings are inconsistent.");
  }
  return manifest;
}

function validSourceBindings(value: Record<string, unknown>): boolean {
  if (
    !hasExactKeys(value, [
      "setupPlan",
      "setupStateFileSha256",
      "setupReportFileSha256",
      "runtimeLockFileSha256",
      "capabilityDeclarationsFileSha256",
      "capabilityLockFileSha256",
      "doctorAttestation",
      "setupDeclarationBindingFileSha256",
      "sourceWorkspacePathSha256",
    ]) ||
    !isObject(value.setupPlan) ||
    !hasExactKeys(value.setupPlan, ["planSha256", "sourceFileSha256"]) ||
    !isSha(value.setupPlan.planSha256) ||
    !isSha(value.setupPlan.sourceFileSha256) ||
    !isSha(value.setupStateFileSha256) ||
    !isNullableSha(value.setupReportFileSha256) ||
    !isNullableSha(value.runtimeLockFileSha256) ||
    !isNullableSha(value.capabilityDeclarationsFileSha256) ||
    !isNullableSha(value.capabilityLockFileSha256) ||
    !isNullableSha(value.setupDeclarationBindingFileSha256) ||
    !isSha(value.sourceWorkspacePathSha256)
  ) {
    return false;
  }
  if (value.doctorAttestation === null) return true;
  return (
    isObject(value.doctorAttestation) &&
    hasExactKeys(value.doctorAttestation, [
      "attestationSha256",
      "sourceFileSha256",
      "verificationStatus",
    ]) &&
    isSha(value.doctorAttestation.attestationSha256) &&
    isSha(value.doctorAttestation.sourceFileSha256) &&
    ["verified", "expired", "drifted"].includes(String(value.doctorAttestation.verificationStatus))
  );
}

function setupAuditAllowedPaths(manifest: SetupAuditManifest): string[] {
  return [
    "control/setup-plan.portable.json",
    "control/setup-state.portable.json",
    ...(manifest.availability.setupReport ? ["control/setup-report.portable.json"] : []),
    ...(manifest.availability.runtimeLock ? ["control/runtime-lock.json"] : []),
    ...(manifest.availability.capabilityDeclarations ? ["control/capabilities.portable.json"] : []),
    ...(manifest.availability.capabilityLock ? ["control/capabilities-lock.portable.json"] : []),
    ...(manifest.availability.doctorAttestation ? ["control/doctor-attestation.json"] : []),
    ...(manifest.availability.setupDeclarationBinding
      ? ["control/setup-declaration-binding.json"]
      : []),
  ].sort();
}

function verifySetupAuditSemantics(
  manifest: SetupAuditManifest,
  snapshots: ReadonlyMap<string, SetupAuditSourceSnapshot>,
): void {
  const plan = parsePortableSetupPlan(
    readBundleJson(snapshots, "control/setup-plan.portable.json"),
  );
  const state = parsePortableSetupState(
    readBundleJson(snapshots, "control/setup-state.portable.json"),
  );
  if (
    plan.kind !== "tiangong-setup-plan-proof" ||
    plan.planId !== manifest.setup.planId ||
    plan.planSha256 !== manifest.setup.planSha256 ||
    plan.sourceFileSha256 !== manifest.sourceBindings.setupPlan.sourceFileSha256 ||
    !isObject(plan.cli) ||
    plan.cli.version !== manifest.setup.cliVersion ||
    !isObject(plan.workspace) ||
    plan.workspace.mode !== manifest.setup.mode ||
    !isObject(plan.selection) ||
    canonicalJson(plan.selection.skillIds) !== canonicalJson(manifest.setup.selectedSkillIds) ||
    state.kind !== "tiangong-setup-state-proof" ||
    state.planSha256 !== manifest.setup.planSha256 ||
    state.sourceFileSha256 !== manifest.sourceBindings.setupStateFileSha256 ||
    state.status !== manifest.readiness.setupState
  ) {
    throw setupAuditError("Setup audit plan/state proofs are not cross-bound.");
  }
  if (manifest.availability.setupReport) {
    const report = parsePortableSetupReport(
      readBundleJson(snapshots, "control/setup-report.portable.json"),
    );
    if (
      report.kind !== "tiangong-setup-report-proof" ||
      report.planSha256 !== manifest.setup.planSha256 ||
      report.sourceFileSha256 !== manifest.sourceBindings.setupReportFileSha256 ||
      report.researchReadiness !== manifest.readiness.research ||
      report.preprocessingReadiness !== manifest.readiness.preprocessing ||
      report.acquisitionReadiness !== manifest.readiness.acquisition ||
      report.authoringReadiness !== manifest.readiness.authoring ||
      report.overallReadiness !== manifest.readiness.overall ||
      report.checkedAt !== manifest.readiness.checkedAt
    ) {
      throw setupAuditError("Setup audit report proof is not cross-bound.");
    }
  }
  if (manifest.availability.runtimeLock) {
    const runtime = parseRuntimeLock(readBundleJson(snapshots, "control/runtime-lock.json"));
    if (
      runtime.packageName !== "@tiangong-ai/cli" ||
      runtime.packageVersion !== manifest.setup.cliVersion ||
      boundFileSha(manifest, "control/runtime-lock.json") !==
        manifest.sourceBindings.runtimeLockFileSha256
    ) {
      throw setupAuditError("Setup audit runtime lock is not bound to the setup CLI.");
    }
  }
  if (manifest.availability.capabilityDeclarations) {
    const capabilities = parsePortableCapabilities(
      readBundleJson(snapshots, "control/capabilities.portable.json"),
    );
    if (
      capabilities.kind !== "tiangong-capability-declarations-proof" ||
      capabilities.sourceFileSha256 !== manifest.sourceBindings.capabilityDeclarationsFileSha256
    ) {
      throw setupAuditError("Setup audit capability declaration proof is not cross-bound.");
    }
  }
  if (manifest.availability.capabilityLock) {
    const lock = parsePortableCapabilityLock(
      readBundleJson(snapshots, "control/capabilities-lock.portable.json"),
    );
    if (
      lock.kind !== "tiangong-capability-lock-proof" ||
      lock.sourceFileSha256 !== manifest.sourceBindings.capabilityLockFileSha256
    ) {
      throw setupAuditError("Setup audit capability lock proof is not cross-bound.");
    }
  }
  if (manifest.availability.doctorAttestation) {
    const attestation = parsePortableDoctorAttestation(
      readBundleJson(snapshots, "control/doctor-attestation.json"),
    );
    const doctorBinding = manifest.sourceBindings.doctorAttestation;
    const currentControlHashesMatch =
      attestation.runtimeLockSha256 === manifest.sourceBindings.runtimeLockFileSha256 &&
      attestation.capabilityDeclarationsSha256 ===
        manifest.sourceBindings.capabilityDeclarationsFileSha256 &&
      attestation.capabilityLockSha256 === manifest.sourceBindings.capabilityLockFileSha256;
    if (
      attestation.attestationSha256 !== doctorBinding?.attestationSha256 ||
      attestation.sourceFileSha256 !== doctorBinding?.sourceFileSha256 ||
      (doctorBinding?.verificationStatus !== "drifted" && !currentControlHashesMatch)
    ) {
      throw setupAuditError("Setup audit doctor attestation is not cross-bound.");
    }
  }
  if (manifest.availability.setupDeclarationBinding) {
    const binding = parseSetupDeclarationBinding(
      readBundleJson(snapshots, "control/setup-declaration-binding.json"),
    );
    if (
      binding.planSha256 !== manifest.setup.planSha256 ||
      boundFileSha(manifest, "control/setup-declaration-binding.json") !==
        manifest.sourceBindings.setupDeclarationBindingFileSha256
    ) {
      throw setupAuditError("Setup audit declaration binding does not match the plan.");
    }
  }
}

function boundFileSha(manifest: SetupAuditManifest, logical: string): string | null {
  return manifest.files.find((file) => file.path === logical)?.sha256 ?? null;
}

function parsePortableSetupPlan(value: Record<string, unknown>): Record<string, unknown> {
  const invalid = () => setupAuditError("Setup audit plan proof shape is invalid.");
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "sourceFileSha256",
      "planId",
      "planSha256",
      "createdAt",
      "cli",
      "workspace",
      "install",
      "selection",
      "sources",
      "skills",
      "acceptedLicenses",
      "credentialSources",
      "settings",
      "agentRoutes",
      "reviewerExecution",
      "checks",
      "confirmations",
      "mutations",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-setup-plan-proof" ||
    !isSha(value.sourceFileSha256) ||
    typeof value.planId !== "string" ||
    !isSha(value.planSha256) ||
    typeof value.createdAt !== "string" ||
    !validCliBinding(value.cli) ||
    !validPlanWorkspace(value.workspace) ||
    !validPlanInstall(value.install) ||
    !validPlanSelection(value.selection) ||
    !closedObjectArray(value.sources, ["id", "repository", "locator", "immutableRef"], (item) =>
      Object.values(item).every((field) => typeof field === "string"),
    ) ||
    !closedObjectArray(
      value.skills,
      [
        "id",
        "skillName",
        "sourceId",
        "sourceRelativePath",
        "expectedTreeSha256",
        "role",
        "licenseId",
      ],
      (item) =>
        ["id", "skillName", "sourceId", "sourceRelativePath", "role", "licenseId"].every(
          (key) => typeof item[key] === "string",
        ) && isSha(item.expectedTreeSha256),
    ) ||
    !closedObjectArray(value.acceptedLicenses, ["skillId", "licenseId", "accepted"], (item) =>
      Boolean(
        typeof item.skillId === "string" &&
        typeof item.licenseId === "string" &&
        item.accepted === true,
      ),
    ) ||
    !closedObjectArray(value.credentialSources, ["id", "storage", "configured"], (item) =>
      Boolean(
        typeof item.id === "string" && typeof item.storage === "string" && item.configured === true,
      ),
    ) ||
    !closedObjectArray(value.settings, ["id", "valueSha256"], (item) =>
      Boolean(typeof item.id === "string" && isSha(item.valueSha256)),
    ) ||
    !validAgentRoutes(value.agentRoutes) ||
    !isObject(value.reviewerExecution) ||
    !hasExactKeys(value.reviewerExecution, ["transport", "isolationProvider"]) ||
    !["native-direct", "sandbox-bridge"].includes(String(value.reviewerExecution.transport)) ||
    value.reviewerExecution.isolationProvider !== "platform-capsule" ||
    !isObject(value.checks) ||
    !hasExactKeys(value.checks, ["live", "allowSyntheticUnstructureUpload", "agentSmoke"]) ||
    Object.values(value.checks).some((item) => typeof item !== "boolean") ||
    !isObject(value.confirmations) ||
    !hasExactKeys(value.confirmations, ["networkDownloads", "globalMutation", "agentSmokeCost"]) ||
    Object.values(value.confirmations).some((item) => typeof item !== "boolean") ||
    !closedObjectArray(value.mutations, ["step", "targetSha256", "reason"], (item) =>
      Boolean(
        typeof item.step === "string" &&
        isSha(item.targetSha256) &&
        typeof item.reason === "string",
      ),
    )
  ) {
    throw invalid();
  }
  return value;
}

function validCliBinding(value: unknown): boolean {
  return (
    isObject(value) &&
    hasExactKeys(value, ["package", "version"]) &&
    value.package === "@tiangong-ai/cli" &&
    typeof value.version === "string"
  );
}

function validPlanWorkspace(value: unknown): boolean {
  return (
    isObject(value) &&
    hasExactKeys(value, ["nameSha256", "mode"]) &&
    isSha(value.nameSha256) &&
    ["smoke-test", "production-research"].includes(String(value.mode))
  );
}

function validPlanInstall(value: unknown): boolean {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["scope", "agents", "mode", "installer", "targets"]) ||
    !["project", "global"].includes(String(value.scope)) ||
    value.mode !== "copy" ||
    !stringArrayIs(value.agents, ["codex", "claude-code"])
  ) {
    return false;
  }
  const installer = value.installer;
  return (
    isObject(installer) &&
    hasExactKeys(installer, [
      "package",
      "version",
      "npmIntegrity",
      "npmShasum",
      "gitHead",
      "runtimeInstall",
    ]) &&
    ["package", "version", "npmIntegrity", "npmShasum", "gitHead"].every(
      (key) => typeof installer[key] === "string",
    ) &&
    installer.runtimeInstall === false &&
    closedObjectArray(value.targets, ["agent", "rootSha256"], (item) =>
      Boolean(["codex", "claude-code"].includes(String(item.agent)) && isSha(item.rootSha256)),
    )
  );
}

function validPlanSelection(value: unknown): boolean {
  return (
    isObject(value) &&
    hasExactKeys(value, ["evidenceProfile", "skillIds"]) &&
    typeof value.evidenceProfile === "string" &&
    stringArrayIs(value.skillIds)
  );
}

function validAgentRoutes(value: unknown): boolean {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "producerAgent",
      "reviewerAgent",
      "producerModel",
      "reviewerModel",
      "producerPricing",
      "reviewerPricing",
    ]) ||
    !["codex", "claude", "workbuddy", "codebuddy"].includes(String(value.producerAgent)) ||
    !["codex", "claude"].includes(String(value.reviewerAgent)) ||
    !nullableString(value.producerModel) ||
    !nullableString(value.reviewerModel)
  ) {
    return false;
  }
  return [value.producerPricing, value.reviewerPricing].every(validPricing);
}

function validPricing(value: unknown): boolean {
  return (
    value === null ||
    (isObject(value) &&
      hasExactKeys(value, [
        "inputUsdPerMillionTokens",
        "cachedInputUsdPerMillionTokens",
        "outputUsdPerMillionTokens",
      ]) &&
      Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item)))
  );
}

function parsePortableSetupState(value: Record<string, unknown>): Record<string, unknown> {
  const validLastError =
    value.lastError === null ||
    (isObject(value.lastError) &&
      hasExactKeys(value.lastError, ["code", "step", "reasonSha256", "minimumActionSha256"]) &&
      nullableString(value.lastError.code) &&
      nullableString(value.lastError.step) &&
      isNullableSha(value.lastError.reasonSha256) &&
      isNullableSha(value.lastError.minimumActionSha256));
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "sourceFileSha256",
      "planSha256",
      "status",
      "currentStep",
      "completedSteps",
      "attempts",
      "updatedAt",
      "lastError",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-setup-state-proof" ||
    !isSha(value.sourceFileSha256) ||
    !isSha(value.planSha256) ||
    !["pending", "applying", "partially-ready", "ready", "blocked"].includes(
      String(value.status),
    ) ||
    !nullableString(value.currentStep) ||
    !stringArrayIs(value.completedSteps) ||
    !Number.isSafeInteger(value.attempts) ||
    Number(value.attempts) < 0 ||
    typeof value.updatedAt !== "string" ||
    !validLastError
  ) {
    throw setupAuditError("Setup audit state proof shape is invalid.");
  }
  return value;
}

function parsePortableSetupReport(value: Record<string, unknown>): Record<string, unknown> {
  const checksValid = closedObjectArray(
    value.checks,
    [
      "id",
      "category",
      "status",
      "scope",
      "componentIds",
      "requiredFor",
      "blocking",
      "componentGate",
      "skippedBecauseSha256",
      "diagnostics",
    ],
    (item) =>
      nullableString(item.id) &&
      nullableString(item.category) &&
      nullableString(item.status) &&
      nullableString(item.scope) &&
      stringArrayIs(item.componentIds) &&
      stringArrayIs(item.requiredFor) &&
      nullableBoolean(item.blocking) &&
      nullableBoolean(item.componentGate) &&
      isNullableSha(item.skippedBecauseSha256) &&
      validPortableDiagnostics(item.diagnostics),
  );
  const summaryValid =
    value.summary === null ||
    (isObject(value.summary) &&
      hasExactKeys(value.summary, ["pass", "warn", "fail"]) &&
      Object.values(value.summary).every(nullableNumber));
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "sourceFileSha256",
      "planSha256",
      "checkedAt",
      "mode",
      "readiness",
      "researchReadiness",
      "preprocessingReadiness",
      "acquisitionReadiness",
      "authoringReadiness",
      "overallReadiness",
      "checks",
      "summary",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-setup-report-proof" ||
    !isSha(value.sourceFileSha256) ||
    !isSha(value.planSha256) ||
    [
      value.checkedAt,
      value.mode,
      value.readiness,
      value.researchReadiness,
      value.preprocessingReadiness,
      value.acquisitionReadiness,
      value.authoringReadiness,
      value.overallReadiness,
    ].some((item) => !nullableString(item)) ||
    !checksValid ||
    !summaryValid
  ) {
    throw setupAuditError("Setup audit report proof shape is invalid.");
  }
  return value;
}

function validPortableDiagnostics(value: unknown): boolean {
  return (
    value === null ||
    (isObject(value) &&
      hasExactKeys(value, [
        "code",
        "executionMode",
        "credentialScope",
        "networkAttempted",
        "httpStatus",
        "retryAfterSeconds",
      ]) &&
      nullableString(value.code) &&
      nullableString(value.executionMode) &&
      nullableString(value.credentialScope) &&
      nullableBoolean(value.networkAttempted) &&
      nullableNumber(value.httpStatus) &&
      nullableNumber(value.retryAfterSeconds))
  );
}

function parseRuntimeLock(value: unknown): RuntimeLock {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "protocolVersion",
      "packageName",
      "packageVersion",
      "workspaceId",
    ]) ||
    value.schemaVersion !== 1 ||
    value.protocolVersion !== 1 ||
    value.packageName !== "@tiangong-ai/cli" ||
    typeof value.packageVersion !== "string" ||
    typeof value.workspaceId !== "string"
  ) {
    throw setupAuditError("Setup audit runtime lock shape is invalid.");
  }
  return value as unknown as RuntimeLock;
}

function parsePortableCapabilities(value: Record<string, unknown>): Record<string, unknown> {
  if (
    !hasExactKeys(value, ["schemaVersion", "kind", "sourceFileSha256", "capabilities"]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-capability-declarations-proof" ||
    !isSha(value.sourceFileSha256) ||
    !closedObjectArray(
      value.capabilities,
      [
        "id",
        "skillPath",
        "source",
        "requiredForDiscovery",
        "permissions",
        "allowedHosts",
        "http",
        "coverage",
        "credentials",
        "healthCheck",
      ],
      validPortableCapability,
    )
  ) {
    throw setupAuditError("Setup audit capability declaration proof shape is invalid.");
  }
  return value;
}

function validPortableCapability(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.skillPath === "string" &&
    validPortableCapabilitySource(value.source) &&
    typeof value.requiredForDiscovery === "boolean" &&
    stringArrayIs(value.permissions) &&
    stringArrayIs(value.allowedHosts) &&
    validCapabilityHttp(value.http) &&
    validCapabilityCoverage(value.coverage) &&
    closedObjectArray(
      value.credentials,
      ["id", "allowedHosts", "headerName", "prefixSha256"],
      (item) =>
        typeof item.id === "string" &&
        stringArrayIs(item.allowedHosts) &&
        typeof item.headerName === "string" &&
        isSha(item.prefixSha256),
    ) &&
    validPortableHealthCheck(value.healthCheck)
  );
}

function validCapabilitySource(value: unknown): boolean {
  return (
    value === null ||
    (isObject(value) &&
      hasExactKeys(value, [
        "type",
        "locator",
        "immutableRef",
        "expectedTreeSha256",
        "license",
        "catalogId",
      ]) &&
      ["git", "registry", "local"].includes(String(value.type)) &&
      typeof value.locator === "string" &&
      typeof value.immutableRef === "string" &&
      isSha(value.expectedTreeSha256) &&
      typeof value.license === "string" &&
      nullableString(value.catalogId))
  );
}

function validPortableCapabilitySource(value: unknown): boolean {
  return (
    value === null ||
    (isObject(value) &&
      hasExactKeys(value, [
        "type",
        "locatorSha256",
        "immutableRef",
        "expectedTreeSha256",
        "license",
        "catalogId",
      ]) &&
      ["git", "registry", "local"].includes(String(value.type)) &&
      isSha(value.locatorSha256) &&
      typeof value.immutableRef === "string" &&
      isSha(value.expectedTreeSha256) &&
      typeof value.license === "string" &&
      nullableString(value.catalogId))
  );
}

function validCapabilityHttp(value: unknown): boolean {
  return (
    value === null ||
    (isObject(value) &&
      hasExactKeys(value, [
        "endpoint",
        "method",
        "accept",
        "allowedContentTypes",
        "staticHeaderBindings",
        "maxRequestBytes",
        "maxResponseBytes",
        "maxItems",
      ]) &&
      typeof value.endpoint === "string" &&
      ["GET", "POST"].includes(String(value.method)) &&
      typeof value.accept === "string" &&
      stringArrayIs(value.allowedContentTypes) &&
      closedObjectArray(value.staticHeaderBindings, ["name", "valueSha256"], (item) =>
        Boolean(typeof item.name === "string" && isSha(item.valueSha256)),
      ) &&
      [value.maxRequestBytes, value.maxResponseBytes, value.maxItems].every(
        (item) => Number.isSafeInteger(item) && Number(item) >= 0,
      ))
  );
}

function validCapabilityCoverage(value: unknown): boolean {
  return (
    value === null ||
    (isObject(value) &&
      hasExactKeys(value, [
        "dimensions",
        "sourceTypes",
        "discoveryScopes",
        "fullText",
        "publicationDates",
      ]) &&
      stringArrayIs(value.dimensions) &&
      stringArrayIs(value.sourceTypes) &&
      stringArrayIs(value.discoveryScopes) &&
      typeof value.fullText === "boolean" &&
      typeof value.publicationDates === "boolean")
  );
}

function validPortableHealthCheck(value: unknown): boolean {
  return (
    value === null ||
    (isObject(value) &&
      hasExactKeys(value, [
        "targetSha256",
        "credentialId",
        "expectedContentTypes",
        "method",
        "bodySha256",
      ]) &&
      isSha(value.targetSha256) &&
      nullableString(value.credentialId) &&
      stringArrayIs(value.expectedContentTypes) &&
      ["GET", "POST"].includes(String(value.method)) &&
      isNullableSha(value.bodySha256))
  );
}

function parseCapabilityLock(value: unknown): CapabilityLock {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["schemaVersion", "generatedAt", "capabilities"]) ||
    value.schemaVersion !== 1 ||
    typeof value.generatedAt !== "string" ||
    !closedObjectArray(value.capabilities, capabilityLockRecordKeys(), (record) =>
      validCapabilityLockRecord(record, false),
    )
  ) {
    throw setupAuditError("Setup audit capability lock source shape is invalid.");
  }
  return value as unknown as CapabilityLock;
}

function parsePortableCapabilityLock(value: Record<string, unknown>): Record<string, unknown> {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "sourceFileSha256",
      "generatedAt",
      "capabilities",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-capability-lock-proof" ||
    !isSha(value.sourceFileSha256) ||
    typeof value.generatedAt !== "string" ||
    !closedObjectArray(value.capabilities, capabilityLockRecordKeys(), (record) =>
      validCapabilityLockRecord(record, true),
    )
  ) {
    throw setupAuditError("Setup audit capability lock proof shape is invalid.");
  }
  return value;
}

function capabilityLockRecordKeys(): string[] {
  return [
    "id",
    "skillName",
    "skillPath",
    "treeSha256",
    "policySha256",
    "source",
    "requiredForDiscovery",
    "permissions",
    "credentialIds",
    "discoveryScopes",
    "healthTargetSha256",
  ];
}

function validCapabilityLockRecord(value: Record<string, unknown>, portable: boolean): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.skillName === "string" &&
    typeof value.skillPath === "string" &&
    isSha(value.treeSha256) &&
    isSha(value.policySha256) &&
    (portable
      ? validPortableCapabilitySource(value.source)
      : validCapabilitySource(value.source)) &&
    typeof value.requiredForDiscovery === "boolean" &&
    stringArrayIs(value.permissions) &&
    stringArrayIs(value.credentialIds) &&
    stringArrayIs(value.discoveryScopes) &&
    isNullableSha(value.healthTargetSha256)
  );
}

function parseSetupDeclarationBinding(value: unknown): {
  schemaVersion: 1;
  kind: "tiangong-research-setup-declaration-binding";
  configurationSha256: string;
  planSha256: string;
} {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["schemaVersion", "kind", "configurationSha256", "planSha256"]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-research-setup-declaration-binding" ||
    !isSha(value.configurationSha256) ||
    !isSha(value.planSha256)
  ) {
    throw setupAuditError("Setup audit declaration binding shape is invalid.");
  }
  return value as {
    schemaVersion: 1;
    kind: "tiangong-research-setup-declaration-binding";
    configurationSha256: string;
    planSha256: string;
  };
}

function parsePortableDoctorAttestation(value: Record<string, unknown>): Record<string, unknown> {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "sourceFileSha256",
      "attestationSha256",
      "workspaceIdSha256",
      "checkedAt",
      "expiresAt",
      "configSha256",
      "runtimeLockSha256",
      "capabilityDeclarationsSha256",
      "capabilityLockSha256",
      "doctorSchemaSha256",
      "reviewerExecution",
      "runtimes",
      "capabilitySmoke",
      "smokeUsage",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "tiangong-doctor-attestation-proof" ||
    ![
      value.sourceFileSha256,
      value.attestationSha256,
      value.workspaceIdSha256,
      value.configSha256,
      value.runtimeLockSha256,
      value.capabilityDeclarationsSha256,
      value.capabilityLockSha256,
      value.doctorSchemaSha256,
    ].every(isSha) ||
    typeof value.checkedAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    !validDoctorReviewerExecution(value.reviewerExecution) ||
    !closedObjectArray(
      value.runtimes,
      [
        "agent",
        "modelSha256",
        "effort",
        "verbosity",
        "binarySha256",
        "wrapperSha256",
        "adapterSha256",
        "binaryVersionSha256",
        "platform",
        "architecture",
      ],
      (runtime) =>
        ["codex", "claude", "workbuddy", "codebuddy"].includes(String(runtime.agent)) &&
        isNullableSha(runtime.modelSha256) &&
        nullableString(runtime.effort) &&
        nullableString(runtime.verbosity) &&
        isSha(runtime.binarySha256) &&
        isSha(runtime.wrapperSha256) &&
        isSha(runtime.adapterSha256) &&
        isSha(runtime.binaryVersionSha256) &&
        typeof runtime.platform === "string" &&
        typeof runtime.architecture === "string",
    ) ||
    !closedObjectArray(
      value.capabilitySmoke,
      ["id", "status", "code", "hostSha256", "targetSha256", "httpStatus"],
      (row) =>
        typeof row.id === "string" &&
        ["pass", "not-applicable"].includes(String(row.status)) &&
        typeof row.code === "string" &&
        isNullableSha(row.hostSha256) &&
        isNullableSha(row.targetSha256) &&
        nullableNumber(row.httpStatus),
    ) ||
    !closedObjectArray(
      value.smokeUsage,
      [
        "agent",
        "tokens",
        "inputTokens",
        "cachedInputTokens",
        "outputTokens",
        "costUsd",
        "wallSeconds",
        "telemetrySha256",
      ],
      (usage) =>
        ["codex", "claude", "workbuddy", "codebuddy"].includes(String(usage.agent)) &&
        [
          usage.tokens,
          usage.inputTokens,
          usage.cachedInputTokens,
          usage.outputTokens,
          usage.costUsd,
          usage.wallSeconds,
        ].every((item) => typeof item === "number" && Number.isFinite(item)) &&
        isNullableSha(usage.telemetrySha256),
    )
  ) {
    throw setupAuditError("Setup audit doctor attestation proof shape is invalid.");
  }
  return value;
}

function parseDoctorAttestation(value: unknown): WorkspaceDoctorAttestation {
  if (!isObject(value) || !validDoctorAttestationShape(value)) {
    throw new CliError("Doctor attestation is invalid and cannot be exported.", {
      code: "RESEARCH_SETUP_AUDIT_ATTESTATION_INVALID",
      exitCode: 3,
    });
  }
  const { attestationSha256, ...core } = value;
  if (sha256Text(canonicalJson(core)) !== attestationSha256) {
    throw new CliError("Doctor attestation is invalid and cannot be exported.", {
      code: "RESEARCH_SETUP_AUDIT_ATTESTATION_INVALID",
      exitCode: 3,
    });
  }
  return value as unknown as WorkspaceDoctorAttestation;
}

function validDoctorAttestationShape(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(value, [
      "schemaVersion",
      "workspaceId",
      "checkedAt",
      "expiresAt",
      "configSha256",
      "runtimeLockSha256",
      "capabilityDeclarationsSha256",
      "capabilityLockSha256",
      "doctorSchemaSha256",
      "reviewerExecution",
      "runtimes",
      "capabilitySmoke",
      "smokeUsage",
      "attestationSha256",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.workspaceId === "string" &&
    typeof value.checkedAt === "string" &&
    typeof value.expiresAt === "string" &&
    [
      value.configSha256,
      value.runtimeLockSha256,
      value.capabilityDeclarationsSha256,
      value.capabilityLockSha256,
      value.doctorSchemaSha256,
      value.attestationSha256,
    ].every(isSha) &&
    validDoctorReviewerExecution(value.reviewerExecution) &&
    Array.isArray(value.runtimes) &&
    value.runtimes.every(validDoctorRuntime) &&
    closedObjectArray(
      value.capabilitySmoke,
      ["id", "status", "code", "host", "targetSha256", "httpStatus"],
      (item) =>
        typeof item.id === "string" &&
        ["pass", "not-applicable"].includes(String(item.status)) &&
        typeof item.code === "string" &&
        nullableString(item.host) &&
        isNullableSha(item.targetSha256) &&
        nullableNumber(item.httpStatus),
    ) &&
    Array.isArray(value.smokeUsage) &&
    value.smokeUsage.every(validDoctorUsage)
  );
}

function validDoctorReviewerExecution(value: unknown): boolean {
  return (
    isObject(value) &&
    hasExactKeys(value, [
      "transport",
      "isolationProvider",
      "policySha256",
      "signerKeyFingerprint",
    ]) &&
    ["native-direct", "sandbox-bridge"].includes(String(value.transport)) &&
    ["sandbox-exec", "bubblewrap"].includes(String(value.isolationProvider)) &&
    isSha(value.policySha256) &&
    nullableString(value.signerKeyFingerprint)
  );
}

function validDoctorRuntime(value: unknown): boolean {
  if (!isObject(value)) return false;
  const allowed = [
    "agent",
    "model",
    "effort",
    "verbosity",
    "binarySha256",
    "wrapperSha256",
    "adapterSha256",
    "binaryVersion",
    "platform",
    "architecture",
  ];
  return (
    hasOnlyKeys(value, allowed) &&
    [
      "agent",
      "model",
      "binarySha256",
      "wrapperSha256",
      "adapterSha256",
      "binaryVersion",
      "platform",
      "architecture",
    ].every((key) => Object.hasOwn(value, key)) &&
    ["codex", "claude", "workbuddy", "codebuddy"].includes(String(value.agent)) &&
    nullableString(value.model) &&
    (value.effort === undefined || typeof value.effort === "string") &&
    (value.verbosity === undefined || nullableString(value.verbosity)) &&
    isSha(value.binarySha256) &&
    isSha(value.wrapperSha256) &&
    isSha(value.adapterSha256) &&
    typeof value.binaryVersion === "string" &&
    typeof value.platform === "string" &&
    typeof value.architecture === "string"
  );
}

function validDoctorUsage(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    hasOnlyKeys(value, [
      "agent",
      "tokens",
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "costUsd",
      "wallSeconds",
      "telemetry",
    ]) &&
    [
      "agent",
      "tokens",
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "costUsd",
      "wallSeconds",
    ].every((key) => Object.hasOwn(value, key)) &&
    ["codex", "claude", "workbuddy", "codebuddy"].includes(String(value.agent)) &&
    [
      value.tokens,
      value.inputTokens,
      value.cachedInputTokens,
      value.outputTokens,
      value.costUsd,
      value.wallSeconds,
    ].every((item) => typeof item === "number" && Number.isFinite(item)) &&
    (value.telemetry === undefined || validDoctorTelemetry(value.telemetry))
  );
}

function validDoctorTelemetry(value: unknown): boolean {
  return (
    isObject(value) &&
    hasExactKeys(value, [
      "eventCounts",
      "itemCounts",
      "toolCalls",
      "providerTurns",
      "reasoningOutputTokens",
      "providerErrors",
    ]) &&
    numberRecordIs(value.eventCounts) &&
    numberRecordIs(value.itemCounts) &&
    typeof value.toolCalls === "number" &&
    nullableNumber(value.providerTurns) &&
    typeof value.reasoningOutputTokens === "number" &&
    stringArrayIs(value.providerErrors)
  );
}

function readBundleJson(
  snapshots: ReadonlyMap<string, SetupAuditSourceSnapshot>,
  logical: string,
): Record<string, unknown> {
  const value = snapshots.get(logical)?.value;
  if (!isObject(value)) throw setupAuditError(`Setup audit proof is invalid: ${logical}.`);
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function closedObjectArray(
  value: unknown,
  keys: readonly string[],
  predicate: (item: Record<string, unknown>) => boolean,
): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => isObject(item) && hasExactKeys(item, keys) && predicate(item))
  );
}

function stringArrayIs(value: unknown, allowed?: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === "string" && (allowed === undefined || allowed.includes(item)),
    )
  );
}

function numberRecordIs(value: unknown): boolean {
  return (
    isObject(value) &&
    Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nullableBoolean(value: unknown): boolean {
  return value === null || typeof value === "boolean";
}

function nullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isNullableSha(value: unknown): boolean {
  return value === null || isSha(value);
}

function safePathOrNull(value: string): string | null {
  try {
    return safeRelativePath(value, "Setup audit manifest path");
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function setupAuditError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_SETUP_AUDIT_BUNDLE_INVALID",
    exitCode: 3,
  });
}

function setupAuditPathError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_SETUP_AUDIT_BUNDLE_PATH_INVALID",
    exitCode: 2,
  });
}
