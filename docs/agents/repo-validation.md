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
  - .nvmrc
  - .gitattributes
  - .prettierrc.json
  - scripts/**
  - test/**
  - .github/workflows/**
lastReviewedAt: 2026-08-10
lastReviewedCommit: bef62f8d48c42eaff14fa2bd7eba1be83a46a58b
---

# Repo Validation

## Runtime Baseline

- Node: `>=24 <25`
- Package manager: `npm`
- Source: TypeScript
- Stable launcher: `bin/tiangong-ai.js`
- Research execution sandbox: macOS `sandbox-exec` or Linux Bubblewrap
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
install Bubblewrap and smoke-test an unprivileged capsule before the test
suite. The remaining lint, test, and coverage steps stay identical across all
four rows.

## Local Gates

Run before delivery:

```bash
npm run lint
npm test
npm run test:coverage
npm run audit:research-setup-pins
docpact validate-config --root . --strict
docpact lint --root . --worktree --mode enforce
```

`npm run prepush:gate` aggregates the lint, coverage, and docpact checks when
`docpact` is installed locally.

When a pinned research setup commit or the whole-tree hash algorithm changes,
recompute every affected catalog entry from a clean detached checkout of its
exact immutable commit. Unit tests remain network-free. The explicit
`audit:research-setup-pins` gate is networked: it creates fresh deterministic
checkouts for every Catalog source, verifies every selected source path and
whole-tree hash, validates exact stable versions, and enforces the
orchestrator's workspace-lock resolver/no-stale-version contract. It is required
locally for a pin change and in release CI.

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
Production tests additionally require an external
public-internet plan and block downstream work when any capability marked
`requiredForDiscovery` lacks a broker receipt. The failure distinguishes a
capability that was never exercised from one that was attempted but yielded no
admissible receipt, including only sanitized failure-kind metadata.

Reviewer executor regression coverage verifies that a Codex reviewer receives
exactly one external-sandbox bypass flag and no nested `--sandbox read-only`
flag, while shell and unified-exec remain disabled. It also verifies the
capsule-local project-root marker/config override that prevents parent
project-config reads.
Primary/repair reuse tests verify that an identical owner-only auth copy is
accepted idempotently while source drift is rejected without overwriting the
capsule file.
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
Broker tests also prove that the configured call ceiling rejects an excess
request before another provider fetch while retaining a sanitized journal
event and the already admitted receipt.
