---
docType: architecture
scope: repo
status: current
authoritative: true
owner: cli
language: en
whenToUse: "When deciding where Tiangong AI CLI command behavior, wrappers, or API boundaries belong."
whenToUpdate: "When command families, runtime layers, environment contracts, or skill handoff boundaries change."
checkPaths:
  - AGENTS.md
  - README.md
  - src/**
  - bin/**
lastReviewedAt: 2026-05-10
lastReviewedCommit: f45edb6f41dd767911b3788eb8bc75e9bcb8ba33
---

# Repo Architecture

## Ownership

This repository owns the public `tiangong-ai` command-line interface for Tiangong
AI automation.

The CLI owns local operator behavior such as command parsing, filesystem
intake, manifest/checkpoint files, retries, concurrency, and structured output.
Backend services own authorization, collection permission checks, dedupe,
storage writes, queueing, and document status transitions.

## Current Runtime Shape

- `bin/tiangong-ai.js`: stable executable launcher.
- `src/main.ts`: process entrypoint.
- `src/cli.ts`: command dispatch, KB upload/status clients, bulk scan,
  metadata dry-run, SQLite checkpointing, and sliding-window bulk runner.
- `scripts/**`: validation helpers.
- `test/**`: Node test runner suites.

## Bulk Ingest Boundary

Bulk ingest state is local operator state. The CLI stores job and file
checkpoints in SQLite under the OS app-data directory by default, or an explicit
`--state` path. The legacy `.tiangong-kb-ingest-manifest.jsonl` remains scoped
to non-bulk upload and is not a bulk checkpoint source.

The CLI may call external bearer-token API routes for collection resolution,
schema snapshots, uploads, and document status polling. The backend remains the
source of truth for authorization, dedupe, pipeline state transitions, and
indexing results.

Bulk derived files are generated as local operator artifacts. All `.docx` files
are uploaded through 300dpi-normalized ingest copies, while oversized PDFs are
split into the fewest uploadable PDF parts. The default
`.tiangong-kb-ingest-derived` directory is excluded from later bulk scans. DOCX
copies preserve the original logical path for metadata-map evaluation, PDF split
parts preserve the original logical parent directory, and split/normalize
lineage stays in SQLite/export state instead of being uploaded as default KB
metadata. The CLI uploads the generated DOCX copy even when normalization leaves
the file unchanged or only slightly smaller.

## Skill Boundary

Reusable skills may call this CLI as a wrapper. Skills should collect task
intent and report CLI output; they should not duplicate long-running batch
logic, API request construction, retries, or checkpoint semantics.
