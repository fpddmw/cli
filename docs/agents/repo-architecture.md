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
lastReviewedAt: 2026-07-15
lastReviewedCommit: 98e9c2cf94413968689934901f0629684ba418fa
---

# Repo Architecture

## Ownership

This repository owns the public `tiangong-ai` command-line interface for Tiangong
AI automation.

The CLI owns local operator behavior such as command parsing, filesystem
intake, SQLite checkpoint files, retries, concurrency, and structured output.
Backend services own authorization, collection permission checks, dedupe,
storage writes, queueing, and document status transitions.

## Current Runtime Shape

- `bin/tiangong-ai.js`: stable executable launcher.
- `src/main.ts`: process entrypoint.
- `src/cli.ts`: command dispatch, KB ingest/status orchestration, bulk scan,
  metadata dry-run, SQLite checkpointing, and sliding-window bulk runner.
- `src/args.ts`, `src/data.ts`, `src/env.ts`, `src/errors.ts`, `src/http.ts`,
  and `src/io.ts`: shared CLI primitives for argument parsing, JSON envelope
  parsing, environment loading, structured error payloads, bearer-token JSON
  HTTP requests, edge-function `postJson`, JSON file input, JSON output, and
  process IO.
- `src/kb/**`: KB API boundary modules for config resolution, collection
  selection/list/resolve, document status polling, and pipeline health checks.
- `src/research/**`: research search command handling and source specs for SCI
  journal, report, patent, and ESG edge-search functions.
- `src/education/**`: education search command handling and source specs for
  course, education, and textbook edge-search functions.
- `src/edge-search.ts`: shared edge-search forwarding helper. It derives
  Supabase Functions base URLs from project root, `/functions/v1`, or
  `/rest/v1` inputs; builds exact POST request plans with `Content-Type`,
  region, input path, and timeout milliseconds; masks credentials for dry-runs;
  and returns raw edge responses without normalizing them.
- `scripts/**`: validation helpers.
- `test/**`: Node test runner suites.

## Bulk Ingest Boundary

Ingest state is local operator state. The CLI stores job and file checkpoints
in SQLite under the OS app-data directory by default, or an explicit `--state`
path. Compatibility upload aliases route through the bulk runner rather than a
separate checkpoint format.

The CLI may call external bearer-token API routes for collection resolution,
schema snapshots, uploads, and document status polling. The backend remains the
source of truth for authorization, dedupe, pipeline state transitions, and
indexing results.

Bulk derived files are generated lazily as local operator artifacts. Initial
bulk setup only scans, fingerprints, runs lightweight preflight, and writes
SQLite state. When a row enters the upload window, `.docx` files larger than
10MiB are uploaded through 300dpi-normalized ingest copies, while oversized PDFs
are split into the fewest uploadable PDF parts. The default
`.tiangong-kb-ingest-derived` directory is excluded from later bulk scans. DOCX
copies preserve the original logical path for metadata-map evaluation, PDF split
parts preserve the original logical parent directory, and split/normalize
lineage stays in SQLite/export state instead of being uploaded as default KB
metadata. Empty `.docx` files with no body text and no media are marked skipped
before upload.
Bulk polling sends the resolved collection selector to `pipeline/health` so the
backend can scope index preflight/backpressure to the target collection's
search partition rather than unrelated active partitions. Upload-scoped callers
may receive a redacted health payload containing only `healthy`, `pressure`,
`recommendedAction`, `recommendedPollAfterSeconds`, `checkedAt`, and an
optional coarse `reason`; the CLI must not depend on admin-only queue or worker
details. Status polling and upload-window top-up keep their 30-second default
loop. Pipeline health is cached separately and refreshed every 60 seconds by
default; explicit CLI or environment overrides still win, and degraded/paused
server recommendations may lengthen only the health refresh interval.

## Skill Boundary

Reusable skills may call this CLI as a wrapper. Skills should collect task
intent and report CLI output; they should not duplicate long-running batch
logic, API request construction, retries, or checkpoint semantics.
