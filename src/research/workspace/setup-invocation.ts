import { RESEARCH_PACKAGE_NAME, packageVersion } from "./constants.js";

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function exactResearchCliCommand(
  args: readonly string[],
  version: string = packageVersion(),
): string {
  return [
    "npx",
    "--yes",
    "--package",
    `${RESEARCH_PACKAGE_NAME}@${version}`,
    "--",
    "tiangong-ai",
    ...args,
  ]
    .map(shellWord)
    .join(" ");
}

export function pinResearchCliCommand(command: string, version: string = packageVersion()): string {
  const trimmed = command.trim();
  if (!trimmed.startsWith("tiangong-ai ") && trimmed !== "tiangong-ai") return trimmed;
  const prefix = exactResearchCliCommand([], version);
  return trimmed === "tiangong-ai" ? prefix : `${prefix} ${trimmed.slice("tiangong-ai ".length)}`;
}

export function researchSetupApplyCommand(input: { version: string; planPath: string }): string {
  return exactResearchCliCommand(
    ["research", "setup", "apply", "--plan", input.planPath, "--json"],
    input.version,
  );
}

export function researchSetupRetryCommand(input: {
  version: string;
  workspace: string;
  step: string;
}): string {
  return exactResearchCliCommand(
    ["research", "setup", "retry", "--step", input.step, "--workspace", input.workspace, "--json"],
    input.version,
  );
}

function shellWord(value: string): string {
  if (SAFE_SHELL_WORD.test(value)) return value;
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
