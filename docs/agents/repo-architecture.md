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
lastReviewedAt: 2026-05-08
lastReviewedCommit: 69e9cde303c75e33da9948ed25744349d880d96c
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
- `src/cli.ts`: command dispatch and current KB ingest implementation.
- `scripts/**`: validation helpers.
- `test/**`: Node test runner suites.

## Skill Boundary

Reusable skills may call this CLI as a wrapper. Skills should collect task
intent and report CLI output; they should not duplicate long-running batch
logic, API request construction, retries, or checkpoint semantics.
