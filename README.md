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
lastReviewedAt: 2026-06-01
lastReviewedCommit: 09572bea5a50c07a5a8e023a2b7e180cbd037d75
---

# Tiangong AI CLI

Package: `@tiangong-ai/cli` Executable: `tiangong-ai` Node: `>=24`

## Run From This Repository

```bash
npm install
npm run build
node ./bin/tiangong-ai.js --help
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

Create a bounded research workspace and register a question:

```bash
tiangong-ai research workspace init /absolute/path/to/workspace
tiangong-ai research project init gpu-resource-impact \
  --workspace /absolute/path/to/workspace \
  --question "How do advanced GPU process nodes change environmental resource burdens?"
```

The workspace stores its current protocol state under `.tiangong-research/`.
Each project follows five ordered stages: evidence discovery, analysis,
synthesis, independent review, and mechanical closure. Producer work defaults
to Codex, independent review defaults to Claude, and a run is blocked when both
routes use the same agent family.

Research execution requires `/usr/bin/sandbox-exec` on macOS or Bubblewrap
(`bwrap`) on Linux. Windows can inspect and configure workspaces but does not
execute research packages.

Add immutable local evidence, verify the workspace, and execute ready work:

```bash
tiangong-ai research project input add gpu-resource-impact \
  --workspace /absolute/path/to/workspace \
  --path /absolute/path/to/inventory.csv \
  --role primary
tiangong-ai research workspace doctor --workspace /absolute/path/to/workspace
tiangong-ai research run --workspace /absolute/path/to/workspace --max-parallel 2
tiangong-ai research status --workspace /absolute/path/to/workspace --json
```

Inputs are admitted by SHA-256. Agent work runs in an ephemeral platform
sandbox, only declared outputs are imported, and the workspace journal is a
hash chain. Token, reported-cost, wall-time, output-count, output-size, and retry
limits are hard budgets in `.tiangong-research/config.json`.

Every evidence source must resolve to an admitted input or a completed broker
receipt. Findings may reference only admitted source IDs. Independent review
binds a runtime-generated packet containing the question, inputs, and artifact
hashes before mechanical closure can succeed.

Method skills are declared in `.tiangong-research/capabilities.json` with
absolute skill paths and explicit permissions, then frozen before execution:

```bash
tiangong-ai research capability lock --workspace /absolute/path/to/workspace
tiangong-ai research capability verify --workspace /absolute/path/to/workspace
```

A capability using `brokered-network` must declare exact `allowedHosts`.
Optional credentials declare logical IDs, exact host scopes, header names, and
prefixes. Put only the logical value map in `.tiangong-research/.env`:

```bash
TIANGONG_RESEARCH_CAPABILITY_CREDENTIALS_JSON={"source.example.api":"owner-provided-value"}
```

The broker injects declared credentials only for admitted HTTPS hosts. Agent
processes do not receive this variable. Keep the file owner-only (`chmod 600`)
and use `research workspace doctor` before a run.

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
