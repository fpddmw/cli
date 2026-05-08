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
  - scripts/**
  - test/**
  - .github/workflows/**
lastReviewedAt: 2026-05-08
lastReviewedCommit: 2f4144ea41116de344f7fce1f2ef919823b09bff
---

# Repo Validation

## Runtime Baseline

- Node: `>=24 <25`
- Package manager: `npm`
- Source: TypeScript
- Stable launcher: `bin/tiangong.js`

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

## Coverage Policy

The coverage gate uses `c8` and fails when coverage drops below the thresholds
encoded in `scripts/run-test-coverage.cjs`. Coverage ignore pragmas are
forbidden; cover the branch or remove dead code.

The initial v0 threshold is intentionally lower than the mature LCA CLI gate.
Raise it as command coverage grows.
