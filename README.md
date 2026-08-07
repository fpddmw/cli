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
lastReviewedAt: 2026-08-07
lastReviewedCommit: bc5f73c8418605892b9905263347044c11d8a7a3
---

# Tiangong AI CLI

Package: `@tiangong-ai/cli` Executable: `tiangong-ai` Node: `>=24`

## Run From This Repository

```bash
npm install
npm run build
node ./bin/tiangong-ai.js --help
node ./bin/tiangong-ai.js --version
```

Use Node `24.x`; this package declares `>=24 <25` and includes `.nvmrc` for
compatible version managers.

After installation, print the package version with either top-level flag:

```bash
tiangong-ai --version
tiangong-ai -v
```

## KB Ingest

Required environment:

```bash
TIANGONG_AI_API_KEY=
TIANGONG_KB_DEFAULT_COLLECTION_NAME=
```

The KB API server defaults to `https://thuenv.tiangong.world:7300` with path
prefix `/api/v1/kb`.

Run a resumable sliding-window ingest for one file or a folder:

```bash
tiangong-ai kb ingest bulk /path/to/document.pdf \
  --collection-path /course/thu_humanities \
  --poll-interval 30 \
  --health-poll-interval 60
```

Run a larger folder ingest:

```bash
tiangong-ai kb ingest bulk /path/to/folder \
  --collection-path /course/thu_humanities \
  --window-size 100 \
  --top-up-max 50 \
  --upload-concurrency 4 \
  --poll-interval 30 \
  --health-poll-interval 60
```

Bulk scan a large folder and emit a structural JSON summary:

```bash
tiangong-ai kb ingest bulk scan /path/to/folder --json
```

Dry-run a layered metadata map against a folder and collection schema:

```bash
tiangong-ai kb ingest bulk dry-run /path/to/folder \
  --collection-path /course/thu_humanities \
  --metadata-map metadata-map.yaml \
  --json
```

The same dry-run is also available through the skill-facing alias:

```bash
tiangong-ai kb ingest metadata dry-run /path/to/folder \
  --collection-path /course/thu_humanities \
  --metadata-map metadata-map.yaml \
  --json
```

Run a resumable sliding-window bulk ingest with metadata:

```bash
tiangong-ai kb ingest bulk /path/to/folder \
  --collection-path /course/thu_humanities \
  --metadata-map metadata-map.yaml \
  --window-size 100 \
  --top-up-max 50 \
  --upload-concurrency 4 \
  --poll-interval 30 \
  --health-poll-interval 60
```

`tiangong-ai kb ingest bulk run /path/to/folder` is accepted as an explicit
alias for wrappers that want a verb before the folder path.

Bulk ingest uses SQLite as its checkpoint source. By default, job files are
stored under the OS app-data directory:

- macOS: `~/Library/Application Support/tiangong-ai/kb-ingest/jobs/<job-id>.sqlite`
- Linux: `~/.local/share/tiangong-ai/kb-ingest/jobs/<job-id>.sqlite`
- Windows: `%APPDATA%/tiangong-ai/kb-ingest/jobs/<job-id>.sqlite`

Use `--state /path/to/job.sqlite` to override the checkpoint path. Bulk ingest
does not impose a client-side polling limit by default, so it can keep topping
up the sliding upload window until all rows complete. Use `--max-polls <n>` only
when a wrapper or operator needs a bounded run. Status checks and upload-window
top-up run every 30 seconds by default. Pipeline health is cached independently
and refreshed every 60 seconds by default, so health backpressure does not slow
status progress. Override the intervals with `--poll-interval` and
`--health-poll-interval`, or with `TIANGONG_KB_BULK_POLL_INTERVAL` and
`TIANGONG_KB_PIPELINE_HEALTH_POLL_INTERVAL`.

Bulk ingest scans and fingerprints files first, then lazily creates derived
files only when a row enters the active upload window. `.docx` files larger than
10MiB are uploaded through 300dpi-normalized ingest copies; smaller `.docx`
files upload directly unless they are empty. Oversized PDFs are split into the
fewest uploadable PDF parts when they enter the window, and the generated part
rows are written back to SQLite so resume can reuse them. Derived files stay
under `.tiangong-kb-ingest-derived` by default, and that directory is excluded
from future bulk scans. Upload metadata remains the user/business metadata
produced by the metadata map.

Manage bulk jobs:

```bash
tiangong-ai kb ingest jobs
tiangong-ai kb ingest status <job-id>
tiangong-ai kb ingest resume <job-id>
tiangong-ai kb ingest export <job-id> --format csv
```

List uploadable collections:

```bash
tiangong-ai kb collections list --capability upload
```

Resolve a collection and include the effective metadata schema:

```bash
tiangong-ai kb collections schema --collection-path /course/thu_humanities --json
```

Check document status:

```bash
tiangong-ai kb ingest status <document-id>
```

Read course fulltext from the processed S3 bucket:

```bash
tiangong-ai kb course fulltext \
  --document-id 000125ed-c4d9-4fe3-9380-000000000000 \
  --tags thu_humanities
```

The command lists exactly one `.txt` object under
`s3://tiangong/processed_docs/course_pickle/<tags>_pickle/<document-id>/` and
prints its content. Override the location with `--bucket`, `--prefix`, or the
`TIANGONG_COURSE_FULLTEXT_S3_BUCKET` and
`TIANGONG_COURSE_FULLTEXT_S3_PREFIX` environment variables. AWS credentials and
region are resolved by the AWS SDK, including `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_REGION`, and
`AWS_DEFAULT_REGION`.

## Research Workspaces

Create a bounded smoke-test workspace and register a question:

```bash
tiangong-ai research workspace init /absolute/path/to/workspace
tiangong-ai research project init gpu-resource-impact \
  --workspace /absolute/path/to/workspace \
  --question "How do advanced GPU process nodes change environmental resource burdens?"
```

`smoke-test` is the default and is intended for deterministic fixtures and
low-cost canaries. Formal work must use `--mode production-research`, explicit
producer/reviewer model IDs and pricing in `config.json`, a requirements JSON
file, and budget confirmation when `maxCostUsd` exceeds
`confirmationCostUsd`:

```bash
tiangong-ai research workspace init /absolute/path/to/workspace \
  --mode production-research
tiangong-ai research capability catalog \
  --path /absolute/path/to/workspace \
  --workspace /absolute/path/to/workspace --json
# Run the returned pinned project installation plan outside the research runtime.
tiangong-ai research capability configure \
  --profile internet-research \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research capability credential set \
  --id brave.search.api-key --from-env BRAVE_SEARCH_API_KEY \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research capability doctor --live \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research project preflight \
  --workspace /absolute/path/to/workspace \
  --question "How do advanced GPU process nodes change environmental resource burdens?" \
  --requirements /absolute/path/to/evidence-requirements.json --json
tiangong-ai research project init gpu-resource-impact \
  --workspace /absolute/path/to/workspace \
  --question "How do advanced GPU process nodes change environmental resource burdens?" \
  --requirements /absolute/path/to/evidence-requirements.json \
  --confirm-budget --json
```

Production admission requires at least one locked external capability with
`brokered-network` and `discoveryScopes: ["public-internet"]`; an input plan or
local files alone cannot represent internet coverage. The machine-readable
catalog contains only external Skills and reports every required, enhanced,
and conditional recommendation; exact source commit and whole-tree hash; a
pinned installer version and checkout/install plan; credential requirements;
and installed, configured, locked, and live provider status. Installation is
never performed by the research runtime. It also reports the other Skills
evaluated from the pinned upstream package and why each is not selected:
custom question-specific admission, query assistance without evidence, or an
execution model that the bounded GET broker does not authorize.

The default `internet-research` profile selects Brave Web Search and News
Search. `internet-research-with-context` additionally selects the
subscription-dependent LLM Context endpoint, while
`internet-research-with-media` also selects image and video discovery. A
provider-plan or authentication failure blocks the selected profile instead of
silently dropping a Skill. `credential set` reads the value only from the
explicit owner environment name and stores it under the declared logical ID;
the value is never returned or journaled.

The requirements object declares `dimensions`, `sourceTypes`, `minSources`,
`minFullTextSources`, `minDatedSources`, and optional inclusive
`publicationDateFrom` / `publicationDateTo` boundaries (`YYYY-MM-DD` or
`null`). After discovery, a mechanical coverage gate verifies the declared
source, full-text, publication-date, and dimension summary before analysis.
For large local sources, pass an immutable `--input-plan` to both preflight and
project initialization. Each plan entry may expose either a separate
`contextPath` or non-overlapping, one-based `contextRanges`; the producer sees
only that bounded context, while independent review receives the hash-verified
full source. Symlinks, duplicate content, changed hashes, and context above
`maxInputContextTokens` are rejected.

The workspace stores its current protocol state under `.tiangong-research/`.
Each project follows five ordered stages: evidence discovery, analysis,
synthesis, independent review, and mechanical closure. Producer work defaults
to Codex, independent review defaults to Claude, and a run is blocked when both
routes use the same agent family.

Research execution requires `/usr/bin/sandbox-exec` on macOS or Bubblewrap
(`bwrap`) on Linux. Windows can inspect and configure workspaces but does not
execute research packages. That outer platform sandbox is the execution
boundary. Codex is therefore started with its nested sandbox disabled: nesting
Seatbelt on macOS can cancel MCP calls even though the process is already
confined. Shell and unified-exec tools remain disabled, as do undeclared Codex
integrations.

Add immutable local evidence, verify the workspace, and execute ready work:

```bash
tiangong-ai research project input add gpu-resource-impact \
  --workspace /absolute/path/to/workspace \
  --path /absolute/path/to/inventory.csv \
  --role primary
tiangong-ai research workspace doctor --workspace /absolute/path/to/workspace
tiangong-ai research workspace doctor --workspace /absolute/path/to/workspace \
  --agent-smoke --capability-smoke
tiangong-ai research run --workspace /absolute/path/to/workspace \
  --project gpu-resource-impact --progress-jsonl
tiangong-ai research status --workspace /absolute/path/to/workspace --json
```

Use `research run --project <id>` for an auditable project-scoped run: only
that project is checked, scheduled, summarized, and bound to the top-level
JSON/JSONL `projectId`, so historical blocked siblings do not alter its exit
status. Omit `--project` and use `--max-parallel` only for an intentional
workspace-wide run.

Inputs are admitted by SHA-256. Agent work runs with a dedicated capsule HOME
in an ephemeral platform sandbox. Only the minimal supported agent auth file is
copied into that HOME. For Claude, an owner-only user `settings.json` is never
copied; only the whitelisted API key/token and HTTPS base URL fields from its
`env` object are injected in memory. Permissions, hooks, additional directories,
and unrelated settings are not admitted. The workspace credential file and the
rest of the host home are not admitted. Production doctor is blocked until
`--agent-smoke` actually starts both routes inside this boundary. A successful
smoke creates a 24-hour attestation bound to workspace config, capability lock,
output schema, and the resolved agent binary/wrapper fingerprints. Production
execution stops before invocation if the attestation expires or any bound value
drifts.
Use the exact `codex` / `claude` route by default. A custom wrapper must use an
absolute `binary` plus an absolute `wrapperTargetBinary`; the runtime injects
the resolved target path and independently hashes the target executable, route
launcher/wrapper, and internal adapter. A wrapper that performs an unpinned
PATH lookup is not a reproducible route.

The CLI owns the authoritative JSON Schemas for discovery, analysis,
synthesis, and review. Inspect one with `research schema show <stage> --json`.
Codex and Claude receive the schema through their structured-output options;
the CLI materializes the validated final object. A syntax/schema failure gets
at most one separately budgeted formatting repair, never a full blind retry.
The same isolated repair may correct mechanically diagnosed provenance or
finding/source bindings; it has no broker or research tools and cannot add new
facts.

Total, per-package, output, repair, broker-response bytes, estimated broker
context tokens, context items, wall-time, output-count, output-size, and attempt
limits live in `.tiangong-research/config.json`.
New workspaces reserve 500,000 total tokens by default, including 200,000 for
discovery; the remaining package defaults are 55,000 for analysis, 60,000 for
synthesis, and 120,000 for review. These are admission ceilings rather than a
target spend and can be lowered only when the resulting pre-call reservations
still fit.
Before an agent starts, the runtime reserves the package token and conservative
price budget. The call-level check accounts for prompt and schema bytes at
three bytes per token, repeats input allowance for every permitted API turn,
adds the maximum bounded broker context for every permitted discovery turn,
and adds primary output plus a potential isolated repair's input and output;
insufficient package or remaining project budget prevents invocation. The
provider cost cap is the current package reservation, not the remaining
workspace allowance. Tool-free primary stages allow two protocol turns because
Claude structured output uses a `StructuredOutput` call plus its follow-up
result; external tools remain disabled. Formatting repair omits the provider
schema tool, uses one plain-JSON turn, and remains subject to the CLI schema and
semantic validators. Current Codex and Claude CLI adapters report
output usage only after execution, so preflight identifies
`outputTokenLimitEnforcement` as `post-execution`; captured bytes provide a
separate process bound. Discovery capture allowance includes the bounded MCP
tool contexts as well as the requested model output, and over-limit output fails
without promotion.
Preflight also reports per-stage `maxTurns` and `turnLimitEnforcement`: Claude
receives a provider-side turn cap, while the current Codex CLI exposes no such
flag, so its turn allowance is reservation guidance plus post-execution
accounting and rejection. Usage records separate input, cached-input, and output
tokens; `inputTokens` excludes
the separately reported cached portion. Configured pricing fills cost when the
provider does not report it. Run records and JSONL progress also preserve
sanitized event/item counts, provider turns, tool calls, reasoning tokens, and
bounded provider errors.

Every evidence source must resolve to an admitted input or a completed broker
receipt. Successful broker bodies are immutable content-addressed objects under
`.tiangong-research/evidence/objects`; receipts are project-scoped and verified
for existence, size, and SHA-256 before every capsule stages them. Independent
review binds the requirements, receipts, permanent evidence objects, inputs,
and artifact hashes. Its exact packet and merged bounded evidence context are
also content-addressed under the project `review/packets/` and
`review/contexts/` directories. Mechanical closure re-verifies the packet,
context, broker objects, and registered local input hashes before recording
their safe locators. Capsule deletion therefore does not delete the durable
review chain.

Discovery receives only the capability broker as an execution tool. The CLI
embeds the exact staged capability manifest and each external Skill's top-level
`SKILL.md` in the prompt, so the producer does not need filesystem or shell
access and cannot execute provider examples directly. Broker responses include
the exact bounded context inline with the hash-bound receipt; raw objects remain
in the permanent evidence store for audit.
Analyze and synthesize receive bounded, hash-verified prior-stage artifacts in
their prompt with tools disabled. Review is also tool-free and limited to the
two turns required by the structured-output protocol:
its prompt embeds the complete generated artifacts, persistent packet, local
bounded contexts, and each cited broker receipt's exact bounded view. Full
local files and raw broker objects are hash-bound for durable human/mechanical
audit, but the model must not claim to have read beyond those embedded views.
The CLI mechanically derives local full-text availability, source types,
counts, date coverage, source IDs, and the coverage decision. A `partial`
dimension is usable but incomplete; a missing dimension or unmet declared
minimum blocks downstream work. Qualitative gaps remain visible without
silently changing those mechanical fields.

Method Skills are external to this project. Recommended evidence Skills are
selected through `research capability configure`; an owner-selected database,
domain index, or other external method is admitted from an absolute reviewed
definition:

```bash
tiangong-ai research capability import \
  --definition /absolute/path/to/external-capability.json \
  --workspace /absolute/path/to/workspace --json
```

`research capability catalog --json` returns the authoritative custom
definition template. Its source must identify an external git, registry, or
local artifact with an immutable reference, explicit `expectedTreeSha256`, and
license. Git references must be full 40-character commits; registry references
must be exact versions; local references must equal
`sha256:<expectedTreeSha256>`. Every source type must match the installed whole
tree before a lock can be written. Skill trees reject symlinks and excessive
file counts/sizes. Project-owned Tiangong Skills are rejected as imported
evidence providers. Configure/import refuses to rewrite the lock if any
existing capability has drifted; restore it or explicitly update its source
identity and expected hash first.

External Skills use absolute paths and explicit permissions, then freeze
before execution:

```bash
tiangong-ai research capability lock --workspace /absolute/path/to/workspace
tiangong-ai research capability verify --workspace /absolute/path/to/workspace
```

A capability using `brokered-network` must declare exact `allowedHosts` and may
declare an `http` policy with one exact `accept` value,
`allowedContentTypes`, `maxResponseBytes`, and `maxItems`. Its optional
`coverage` block declares dimensions, source types, full-text availability,
publication-date availability, and named discovery scopes for the preflight gap
report. Mark `requiredForDiscovery: true` for every public index or
owner-whitelisted database the question must exercise. Downstream work is
blocked unless each such capability produces its own verified broker receipt;
another local file cannot substitute for it. The current evidence broker
authorizes bounded GET endpoints only. A non-network external method-guidance
Skill stages reviewed instructions but does not grant an undeclared tool or
service call.
Optional credentials declare logical IDs, exact host scopes, header names, and
prefixes. Put only the logical value map in `.tiangong-research/.env`:

```bash
TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"source.example.api":"owner-provided-value"}
```

Prefer the non-echoing configuration command over hand editing:

```bash
tiangong-ai research capability credential set \
  --id source.example.api --from-env OWNER_DATABASE_API_KEY \
  --workspace /absolute/path/to/workspace --json
```

The broker injects declared credentials only for admitted HTTPS hosts. Agent
processes do not receive this variable. Keep the file owner-only (`chmod 600`)
and run `research capability doctor --live` plus production
`research workspace doctor --agent-smoke --capability-smoke` before a run.
Capability doctor retries only one 429 response with bounded `Retry-After`
backoff; deterministic 4xx, missing subscription, authentication, drift, and
content-type failures stop explicitly. The broker preserves a
sanitized non-2xx excerpt, safe request ID, and `Retry-After`; it supports JSON
Pointer extraction, bounded item and estimated-token views, and an explicit
public-response cache. For a JSON collection, use the returned
`contextNextOffset` as the next `item_offset`; this creates a distinct bounded
context receipt while reusing the same verified raw object instead of
refetching it. Follow upstream pagination with its next admitted HTTPS URL.
The recorded estimate is `ceil(contextBytes / 3)`. Use `cache_mode=bypass` for
a fresh public request and always for credentialed requests. Raw URLs and
credential values are never journaled.

Retry policy is classified: deterministic configuration/4xx/output failures
stop, schema failures use the formatting repair path, and rate limits or
transient server failures alone may schedule another attempt. Explicit recovery
uses append-only management events:

```bash
tiangong-ai research project retry gpu-resource-impact --package analyze \
  --workspace /absolute/path/to/workspace
tiangong-ai research project fork gpu-resource-impact \
  --to gpu-resource-impact-v2 --resume-through analyze \
  --workspace /absolute/path/to/workspace
```

## Research Search

Forward research-oriented search requests to SCI, report, patent, and ESG edge
search sources:

```bash
tiangong-ai research search \
  --input ./sci-request.json \
  --sources all \
  --dry-run \
  --json
```

Required environment:

```bash
TIANGONG_AI_APIKEY=
```

`--input <file>` reads a JSON object and forwards it unchanged as the POST body
to every selected source. Use `--dry-run` to emit the exact request plan,
including method, URL, masked headers, input path, body, and timeout
milliseconds, without remote calls.
For quick calls, `--query <text>` builds a minimal body with `query` plus
optional `--top-k`, `--ext-k`, and `--get-meta`.

`--sources` accepts concrete IDs and presets. `default` expands to `sci`; `all`
expands to `sci,report,patent,esg`. Use source-specific endpoint or credential
overrides with `--sci-url`, `--report-url`, `--patent-url`, `--esg-url`,
`--sci-api-key`, `--report-api-key`, `--patent-api-key`, and `--esg-api-key`.
The equivalent ESG environment variables are `TIANGONG_ESG_SEARCH_URL` and
`TIANGONG_ESG_APIKEY`. When source URLs are not provided, `--api-base-url` or
`TIANGONG_AI_API_BASE_URL` may be a Supabase project root, `/functions/v1`, or
`/rest/v1`; the CLI derives the Functions base URL and appends `sci_search`,
`report_search`, `patent_search`, or `esg_search`.

## Education Search

Forward education-oriented search requests to course, education, and textbook
edge search sources:

```bash
tiangong-ai education search \
  --query "activated sludge process principles" \
  --sources all \
  --json
```

`--input <file>` forwards the JSON request body unchanged. `--query <text>`
builds a minimal body with `query` plus optional `--top-k` and `--ext-k`.
`--sources default` expands to `course`; `--sources all` expands to
`course,edu,textbook`. `course` search can use a scoped bearer token through
`--bearer-token` or `TIANGONG_EDUCATION_BEARER_TOKEN`; all education sources can
use `--api-key` or `TIANGONG_AI_APIKEY`. When source URLs are not provided,
`--api-base-url` or `TIANGONG_AI_API_BASE_URL` may be a Supabase project root,
`/functions/v1`, or `/rest/v1`; the CLI derives the Functions base URL and
appends `course_search`, `edu_search`, or `textbook_search`.

## Boundary

The CLI owns local operator workflows. Research workspaces keep bounded local
state, capability locks, isolated agent runs, usage accounting, provenance,
independent review, and deterministic closure. Research capability credentials
remain in the workspace broker and are not forwarded to agent processes.

For KB operations, the CLI sends bearer-token requests to the Tiangong KB
ingest API and records SQLite checkpoints for batch recovery. Ingest uses
the bulk runner and releases sliding-window capacity only when document status
is `completed` and both `opensearchIndexed` and `pineconeIndexed` are true. If
the status API does not return those index flags yet, the file remains in
`waiting_for_index_flags`. The backend owns authorization, collection
permissions, duplicate detection, NAS raw writes, parse queueing, and status
transitions.

## Validation

```bash
npm run lint
npm test
npm run test:coverage
docpact validate-config --root . --strict
```

## Release

Publishing is handled by GitHub Actions in `.github/workflows/publish.yml`.
Push a `v*` tag that matches `package.json` version. The workflow publishes
`@tiangong-ai/cli` to npm through npm Trusted Publishing after lint, tests,
coverage, version availability, and a package dry run pass.
