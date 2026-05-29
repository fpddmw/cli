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
lastReviewedAt: 2026-05-29
lastReviewedCommit: 8bd0ba63b906789761fc21f450f9979bd5e1b0b9
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
  --poll-interval 30
```

Run a larger folder ingest:

```bash
tiangong-ai kb ingest bulk /path/to/folder \
  --collection-path /course/thu_humanities \
  --window-size 100 \
  --top-up-max 50 \
  --upload-concurrency 4 \
  --poll-interval 30
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
  --poll-interval 30
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
when a wrapper or operator needs a bounded run.

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

## Research Search

Forward research-oriented search requests to SCI, report, and patent edge
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
expands to `sci,report,patent`. Use source-specific endpoint or credential
overrides with `--sci-url`, `--report-url`, `--patent-url`,
`--sci-api-key`, `--report-api-key`, and `--patent-api-key`. When source URLs
are not provided, `--api-base-url` or `TIANGONG_AI_API_BASE_URL` may be a
Supabase project root, `/functions/v1`, or `/rest/v1`; the CLI derives the
Functions base URL and appends `sci_search`, `report_search`, or
`patent_search`.

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

The CLI is a thin local client. It sends bearer-token requests to the Tiangong
KB ingest API and records SQLite checkpoints for batch recovery. Ingest uses
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
