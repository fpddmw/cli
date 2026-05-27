import { CliError } from "./errors.js";

export type StrictOptionType = "boolean" | "string";

export interface StrictParsedArgs {
  flags: Map<string, string | true>;
  positionals: string[];
}

export function parseStrictArgs(
  argv: string[],
  options: Record<string, StrictOptionType>,
  commandName: string,
): StrictParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    const type = options[name];
    if (!type) {
      throw new CliError(`Unknown option for ${commandName}: --${name}`, {
        code: "INVALID_ARGS",
        exitCode: 2,
        details: { option: name, command: commandName },
      });
    }

    if (type === "boolean") {
      if (equalsIndex >= 0) {
        const value = withoutPrefix.slice(equalsIndex + 1);
        if (value !== "true" && value !== "false") {
          throw new CliError(`Boolean option --${name} must be true or false.`, {
            code: "INVALID_ARGS",
            exitCode: 2,
            details: { option: name, value },
          });
        }
        if (value === "true") flags.set(name, true);
      } else {
        flags.set(name, true);
      }
      continue;
    }

    const value = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliError(`Missing value for --${name}.`, {
        code: "INVALID_ARGS",
        exitCode: 2,
        details: { option: name, command: commandName },
      });
    }
    flags.set(name, value);
    if (equalsIndex < 0) index += 1;
  }

  return { flags, positionals };
}

export function strictString(args: StrictParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function strictBoolean(args: StrictParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}
