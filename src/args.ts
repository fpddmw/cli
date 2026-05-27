import { CliError } from "./errors.js";

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      flags.set(withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(withoutPrefix, next);
      index += 1;
    } else {
      flags.set(withoutPrefix, true);
    }
  }

  return { positionals, flags };
}

export function getString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

export function getBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === "true";
}

export function getPositiveInteger(args: ParsedArgs, name: string, defaultValue: number): number {
  return positiveIntegerValue(getString(args, name), defaultValue, `--${name}`);
}

export function getNonNegativeInteger(
  args: ParsedArgs,
  name: string,
  defaultValue: number,
): number {
  return nonNegativeIntegerValue(getString(args, name), defaultValue, `--${name}`);
}

export function nonNegativeIntegerValue(
  value: string | undefined,
  defaultValue: number,
  label: string,
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new CliError(`${label} must be a non-negative integer.`);
  return parsed;
}

export function getPositiveNumber(args: ParsedArgs, name: string, defaultValue: number): number {
  return positiveNumberValue(getString(args, name), defaultValue, `--${name}`);
}

export function positiveNumberValue(
  value: string | undefined,
  defaultValue: number,
  label: string,
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new CliError(`${label} must be a positive number.`);
  return parsed;
}

export function positiveIntegerValue(
  value: string | undefined,
  defaultValue: number,
  label: string,
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new CliError(`${label} must be a positive integer.`);
  return parsed;
}
