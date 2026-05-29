import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";

import { getBoolean, getString, parseArgs, type ParsedArgs } from "../args.js";
import { firstEnv } from "../env.js";
import { CliError } from "../errors.js";
import type { CliIO } from "../io.js";
import { write } from "../io.js";

const DEFAULT_COURSE_FULLTEXT_BUCKET = "tiangong";
const DEFAULT_COURSE_FULLTEXT_PREFIX = "processed_docs/course_pickle";

export interface CourseFulltextOptions {
  documentId: string;
  tags: string;
  bucket: string;
  prefix: string;
  region?: string | undefined;
}

export interface CourseFulltextResult {
  document_id: string;
  tags: string;
  bucket: string;
  prefix: string;
  key: string;
  text: string;
}

export async function runCourseFulltextCommand(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  if (
    getBoolean(args, "help") ||
    args.positionals[0] === "--help" ||
    args.positionals[0] === "-h"
  ) {
    write(io.stdout, courseFulltextHelp());
    return 0;
  }

  const options = resolveCourseFulltextOptions(args, io.env);
  const result = await readCourseFulltext(options);
  if (getBoolean(args, "json")) {
    write(io.stdout, `${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  write(io.stdout, result.text);
  if (!result.text.endsWith("\n")) write(io.stdout, "\n");
  return 0;
}

export function courseFulltextHelp(): string {
  return `Tiangong KB course fulltext

Usage:
  tiangong-ai kb course fulltext --document-id <id> --tags <tag> [--json]
  tiangong-ai kb course fulltext <document-id> --tags <tag> [--json]

Options:
  --document-id <id>
  --tags <tag>
  --bucket <name> (default tiangong)
  --prefix <path> (default processed_docs/course_pickle)
  --region <name>
  --json
`;
}

export function resolveCourseFulltextOptions(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): CourseFulltextOptions {
  const documentId = getString(args, "document-id") ?? args.positionals[0]?.trim();
  const tags = getString(args, "tags") ?? getString(args, "tag");
  const extraPositionals = args.positionals.slice(
    documentId === args.positionals[0]?.trim() ? 1 : 0,
  );

  if (extraPositionals.length > 0) {
    throw new CliError("kb course fulltext accepts at most one positional document id.", {
      code: "INVALID_ARGS",
      exitCode: 2,
      details: { positionals: args.positionals },
    });
  }
  if (!documentId) {
    throw new CliError("Usage: tiangong-ai kb course fulltext --document-id <id> --tags <tag>", {
      code: "COURSE_FULLTEXT_DOCUMENT_ID_REQUIRED",
      exitCode: 2,
    });
  }
  if (!tags) {
    throw new CliError("Missing --tags for course fulltext lookup.", {
      code: "COURSE_FULLTEXT_TAGS_REQUIRED",
      exitCode: 2,
    });
  }

  const bucket =
    getString(args, "bucket") ??
    firstEnv(
      env,
      "TIANGONG_COURSE_FULLTEXT_S3_BUCKET",
      "KB_COURSE_FULLTEXT_S3_BUCKET",
      "KB_PROCESSED_S3_BUCKET",
    ) ??
    DEFAULT_COURSE_FULLTEXT_BUCKET;
  const prefix =
    getString(args, "prefix") ??
    firstEnv(env, "TIANGONG_COURSE_FULLTEXT_S3_PREFIX", "KB_COURSE_FULLTEXT_S3_PREFIX") ??
    DEFAULT_COURSE_FULLTEXT_PREFIX;
  const region = getString(args, "region") ?? firstEnv(env, "AWS_REGION", "AWS_DEFAULT_REGION");

  return { documentId, tags, bucket, prefix, region };
}

export function buildCourseFulltextPrefix(
  options: Pick<CourseFulltextOptions, "documentId" | "tags" | "prefix">,
): string {
  const documentId = validatePathSegment(options.documentId, "document id");
  const tags = validatePathSegment(options.tags, "tags");
  const prefix = trimSlashes(options.prefix);
  if (!prefix) {
    throw new CliError("--prefix must not be empty.", {
      code: "COURSE_FULLTEXT_PREFIX_REQUIRED",
      exitCode: 2,
    });
  }
  return `${prefix}/${tags}_pickle/${documentId}/`;
}

export function selectCourseFulltextTextKey(keys: string[], prefix: string): string {
  const matches = keys.filter(
    (key) => key.startsWith(prefix) && key.toLowerCase().endsWith(".txt"),
  );
  if (matches.length === 1) return matches[0] as string;
  if (matches.length === 0) {
    throw new CliError(`No .txt fulltext file found under s3 prefix: ${prefix}`, {
      code: "COURSE_FULLTEXT_NOT_FOUND",
      details: { prefix },
    });
  }
  throw new CliError(`Multiple .txt fulltext files found under s3 prefix: ${prefix}`, {
    code: "COURSE_FULLTEXT_AMBIGUOUS",
    details: { prefix, keys: matches },
  });
}

export async function readCourseFulltext(
  options: CourseFulltextOptions,
): Promise<CourseFulltextResult> {
  const client = new S3Client(options.region ? { region: options.region } : {});
  const prefix = buildCourseFulltextPrefix(options);
  const keys = await listAllKeys(client, options.bucket, prefix);
  const key = selectCourseFulltextTextKey(keys, prefix);
  const text = await getObjectText(client, options.bucket, key);
  return {
    document_id: options.documentId,
    tags: options.tags,
    bucket: options.bucket,
    prefix,
    key,
    text,
  };
}

async function listAllKeys(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) keys.push(object.Key);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function getObjectText(client: S3Client, bucket: string, key: string): Promise<string> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return bodyToString(response.Body, key);
}

async function bodyToString(body: GetObjectCommandOutput["Body"], key: string): Promise<string> {
  if (!body) {
    throw new CliError(`S3 object has no body: ${key}`, {
      code: "COURSE_FULLTEXT_EMPTY_OBJECT",
      details: { key },
    });
  }

  const maybeTransform = body as { transformToString?: () => Promise<string> };
  if (typeof maybeTransform.transformToString === "function") {
    return await maybeTransform.transformToString();
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validatePathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("/")) {
    throw new CliError(`Course fulltext ${label} must be a non-empty single S3 path segment.`, {
      code: "COURSE_FULLTEXT_INVALID_PATH_SEGMENT",
      exitCode: 2,
      details: { label, value },
    });
  }
  return trimmed;
}

function trimSlashes(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}
