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
lastReviewedAt: 2026-08-04
lastReviewedCommit: 7429c2ab92509920a2728dc38685ad5c4f2c8f13
---

# Repo Validation

## Runtime Baseline

- Node: `>=24 <25`
- Package manager: `npm`
- Source: TypeScript
- Stable launcher: `bin/tiangong-ai.js`
- Research execution sandbox: macOS `sandbox-exec` or Linux Bubblewrap
- Repository text checkout uses LF line endings through `.gitattributes`; this
  keeps Prettier behavior consistent across Linux and Windows CI runners.

## Local Gates

Run before delivery:

```bash
npm run lint
npm test
npm run test:coverage
docpact validate-config --root . --strict
docpact lint --root . --worktree --mode enforce
```

`npm run prepush:gate` aggregates the lint, coverage, and docpact checks when
`docpact` is installed locally.

## Release Flow

`.github/workflows/publish.yml` publishes `@tiangong-ai/cli` to npm from
GitHub Actions. It runs the same npm lint, test, and coverage gates before any
publish attempt.

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
`test/research-runtime-production.test.ts` adds zero-cost
production evals for permanent evidence and review packets, exact HTTP policy,
byte/item/offset/estimated-token extraction bounds and raw-object cache reuse,
sanitized 429/422 handling, structured-output and provenance repair,
mechanically normalized dimension/full-text/publication-date coverage,
bounded local context with full-source review, stage tool isolation, runtime
target/wrapper/adapter fingerprinting and drift rejection, telemetry redaction,
owner-only whitelisted Claude settings authentication, production doctor
attestation, two-protocol-turn tool-free review with exact local/broker bounded views,
persistent packet/context tamper rejection at closure, JSONL progress, and
append-only retry/fork recovery.
