---
docType: agent-contract
scope: repository
status: current
authoritative: true
owner: cli
language: en
whenToUse: "Before changing the Tiangong AI CLI implementation."
whenToUpdate: "When CLI command boundaries, environment variables, validation commands, or release flow change."
checkPaths:
  - AGENTS.md
  - README.md
  - package.json
  - .github/workflows/**
  - .docpact/config.yaml
  - docs/agents/**
  - src/**
lastReviewedAt: 2026-05-08
lastReviewedCommit: 69e9cde303c75e33da9948ed25744349d880d96c
---

# Tiangong AI CLI Contract

This repository owns the Tiangong AI command-line interface.

## Boundaries

- The CLI is a local operator tool for repeatable, long-running, or batch work.
- The CLI may call public Tiangong HTTP APIs with user-provided credentials.
- The CLI must not embed server-side secrets, Supabase service-role keys, NAS
  credentials, AWS keys, Pinecone keys, or OpenSearch admin credentials.
- Backend services remain responsible for authorization, persistence, dedupe,
  queueing, and state transitions.
- Agent skills may call this CLI, but reusable workflow prompts belong in the
  `skills` repository.

## Current Command Surface

- `tiangong-ai doctor`
- `tiangong-ai kb ingest`
- `tiangong-ai kb collections`
- `tiangong-ai kb status`

## Validation

Run before delivery:

```bash
npm run lint
npm run build
npm test
npm run test:coverage
docpact validate-config --root . --strict
docpact lint --root . --worktree --mode enforce
```

Use `npm run typecheck` for a faster TypeScript-only check.
Use `npm run prepush:gate` when `docpact` is installed and you want the
aggregated local quality gate.

## Release

GitHub Actions publishes npm releases through `.github/workflows/publish.yml`.
The workflow uses npm Trusted Publishing through GitHub OIDC and runs npm lint,
test, coverage, and pack checks before publishing.

## Required Docs

- Read `docs/agents/repo-architecture.md` before changing command behavior or
  skill handoff boundaries.
- Read `docs/agents/repo-validation.md` before changing package scripts,
  coverage thresholds, CI, or docpact configuration.
