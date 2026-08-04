import { spawn } from "node:child_process";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

import { CliError } from "../../errors.js";
import type { AgentRoute, ExecutionResult } from "./types.js";

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const CREDENTIAL_ENV_NAME =
  /(^|[_-])(authorization|auth|cookie|credential|password|passwd|private[_-]?key|secret|token|access[_-]?key|api[_-]?key)([_-]|$)/i;

export interface AgentExecutionRequest {
  route: AgentRoute;
  prompt: string;
  capsuleRoot: string;
  projectRoot: string;
  workspaceRoot: string;
  timeoutSeconds: number;
  environment: NodeJS.ProcessEnv;
  brokerUrl: string | null;
}

export async function executeAgent(request: AgentExecutionRequest): Promise<ExecutionResult> {
  validateAgentBinary(request.route);
  const temporaryDirectory = join(request.capsuleRoot, "tmp");
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const secrets = configuredSecrets(request.environment);
  const invocation = await buildInvocation(
    request.route,
    request.prompt,
    request.brokerUrl,
    request.capsuleRoot,
  );
  const sandboxed = await sandboxInvocation(
    invocation.binary,
    invocation.args,
    request.capsuleRoot,
    request.projectRoot,
    request.workspaceRoot,
  );
  const started = process.hrtime.bigint();
  const completed = await spawnCaptured({
    binary: sandboxed.binary,
    args: sandboxed.args,
    cwd: request.projectRoot,
    env: sanitizedEnvironment(request.environment, temporaryDirectory),
    timeoutMs: request.timeoutSeconds * 1000,
  });
  const wallSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
  const parsed = parseAgentResult(request.route.agent, completed.stdout, completed.stderr);
  const redacted = redactResult(parsed.stdout, parsed.stderr, secrets);
  const exitCode = redacted.exposed
    ? 86
    : completed.exitCode !== 0
      ? completed.exitCode
      : parsed.parseFailed
        ? 3
        : 0;
  return {
    exitCode,
    stdout: redacted.stdout,
    stderr: redacted.stderr,
    tokens: redacted.exposed ? 0 : parsed.tokens,
    costUsd: redacted.exposed ? 0 : parsed.costUsd,
    wallSeconds,
  };
}

async function buildInvocation(
  route: AgentRoute,
  prompt: string,
  brokerUrl: string | null,
  capsuleRoot: string,
): Promise<{ binary: string; args: string[] }> {
  if (route.agent === "codex") {
    const args = [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "-c",
      'web_search="disabled"',
      "--json",
    ];
    if (brokerUrl) {
      args.push(
        "-c",
        `mcp_servers.research_broker.url=${JSON.stringify(brokerUrl)}`,
        "-c",
        "mcp_servers.research_broker.required=true",
        "-c",
        'mcp_servers.research_broker.enabled_tools=["fetch_candidate_source"]',
      );
    }
    if (route.model) args.push("--model", route.model);
    args.push(prompt);
    return { binary: route.binary, args };
  }
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--no-chrome",
    "--disable-slash-commands",
    "--tools",
    "Read,Write,Edit,Glob,Grep",
  ];
  const allowedTools = ["Read", "Write", "Edit", "Glob", "Grep"];
  if (brokerUrl) {
    const mcpConfigPath = join(capsuleRoot, "research-mcp.json");
    await writeFile(
      mcpConfigPath,
      `${JSON.stringify({
        mcpServers: {
          research_broker: { type: "http", url: brokerUrl },
        },
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    allowedTools.push("mcp__research_broker__fetch_candidate_source");
    args.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
  }
  args.push("--allowedTools", allowedTools.join(","));
  if (route.model) args.push("--model", route.model);
  return { binary: route.binary, args };
}

async function sandboxInvocation(
  binary: string,
  args: string[],
  capsuleRoot: string,
  projectRoot: string,
  workspaceRoot: string,
): Promise<{ binary: string; args: string[] }> {
  const configuredCredentialPath = join(workspaceRoot, ".tiangong-research", ".env");
  const workspaceCredentialPath = await realpath(configuredCredentialPath).catch(
    () => configuredCredentialPath,
  );
  if (platform() === "darwin") {
    const sandbox = "/usr/bin/sandbox-exec";
    await requireExecutable(sandbox, "macOS sandbox-exec");
    const profile = join(capsuleRoot, "execution.sb");
    const policy = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow network*)",
      `(allow file-read* (require-not (literal ${sandboxString(workspaceCredentialPath)})))`,
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow ipc-posix*)",
      `(allow file-write* (literal "/dev/null") (subpath ${sandboxString(capsuleRoot)}))`,
      "",
    ].join("\n");
    await writeFile(profile, policy, { encoding: "utf8", mode: 0o600 });
    return { binary: sandbox, args: ["-f", profile, binary, ...args] };
  }
  if (platform() === "linux") {
    const bubblewrap = await firstExecutable([
      "/usr/bin/bwrap",
      "/usr/local/bin/bwrap",
      "/bin/bwrap",
    ]);
    if (!bubblewrap) {
      throw new CliError("Linux research execution requires Bubblewrap.", {
        code: "RESEARCH_SANDBOX_UNAVAILABLE",
        exitCode: 3,
      });
    }
    const sandboxArgs = [
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      capsuleRoot,
      capsuleRoot,
      "--bind",
      join(capsuleRoot, "tmp"),
      "/tmp",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--chdir",
      projectRoot,
    ];
    if (await pathIsReadable(workspaceCredentialPath)) {
      sandboxArgs.push("--ro-bind", "/dev/null", workspaceCredentialPath);
    }
    sandboxArgs.push(binary, ...args);
    return {
      binary: bubblewrap,
      args: sandboxArgs,
    };
  }
  throw new CliError(`Unsupported research execution platform: ${platform()}`, {
    code: "RESEARCH_SANDBOX_UNAVAILABLE",
    exitCode: 3,
  });
}

async function pathIsReadable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function spawnCaptured(input: {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;

    const terminate = (): void => {
      if (!child.pid) return;
      try {
        if (platform() === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => terminate(), input.timeoutMs);
    const capture = (target: Buffer[], chunk: Buffer): void => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        terminate();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detail = signal ? `\nprocess terminated by ${signal}` : "";
      resolvePromise({
        exitCode: typeof code === "number" ? code : 70,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: `${Buffer.concat(stderr).toString("utf8")}${detail}`,
      });
    });
  });
}

function parseAgentResult(
  agent: AgentRoute["agent"],
  stdout: string,
  stderr: string,
): { stdout: string; stderr: string; tokens: number; costUsd: number; parseFailed: boolean } {
  if (agent === "codex") {
    let tokens = 0;
    const messages: string[] = [];
    let parsedEvents = 0;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        parsedEvents += 1;
        if (event.type === "turn.completed" && isRecord(event.usage)) {
          tokens = numeric(event.usage.input_tokens) + numeric(event.usage.output_tokens);
        }
        if (event.type === "item.completed" && isRecord(event.item)) {
          if (event.item.type === "agent_message" && typeof event.item.text === "string") {
            messages.push(event.item.text);
          }
        }
      } catch {
        continue;
      }
    }
    return {
      stdout: messages.length ? messages.join("\n") : stdout,
      stderr,
      tokens,
      costUsd: 0,
      parseFailed: parsedEvents === 0,
    };
  }
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const usage = isRecord(value.usage) ? value.usage : {};
    return {
      stdout: typeof value.result === "string" ? value.result : stdout,
      stderr,
      tokens:
        numeric(usage.input_tokens) +
        numeric(usage.output_tokens) +
        numeric(usage.cache_creation_input_tokens) +
        numeric(usage.cache_read_input_tokens),
      costUsd: numeric(value.total_cost_usd),
      parseFailed: false,
    };
  } catch {
    return { stdout, stderr, tokens: 0, costUsd: 0, parseFailed: true };
  }
}

function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  temporaryDirectory: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (!value || CREDENTIAL_ENV_NAME.test(name)) continue;
    environment[name] = value;
  }
  environment.HOME = homedir();
  environment.NO_COLOR = "1";
  environment.TMPDIR = temporaryDirectory;
  environment.TMP = temporaryDirectory;
  environment.TEMP = temporaryDirectory;
  return environment;
}

function configuredSecrets(source: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set(
      Object.entries(source)
        .filter(
          ([name, value]) =>
            CREDENTIAL_ENV_NAME.test(name) && typeof value === "string" && value.length >= 8,
        )
        .map(([, value]) => value as string),
    ),
  ].sort((left, right) => right.length - left.length);
}

function redactResult(
  stdout: string,
  stderr: string,
  secrets: string[],
): { stdout: string; stderr: string; exposed: boolean } {
  let safeStdout = stdout;
  let safeStderr = stderr;
  let exposed = false;
  for (const secret of secrets) {
    if (safeStdout.includes(secret) || safeStderr.includes(secret)) exposed = true;
    safeStdout = safeStdout.replaceAll(secret, "[REDACTED]");
    safeStderr = safeStderr.replaceAll(secret, "[REDACTED]");
  }
  return { stdout: safeStdout, stderr: safeStderr, exposed };
}

function validateAgentBinary(route: AgentRoute): void {
  if (!isAbsolute(route.binary) && route.binary !== route.agent) {
    throw new CliError(
      `Configured ${route.agent} binary must be absolute or exactly '${route.agent}'.`,
      {
        code: "RESEARCH_EXECUTOR_INVALID",
        exitCode: 2,
      },
    );
  }
}

async function requireExecutable(path: string, label: string): Promise<void> {
  try {
    await access(path, fsConstants.X_OK);
  } catch {
    throw new CliError(`${label} is unavailable: ${path}`, {
      code: "RESEARCH_SANDBOX_UNAVAILABLE",
      exitCode: 3,
    });
  }
}

async function firstExecutable(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function sandboxString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
