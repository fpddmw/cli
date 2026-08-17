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
lastReviewedAt: 2026-08-17
lastReviewedCommit: d14c542100d6e1efdd82798c2d92e68a5bc3bba2
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
tiangong-ai research setup catalog \
  --workspace /absolute/path/to/workspace --json
# Interactive and user-initiated: select external Skills, configure credentials
# with hidden input/env/stdin, review licenses, choose scope, and run checks.
tiangong-ai research setup \
  --workspace /absolute/path/to/workspace
tiangong-ai research setup status \
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

The guided setup creates an immutable, hash-bound plan before mutation. No Skill
is bundled or installed without an explicit Wizard confirmation or plan
selection. The Wizard recommends a project-local `tiangong-auto-research`
orchestrator so ordinary research requests can enter the workflow from any
user-selected workspace directory. It pins the installer integrity, source
commits, Skill tree hashes, exact destinations, license acceptance, safe
credential bindings, settings, and checks. For every selected provider, the
Wizard offers hidden TTY input (recommended), a named owner environment
variable, preloaded bounded stdin/password-manager input, or an explicit skip.
Secret values never enter the plan or terminal output. Required credential
preflight and owner-only storage run before downloads. Project-local copy is
the default; global writes, network downloads, live provider checks, synthetic
document uploads, and paid agent smokes each require their applicable
confirmation.

### Declarative setup

For repeatable provisioning without a TTY, generate a safe workspace-local
template:

```bash
tiangong-ai research setup init \
  --workspace /absolute/path/to/workspace --json
```

This no-overwrite command creates:

- `.tiangong-research/setup.yaml`: every current catalog Skill, credential, and
  setting with explicit enabled/disabled state, plus license acceptances, agent
  routes, verification choices, and confirmations;
- `.tiangong-research/setup.env.example`: every catalog credential variable
  name with an empty value and matching requirement/enabled comments; copy it
  to `setup.env` only when a file-based secret source is needed;
- `.tiangong-research/.gitignore`: excludes `setup.env`.

Review the catalog, edit `setup.yaml`, and never put a key or token in it. For a
file-based credential source:

```bash
cp .tiangong-research/setup.env.example .tiangong-research/setup.env
chmod 600 .tiangong-research/setup.env
# Edit setup.env locally. Keep disabled optional entries empty unless their
# corresponding credentials.<id>.enabled flag is explicitly changed to true.
```

Then run the ordinary command:

```bash
tiangong-ai research setup \
  --workspace /absolute/path/to/workspace --json
```

Bare setup checks only the fixed workspace-local `setup.yaml`; it never scans a
parent directory. When the file exists, setup is fully non-interactive and does
not fall back to the Wizard after a parse, schema, permission, credential, or
readiness failure. Use absolute `--config` and `--env-file` paths only for an
explicit alternative. Use `research setup wizard` to explicitly choose the
interactive path even when a declaration exists.

The closed YAML declaration is `schemaVersion: 2`; the removed v1 shape is not
migrated or accepted. It requires `selection.skills`, `credentials`, and
`settings` to contain exactly all current catalog entries. Skill entries expose
`enabled` and the catalog license ID. Credential and setting entries expose the
catalog- and current-selection-derived `requirement`, catalog `appliesTo`, and
an explicit `enabled` choice;
optional omission is not a configuration state. Missing, extra, or drifted
catalog metadata, incomplete Brave profile combinations, a disabled required
entry, or an enabled setting without a value fails before network access.

`setup.env` must be a regular non-symlink file, no larger than 64 KiB,
owner-only on POSIX, and may contain only credential variable names declared by
the YAML. Empty values keep disabled options visible without selecting them. A
non-empty value for a disabled credential is rejected; enable it in YAML or
remove the value. The file is read as literal data without shell expansion. A
differing value in the ambient environment and `setup.env` is also an error;
setup never chooses between them silently. Enabled secret values are imported
into the existing owner-only logical stores before downloads and never enter
the YAML, immutable plan, declaration binding, output, report, or journal.

The semantic YAML hash is bound to the immutable plan. Re-running unchanged
configuration reuses that exact plan and reruns all verification. A changed
declaration stops until the owner reviews it and sets
`replaceExistingPlan: true`; the prior plan and declaration binding are archived
before replacement.

Declarative setup requires live provider checks and the independent reviewer
CLI agent smoke, including explicit cost authorization. Interactive setup
recommends both by default while retaining explicit quota/cost consent. Apply,
status, doctor, and the Wizard return success only when
`overallReadiness=READY`; skipped checks, warnings, missing dependencies, and
optional selected-component failures remain visible as a non-zero incomplete
setup instead of a false success. The native producer is still not launched as
a child process.

If the full orchestrator was selected, accepted apply creates a separate
project-local `tiangong-auto-research-recovery` Skill after credentials are
stored and before source checkout. This CLI-generated, plan-bound shim can only
inspect context/status and execute the exact-version retry returned by setup; it
cannot perform research, call standalone evidence, or access credentials. A
checkout or install failure therefore remains discoverable without falling back
to a global Skill. After the full external orchestrator matches its reviewed
tree hash, setup verifies the shim byte-for-byte and removes only that generated
directory. Modified, symlinked, or ambiguous recovery bytes block cleanup.

Production admission requires at least one locked external capability with
`brokered-network` and `discoveryScopes: ["public-internet"]`; an input plan or
local files alone cannot represent internet coverage. The machine-readable
setup catalog contains only separately sourced external Skills and reports each
orchestrator, evidence, preprocessing, acquisition, and post-closure
recommendation; exact
source commit and tree hash; license and credential requirements; dependencies;
and installed-byte status. Installation is never performed by a research
package.

Whole-tree hashes are platform-stable: logical paths are NFC-normalized and
ordered by UTF-8 bytes rather than the host locale, and newly created detached
source checkouts disable Git line-ending conversion before checkout. A source
hash mismatch remains fail-closed before `npx skills add`; its structured error
reports only the Skill/source IDs, hash algorithm, and expected/observed hashes.
It never treats file existence as installation success or silently rewrites an
immutable plan. Plans created by an earlier CLI release are rejected at the
execution boundary; create and review a new plan with the active release. The
orchestrator additionally declares a `workspace-lock` runtime contract: every
workspace command goes through its bundled resolver, which accepts only the
regular non-symlink `runtime-lock.json` exact stable CLI version. Setup and
release CI reject a missing resolver or any stale exact CLI version in the
orchestrator's `SKILL.md` or `references/*.md`.

### Top-journal Policy, scientific design, and publication gates

A `top-journal` project starts with a human-reviewed Markdown Policy, not with
model execution. After project-scoped setup reaches `READY`, use the guided
Wizard:

```bash
tiangong-ai research policy wizard top-journal-paper \
  --workspace /absolute/path/to/workspace
tiangong-ai research policy status top-journal-paper \
  --workspace /absolute/path/to/workspace --json
```

The Wizard resolves only the verified project-installed
`tiangong-auto-research` tree. Before catalog use, the CLI parses every Markdown
template in every category of that exact locked tree; setup doctor performs the
same compatibility check before any provider live check or reviewer smoke. The
baseline must require the scientific-design contract, ordered early reviews,
and real-record construct canary, and those safeguards must remain true in the
resolved Policy. The Wizard then copies a baseline plus one article type, field,
journal class, project brief, and four reviewer rubrics. Generic defaults are
clearly reported and require a separate acknowledgement. An exact-journal
Policy additionally requires a current official HTTPS guideline URL, retrieval
date, and substantive human content for all journal-specific sections. Approval
binds the manifest and every document by SHA-256; edits, manifest tampering, or
expiry block preflight and all later stages until the Policy is reviewed and
approved again.

Before search, the current native Codex or Claude host must author a
project-specific scientific design. The CLI owns the closed schema and rejects
designs that confuse model-to-model disagreement with observed truth, inflate
independent sample size through resampling, omit quantity/threshold semantics,
leave blocking gaps unresolved, or cannot fit the complete review lifecycle.
The CLI validates, freezes, hashes, and routes this design; it does not author
the design or launch a nested producer.

Hash binding alone does not make a model executable. Each model declares raw
implementation bytes, a retrievable safe locator and entrypoint, exact
environment-lock bytes, implementation/environment status, and a freeze gate.
Source-derived uncertainty states also declare whether their values are frozen
or pending, and every joint state maps exact parameter-state IDs. Pending model,
environment, or uncertainty objects are allowed only when a planned Policy rule
owns the same due gate. They are exposed in every earlier review packet as
`futureGateObligations` and become blocking mechanical errors at that gate.
Freezing them requires a new authoritative generation; it never upgrades the
old object in place.

Use the same Policy project ID and exact design when preflighting and admitting
the research project:

```bash
tiangong-ai research schema show scientific-design --json
tiangong-ai research project preflight \
  --question "A specific, testable research question" \
  --goal top-journal --policy-project top-journal-paper \
  --requirements /absolute/path/to/evidence-requirements.json \
  --design /absolute/path/to/scientific-design.json \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research project init top-journal-paper \
  --question "A specific, testable research question" \
  --goal top-journal \
  --requirements /absolute/path/to/evidence-requirements.json \
  --design /absolute/path/to/scientific-design.json \
  --design-producer-agent codex \
  --design-producer-session OPAQUE_NATIVE_SESSION \
  --confirm-budget \
  --workspace /absolute/path/to/workspace --json
```

The base evidence lifecycle remains
`discover -> acquire -> analyze -> synthesize -> review -> close`, authored in
the current interactive Codex or Claude Code host. A fresh independent reviewer
must first pass three hash-bound scientific gates: `research-design` before
discovery, a real-record and outcome-blind `evidence-construct` canary after
discovery and before acquisition, and `pilot-methods` after acquisition and
before analysis. Reviewer prose cannot override a mechanical failure.

```bash
tiangong-ai research schema show scientific-assessment-research-design --json
tiangong-ai research project scientific review prepare top-journal-paper \
  --role research-design \
  --assessment /absolute/path/to/research-design-assessment.json \
  --reviewer-agent claude \
  --reviewer-session FRESH_OPAQUE_REVIEW_SESSION \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research schema show scientific-review-research-design --json
tiangong-ai research project scientific review submit top-journal-paper \
  --role research-design --review /absolute/path/to/review.json \
  --workspace /absolute/path/to/workspace --json
```

Repeat the same prepare/submit route for `evidence-construct` and
`pilot-methods` at their stage boundaries. A top-journal fork or addendum is a
new authoritative generation and therefore requires a target-specific approved
Policy, design, and fresh native producer session; it cannot inherit scientific
approval from a superseded generation.

Review packet `stageInputs` identify promoted portable objects by purpose,
owner, source locator, and SHA-256 over raw file bytes. `packetSha256` is the
logical packet identity that excludes its own identity field; the portable
audit manifest separately records the raw stored packet-file digest. This keeps
packet identity and byte-level transfer verification explicit rather than
overloading one hash with both meanings.

After base closure, the current native host writes a final manuscript and
schema-valid publication assessment. `research publication freeze` then
content-addresses the Policy, scientific design and early reviews, evidence
snapshot, base outputs, manuscript, assessment, and supplements.
Exactly four fresh independent sessions review that frozen generation:
evidence, methods/reproducibility, domain/novelty, and journal-editor. A revised
manuscript invalidates prior reviews; reviewer-session reuse is rejected from
the append-only journal even if mutable cache state is removed. The raw opaque
producer/reviewer session identifiers are accepted only at the command boundary;
generation, packet, review, journal, and closure objects persist only their
SHA-256 bindings.

```bash
tiangong-ai research schema show publication-assessment --json
tiangong-ai research publication freeze top-journal-paper \
  --manuscript /absolute/path/to/final-manuscript.md \
  --assessment /absolute/path/to/publication-assessment.json \
  --producer-agent codex --producer-session OPAQUE_NATIVE_SESSION \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research publication status top-journal-paper \
  --workspace /absolute/path/to/workspace --json
```

The CLI returns a mechanically bounded ceiling:
`top-journal-candidate`, `top-journal-class-ready`, or
`target-journal-submission-ready`. Evidence and review failures can only lower
it. None of these states predicts or guarantees editorial acceptance.

Before external handoff or archival, export and independently verify a portable
audit directory. It contains the selected project, portable copies of admitted
inputs, formal evidence and artifact bytes, Policy/design/review objects,
outputs, environment fingerprints, and journal proofs. Credentials, setup
sources, browser profiles, native active state, capsules, unrelated projects,
and host-specific absolute paths are excluded.

```bash
tiangong-ai research project audit export top-journal-paper \
  --output /absolute/path/to/new-audit-directory \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research project audit verify \
  --bundle /absolute/path/to/new-audit-directory --json
```

`research setup status --json` reports credential persistence separately from
readiness. It also reports the effective exact-npx CLI package/version/root,
the selected project orchestrator, any temporary recovery shim, ignored global
same-name Skills, legacy wrappers that still contain an unmanaged PATH CLI
fallback, and the real failed source/immutable ref/cache state when checkout is
retryable. A direct `research search` inside a managed workspace stops before
network access and returns the same broker-vs-standalone and setup provenance;
it never converts a stored broker credential into an ambient credential.

The default `internet-research` profile selects Brave Web Search and News
Search. `internet-research-with-context` additionally selects the
subscription-dependent LLM Context endpoint, while
`internet-research-with-media` also selects image and video discovery. A
provider-plan or authentication failure blocks the selected profile instead of
silently dropping a Skill. `credential set` accepts exactly one of `--prompt`,
`--from-stdin`, or `--from-env <name>` and stores the value under the declared
logical ID; the value is never returned or journaled. For example:

```bash
tiangong-ai research setup credential set \
  --id brave.search.api-key --prompt \
  --workspace /absolute/path/to/workspace --json

op read 'op://Research/Brave/api-key' | \
  tiangong-ai research setup credential set \
    --id brave.search.api-key --from-stdin \
    --workspace /absolute/path/to/workspace --json
```

The pinned Brave checkout is verified at `skills/<skill-name>` before install.
An explicitly reviewed replacement plan reconciles the complete setup-managed
capability set and both owner-only credential stores: deselected Brave, SCI,
report, or patent declarations and lock records are removed, custom capability
declarations are preserved, and installed Skill directories are never deleted
implicitly.
Provider-dependent context/media choices never fall back silently; select the
baseline in a replacement plan when that is the intended operator decision.

The interactive Wizard uses restrained semantic colors and section markers
only when its terminal output is a TTY. Hidden credential input is not echoed.
Set `NO_COLOR` or `TERM=dumb` for plain text; `--json` also disables Wizard
styling so structured output never contains ANSI escape sequences. Password
managers may preload one line per logical ID with
`--credential-stdin <id[,id...]>`; the remaining Wizard questions use the
controlling terminal.

Optional setup entries have explicit roles. Tiangong SCI, report, and patent
search are distinct owner-whitelisted POST evidence capabilities with separate
logical credentials and discovery scopes; one cannot substitute for another.
Document decomposition is an input preprocessor; academic paper download is an
acquisition adapter; document and
presentation Skills are post-closure authoring only. Run selected preprocessors
and acquisition adapters with `research setup companion run`, then admit their
exact hash-bound output separately. Automatic paper OA exhaustion returns an
explicit browser handoff and never launches or chooses a browser silently.
For PPT creation, setup recommends `hugohe3.ppt-master` first;
`anthropic.pptx` remains a compatible situational option, and both may be
selected in the same explicit plan.

Every leaf command accepts `--help` before workspace resolution, so operators
can inspect `capability doctor`, `project preflight`, `project init`, and `run`
syntax safely from an empty or unrelated directory.

The requirements object declares `dimensions`, `sourceTypes`, optional
`requiredCapabilityIds`, `requiredCompanionIds`, and
`requiredDiscoveryScopes`, `minSources`,
`minFullTextSources`, `minDatedSources`, and optional inclusive
`publicationDateFrom` / `publicationDateTo` boundaries (`YYYY-MM-DD` or
`null`). Explicit capability/scope requirements are exact: wildcard web or SCI
coverage cannot satisfy a required report database. Preflight returns both
stable string gaps and structured `coverageGaps` with the affected dimensions,
source types, alternative-coverage decision, and minimum owner action. After
discovery, a mechanical coverage gate verifies the declared
source, full-text, publication-date, and dimension summary before analysis.
For large local sources, pass an immutable `--input-plan` to both preflight and
project initialization. Each plan entry may expose either a separate
`contextPath` or non-overlapping, one-based `contextRanges`; the producer sees
only that bounded context, while independent review receives the hash-verified
full source. Symlinks, duplicate content, changed hashes, and context above
`maxInputContextTokens` are rejected.

The workspace stores its current protocol state under `.tiangong-research/`.
Each project follows the evidence-first sequence: broad discovery, strict
admission, acquisition audit, immutable evidence freeze, analysis, synthesis,
independent review, and mechanical closure. Discover, acquire, analyze, and
synthesize run in the current interactive Codex app/session or Claude Code
session. The CLI never launches a nested producer process. Independent review
runs through the other configured agent family's CLI, and execution is blocked
when the two roles use the same family.

Independent reviewer execution requires `/usr/bin/sandbox-exec` on macOS or
Bubblewrap (`bwrap`) on Linux. Windows can inspect and configure workspaces but
does not launch reviewer packages; smoke-test setup reports a non-blocking
warning there, while production readiness fails closed. The current native producer remains governed
by its host application's own permissions; the CLI supplies a hash-bound packet
and deterministic broker commands, not a second nested sandbox or agent.

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
# When stopReason is native-stage-required, perform the returned stage here:
tiangong-ai research project stage prepare gpu-resource-impact \
  --stage discover --host-agent codex \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research project stage submit gpu-resource-impact \
  --session SESSION_ID --output /absolute/path/to/discover.json \
  --confirm-model EXPECTED_MODEL \
  --workspace /absolute/path/to/workspace --json
tiangong-ai research status --workspace /absolute/path/to/workspace --json
```

The discover packet derives a bounded multi-channel plan from reviewed evidence
requirements. Required channels run first; exact repeated requests reuse the
project cache without another provider call but still consume a bounded context
view; remaining views are spent only on explicit coverage,
counterevidence, date, applicability, or full-text gaps. Native Web/Browser
leads may be registered as supplemental candidates, but they cannot be admitted
until the same canonical URL/DOI has an immutable broker occurrence. Registered
inputs are formal candidates under their own content-hash identity.
The acquire packet audits every provisional source and registers only explicit
files—never a directory or “latest download.” PDF and Office artifacts are
structurally verified and content-addressed. A registered binary full file is
review-bound but is not counted as producer-readable full text unless an
admitted UTF-8 text/JSON/HTML/CSV/Markdown derivative exists. Such a derivative
names its registered parent and inherits that parent's canonical source URL;
it does not invent a second network-download binding, and a conflicting URL is
rejected.

For top-journal work, the frozen scientific design maps every required evidence
role to all applicable lawful acquisition routes in the configured environment.
Every declared agent route for a required role is mandatory, and every required
capability must map to an available locked broker route at preflight.
Each broker call carries its exact `acquisition_route_id`; native activity and
download records carry `acquisitionRouteId`. A missing or mismatched route ID is
rejected rather than becoming evidence that a method was tried.

Inspect the live, hash-verified route state before declaring a material evidence
ceiling:

```bash
tiangong-ai research project access status gpu-resource-impact \
  --workspace /absolute/path/to/workspace --json
```

Once all agent routes are terminal, the command first recommends assessing
required evidence-role coverage. Its `ifEvidenceStillInsufficient` field is a
conditional access/scope action, not a claim that purchase is always necessary.

Successful broker/native/download completion, explicit broker authentication or
entitlement denial, and validated deterministic no-OA download outcomes can be
terminal. HTTP 422, malformed requests, configuration errors, timeouts, 429,
5xx, cancelled downloads, and login/MFA/CAPTCHA/security challenges are not
route exhaustion. Challenges pause immediately through an
`interactive-challenge` handoff.

Only after every required plan-bound agent route for a still-missing required
evidence role has exact terminal event hashes may the native host submit a
schema-v2 `evidence-exhausted` handoff. The durable handoff names each remaining
purchase, subscription, institutional authorization, owner input, external data
request, or field collection action with an official non-sensitive locator and
resume criteria. Research then stops; it does not spend more budget on
low-yield substitutes. If no lawful remaining route exists, the user must narrow
or abandon the unsupported scope before a new reviewed generation can resume.

Successful acquisition freezes an immutable evidence snapshot before analysis.
The reviewer and mechanical closure bind and recheck the snapshot chain,
ledger, receipts, selected artifacts, excerpts, analysis, and report. Refresh a
closed result with `research project addendum SOURCE --to TARGET`; the original
closure remains unchanged, the child snapshot records a mechanical delta, and
default status hides the superseded project (`research status --all` shows full
lineage).

Use `research run --project <id>` for an auditable project-scoped run: only
that project is checked, scheduled, summarized, and bound to the top-level
JSON/JSONL `projectId`, so historical blocked siblings do not alter its exit
status. Omit `--project` and use `--max-parallel` only for an intentional
workspace-wide run.

Inputs are admitted by SHA-256. Native producer preparation creates an
ephemeral, hash-bound packet directory but does not copy agent authentication
or start an agent. The independent reviewer runs with a dedicated capsule HOME
in an ephemeral platform sandbox. Only the minimal supported reviewer auth file
is copied into that HOME. A reviewer formatting repair reuses that capsule copy
only after its SHA-256 still matches the owner source; changed, symlinked, or
non-owner-only authentication stops execution instead of being overwritten. For Claude, an
owner-only user `settings.json` is never
copied; only the whitelisted API key/token and HTTPS base URL fields from its
`env` object are injected in memory. Permissions, hooks, additional directories,
and unrelated settings are not admitted. Codex project-root discovery is
terminated by a capsule-local marker/config override, so a parent workspace
`.codex/config.toml` is neither required nor made readable. The workspace
credential file and the rest of the host home are not admitted. Production
doctor is blocked until `--agent-smoke` actually starts the independent reviewer
inside this boundary. The native producer is verified as the current host and
is never smoke-tested as a child process. A successful smoke creates a 24-hour
attestation bound to workspace config, capability lock, output schema, and the
resolved reviewer binary/wrapper fingerprints. Production review stops before
invocation if the attestation expires or any bound value drifts. While that
attestation remains current, a plain `workspace doctor` revalidates its hashes
and the current reviewer runtime fingerprint before reuse. Passing the smoke
flags explicitly performs fresh checks instead; missing, expired, or drifted
attestations remain blocking and include the refresh action. Use the exact
`codex` / `claude` route by default. A custom reviewer wrapper must use an
absolute `binary` plus an absolute `wrapperTargetBinary`; the runtime injects
the resolved target path and independently hashes the target executable, route
launcher/wrapper, and internal adapter. A wrapper that performs an unpinned
PATH lookup is not a reproducible route.

The CLI owns the authoritative JSON Schemas for discovery, acquisition,
analysis, synthesis, and review. Inspect one with
`research schema show <stage> --json`.
Native producer preparation returns the exact schema and prompt to the current
host; `stage submit` validates and atomically materializes its JSON. A rejected
native submission keeps the bound session for an explicit correction and never
launches a repair model. The independent reviewer receives its schema through
the reviewer CLI's structured-output option; a reviewer syntax/schema or
mechanical binding failure gets at most one separately budgeted formatting-only
repair with no research tools.

Total, per-package, output, repair, broker-response bytes, estimated broker
context tokens, context items, wall-time, output-count, output-size, and attempt
limits live in `.tiangong-research/config.json`.
New production workspaces use generous but finite runaway ceilings: 50,000,000
total tokens, USD 5,000, 30 days, and package ceilings of 12,000,000 for discovery, 2,000,000 for
acquisition, 1,500,000 each for analysis and synthesis, and 2,500,000 for
review. Primary output is bounded at 32,000 tokens and a separately invoked
repair at 16,000. The production broker hard ceiling is 256 bounded views with
32,000 context tokens per view; input context is bounded at 128,000 tokens.
Top-journal admission additionally reserves three early scientific reviews at
500,000 tokens each, four final publication reviews at 750,000 each, and one
4,000,000-token revision cycle, including their finite wall-time allowances.
These values are not a target spend. Coverage-derived working plans and early
stop control ordinary use, while the finite ceilings, three attempts per
package, and explicit confirmation above the cost threshold stop runaway work.
Smoke-test workspaces retain their smaller low-cost defaults.
Before project initialization and every executable package, the control plane
requires the complete token and conservative price reservation to fit. Native
producer stages reserve prompt, schema, admitted context, bounded broker
context, and output allowance, but the host app does not expose trusted
per-stage usage telemetry to this CLI. A successful native submit therefore
charges the full reviewed package reservation and records
`accountingMode=reserved-native-host`; submit still enforces the exact schema,
output bytes/tokens, provenance, coverage, hashes, and remaining project budget.
It does not claim a provider-side turn or output-token cap for the host app.

Independent review uses the pre-call reservation calculator and the reviewer's
provider-side structured-output/turn controls where available. Review admission
reserves three maximum-size generated artifacts plus one globally bounded
evidence-excerpt bundle, and formatting repair remains one separately budgeted,
tool-free JSON correction. Production workspaces enforce a finite 256-view
broker ceiling mechanically, while each project derives a much smaller working
budget from its reviewed coverage requirements and stops early when they are
supportable. Every successful native evidence fetch reports the remaining
working budget; excess calls are rejected before another provider request or
evidence promotion. Reviewer usage records separate input, cached-input, and
output tokens; configured pricing fills cost when the provider omits it. Run
records and JSONL progress preserve sanitized accounting mode, event/item
counts, provider turns, tool calls, reasoning tokens, and bounded provider
errors.

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

Native discovery preparation embeds the exact staged capability manifest and
each external Skill's top-level `SKILL.md`. The current host may fetch admitted
evidence only with `research project evidence fetch`, whose bounded request file
contains logical IDs but no credential values. The manifest includes the locked,
non-secret HTTPS endpoint rather than only its host, and each response returns
the exact bounded context plus a hash-bound receipt while retaining the raw
object in the permanent evidence store. Host web/search/database tools cannot
substitute for a required broker receipt.
Analyze and synthesize packets contain bounded, hash-verified prior-stage
artifacts and require no external evidence calls. Review is tool-free and uses the
reviewer's route-specific structured-output turn cap:
its prompt embeds the complete generated artifacts and a deterministic,
globally bounded set of excerpts distributed across registered local contexts
and broker receipts. Broker excerpts prioritize deterministic, sanitized
projections of the exact raw-response items selected by admitted evidence JSON
Pointers; uncited receipts retain metadata-only bindings, and unresolved
pointers receive a bounded-context fallback. The packet hash is schema-bound, but complete packet
metadata is not redundantly copied into model context. Full local files,
original per-receipt bounded contexts, raw broker objects, and the complete
packet remain hash-bound for durable human/mechanical audit; the model must not
claim to have read beyond the embedded excerpts.
The CLI mechanically derives local full-text availability, source types,
counts, date coverage, source IDs, and the coverage decision. A `partial`
dimension is usable but incomplete; a missing dimension or unmet declared
minimum blocks downstream work. Qualitative gaps remain visible without
silently changing those mechanical fields.

Method Skills are external to this project. Recommended Skills are selected
through `research setup`; a custom owner-selected database, domain index, or
other external method is admitted from an absolute reviewed definition:

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
file counts/sizes. Project-owned Tiangong Skills are rejected through this
generic import path; the setup catalog has separate reviewed first-party
adapters for Tiangong SCI, report, and patent search. Configure/import refuses to rewrite the lock if any
existing capability has drifted; restore it or explicitly update its source
identity and expected hash first.

External Skills use absolute paths and explicit permissions, then freeze
before execution:

```bash
tiangong-ai research capability lock --workspace /absolute/path/to/workspace
tiangong-ai research capability verify --workspace /absolute/path/to/workspace
```

A capability using `brokered-network` must declare exact `allowedHosts` and an
`http` policy with a credential-free exact `endpoint`, `method` (`GET` or
bounded JSON `POST`), one exact `accept` value, safe `staticHeaders`, `maxRequestBytes`,
`allowedContentTypes`, `maxResponseBytes`, and `maxItems`. Its optional
`coverage` block declares dimensions, source types, full-text availability,
publication-date availability, and named discovery scopes for the preflight gap
report. Mark `requiredForDiscovery: true` for every public index or
owner-whitelisted database the question must exercise. Downstream work is
blocked unless each such capability produces its own verified broker receipt;
another local file cannot substitute for it. POST request bodies may contain
only documented non-secret fields; credential-like keys are rejected, only the
body hash is persisted, and redirects are refused. GET targets and every
redirect must remain on the endpoint path (an explicitly declared `/` endpoint
grants origin-wide paths). A non-network external
method-guidance Skill stages reviewed instructions but does not grant an
undeclared tool or service call.
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
and run the production setup/workspace doctor before a run. Setup doctor reuses
one capability probe and never starts the paid reviewer smoke while a blocking
static or low-cost prerequisite is already failing.
Capability doctor retries only one 429 response with bounded `Retry-After`
backoff; deterministic 4xx, missing subscription, authentication, drift, and
content-type failures stop explicitly. It retains only a bounded sanitized
provider code/detail and safe request ID, with an actionable baseline-or-
subscription decision for `OPTION_NOT_IN_PLAN`. Required evidence/reviewer
failures make `researchReadiness=BLOCKED`. Optional preprocessing, acquisition,
and authoring checks have separate readiness fields; they block only a project
or operation that explicitly lists the exact component in
`requiredCompanionIds`.
Credential diagnostics distinguish standalone ambient absence,
broker-store absence, policy-rejected injection, and provider 401/403. Every
such diagnostic identifies the execution mode, credential scope, whether a
network request occurred, and a minimum action without returning credentials
or raw authentication responses. The optional Semantic Scholar resolver check
also performs only one bounded 429 retry. A second 429 leaves acquisition
`DEGRADED`, does not block unrelated research, and never triggers a standalone
fallback; the academic adapter can still use its unchanged Unpaywall → Semantic
Scholar OA → arXiv → explicit browser-handoff order.
The broker preserves a sanitized non-2xx excerpt, safe request ID, and
`Retry-After`. It performs at most one inline 429 retry when the declared or
default delay is at most five seconds; longer throttles return an actionable
rate-limit failure instead of holding the agent call open. The journal records
the bounded retry decision without raw URLs or credentials. It supports JSON
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
transient server failures alone may schedule another attempt. Synthesis
semantic validation also rejects literal `/n` or double-escaped
`\\n` markers immediately before Markdown block structures. This unambiguous
case is mechanically converted to the same number of line-feed characters and
recorded as a content-free `package.output.normalized` journal event before
independent review; URLs and other unmatched text are unchanged.
Explicit recovery uses append-only management events:

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
npm run audit:research-setup-pins
docpact validate-config --root . --strict
```

## Release

Publishing is handled by GitHub Actions in `.github/workflows/publish.yml`.
Push a `v*` tag that matches `package.json` version. The workflow publishes
`@tiangong-ai/cli` to npm through npm Trusted Publishing after lint, tests,
coverage, immutable remote Skill pin/runtime-contract audit, version
availability, and a package dry run pass.
