import { runEdgeSearch } from "../edge-search.js";
import { CliError } from "../errors.js";
import type { CliIO } from "../io.js";
import { readJsonInput, stringifyJson, write } from "../io.js";
import { parseStrictArgs, strictBoolean, strictString } from "../strict-args.js";
import { parseResearchSources, researchSourceConfig, resolveResearchConfig } from "./config.js";

const RESEARCH_SEARCH_OPTIONS = {
  help: "boolean",
  json: "boolean",
  "dry-run": "boolean",
  input: "string",
  query: "string",
  claim: "string",
  sources: "string",
  "api-key": "string",
  "api-base-url": "string",
  "sci-api-key": "string",
  "report-api-key": "string",
  "patent-api-key": "string",
  "esg-api-key": "string",
  "sci-url": "string",
  "report-url": "string",
  "patent-url": "string",
  "esg-url": "string",
  region: "string",
  timeout: "string",
  "top-k": "string",
  "ext-k": "string",
  "get-meta": "boolean",
} as const;

export async function runResearchCommand(argv: string[], io: CliIO): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    write(io.stdout, researchHelp());
    return 0;
  }
  if (subcommand === "search") {
    return runResearchSearchCommand(rest, io);
  }
  write(io.stdout, researchHelp());
  return 1;
}

function researchHelp(): string {
  return `Tiangong research commands

Usage:
  tiangong-ai research search --input <request.json> [--sources default|all|sci|report|patent|esg] [--dry-run] [--json]
  tiangong-ai research search --query <query> [--sources default|all|sci|report|patent|esg] [--dry-run] [--json]

Research search options:
  --input <file>
    JSON request body to forward unchanged to each selected edge function.
  --query <text>
    Convenience mode; builds {"query": text} plus optional --top-k/--ext-k/--get-meta.
  --sources <csv> (default sci; all = sci,report,patent,esg)
  --dry-run
    Print the exact POST request plan with masked credentials.
  --api-key <token> or TIANGONG_AI_APIKEY
  --api-base-url <url>
    Supabase project root, /functions/v1, or /rest/v1 base URL.
  --sci-api-key <token>, --report-api-key <token>, --patent-api-key <token>, --esg-api-key <token>
  --sci-url <url>, --report-url <url>, --patent-url <url>, --esg-url <url>
  --region <name>
  --timeout <seconds>
  --top-k <n>
  --ext-k <n>
  --get-meta
  --json
`;
}

async function runResearchSearchCommand(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(argv, RESEARCH_SEARCH_OPTIONS, "research search");
  if (strictBoolean(args, "help")) {
    write(io.stdout, researchHelp());
    return 0;
  }
  if (args.positionals.length > 0) {
    throw new CliError("research search does not accept positional arguments.", {
      code: "INVALID_ARGS",
      exitCode: 2,
      details: { positionals: args.positionals },
    });
  }

  const sourceIds = parseResearchSources(strictString(args, "sources"));
  const config = resolveResearchConfig(args, io.env);
  const inputPath = strictString(args, "input");
  const body = researchRequestBody(args);
  const result = await runEdgeSearch({
    body,
    inputPath,
    sources: sourceIds.map((source) => ({ source, ...researchSourceConfig(config, source) })),
    timeoutMs: config.timeoutSeconds * 1000,
    dryRun: strictBoolean(args, "dry-run"),
    missingCredentialHelp:
      "Provide --api-key, a source-specific API key option, or set TIANGONG_AI_APIKEY.",
  });

  writeSearchResult(io, result, strictBoolean(args, "json"));
  return 0;
}

function researchRequestBody(args: ReturnType<typeof parseStrictArgs>): unknown {
  const inputPath = strictString(args, "input");
  if (inputPath) {
    rejectInputModeBodyFlags(args, ["query", "claim", "top-k", "ext-k", "get-meta"]);
    return readJsonInput(inputPath);
  }

  const query = strictString(args, "query") ?? strictString(args, "claim");
  if (!query) {
    throw new CliError("Usage: tiangong-ai research search --input <file> or --query <query>", {
      code: "RESEARCH_QUERY_REQUIRED",
      exitCode: 2,
    });
  }

  const body: Record<string, unknown> = { query };
  const topK = optionalPositiveInteger(strictString(args, "top-k"), "--top-k");
  const extK = optionalPositiveInteger(strictString(args, "ext-k"), "--ext-k");
  if (topK !== undefined) body.topK = topK;
  if (extK !== undefined) body.extK = extK;
  if (strictBoolean(args, "get-meta")) body.getMeta = true;
  return body;
}

function rejectInputModeBodyFlags(
  args: ReturnType<typeof parseStrictArgs>,
  bodyFlagNames: string[],
): void {
  const present = bodyFlagNames.filter((name) => args.flags.has(name));
  if (present.length === 0) return;
  throw new CliError(`--input cannot be combined with body-building flags: ${present.join(", ")}`, {
    code: "INVALID_ARGS",
    exitCode: 2,
    details: { flags: present },
  });
}

function optionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`${label} must be a positive integer.`, {
      code: "INVALID_NUMERIC_OPTION",
      exitCode: 2,
      details: { label, value },
    });
  }
  return parsed;
}

function writeSearchResult(
  io: CliIO,
  result: Awaited<ReturnType<typeof runEdgeSearch>>,
  compact: boolean,
): void {
  const output =
    !result.dryRun && result.responses.length === 1 ? result.responses[0]?.response : result;
  write(io.stdout, stringifyJson(output, compact));
}
