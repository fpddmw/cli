import { existsSync, readFileSync } from "node:fs";

import { CliError } from "./errors.js";

export interface Output {
  write(text: string): unknown;
}

export interface CliIO {
  env: NodeJS.ProcessEnv;
  stdout: Output;
  stderr: Output;
}

export function write(output: Output, text: string): void {
  output.write(text);
}

export function readJsonInput(inputPath: string): unknown {
  if (!inputPath) {
    throw new CliError("Missing required --input value.", {
      code: "INPUT_REQUIRED",
      exitCode: 2,
    });
  }

  if (!existsSync(inputPath)) {
    throw new CliError(`Input file not found: ${inputPath}`, {
      code: "INPUT_NOT_FOUND",
      exitCode: 2,
    });
  }

  try {
    return JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  } catch (error) {
    throw new CliError(`Input file is not valid JSON: ${inputPath}`, {
      code: "INPUT_INVALID_JSON",
      exitCode: 2,
      details: String(error),
    });
  }
}

export function stringifyJson(value: unknown, compact: boolean): string {
  return `${JSON.stringify(value, null, compact ? undefined : 2)}\n`;
}
