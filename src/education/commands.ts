import { runEdgeSearch } from "../edge-search.js";
import { CliError } from "../errors.js";
import type { CliIO } from "../io.js";
import { readJsonInput, stringifyJson, write } from "../io.js";
import { parseStrictArgs, strictBoolean, strictString } from "../strict-args.js";
import { educationSourceConfig, parseEducationSources, resolveEducationConfig } from "./config.js";

const EDUCATION_SEARCH_OPTIONS = {
  help: "boolean",
  json: "boolean",
  "dry-run": "boolean",
  input: "string",
  query: "string",
  sources: "string",
  "api-key": "string",
  "api-base-url": "string",
  "bearer-token": "string",
  "course-api-key": "string",
  "edu-api-key": "string",
  "textbook-api-key": "string",
  "course-url": "string",
  "edu-url": "string",
  "textbook-url": "string",
  region: "string",
  timeout: "string",
  "top-k": "string",
  "ext-k": "string",
} as const;

export async function runEducationCommand(argv: string[], io: CliIO): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    write(io.stdout, educationHelp());
    return 0;
  }
  if (subcommand === "search") {
    return runEducationSearchCommand(rest, io);
  }
  write(io.stdout, educationHelp());
  return 1;
}

function educationHelp(): string {
  return `Tiangong education commands

Usage:
  tiangong-ai education search --input <request.json> [--sources default|all|course|edu|textbook] [--dry-run] [--json]
  tiangong-ai education search --query <query> [--sources default|all|course|edu|textbook] [--dry-run] [--json]

Education search options:
  --input <file>
    JSON request body to forward unchanged to each selected edge function.
  --query <text>
    Convenience mode; builds {"query": text} plus optional --top-k/--ext-k.
  --sources <csv> (default course; all = course,edu,textbook)
  --dry-run
    Print the exact POST request plan with masked credentials.
  --api-key <token> or TIANGONG_AI_APIKEY
  --api-base-url <url>
    Supabase project root, /functions/v1, or /rest/v1 base URL.
  --bearer-token <token> for scoped course search
  --course-api-key <token>, --edu-api-key <token>, --textbook-api-key <token>
  --course-url <url>, --edu-url <url>, --textbook-url <url>
  --region <name>
  --timeout <seconds>
  --top-k <n>
  --ext-k <n>
  --json
`;
}

async function runEducationSearchCommand(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(argv, EDUCATION_SEARCH_OPTIONS, "education search");
  if (strictBoolean(args, "help")) {
    write(io.stdout, educationHelp());
    return 0;
  }
  if (args.positionals.length > 0) {
    throw new CliError("education search does not accept positional arguments.", {
      code: "INVALID_ARGS",
      exitCode: 2,
      details: { positionals: args.positionals },
    });
  }

  const sourceIds = parseEducationSources(strictString(args, "sources"));
  const config = resolveEducationConfig(args, io.env);
  const inputPath = strictString(args, "input");
  const body = educationRequestBody(args);
  const result = await runEdgeSearch({
    body,
    inputPath,
    sources: sourceIds.map((source) => ({ source, ...educationSourceConfig(config, source) })),
    timeoutMs: config.timeoutSeconds * 1000,
    dryRun: strictBoolean(args, "dry-run"),
    missingCredentialHelp:
      "Provide --api-key, --bearer-token for course search, a source-specific API key option, or set TIANGONG_AI_APIKEY.",
  });

  writeSearchResult(io, result, strictBoolean(args, "json"));
  return 0;
}

function educationRequestBody(args: ReturnType<typeof parseStrictArgs>): unknown {
  const inputPath = strictString(args, "input");
  if (inputPath) {
    rejectInputModeBodyFlags(args, ["query", "top-k", "ext-k"]);
    return readJsonInput(inputPath);
  }

  const query = strictString(args, "query");
  if (!query) {
    throw new CliError("Usage: tiangong-ai education search --input <file> or --query <query>", {
      code: "EDUCATION_QUERY_REQUIRED",
      exitCode: 2,
    });
  }

  const body: Record<string, unknown> = { query };
  const topK = optionalPositiveInteger(strictString(args, "top-k"), "--top-k");
  const extK = optionalPositiveInteger(strictString(args, "ext-k"), "--ext-k");
  if (topK !== undefined) body.topK = topK;
  if (extK !== undefined) body.extK = extK;
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
