import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/io.js";
import { lockCapabilities } from "../src/research/workspace/capabilities.js";
import {
  exportSetupAuditBundle,
  verifySetupAuditBundle,
  type SetupAuditManifest,
} from "../src/research/workspace/setup-audit-bundle.js";
import { createResearchSetupPlan } from "../src/research/workspace/setup.js";
import { schemaForStage } from "../src/research/workspace/schemas.js";
import {
  canonicalJson,
  hashRegularTree,
  regularTreeFiles,
  sha256File,
  sha256Text,
  workspacePaths,
  writeJsonAtomic,
} from "../src/research/workspace/storage.js";
import {
  initializeResearchWorkspace,
  loadWorkspaceConfig,
  loadWorkspaceMarker,
} from "../src/research/workspace/workspace.js";

describe("portable research setup audit bundles", () => {
  it("exports a movable pre-project proof without host paths, secrets, or excluded stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-setup-audit-workspace-"));
    const destination = join(tmpdir(), `tiangong-setup-audit-${process.pid}-${Date.now()}`);
    const moved = `${destination}-moved`;
    const secret = "opaque-setup-audit-owner-secret";
    const unrelatedHostPath = "/Users/alice/.claude/session.json";
    const credentialEnvironmentName = "BRAVE_API_KEY";
    try {
      const plan = await setupFixture(root, "PARTIALLY_READY", secret);
      const paths = workspacePaths(root);
      await writeJsonAtomic(paths.capabilityLock, {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        capabilities: [],
      });
      const marker = await loadWorkspaceMarker(root);
      const config = await loadWorkspaceConfig(root);
      const checkedAt = new Date().toISOString();
      const attestationCore = {
        schemaVersion: 1 as const,
        workspaceId: marker.workspaceId,
        checkedAt,
        expiresAt: new Date(Date.parse(checkedAt) + 60_000).toISOString(),
        configSha256: sha256Text(canonicalJson(config)),
        runtimeLockSha256: await sha256File(paths.runtimeLock),
        capabilityDeclarationsSha256: await sha256File(paths.capabilityDeclarations),
        capabilityLockSha256: await sha256File(paths.capabilityLock),
        doctorSchemaSha256: sha256Text(canonicalJson(schemaForStage("doctor"))),
        reviewerExecution: {
          transport: config.reviewerExecution.transport,
          isolationProvider: process.platform === "darwin" ? "sandbox-exec" : "bubblewrap",
          policySha256: "d".repeat(64),
          signerKeyFingerprint: null,
        },
        runtimes: [
          {
            agent: config.reviewer.agent,
            model: config.reviewer.model,
            binarySha256: "a".repeat(64),
            wrapperSha256: "b".repeat(64),
            adapterSha256: "c".repeat(64),
            binaryVersion: `audit-fixture ${unrelatedHostPath}`,
            platform: process.platform,
            architecture: process.arch,
          },
        ],
        capabilitySmoke: [],
        smokeUsage: [
          {
            agent: config.reviewer.agent,
            tokens: 1,
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            wallSeconds: 0.01,
            telemetry: {
              eventCounts: {},
              itemCounts: {},
              toolCalls: 0,
              providerTurns: 1,
              reasoningOutputTokens: 0,
              providerErrors: [`failed at ${unrelatedHostPath} using ${credentialEnvironmentName}`],
            },
          },
        ],
      };
      await writeJsonAtomic(paths.doctorAttestation, {
        ...attestationCore,
        attestationSha256: sha256Text(canonicalJson(attestationCore)),
      });
      await Promise.all([
        writeOwnerFile(paths.env, "TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={}\n"),
        writeOwnerFile(paths.setupDeclarationEnv, `OWNER_SECRET=${secret}\n`),
        writeOwnerFile(paths.setupAdapterEnv, "TIANGONG_RESEARCH_ADAPTER_CREDENTIALS_JSON={}\n"),
      ]);
      await mkdir(paths.setupSources, { recursive: true });
      await writeFile(join(paths.setupSources, "must-not-export.txt"), secret);
      await writeFile(join(root, "concurrent-unrelated.pdf"), "%PDF-unrelated\n");

      const exported = await exportSetupAuditBundle({
        root,
        destination,
        environment: { OWNER_SECRET: secret },
      });
      assert.equal(exported.kind, "tiangong-setup-audit-bundle");
      assert.equal(exported.sourceBindings.setupPlan.planSha256, plan.planSha256);
      assert.equal(exported.readiness.overall, "PARTIALLY_READY");
      assert.match(exported.manifestSha256, /^[a-f0-9]{64}$/);
      assert.equal(
        (
          await verifySetupAuditBundle(destination, {
            expectedManifestSha256: exported.manifestSha256,
          })
        ).status,
        "verified",
      );

      const manifest = JSON.parse(
        await readFile(join(destination, "manifest.json"), "utf8"),
      ) as SetupAuditManifest;
      assert.ok(manifest.files.length >= 3);
      assert.ok(
        manifest.files.every((file) => !file.path.startsWith("/") && !file.path.includes("..")),
      );
      assert.equal(manifest.availability.setupReport, true);
      assert.equal(manifest.availability.doctorAttestation, true);

      const combined = (
        await Promise.all(
          (await regularTreeFiles(destination)).map(async (path) =>
            (await readFile(path)).toString("utf8"),
          ),
        )
      ).join("\n");
      assert.equal(combined.includes(root), false);
      assert.equal(combined.includes(secret), false);
      assert.equal(combined.includes("OWNER_SECRET"), false);
      assert.equal(combined.includes("OWNER_S2_KEY"), false);
      assert.equal(combined.includes("setup-sources"), false);
      assert.equal(combined.includes("concurrent-unrelated.pdf"), false);
      assert.equal(combined.includes(unrelatedHostPath), false);
      assert.equal(combined.includes(credentialEnvironmentName), false);

      await rename(destination, moved);
      assert.equal(
        (
          await verifySetupAuditBundle(moved, {
            expectedManifestSha256: exported.manifestSha256,
          })
        ).status,
        "verified",
      );
      const unanchored = await invokeCli([
        "research",
        "setup",
        "audit",
        "verify",
        "--bundle",
        moved,
        "--json",
      ]);
      assert.equal(unanchored.exitCode, 2);
      const cliVerified = await invokeCli([
        "research",
        "setup",
        "audit",
        "verify",
        "--bundle",
        moved,
        "--expected-manifest-sha256",
        exported.manifestSha256,
        "--json",
      ]);
      assert.equal(cliVerified.exitCode, 0, cliVerified.stderr);
      assert.equal(JSON.parse(cliVerified.stdout).status, "verified");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
        rm(moved, { recursive: true, force: true }),
      ]);
    }
  });

  it("fails closed on tamper, extra bytes, symlinks, and an invalid doctor attestation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-setup-audit-integrity-"));
    const destination = join(
      tmpdir(),
      `tiangong-setup-audit-integrity-${process.pid}-${Date.now()}`,
    );
    const semantic = `${destination}-semantic`;
    const forged = `${destination}-forged`;
    const bindingDrift = `${destination}-binding-drift`;
    const closedProof = `${destination}-closed-proof`;
    const raced = `${destination}-raced`;
    const linked = `${destination}-linked`;
    try {
      await setupFixture(root, "BLOCKED", "integrity-owner-secret");
      const paths = workspacePaths(root);
      await writeJsonAtomic(paths.doctorAttestation, { schemaVersion: 1, tampered: true });
      await assert.rejects(
        exportSetupAuditBundle({ root, destination }),
        errorCode("RESEARCH_SETUP_AUDIT_ATTESTATION_INVALID"),
      );
      await rm(paths.doctorAttestation, { force: true });

      const exported = await exportSetupAuditBundle({ root, destination });
      await writeFile(join(destination, "extra.txt"), "unbound\n");
      await assert.rejects(
        verifySetupAuditBundle(destination, {
          expectedManifestSha256: exported.manifestSha256,
        }),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_INVALID"),
      );
      await rm(join(destination, "extra.txt"));

      const portablePlan = join(destination, "control", "setup-plan.portable.json");
      await chmod(portablePlan, 0o600);
      await writeFile(portablePlan, '{"tampered":true}\n');
      await assert.rejects(
        verifySetupAuditBundle(destination, {
          expectedManifestSha256: exported.manifestSha256,
        }),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_INVALID"),
      );

      const semanticExport = await exportSetupAuditBundle({ root, destination: semantic });
      const reportPath = join(semantic, "control", "setup-report.portable.json");
      const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
      report.overallReadiness = "READY";
      await writeJsonAtomic(reportPath, report, 0o444);
      const manifestPath = join(semantic, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SetupAuditManifest;
      const reportRecord = manifest.files.find(
        (file) => file.path === "control/setup-report.portable.json",
      );
      assert.ok(reportRecord);
      reportRecord.sha256 = await sha256File(reportPath);
      reportRecord.bytes = (await lstat(reportPath)).size;
      const { manifestSha256: _previousManifestSha256, ...manifestCore } = manifest;
      manifest.manifestSha256 = sha256Text(canonicalJson(manifestCore));
      await writeJsonAtomic(manifestPath, manifest, 0o444);
      await assert.rejects(
        verifySetupAuditBundle(semantic, {
          expectedManifestSha256: manifest.manifestSha256,
        }),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_INVALID"),
      );

      await rm(reportPath);
      await symlink(portablePlan, reportPath);
      await assert.rejects(
        verifySetupAuditBundle(semantic, {
          expectedManifestSha256: semanticExport.manifestSha256,
        }),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_INVALID"),
      );

      const forgedExport = await exportSetupAuditBundle({ root, destination: forged });
      const forgedReportPath = join(forged, "control", "setup-report.portable.json");
      const forgedReport = JSON.parse(await readFile(forgedReportPath, "utf8")) as Record<
        string,
        unknown
      >;
      forgedReport.overallReadiness = "READY";
      await writeJsonAtomic(forgedReportPath, forgedReport, 0o444);
      const forgedManifestPath = join(forged, "manifest.json");
      const forgedManifest = JSON.parse(
        await readFile(forgedManifestPath, "utf8"),
      ) as SetupAuditManifest;
      forgedManifest.readiness.overall = "READY";
      const forgedRecord = forgedManifest.files.find(
        (file) => file.path === "control/setup-report.portable.json",
      );
      assert.ok(forgedRecord);
      forgedRecord.sha256 = await sha256File(forgedReportPath);
      forgedRecord.bytes = (await lstat(forgedReportPath)).size;
      const { manifestSha256: _forgedPrevious, ...forgedCore } = forgedManifest;
      forgedManifest.manifestSha256 = sha256Text(canonicalJson(forgedCore));
      await writeJsonAtomic(forgedManifestPath, forgedManifest, 0o444);
      await assert.rejects(
        verifySetupAuditBundle(forged, {
          expectedManifestSha256: forgedExport.manifestSha256,
        }),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_INVALID"),
      );
      assert.equal(
        (
          await verifySetupAuditBundle(forged, {
            expectedManifestSha256: forgedManifest.manifestSha256,
          })
        ).status,
        "verified",
      );

      await exportSetupAuditBundle({ root, destination: bindingDrift });
      const driftManifestPath = join(bindingDrift, "manifest.json");
      const driftManifest = JSON.parse(
        await readFile(driftManifestPath, "utf8"),
      ) as SetupAuditManifest;
      driftManifest.sourceBindings.setupPlan.planSha256 = "b".repeat(64);
      const { manifestSha256: _driftPrevious, ...driftCore } = driftManifest;
      driftManifest.manifestSha256 = sha256Text(canonicalJson(driftCore));
      await writeJsonAtomic(driftManifestPath, driftManifest, 0o444);
      await assert.rejects(
        verifySetupAuditBundle(bindingDrift, {
          expectedManifestSha256: driftManifest.manifestSha256,
        }),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_INVALID"),
      );

      await exportSetupAuditBundle({ root, destination: closedProof });
      const closedPlanPath = join(closedProof, "control", "setup-plan.portable.json");
      const closedPlan = JSON.parse(await readFile(closedPlanPath, "utf8")) as Record<
        string,
        unknown
      >;
      closedPlan.payload = "unknown-but-hash-bound";
      await writeJsonAtomic(closedPlanPath, closedPlan, 0o444);
      const closedManifestPath = join(closedProof, "manifest.json");
      const closedManifest = JSON.parse(
        await readFile(closedManifestPath, "utf8"),
      ) as SetupAuditManifest;
      const closedPlanRecord = closedManifest.files.find(
        (file) => file.path === "control/setup-plan.portable.json",
      );
      assert.ok(closedPlanRecord);
      closedPlanRecord.sha256 = await sha256File(closedPlanPath);
      closedPlanRecord.bytes = (await lstat(closedPlanPath)).size;
      const { manifestSha256: _closedPrevious, ...closedCore } = closedManifest;
      closedManifest.manifestSha256 = sha256Text(canonicalJson(closedCore));
      await writeJsonAtomic(closedManifestPath, closedManifest, 0o444);
      await assert.rejects(
        verifySetupAuditBundle(closedProof, {
          expectedManifestSha256: closedManifest.manifestSha256,
        }),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_INVALID"),
      );

      const racedExport = await exportSetupAuditBundle({ root, destination: raced });
      const raceOptions = {
        expectedManifestSha256: racedExport.manifestSha256,
        afterSnapshotBound: async () => {
          const racedPlanPath = join(raced, "control", "setup-plan.portable.json");
          const racedPlan = JSON.parse(await readFile(racedPlanPath, "utf8")) as Record<
            string,
            unknown
          >;
          racedPlan.createdAt = "2099-01-01T00:00:00.000Z";
          await writeJsonAtomic(racedPlanPath, racedPlan, 0o444);
        },
      };
      await assert.rejects(
        verifySetupAuditBundle(raced, raceOptions),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_INVALID"),
      );

      await symlink(destination, linked);
      await assert.rejects(
        exportSetupAuditBundle({ root, destination: linked }),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_PATH_INVALID"),
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
        rm(semantic, { recursive: true, force: true }),
        rm(forged, { recursive: true, force: true }),
        rm(bindingDrift, { recursive: true, force: true }),
        rm(closedProof, { recursive: true, force: true }),
        rm(raced, { recursive: true, force: true }),
        rm(linked, { force: true }),
      ]);
    }
  });

  it("exposes export through the public CLI without rerunning setup work", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-setup-audit-cli-"));
    const destination = join(tmpdir(), `tiangong-setup-audit-cli-${process.pid}-${Date.now()}`);
    try {
      await setupFixture(root, "READY", "cli-audit-owner-secret");
      const result = await invokeCli([
        "research",
        "setup",
        "audit",
        "export",
        "--workspace",
        root,
        "--output",
        destination,
        "--json",
      ]);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).kind, "tiangong-setup-audit-bundle");
      const exported = JSON.parse(result.stdout) as SetupAuditManifest;
      assert.equal(
        (
          await verifySetupAuditBundle(destination, {
            expectedManifestSha256: exported.manifestSha256,
          })
        ).status,
        "verified",
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects escaped secrets, oversized sources, and unknown declaration fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-setup-audit-sensitive-"));
    const base = join(tmpdir(), `tiangong-setup-audit-sensitive-${process.pid}-${Date.now()}`);
    const escapedSecret = 'opaque"slash\\line\nsecond-line-secret';
    try {
      const plan = await setupFixture(root, "READY", escapedSecret);
      const binding = workspacePaths(root).setupDeclarationBinding;
      const validBinding = {
        schemaVersion: 1,
        kind: "tiangong-research-setup-declaration-binding",
        configurationSha256: "a".repeat(64),
        planSha256: plan.planSha256,
      };
      await writeJsonAtomic(binding, { ...validBinding, payload: escapedSecret });
      await assert.rejects(
        exportSetupAuditBundle({
          root,
          destination: `${base}-secret`,
          environment: { OWNER_SECRET: escapedSecret },
        }),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_SENSITIVE"),
      );

      await writeJsonAtomic(binding, { ...validBinding, payload: "x".repeat(17 * 1024 * 1024) });
      await assert.rejects(
        exportSetupAuditBundle({ root, destination: `${base}-oversized` }),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_INVALID"),
      );

      await writeJsonAtomic(binding, { ...validBinding, payload: "unknown-but-safe" });
      await assert.rejects(
        exportSetupAuditBundle({ root, destination: `${base}-unknown` }),
        errorCode("RESEARCH_SETUP_AUDIT_BUNDLE_INVALID"),
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(`${base}-secret`, { recursive: true, force: true }),
        rm(`${base}-oversized`, { recursive: true, force: true }),
        rm(`${base}-unknown`, { recursive: true, force: true }),
      ]);
    }
  });

  it("hashes an owner local capability locator instead of exporting its host path", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiangong-setup-audit-local-capability-"));
    const externalParent = await mkdtemp(join(tmpdir(), "private-owner-capability-"));
    const external = join(externalParent, "owner-local-capability");
    const destination = join(
      tmpdir(),
      `tiangong-setup-audit-local-capability-${process.pid}-${Date.now()}`,
    );
    const staticSecret = "opaque-static-header-secret";
    const prefixSecret = "opaque-credential-prefix-secret";
    try {
      await setupFixture(root, "READY", "local-capability-secret");
      await mkdir(external);
      await writeFile(
        join(external, "SKILL.md"),
        "---\nname: owner-local-capability\ndescription: Owner local fixture.\n---\n",
      );
      const treeSha256 = await hashRegularTree(external);
      await writeJsonAtomic(workspacePaths(root).capabilityDeclarations, {
        schemaVersion: 1,
        capabilities: [
          {
            id: "owner.local-capability",
            skillPath: external,
            source: {
              type: "local",
              locator: external,
              immutableRef: `sha256:${treeSha256}`,
              expectedTreeSha256: treeSha256,
              license: "owner-authorized",
              catalogId: null,
            },
            requiredForDiscovery: false,
            permissions: ["project-read", "candidate-write", "brokered-network"],
            allowedHosts: ["owner.example.test"],
            http: {
              endpoint: "https://owner.example.test/",
              method: "GET",
              accept: "application/json",
              allowedContentTypes: ["application/json"],
              staticHeaders: { "x-region": staticSecret },
              maxRequestBytes: 1,
              maxResponseBytes: 4096,
              maxItems: 10,
            },
            coverage: {
              dimensions: ["*"],
              sourceTypes: ["owner-database"],
              discoveryScopes: ["database:owner"],
              fullText: false,
              publicationDates: true,
            },
            credentials: [
              {
                id: "owner.local-capability.api-key",
                allowedHosts: ["owner.example.test"],
                headerName: "Authorization",
                prefix: prefixSecret,
              },
            ],
            healthCheck: null,
          },
        ],
      });
      await lockCapabilities(root);
      const exported = await exportSetupAuditBundle({ root, destination });
      await verifySetupAuditBundle(destination, {
        expectedManifestSha256: exported.manifestSha256,
      });
      const combined = (
        await Promise.all(
          (await regularTreeFiles(destination)).map(async (path) =>
            (await readFile(path)).toString("utf8"),
          ),
        )
      ).join("\n");
      assert.equal(combined.includes(external), false);
      assert.equal(combined.includes(staticSecret), false);
      assert.equal(combined.includes(prefixSecret), false);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(externalParent, { recursive: true, force: true }),
        rm(destination, { recursive: true, force: true }),
      ]);
    }
  });
});

async function setupFixture(root: string, readiness: string, secret: string) {
  const plan = await createResearchSetupPlan({
    workspace: root,
    mode: "smoke-test",
    evidenceProfile: "none",
    skillIds: ["tiangong.academic-paper-download"],
    acceptedLicenseIds: ["tiangong-ai-skills:MIT"],
    credentialEnvironment: { "semantic-scholar.api-key": "OWNER_S2_KEY" },
    settings: { "unpaywall.contact-email": "audit@example.test" },
    confirmNetworkDownloads: true,
    environment: { OWNER_S2_KEY: secret },
  });
  await initializeResearchWorkspace(root, "Portable setup audit fixture", "smoke-test");
  const paths = workspacePaths(root);
  await writeJsonAtomic(paths.setupReport, {
    schemaVersion: 1,
    workspace: root,
    planSha256: plan.planSha256,
    checkedAt: "2026-08-21T00:00:00.000Z",
    mode: "static",
    readiness: readiness === "BLOCKED" ? "BLOCKED" : "READY",
    researchReadiness: readiness === "BLOCKED" ? "BLOCKED" : "READY",
    preprocessingReadiness: "NOT_REQUIRED",
    acquisitionReadiness: "NOT_REQUIRED",
    authoringReadiness: "NOT_REQUIRED",
    overallReadiness: readiness,
    checks: [
      {
        id: "synthetic-proof",
        category: "runtime",
        status: readiness === "READY" ? "pass" : "warn",
        detail: `host=${root} Authorization: Bearer ${secret}`,
        minimumAction: `retry --workspace ${root}`,
        scope: "research-core",
        componentIds: [],
        requiredFor: ["setup"],
        blocking: false,
        componentGate: true,
      },
    ],
    summary: { pass: readiness === "READY" ? 1 : 0, warn: readiness === "READY" ? 0 : 1, fail: 0 },
  });
  return plan;
}

async function writeOwnerFile(path: string, content: string) {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function invokeCli(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    env: {},
    stdout: { write: (chunk) => ((stdout += chunk), true) },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
  };
  const exitCode = await runCli(argv, io);
  return { exitCode, stdout, stderr };
}

function errorCode(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  };
}
