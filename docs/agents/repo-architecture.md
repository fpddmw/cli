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
lastReviewedAt: 2026-08-08
lastReviewedCommit: c55eab450de73bed783c7417c43db20ef56c0c43
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
- `src/research/commands.ts` and `src/research/config.ts`: the public research
  command router and edge-search source configuration.
- `src/research/orchestration.ts`: strict parsing for research context,
  workspace, capability, project, status, and run commands.
- `src/research/workspace/**`: the versioned research workspace protocol. It
  owns context classification, immutable input admission, capability policy
  locks, an external-only recommended Skill catalog, reproducible detached
  source checkout/install plans, custom external capability admission,
  owner-environment-to-logical-credential configuration, static/live provider
  diagnostics, required-discovery receipt gates, bounded local-input plans, a
  scoped HTTPS MCP broker with inline bounded result contexts,
  content-addressed permanent evidence, paged broker views/cache,
  schema-driven agent output and isolated repair, dedicated capsule homes,
  separately fingerprinted agent targets/wrappers/adapters, doctor
  attestations, complete pre-call package and tool-context reservations,
  tool-context-aware process capture, classified retries,
  project-scoped scheduling/exit status, JSONL progress, recovery events,
  persistent review packets/bounded evidence contexts, tool-free independent
  review, and mechanical closure-time hash verification.
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

Reusable skills may call this CLI as a wrapper. Skills collect task intent,
select smoke or production mode, prepare evidence requirements, obtain budget
confirmation, and report CLI output. They do not duplicate the CLI's output
schemas, coverage gate, workspace state transitions, capability admission,
scheduling, sandboxing, budget enforcement, provenance, review, closure, batch
logic, API request construction, retries, or checkpoint semantics.

Research method implementations are external Skills. The CLI may recommend and
content-lock reviewed external trees, but it does not install them during a
research run and the Tiangong Skills repository is not an evidence-provider
source. Brokered Skills document allowlisted GET APIs; credentials remain in an
owner-only logical map and are injected only by the broker. A selected
production profile must include an external public-internet capability, while
owner-whitelisted databases are imported with explicit source identity, hosts,
health checks, and discovery scope. Source commit/version and expected
whole-tree SHA-256 must both match before locking; configure/import never
re-locks an already drifting capability. The catalog also records reviewed but
unselected upstream Skills and their admission or execution limitation so the
recommendation boundary is explicit.

The platform `sandbox-exec`/Bubblewrap capsule is the agent security boundary.
Codex does not nest its own sandbox inside that capsule because nested macOS
Seatbelt prevents reliable MCP execution. The adapter disables shell,
unified-exec, filesystem, and undeclared integration tools for discovery, then
embeds the locked capability manifest and each staged top-level `SKILL.md` in
the prompt. The only discovery execution tool is the scoped broker. Later
stages are tool-free and receive only bounded, hash-verified context.
