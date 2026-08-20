---
docType: runbook
scope: repo
status: current
authoritative: true
owner: cli
language: en
whenToUse: "When validating Tiangong AI CLI changes, CI behavior, coverage, or release readiness."
whenToUpdate: "When Node baseline, package scripts, coverage thresholds, docpact rules, or CI workflow change."
checkPaths:
  - package.json
  - package-lock.json
  - .dockerignore
  - Dockerfile.clean-test
  - .nvmrc
  - .gitattributes
  - .prettierrc.json
  - scripts/**
  - test/**
  - .github/workflows/**
lastReviewedAt: 2026-08-20
lastReviewedCommit: 574f421b2e3ca032b65248e6ee83af3efdd66c12
---

# Repo Validation

## Runtime Baseline

- Node: `>=24 <25`
- Package manager: `npm`
- Source: TypeScript
- Stable launcher: `bin/tiangong-ai.js`
- Research execution sandbox: macOS `sandbox-exec` or Linux Bubblewrap
- Windows validates setup and deterministic logic in smoke-test mode, but
  production research readiness remains blocked without an approved capsule
  sandbox.
- Repository text checkout uses LF line endings through `.gitattributes`; this
  keeps Prettier behavior consistent across Linux, macOS, and Windows CI
  runners.

## Hosted CI Matrix

`.github/workflows/quality-gate.yml` runs for pull requests and pushes to
`main`, with `fail-fast: false`, across the same four runner/architecture pairs
used by the reference workspace CLI:

- `ubuntu-latest` / `x64`
- `windows-latest` / `x64`
- `macos-latest` / `arm64`
- `ubuntu-24.04-arm` / `arm64`

The runner label selects the actual GitHub-hosted architecture; the explicit
`arch` value keeps job names and matrix intent auditable. Both Linux rows
install Bubblewrap and smoke-test an unprivileged capsule. Every row runs lint,
but each row runs the full test suite only once: Ubuntu x64 obtains that result
through coverage, Ubuntu ARM runs `npm test`, and macOS/Windows run `npm test`
plus the small pure `test:platform` contract. Coverage therefore runs only on
Linux x64 and never follows a duplicate `npm test` in that job.

The pure platform contract models Windows drive letters, separators,
case-insensitive containment and cross-drive paths plus the macOS `/var` to
`/private/var` alias without depending on the current host filesystem. The
central capability profile declares Windows and unsupported systems
configuration/smoke-only: they may validate setup and deterministic logic but
cannot start a native reviewer or reviewer sidecar.

Both PR workflows cancel obsolete runs for the same pull request. Pushes to
`main` are not canceled. The docpact workflow installs the workspace-standard
`0.1.9` release.

## Local Gates

Run before delivery:

```bash
npm run test:clean:cold
npm run lint
npm test
npm run test:platform
npm run test:coverage
npm run audit:research-setup-pins
docpact validate-config --root . --strict
docpact lint --root . --worktree --mode enforce
```

`npm run test:clean` is the iterative red/green/refactor entrypoint. It builds
from the digest-pinned Node 24 image, may reuse Docker layers whose declared
inputs still match, copies only the `.dockerignore`-filtered checkout, and runs
the full lint/coverage gate as a non-root user in a newly created,
runtime-offline container. Tests run after container creation and are never a
build-cache result. Host tests cannot replace this gate.

`npm run test:clean:cold` selects the same isolation contract with an explicit
`--no-cache` build. Run it after `.dockerignore`, Dockerfile, dependency
manifest, or lockfile changes and before delivery. PR and publish workflows use
cold mode. Neither mode uses `--pull`; the base image stays reproducible until
its reviewed digest changes. Provider live checks and the networked
immutable-pin audit run separately because they are explicit networked
validations.

`npm run test:platform` is a fast host-independent contract for platform
classification. It is not a substitute for the real macOS/Windows matrix; it
moves known path and capability semantics ahead of that matrix so hosted
runners discover only genuinely platform-specific defects.

Every runtime container has no host mounts, Docker socket, credentials, or
runtime network. It enables Docker's privileged namespace mode solely so the non-root
test process can exercise the real nested Bubblewrap capsule instead of skipping
or mocking it; the isolation assertion still rejects root execution, host HOME,
global Skills, and global CLI state.

On a Linux test host where
`/proc/sys/kernel/apparmor_restrict_unprivileged_userns` is `1`, the local gate
stops before building and reports the exact prerequisite. The operator or CI
runner must set that host policy to `0` for the test lifetime; the test script
does not mutate host kernel policy itself.

`npm run prepush:gate` aggregates the lint, coverage, and docpact checks when
`docpact` is installed locally.

When a pinned research setup commit or the whole-tree hash algorithm changes,
recompute every affected catalog entry from a clean detached checkout of its
exact immutable commit. Unit tests remain network-free. The explicit
`audit:research-setup-pins` gate is networked: it creates fresh deterministic
checkouts for every Catalog source, verifies every selected source path and
whole-tree hash, validates exact stable versions, and enforces the
orchestrator's workspace-lock resolver/no-stale-version contract. It also parses
every template in the exact pinned Top-Journal Policy pack and requires its
mandatory scientific-design, early-review, and real-record canary invariants.
It is required locally for a pin change and in release CI.

Release CI additionally sets `TIANGONG_RESEARCH_REQUIRE_SKILLS_MAIN=1`; the
audit then requires the first-party `tiangong-ai/skills` pin to be reachable
from remote `main`. This makes a merged Skills change a prerequisite for CLI
release and prevents publishing a catalog from an unmerged branch while still
allowing the catalog to retain the exact reviewed commit beneath a merge commit.

`test/research-setup.test.ts` covers plan-only context, blocked source checkout,
stored broker credentials without ambient credentials, exact retry commands,
source-specific retry provenance, project/global Skill conflicts, symlinked
ambient CLI resolution, legacy PATH-wrapper detection, the generated
recovery-only Skill, and verified cleanup after the full orchestrator is
available. These cases must remain network-free inside `npm run test:clean`.

`test/research-setup-declarative.test.ts` covers public no-overwrite template
initialization, v1 declaration rejection, complete explicit catalog
materialization, fixed workspace-only
discovery, removal of the earlier implicit credential map, strict
duplicate/alias/unknown/incomplete YAML rejection, catalog-metadata drift,
owner-only non-symlink env intake, disabled optional credential behavior,
undeclared and conflicting variable rejection, secret non-persistence,
mandatory live/reviewer checks, semantic-hash plan reuse, explicit replacement
with archived bindings, and non-zero apply/status/doctor results until overall
readiness is complete. The suite uses injected setup operations for
provider-free execution and must not contact a real provider or reviewer
service.

## Release Flow

`.github/workflows/publish.yml` publishes `@tiangong-ai/cli` to npm from
GitHub Actions. It runs the same npm lint, test, and coverage gates before any
publish attempt, then runs the networked immutable Skill pin/runtime-contract
audit before packaging.

Publishing starts when a `v*` tag is pushed. The tag must match
`package.json` version exactly, for example `v0.1.0` for version `0.1.0`.

Linux CI installs Bubblewrap and smoke-tests an unprivileged capsule before the
test suite. On ephemeral Ubuntu runners that expose the AppArmor user-namespace
restriction, the workflow disables that restriction for the runner lifetime so
the test exercises the same unprivileged Bubblewrap boundary required at
runtime.

The workflow uses npm Trusted Publishing through GitHub OIDC. Configure npm
trusted publisher metadata for this repository and workflow before first use;
do not configure an npm token secret. The publish job keeps `id-token: write`
enabled, upgrades npm for trusted publishing, checks that the version is not
already published, runs the local gates, performs a package dry run, and then
executes `npm publish --access public --provenance`.

## Coverage Policy

The coverage gate uses `c8` and fails when coverage drops below the thresholds
encoded in `scripts/run-test-coverage.cjs`. Coverage ignore pragmas are
forbidden; cover the branch or remove dead code.

The initial v0 threshold is intentionally conservative. Raise it as command
coverage grows.

`test/research-workspace.test.ts` exercises context classification, current
workspace initialization, environment rejection, capability locks, the MCP
broker boundary, platform sandbox invocation, multi-project scheduling,
project-scoped scheduling/exit semantics, pre-call budget enforcement,
independent review, closure, and the public command family.
`test/research-setup.test.ts` covers the separately sourced recommendation
catalog, immutable plan/tamper checks, explicit licenses and global mutation,
credential preflight and 0600 persistence before downloads, resumable setup
state, hidden-TTY/env/bounded-stdin/explicit-skip Wizard paths without secret
disclosure, TTY Wizard automation and color suppression, pinned Brave
source-layout paths across every evidence profile, deterministic Git checkout
configuration, safe hash-mismatch diagnostics and pre-installer fail-closed
behavior, workspace-lock resolver/stale-version rejection, Catalog CLI-drift
warnings, optional setting/credential omission without false readiness
warnings, reusable runtime-bound live
attestations, explicit orchestrator/default-baseline selection,
replacement-time managed capability and credential pruning with custom/Skill
preservation, explicit smoke-failure blocking, minimal secret environments,
exact document/paper artifact
binding, no-overwrite/no-directory-scan behavior, explicit browser handoff, and
bounded JSON POST broker credential/body redaction. Readiness tests additionally
prove that one capability probe is reused, paid reviewer smoke is skipped after
a blocking prerequisite, Semantic Scholar throttling degrades only acquisition,
and an optional preprocessor becomes a hard gate only when its exact catalog ID
is required by the project.
`test/research-workspace.test.ts` also fixes the whole-tree traversal order to
NFC-normalized UTF-8 byte ordering so default ICU locale changes cannot alter a
capability or setup pin.
`test/research-runtime-production.test.ts` adds zero-cost
production evals for permanent evidence and review packets, exact HTTP policy,
byte/item/offset/estimated-token extraction bounds and raw-object cache reuse,
sanitized 429/422 handling, bounded broker-level 429 retry, structured-output and provenance repair,
audited deterministic Markdown newline-artifact normalization before independent review,
mechanically normalized dimension/full-text/publication-date coverage,
bounded local context with full-source review, stage tool isolation, runtime
target/wrapper/adapter fingerprinting and drift rejection, telemetry redaction,
owner-only whitelisted Claude settings authentication, production doctor
attestation creation, default-doctor reuse, current-runtime drift rejection,
two-protocol-turn tool-free review with exact local views and cited broker
items selected from hash-bound raw responses by admitted JSON Pointer,
persistent packet/context tamper rejection at closure, JSONL progress, and
append-only retry/fork recovery. `test/research-external-skills.test.ts`
validates the pinned external recommendation catalog, actionable missing-install
errors, owner-environment credential configuration without disclosure, custom
database Skill admission, whole-tree locks and staged manifests, static/live
provider checks, bounded 429 retry, authentication/rate-limit redaction,
exact endpoint staging and pre-fetch/redirect scope rejection,
distinct report/patent capability admission, broker-store versus provider-auth
diagnostics, bounded sanitized provider code/detail/request-ID retention,
source-to-installed-tree binding, refusal to bless drift through lock/configure/import,
internal-source rejection, invalid-definition errors, sensitive health-URL
rejection, and blocked catalog/doctor status for symlinked credential files.
Native-host regression coverage proves that ordinary `research run` never
invokes the producer executor, prepare/submit advances discover through
synthesize with hash-bound sessions and reserved accounting, native broker
fetches remain call-bounded and sanitized, and only the other-family reviewer
CLI is launched before mechanical closure.
`test/research-policy.test.ts` and `test/research-policy-wizard.test.ts` cover
verified project-installed Policy source resolution, exhaustive bundled-template
parsing, mandatory top-journal invariants, default selection and human
completion, exact-journal requirements, explicit default acknowledgement,
content/manifest tamper detection, expiry, conflict resolution, and stage
binding. Setup doctor tests prove incompatible packs block before paid reviewer
smoke. `test/research-publication-workflow.test.ts` covers mechanical
top-journal assessment, owner-input trust ceilings, immutable manuscript
generations, required manuscript sections, complete distinct-file submission
roles, content/inference/analysis/Claim-Evidence Graph topology bindings,
reproducibility manifests, Policy/evidence/base-output hashes, four
role-specific review schemas, configured other-family producer/reviewer
separation, append-only reviewer-session reuse rejection, raw-session
non-persistence, active-base-research status, revision invalidation, package
status projection, and publication closure language ceilings.
`test/research-acquisition.test.ts` additionally covers honest acquisition
freeze with a separate inference stop, exact decomposition lineage, evidence
atoms, typed-content snapshots, inference snapshots, generated Claim-Evidence
Graphs, operator-visible `evidencePipeline` status, semantic audit-chain export,
safe journal-proof derivatives, and pre-export tamper rejection.
`test/research-scientific-design.test.ts` uses the EV pavement-model R9 failure
as a fixed regression for truth-role confusion, non-independent validation,
effective-sample inflation, quantity/threshold overclaim, closest-work
full-text gaps, unresolved blocking gaps, unfair baselines, and context-plan
overflow. Later EV review regressions cover retrievable raw-byte model and
environment bindings, implementation-versus-freeze status, Policy ownership of
pending model/environment/uncertainty objects, exact joint-state mappings,
continuous decision-consequence graphs, explicit factor/uncertainty
composition, and the rule that specification bytes do not establish
executability. `test/research-scientific-admission.test.ts` covers native producer
session hashing, immutable design admission, Policy/design identity, complete
lifecycle reservations, and target-specific fork generations.
`test/research-scientific-objects.test.ts` covers the public pre-admission
scientific-object register/inspect flow, raw Python and lock-file promotion,
idempotency, exact media/object-kind packet metadata, symlink and control-store
source rejection, unsupported-media and host-path redaction, preflight gaps,
kind mismatch, immutable-blob drift at project admission, canonical parent
aliases, and Windows cross-volume containment classification.
`test/research-scientific-review.test.ts` covers the ordered research-design,
real-record evidence-construct, and pilot-methods gates; other-family/fresh
reviewer sessions; closed assessment/review schemas; mechanical precedence;
post-acquisition snapshot source/full-text/date binding; exact promoted canary
artifact binding; rejection of invented evidence IDs and unbound digests;
stage-time hash revalidation; machine-visible future obligations before their
due gate and blocking errors at that gate; and the invariant that 200,000
resamples of four independent structures still provide four independent
structures.
`test/research-audit-bundle.test.ts` covers exact portable export and independent
verification, formal evidence/artifact bytes, transformed input bindings,
environment and journal proofs, read-only content, tamper/extra-byte rejection,
and exclusion of credentials, active state, capsules, unrelated projects,
host-specific paths, and sensitive URL/authentication material.
Production tests additionally require an external
public-internet plan and block downstream work when any capability marked
`requiredForDiscovery` lacks a broker receipt. The failure distinguishes a
capability that was never exercised from one that was attempted but yielded no
admissible receipt, including only sanitized failure-kind metadata.

`test/research-evidence-ledger.test.ts` covers append-only ledger integrity,
cross-receipt canonical deduplication, bounded incremental discovery judgments,
compact closeout, and dynamic coverage-derived discovery budgets with early
stop and a hard ceiling. `test/research-acquisition.test.ts` covers native-lead
formalization, hashed native activity, exact download-event and concurrent-file
isolation, failed/cancelled non-commit behavior, sensitive locator redaction,
PDF/ZIP/OpenXML structure checks, false-PDF rejection, derived-artifact lineage,
parent URL inheritance and conflicting derivative URL rejection, binary-only
versus producer-readable full text, artifact drift, immutable
snapshot/delta lineage, and non-destructive addenda. Workspace/runtime tests
additionally verify default superseded-project filtering, authoritative fork
lineage, archive/abandon dispositions, durable user/external handoffs and
challenge gates, and closure rejection when any bound snapshot-chain object
drifts. `test/research-workspace-lock.test.ts` uses real child processes to
prove `SIGKILL` recovery, released single-file-lock migration, live-owner
refusal with sanitized actionable diagnostics, and owner-token-checked release;
the full setup suite also proves that setup initialization accepts only the
exact current lease artifacts while the lock is held.

Scientific route-exhaustion regressions additionally require exact route IDs on
broker, native-host, and download events; reject unbound or selector-mismatched
events; and verify project-scope plus hash-chain integrity before status. They
also reject optional agent routes for required roles, unmapped required
capabilities, and unavailable plan-bound broker capabilities. They
prove that completed-insufficient and explicit authentication/entitlement
blocks may close a route, while failed native work, login/MFA/CAPTCHA/security
challenges, HTTP 422, 429, 5xx, timeouts, and cancelled downloads remain
retry/user-intervention states. Structured handoff tests cover safe official
locators, sensitive URL/token redaction, exact terminal hashes, purchase and
external-request actions, empty-route scope pivots, durable status, and no
manifest/output promotion after a failed or cancelled acquisition.

Reviewer executor regression coverage verifies that a Codex reviewer receives
exactly one external-sandbox bypass flag and no nested `--sandbox read-only`
flag, while shell and unified-exec remain disabled. It also verifies the
capsule-local project-root marker/config override that prevents parent
project-config reads.
`test/research-review-bridge.test.ts` covers explicit no-fallback selection,
missing-sidecar errors, exact capsule copying, owner-only external key state,
signed request/result/policy bindings, model/version/signature drift, atomic
nonce replay rejection, a fixed no-command protocol, secret redaction, real
macOS/Linux negative probes, workspace doctor routing, and the long-running CLI
sidecar lifecycle. WorkBuddy native-host tests separately prove that the CLI
records the real producer identity, refuses to launch it as a child, removes the
single active-session binding after submit, and retains the completed capsule
with a non-sensitive journal disposition instead of requesting a recursive bulk
delete from the outer IDE. A full injected WorkBuddy package flow separately
proves that the reviewer/work-package capsule is retained with the same bounded
disposition while mechanical closure still completes.
Primary/repair reuse tests verify that an identical owner-only auth copy is
accepted idempotently while source drift is rejected without overwriting the
capsule file. Claude subscription regressions verify successful atomic refresh
writeback, concurrent owner-change refusal without overwrite, and retained
capsule disposition when reconciliation fails. The legacy lock regression
parses the exact recovery event before checking that PID data is absent, rather
than treating unrelated timestamp or digest digits as a leak.
Leaf-command help tests run from an unmanaged directory before workspace
resolution. A deterministic fake Codex emits a
90 KiB MCP result to prove the capture reservation includes bounded tool
context instead of failing at the historical 64 KiB floor. The retained
test-only injected-producer seam verifies legacy broker packet bounds without
being reachable from the public CLI; native runtime tests cover the public
prepare/fetch/submit protocol.
Preflight/runtime parity coverage verifies that the full bounded capability
documentation allowance is reserved for every possible broker turn and fits
the default discovery package before project admission.
Broker tests also prove that the configured view ceiling rejects an excess
request before another provider fetch while retaining a sanitized journal event
and the already admitted receipt. Project-cache reuse avoids a second provider
call but still consumes one bounded context-view reservation.
