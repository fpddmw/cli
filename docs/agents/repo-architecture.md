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
lastReviewedAt: 2026-08-12
lastReviewedCommit: 7d692de934c51178df520ccdaa212acc7dc303f0
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
- `src/research/orchestration.ts` and `src/research/setup-command.ts`: strict
  parsing for setup, context, workspace, capability, project, status, and run
  commands. Bare `research setup` is the interactive TTY Wizard; the remaining
  setup actions are deterministic automation surfaces. Wizard presentation is
  semantic and TTY-aware, with plain output for `NO_COLOR`, dumb terminals, and
  JSON mode; styling never changes plan or command contracts.
- `src/research/workspace/**`: the versioned research workspace protocol. It
  owns context classification, immutable input admission, capability policy
  locks, a separately sourced external Skill ecosystem catalog, immutable setup
  plans/state/history, reproducible detached source checkout with fixed Git
  line-ending behavior, locale-independent whole-tree hashing, and exact-copy
  installation, custom external capability admission,
  hidden-TTY, bounded-stdin, and owner-environment-to-logical-credential
  configuration with pre-download owner-only persistence, static/live provider
  diagnostics, explicit orchestrator installation, replacement-time
  setup-managed capability/credential reconciliation, role-constrained
  document/paper companions, required-discovery
  receipt gates with distinct never-attempted/attempted-without-evidence
  diagnostics, bounded local-input plans, a scoped HTTPS GET/JSON-POST MCP
  broker with inline bounded result contexts,
  one bounded short-delay 429 retry with sanitized journal provenance,
  a coverage-derived working broker-view budget under a reviewed workspace
  ceiling, content-addressed permanent evidence, paged broker views/cache,
  a hash-chained candidate/admission/artifact/claim/review ledger,
  deterministic candidate deduplication and a supplemental native Web bridge,
  coverage-derived discovery call planning with early stop and a hard ceiling,
  append-only incremental candidate assessment with a compact discovery
  closeout, native Web/Browser activity receipts whose sensitive inputs are
  retained only by hash, exact download-event binding, and explicit exact-file
  artifact registration with PDF/ZIP/OpenXML validation,
  acquisition audits, immutable parent/delta evidence snapshots, addendum
  supersession, one authoritative project lineage with explicit
  archive/abandon dispositions, and default historical-project filtering,
  hash-bound native-host producer stage prepare/submit/abort, one-shot native
  broker fetches, schema-driven reviewer output and isolated repair, dedicated
  reviewer capsule homes,
  pre-review deterministic Markdown newline-artifact normalization with
  content-free journal provenance,
  hash-verified idempotent capsule-auth reuse across primary/repair calls,
  separately fingerprinted reviewer targets/wrappers/adapters, hash-bound
  reviewer doctor attestations with expiry-aware reuse and live runtime-drift
  verification,
  complete pre-call package and tool-context reservations,
  one shared preflight/runtime reservation formula with bounded capability
  documentation included at admission,
  mode-specific budgets with low-cost smoke defaults and deliberately generous
  but finite production runaway ceilings,
  tool-context-aware process capture, classified retries,
  project-scoped scheduling/exit status, durable user-action and
  external-response handoffs, JSONL progress, recovery events, exact
  companion readiness gates, domain-scoped setup readiness, persistent review
  packets/bounded evidence contexts with exact cited-item JSON-Pointer
  projections, tool-free independent review, and
  mechanical closure-time hash verification.
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

Reusable skills may call this CLI as a deterministic control plane. Skills
collect task intent, select smoke or production mode, prepare evidence
requirements, obtain budget confirmation, and direct the current interactive
Codex or Claude Code host through hash-bound producer packets. They do not
launch a nested producer CLI or duplicate output schemas, coverage gates,
workspace state transitions, capability admission, scheduling, budgets,
provenance, review, closure, API request construction, retries, or checkpoint
semantics.

Research method implementations are external Skills. Setup may copy only
user-selected, separately licensed trees after freezing the installer integrity,
source commit, whole-tree SHA-256, exact destination, settings, credential
variable names, and declared mutations. It never installs a Skill from a
research package, resolves system/Python dependencies, silently updates a pin,
or overwrites drift.

The recommended `tiangong-auto-research` tree is an external orchestrator role,
not an evidence capability. Wizard selection is explicit and project-local by
default. Evidence defaults to Brave web/news; context and media profiles remain
subscription-dependent choices. A replacement removes only deselected
setup-managed declarations/credentials, preserves custom capabilities, and
never removes installed Skill directories. The Catalog marks the orchestrator
with a `workspace-lock` runtime contract and marks direct SCI/report/patent
wrappers only with their separate `standaloneTestedCliVersion`. Setup verifies
the bundled resolver and forbids stale exact CLI literals in orchestrator
instructions before installation.

The CLI may generate a separate project-local recovery-only Skill after an
accepted apply has stored credentials but before external checkout. It contains
only exact-version context/status recovery instructions bound to the immutable
plan, never producer or evidence logic. It closes the partial-install routing
gap and is removed only after byte verification once the selected external
orchestrator is installed. Setup status/doctor also report the effective CLI,
project Skill, temporary recovery Skill, ignored global conflicts, and legacy
unmanaged PATH fallbacks.

Brokered evidence Skills document allowlisted GET or bounded JSON POST APIs;
credentials remain in an owner-only logical map and are injected only by the
broker. POST request bodies reject credential-like fields, persist only their
hash outside the evidence object, and cannot redirect. A selected production
profile must include an independent public-internet capability. The reviewed
Tiangong SCI, report, and patent adapters are optional, distinct
owner-whitelisted databases and cannot satisfy that public-internet gate or
substitute for one another; arbitrary owner databases still require an explicit
external definition. Project evidence requirements may bind exact capability
IDs and discovery scopes, which preflight reports as structured, actionable
coverage gaps when absent.

Document decomposition is an input-preprocessor and paper download is an
acquisition adapter. Their explicit companion command verifies the installed
tree, builds a minimal child environment, and returns hash-bound output for
later input admission; neither executes inside an agent capsule or becomes
evidence by itself. Authoring Skills run only after closure. Optional companion
failures are domain-scoped diagnostics unless a project's
`requiredCompanionIds` (or the explicit operation itself) names that exact
component. Semantic Scholar resolver throttling therefore degrades acquisition
without globally blocking research. Source
commit/version and expected whole-tree SHA-256 must match before any role is
configured or executed. The tree-hash contract rejects symlinks and
canonically equivalent path collisions, normalizes logical paths to NFC, and
orders directory entries by UTF-8 bytes rather than locale collation. New Git
source caches set repository-local `core.autocrlf=false` and `core.eol=lf`
before materializing the detached commit. Hash failures stop before installer
execution and expose only sanitized, non-secret identifiers and digests.

The current interactive host is the producer boundary: the CLI prepares an
ephemeral hash-bound packet but does not start Codex or Claude for discover,
acquire, analyze, or synthesize. Discovery uses explicit one-shot broker
commands whose request files contain logical IDs only. It records candidate
judgments in bounded append-only batches instead of returning a source-sized
JSON document. Native Web/Browser discovery remains visible as hashed activity
and supplemental candidates; the same URL or DOI must be formalized through
the broker before admission. Acquisition binds a completed network download to
the exact selected file and download event before artifact registration,
requires derived text to name its parent artifact, and lets that derivative
inherit only the parent's canonical source URL instead of fabricating a second
download binding; a conflicting URL is rejected. Acquisition then produces a
complete source audit, and analysis starts only after a verified immutable
snapshot. Later
producer packets contain bounded, hash-verified prior artifacts. The platform
`sandbox-exec`/Bubblewrap capsule is used for the independently launched
reviewer CLI; that adapter disables shell, unified-exec, filesystem, and
undeclared integrations.

When a producer reaches login, MFA, CAPTCHA, paywall, authorization, or another
human-only boundary, it records the activity and requests a durable
`user-action-required` handoff. When a material gap requires an institution or
other third party to respond, it requests `external-response-required` and
stops substitute searching. Resolution is an explicit journaled operation;
neither state consumes another producer attempt while waiting.

Every brokered manifest entry carries a locked non-secret HTTPS endpoint;
initial targets and GET redirects are checked against that endpoint scope
before a provider request.
Broker diagnostics keep standalone ambient credentials, broker logical
credentials, injection policy, and provider authentication as separate failure
classes. They expose only execution mode, credential scope, network-attempt
state, safe request metadata, and minimum action. Setup doctor performs one
bounded Semantic Scholar 429 retry and reports a remaining throttle in
acquisition readiness without changing research-core readiness; no managed
research path silently downgrades to a direct wrapper. When Codex is the
reviewer, it receives a capsule-local project-root marker override so parent host
`.codex/config.toml` discovery stops at the capsule boundary without widening
the sandbox's readable roots.
