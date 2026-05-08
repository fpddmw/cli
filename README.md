---
docType: repo-readme
scope: repo
status: current
authoritative: true
owner: cli
language: en
whenToUse: "When installing, running, or validating the Tiangong AI CLI."
whenToUpdate: "When package name, Node baseline, command examples, environment variables, or validation commands change."
checkPaths:
  - README.md
  - package.json
  - bin/**
  - src/**
lastReviewedAt: 2026-05-08
lastReviewedCommit: 2f4144ea41116de344f7fce1f2ef919823b09bff
---

# Tiangong AI CLI

Package: `@tiangong-ai/cli` Executable: `tiangong` Node: `>=24`

## Run From This Repository

```bash
npm install
npm run build
node ./bin/tiangong.js --help
```

Use Node `24.x`; this package declares `>=24 <25` and includes `.nvmrc` for
compatible version managers.

## KB Ingest

Required environment:

```bash
TIANGONG_AI_API_KEY=
TIANGONG_KB_DEFAULT_COLLECTION_NAME=
```

The KB API server defaults to `https://thuenv.tiangong.world:7300` with path
prefix `/api/v1/kb`.

Upload one file:

```bash
tiangong kb ingest upload /path/to/document.pdf
```

Upload a folder recursively with local checkpointing:

```bash
tiangong kb ingest upload /path/to/folder --recursive --concurrency 3 --retries 3
```

List uploadable collections:

```bash
tiangong kb collections list --capability upload
```

Check document status:

```bash
tiangong kb ingest status <document-id>
```

## Boundary

The CLI is a thin local client. It sends bearer-token requests to the Tiangong
KB ingest API and records local manifests for batch recovery. The backend owns
authorization, collection permissions, duplicate detection, NAS raw writes,
parse queueing, and status transitions.

## Validation

```bash
npm run lint
npm test
npm run test:coverage
docpact validate-config --root . --strict
```
