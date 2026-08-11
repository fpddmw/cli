import { closeSync, openSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { ReadStream as TtyReadStream } from "node:tty";

import { CliError } from "../../errors.js";
import type { CliIO, Output } from "../../io.js";
import { stringifyJson, write } from "../../io.js";
import { parseStrictArgs, strictBoolean, strictString } from "../../strict-args.js";
import {
  EXTERNAL_SKILL_CONTEXT_PROFILE,
  EXTERNAL_SKILL_MEDIA_PROFILE,
  EXTERNAL_SKILL_PROFILE,
} from "./external-skills.js";
import {
  RESEARCH_SETUP_CREDENTIALS,
  RESEARCH_SETUP_INSTALLER,
  RESEARCH_SETUP_SELECTION_GUIDANCE,
  RESEARCH_SETUP_SETTINGS,
  RESEARCH_SETUP_SKILLS,
  resolveSetupSkills,
  setupSource,
  setupTargetRoot,
  type ResearchSetupAgent,
  type ResearchSetupScope,
} from "./setup-catalog.js";
import {
  applyResearchSetupPlan,
  createResearchSetupPlan,
  inspectResearchSetupStatus,
  resolveResearchSetupWorkspacePath,
  type ResearchSetupAgentRoutePlan,
  type ResearchSetupEvidenceProfile,
} from "./setup.js";
import { pathExists, workspacePaths } from "./storage.js";
import type { AgentPricing, ResearchMode } from "./types.js";

export interface ResearchSetupWizardPrompt {
  note(message: string, tone?: ResearchSetupWizardNoteTone): void;
  input(message: string, defaultValue?: string): Promise<string>;
  secret(message: string): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  select<T extends string>(
    message: string,
    choices: ReadonlyArray<{ value: T; label: string }>,
    defaultValue: T,
  ): Promise<T>;
  multiSelect<T extends string>(
    message: string,
    choices: ReadonlyArray<{ value: T; label: string }>,
    defaultValues: readonly T[],
  ): Promise<T[]>;
  close(): void;
}

export type ResearchSetupWizardNoteTone =
  | "brand"
  | "section"
  | "info"
  | "warning"
  | "success"
  | "summary";

export interface ResearchSetupWizardTheme {
  readonly color: boolean;
  brand(text: string): string;
  heading(text: string): string;
  accent(text: string): string;
  muted(text: string): string;
  success(text: string): string;
  warning(text: string): string;
}

export function shouldUseResearchSetupWizardColor(input: {
  outputIsTTY: boolean;
  json: boolean;
  environment: NodeJS.ProcessEnv;
}): boolean {
  return (
    input.outputIsTTY &&
    !input.json &&
    input.environment.NO_COLOR === undefined &&
    input.environment.TERM !== "dumb"
  );
}

export function createResearchSetupWizardTheme(color: boolean): ResearchSetupWizardTheme {
  const style = (code: string, text: string) => (color ? `\u001B[${code}m${text}\u001B[0m` : text);
  return {
    color,
    brand: (text) => style("1;36", text),
    heading: (text) => style("1;34", text),
    accent: (text) => style("36", text),
    muted: (text) => style("2", text),
    success: (text) => style("1;32", text),
    warning: (text) => style("1;33", text),
  };
}

export function formatResearchSetupWizardNote(
  message: string,
  tone: ResearchSetupWizardNoteTone,
  theme: ResearchSetupWizardTheme,
): string {
  const [first = "", ...rest] = message.split("\n");
  const glyph = {
    brand: "◆",
    section: "◆",
    info: "›",
    warning: "!",
    success: "✓",
    summary: "◇",
  }[tone];
  const styledGlyph =
    tone === "warning"
      ? theme.warning(glyph)
      : tone === "success"
        ? theme.success(glyph)
        : theme.accent(glyph);
  const styledFirst =
    tone === "brand"
      ? theme.brand(first)
      : tone === "warning"
        ? theme.warning(first)
        : tone === "success"
          ? theme.success(first)
          : theme.heading(first);
  const body = rest.length ? `\n${rest.map((line) => `  ${line}`).join("\n")}` : "";
  return `\n${styledGlyph} ${styledFirst}${body}\n`;
}

const DEFAULT_CREDENTIAL_ENVIRONMENT: Record<string, string> = {
  "brave.search.api-key": "BRAVE_API_KEY",
  "tiangong.sci.api-key": "TIANGONG_SCI_APIKEY",
  "tiangong.unstructure.auth-token": "UNSTRUCTURED_AUTH_TOKEN",
  "semantic-scholar.api-key": "SEMANTIC_SCHOLAR_API_KEY",
};

const MAX_CREDENTIAL_STDIN_BYTES = 64 * 1024;

function credentialStdinIds(value: string | undefined): string[] {
  if (!value) return [];
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids.length || new Set(ids).size !== ids.length) {
    throw wizardStdinError("--credential-stdin requires unique logical credential IDs.");
  }
  const known = new Set(RESEARCH_SETUP_CREDENTIALS.map((credential) => credential.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    throw wizardStdinError(`Unknown logical credential IDs: ${unknown.join(", ")}.`);
  }
  return ids;
}

export async function readResearchSetupCredentialStdin(
  input: (NodeJS.ReadableStream & { isTTY?: boolean | undefined }) | undefined,
  credentialIds: readonly string[],
): Promise<Record<string, string>> {
  if (!input || input.isTTY) {
    throw wizardStdinError("Credential stdin requires a non-interactive input pipe.");
  }
  let totalBytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of input as NodeJS.ReadableStream &
    AsyncIterable<Buffer | Uint8Array | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_CREDENTIAL_STDIN_BYTES) {
      throw wizardStdinError("Credential stdin exceeds the supported bounded input size.");
    }
    chunks.push(buffer);
  }
  const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  if (lines.length !== credentialIds.length) {
    throw wizardStdinError(
      `Credential stdin must contain exactly one line for each of ${credentialIds.length} listed logical credential IDs.`,
    );
  }
  const result: Record<string, string> = {};
  for (const [index, credentialId] of credentialIds.entries()) {
    const value = lines[index]?.trim() ?? "";
    const definition = RESEARCH_SETUP_CREDENTIALS.find(
      (credential) => credential.id === credentialId,
    )!;
    if (Buffer.byteLength(value, "utf8") < definition.minimumUtf8Bytes) {
      clearCredentialRecord(result);
      throw wizardStdinError(
        `Credential stdin value for ${credentialId} is absent or does not meet the provider minimum.`,
      );
    }
    result[credentialId] = value;
  }
  return result;
}

function openResearchSetupControllingTerminal(): {
  input: NodeJS.ReadableStream & { isTTY: boolean };
  close(): void;
} {
  let descriptor: number;
  try {
    descriptor = openSync(process.platform === "win32" ? "CONIN$" : "/dev/tty", "r");
  } catch {
    throw wizardStdinError(
      "A controlling terminal is required when credential values are piped to the Wizard.",
    );
  }
  const input = new TtyReadStream(descriptor);
  return {
    input,
    close: () => {
      try {
        if (input.isRaw) input.setRawMode(false);
        input.destroy();
        closeSync(descriptor);
      } catch {
        // Best-effort terminal cleanup after readline has already closed.
      }
    },
  };
}

function clearCredentialRecord(record: Readonly<Record<string, string>>): void {
  const mutable = record as Record<string, string>;
  for (const id of Object.keys(mutable)) {
    mutable[id] = "";
    delete mutable[id];
  }
}

export async function runResearchSetupWizard(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    {
      help: "boolean",
      json: "boolean",
      workspace: "string",
      "credential-stdin": "string",
    },
    "research setup wizard",
  );
  if (strictBoolean(args, "help")) {
    write(
      io.stdout,
      "Usage: tiangong-ai research setup [--workspace <absolute-path>] [--credential-stdin <logical-id[,logical-id...]>] [--json]\n",
    );
    return 0;
  }
  if (args.positionals.length) {
    throw new CliError("research setup Wizard does not accept positional arguments.", {
      code: "INVALID_ARGS",
      exitCode: 2,
    });
  }
  const stdinCredentialIds = credentialStdinIds(strictString(args, "credential-stdin"));
  if (!stdinCredentialIds.length && !io.stdin?.isTTY) {
    throw new CliError("Interactive research setup requires a TTY.", {
      code: "RESEARCH_SETUP_TTY_REQUIRED",
      exitCode: 2,
      details: {
        step: "wizard",
        reason: "No interactive terminal is attached.",
        minimumAction:
          "Run the Wizard in a terminal, or use research setup catalog/plan/apply for automation.",
        retryCommand: "tiangong-ai research setup --help",
      },
    });
  }
  if (stdinCredentialIds.length && io.stdin?.isTTY) {
    throw wizardStdinError(
      "--credential-stdin requires a non-interactive pipe; use secure input for a terminal value.",
    );
  }
  const stdinCredentials = stdinCredentialIds.length
    ? await readResearchSetupCredentialStdin(io.stdin, stdinCredentialIds)
    : {};
  const controllingTerminal = stdinCredentialIds.length
    ? openResearchSetupControllingTerminal()
    : null;
  const interactiveInput = controllingTerminal?.input ?? io.stdin!;
  const json = strictBoolean(args, "json");
  const prompt = new TextResearchSetupWizardPrompt(
    interactiveInput,
    io.stderr,
    createResearchSetupWizardTheme(
      shouldUseResearchSetupWizardColor({
        outputIsTTY: Boolean((io.stderr as Output & { isTTY?: boolean }).isTTY),
        json,
        environment: io.env,
      }),
    ),
  );
  try {
    const workspace = strictString(args, "workspace");
    const result = await executeResearchSetupWizard({
      ...(workspace === undefined ? {} : { workspace }),
      environment: io.env,
      prompt,
      stdinCredentials,
    });
    write(io.stdout, stringifyJson(result.value, json));
    return result.exitCode;
  } finally {
    prompt.close();
    controllingTerminal?.close();
    clearCredentialRecord(stdinCredentials);
  }
}

export async function promptResearchSetupCredentialValue(
  io: CliIO,
  credentialId: string,
  json: boolean,
): Promise<string> {
  if (!io.stdin?.isTTY) {
    throw new CliError("Secure credential input requires a TTY.", {
      code: "RESEARCH_SETUP_TTY_REQUIRED",
      exitCode: 2,
      details: {
        step: "credentials",
        minimumAction: "Run with --prompt in a terminal, or pipe the value with --from-stdin.",
      },
    });
  }
  const prompt = new TextResearchSetupWizardPrompt(
    io.stdin,
    io.stderr,
    createResearchSetupWizardTheme(
      shouldUseResearchSetupWizardColor({
        outputIsTTY: Boolean((io.stderr as Output & { isTTY?: boolean }).isTTY),
        json,
        environment: io.env,
      }),
    ),
  );
  try {
    return await prompt.secret(`Secure value for ${credentialId} (input hidden)`);
  } finally {
    prompt.close();
  }
}

export async function executeResearchSetupWizard(input: {
  workspace?: string;
  environment: NodeJS.ProcessEnv;
  prompt: ResearchSetupWizardPrompt;
  stdinCredentials?: Readonly<Record<string, string>>;
}): Promise<{ exitCode: number; value: unknown }> {
  const { prompt } = input;
  prompt.note(
    [
      "Tiangong Auto Research setup",
      "No Skill is bundled or installed until you review the exact plan and confirm it.",
      "Credentials may be entered securely, read from an owner environment variable, or preloaded from stdin. Values are never displayed or written to the plan.",
    ].join("\n"),
    "brand",
  );

  prompt.note("1. Workspace", "section");
  const defaultWorkspace = resolve(input.workspace ?? process.cwd());
  const workspaceInput = await prompt.input("Absolute workspace directory", defaultWorkspace);
  if (!isAbsolute(workspaceInput)) {
    throw wizardError("Workspace must be an absolute path.", "workspace");
  }
  const requestedWorkspace = resolve(workspaceInput);
  const existingInfo = await lstat(requestedWorkspace).catch(() => undefined);
  let createWorkspaceDirectory = false;
  if (!existingInfo) {
    createWorkspaceDirectory = await prompt.confirm(
      `Directory does not exist. Create exactly ${requestedWorkspace}?`,
      false,
    );
    if (!createWorkspaceDirectory) throw wizardCancelled("workspace");
  } else if (!existingInfo.isDirectory() || existingInfo.isSymbolicLink()) {
    throw wizardError("Workspace must be a regular non-symlink directory.", "workspace");
  }
  const workspace = await resolveResearchSetupWorkspacePath(requestedWorkspace, {
    allowMissingLeaf: createWorkspaceDirectory,
  });
  if (workspace !== requestedWorkspace) {
    prompt.note(
      `Resolved workspace path for the reviewed plan:\n${requestedWorkspace}\n→ ${workspace}`,
      "info",
    );
  }

  if (existingInfo && (await pathExists(workspacePaths(workspace).setupPlan))) {
    prompt.note(
      "Existing plans are immutable. Choose replacement after a reviewed catalog update; do not edit a plan in place.",
      "warning",
    );
    const existingAction = await prompt.select(
      "An immutable setup plan already exists",
      [
        { value: "status", label: "Inspect status and stop" },
        { value: "apply", label: "Apply/resume the existing plan" },
        { value: "replace", label: "Create an explicitly reviewed replacement plan" },
        { value: "cancel", label: "Cancel" },
      ] as const,
      "status",
    );
    if (existingAction === "status") {
      return {
        exitCode: 0,
        value: await inspectResearchSetupStatus(workspace, input.environment),
      };
    }
    if (existingAction === "apply") {
      const value = await applyResearchSetupPlan(workspacePaths(workspace).setupPlan, {
        environment: input.environment,
      });
      return { exitCode: value.state.status === "blocked" ? 3 : 0, value };
    }
    if (existingAction === "cancel") throw wizardCancelled("resume");
  }

  prompt.note("2. Research scope and evidence", "section");
  const mode = await prompt.select<ResearchMode>(
    "Research mode",
    [
      {
        value: "production-research",
        label: "Production research (requires public-internet evidence)",
      },
      { value: "smoke-test", label: "Smoke test (low-cost workflow validation)" },
    ],
    "production-research",
  );
  const producerAgent = await prompt.select<"codex" | "claude">(
    "Current native research host",
    [
      {
        value: "codex",
        label: "Codex app/session (research here; Claude Code reviews independently)",
      },
      {
        value: "claude",
        label: "Claude Code interactive session (research here; Codex CLI reviews independently)",
      },
    ],
    "codex",
  );
  const evidenceChoices: Array<{ value: ResearchSetupEvidenceProfile; label: string }> = [
    { value: EXTERNAL_SKILL_PROFILE, label: "Brave web + news (recommended baseline)" },
    {
      value: EXTERNAL_SKILL_CONTEXT_PROFILE,
      label: "Brave web + news + bounded context (requires provider plan support)",
    },
    {
      value: EXTERNAL_SKILL_MEDIA_PROFILE,
      label: "Brave context + image/video discovery (subscription-dependent)",
    },
  ];
  if (mode === "smoke-test") {
    evidenceChoices.push({ value: "none", label: "No public internet (smoke test only)" });
  }
  const evidenceProfile = await prompt.select(
    "Independent public-internet evidence profile",
    evidenceChoices,
    EXTERNAL_SKILL_PROFILE,
  );

  const includeOrchestrator = await prompt.confirm(
    "Install the tiangong-auto-research orchestrator so ordinary research requests route into this workspace workflow?",
    true,
  );

  const companionChoices = RESEARCH_SETUP_SKILLS.filter(
    (skill) =>
      skill.sourceId === "tiangong-ai-skills" &&
      skill.role !== "orchestrator" &&
      skill.role !== "post-closure-authoring",
  ).map((skill) => ({ value: skill.id, label: `${skill.skillName} — ${skill.purpose}` }));
  const companionIds = await prompt.multiSelect(
    "Optional Tiangong companion Skills (explicit selection)",
    companionChoices,
    companionChoices
      .map((choice) => RESEARCH_SETUP_SKILLS.find((skill) => skill.id === choice.value)!)
      .filter((skill) => skill.defaultSelected)
      .map((skill) => skill.id),
  );

  let authoringIds: string[] = [];
  if (
    await prompt.confirm(
      "Review optional post-closure authoring Skills? They do not become research evidence capabilities.",
      false,
    )
  ) {
    const choices = RESEARCH_SETUP_SKILLS.filter((skill) => skill.role === "post-closure-authoring")
      .sort(
        (left, right) =>
          postClosureAuthoringRank(left.id) - postClosureAuthoringRank(right.id) ||
          left.skillName.localeCompare(right.skillName),
      )
      .map((skill) => ({ value: skill.id, label: `${skill.skillName} — ${skill.purpose}` }));
    authoringIds = await prompt.multiSelect("Post-closure authoring Skills", choices, []);
  }
  const explicitSkillIds = [
    ...new Set([
      ...(includeOrchestrator ? ["tiangong.auto-research"] : []),
      ...companionIds,
      ...authoringIds,
    ]),
  ];
  const profileSkillIds = evidenceProfileSkillIds(evidenceProfile);
  const selected = resolveSetupSkills([...profileSkillIds, ...explicitSkillIds]);

  prompt.note("3. Installation targets", "section");
  const evidenceSelected = selected.some((skill) => skill.role === "evidence-capability");
  const producerTarget = producerAgent === "codex" ? "codex" : "claude-code";
  const installChoices = evidenceSelected
    ? producerAgent === "claude"
      ? [{ value: "both", label: "Codex capabilities + Claude Code orchestrator (required)" }]
      : [
          { value: "codex", label: "Codex only (.agents/skills)" },
          { value: "both", label: "Codex and Claude Code (two copied trees)" },
        ]
    : [
        {
          value: producerTarget,
          label:
            producerTarget === "codex"
              ? "Codex only (.agents/skills)"
              : "Claude Code only (.claude/skills)",
        },
        { value: "both", label: "Codex and Claude Code" },
      ];
  const agentChoice = await prompt.select(
    "Install targets",
    installChoices,
    evidenceSelected && producerAgent === "claude" ? "both" : producerTarget,
  );
  const agents: ResearchSetupAgent[] =
    agentChoice === "both" ? ["codex", "claude-code"] : [agentChoice as ResearchSetupAgent];
  const scope = await prompt.select<ResearchSetupScope>(
    "Installation scope",
    [
      { value: "project", label: "Project-local copy (recommended, auditable)" },
      { value: "global", label: "Global copy (affects other workspaces)" },
    ],
    "project",
  );
  let confirmGlobalMutation = false;
  if (scope === "global") {
    prompt.note(
      `Global targets:\n${agents
        .map(
          (agent) =>
            `  ${agent}: ${setupTargetRoot({ workspace, scope, agent, environment: input.environment })}`,
        )
        .join("\n")}`,
      "info",
    );
    confirmGlobalMutation = await prompt.confirm(
      "I understand this writes outside the workspace",
      false,
    );
    if (!confirmGlobalMutation) throw wizardCancelled("global-confirmation");
  }

  prompt.note("4. Configuration and licenses", "section");
  const settings = await collectSettings(
    selected.map((skill) => skill.id),
    prompt,
  );
  const credentials = await collectCredentialSources(
    selected.map((skill) => skill.id),
    input.environment,
    input.stdinCredentials ?? {},
    prompt,
  );
  try {
    const acceptedLicenseIds = await collectLicenseAcceptances(
      selected.map((skill) => skill.id),
      prompt,
    );
    const agentRoutes = await collectAgentRoutes(prompt, producerAgent);

    prompt.note("5. Verification options", "section");
    const liveChecks = await prompt.confirm(
      "Run live provider checks after installation? This uses network/quota but does not run model agents.",
      false,
    );
    const allowSyntheticUnstructureUpload =
      liveChecks && selected.some((skill) => skill.id === "tiangong.document-granular-decompose")
        ? await prompt.confirm(
            "Authorize upload of a generated one-page PDF to the configured Unstructure service?",
            false,
          )
        : false;
    const agentSmoke = await prompt.confirm(
      "Run the independent reviewer CLI smoke after installation? This may consume paid model quota.",
      false,
    );
    const confirmAgentSmokeCost = agentSmoke
      ? await prompt.confirm("I explicitly authorize the agent smoke-check cost", false)
      : false;
    if (agentSmoke && !confirmAgentSmokeCost) throw wizardCancelled("agent-smoke-confirmation");

    const missingRequiredCredentialIds = requiredCredentialIds(
      selected.map((skill) => skill.id).filter(Boolean),
    ).filter((id) => !credentials.environmentBindings[id]);
    const preview = {
      workspace,
      createWorkspaceDirectory,
      mode,
      evidenceProfile,
      selectedSkillIds: selected.map((skill) => skill.id),
      install: {
        scope,
        agents,
        targets: agents.map((agent) => ({
          agent,
          root: setupTargetRoot({ workspace, scope, agent, environment: input.environment }),
        })),
      },
      installer: RESEARCH_SETUP_INSTALLER,
      sourcePins: [...new Set(selected.map((skill) => skill.sourceId))].map((sourceId) => {
        const source = setupSource(sourceId);
        return {
          id: source.id,
          locator: source.locator,
          immutableRef: source.immutableRef,
        };
      }),
      skillPins: selected.map((skill) => ({
        id: skill.id,
        role: skill.role,
        expectedTreeSha256: skill.expectedTreeSha256,
        licenseId: skill.license.id,
      })),
      acceptedLicenseIds,
      credentialSources: credentials.preview,
      missingRequiredCredentialIds,
      checks: { liveChecks, allowSyntheticUnstructureUpload, agentSmoke },
      networkDownloads: selected.length > 0,
    };
    prompt.note("6. Review and apply", "section");
    prompt.note(`Reviewed setup preview:\n${JSON.stringify(preview, null, 2)}`, "summary");
    const confirmNetworkDownloads =
      selected.length === 0 ||
      (await prompt.confirm(
        "Authorize downloads of only the displayed pinned npm package and git commits?",
        false,
      ));
    if (!confirmNetworkDownloads) throw wizardCancelled("network-confirmation");
    if (!(await prompt.confirm("Create this immutable setup plan?", false))) {
      throw wizardCancelled("plan-confirmation");
    }
    if (createWorkspaceDirectory) await mkdir(workspace);

    const replacePlan = await pathExists(workspacePaths(workspace).setupPlan);
    const plan = await createResearchSetupPlan({
      workspace,
      mode,
      evidenceProfile,
      skillIds: explicitSkillIds,
      scope,
      agents,
      acceptedLicenseIds,
      credentialEnvironment: credentials.environmentBindings,
      settings,
      agentRoutes,
      liveChecks,
      allowSyntheticUnstructureUpload,
      agentSmoke,
      confirmNetworkDownloads,
      confirmGlobalMutation,
      confirmAgentSmokeCost,
      replacePlan,
      environment: input.environment,
    });
    prompt.note(
      `Plan created: ${workspacePaths(workspace).setupPlan}\nSHA-256: ${plan.planSha256}`,
      "success",
    );

    if (missingRequiredCredentialIds.length) {
      prompt.note(
        `Apply is blocked until these required logical credentials are configured: ${missingRequiredCredentialIds.join(
          ", ",
        )}`,
        "warning",
      );
    } else if (credentials.hasTransientValues) {
      prompt.note(
        "Securely entered or stdin values exist only for this apply. Applying now stores them in the owner-only credential store before downloads; choosing no discards them.",
        "info",
      );
    }
    const applyNow = await prompt.confirm(
      missingRequiredCredentialIds.length
        ? "Apply now anyway? Preflight will stop before downloads because required credentials are absent."
        : "Apply the reviewed plan now?",
      missingRequiredCredentialIds.length === 0,
    );
    if (!applyNow) {
      return {
        exitCode: 0,
        value: {
          schemaVersion: 1,
          status: "planned",
          plan,
          next: credentials.hasTransientValues
            ? {
                minimumAction:
                  "Secure and stdin values were discarded. Configure those logical credentials again before apply.",
                credentialCommands: credentials.preview
                  .filter(
                    (credential) =>
                      credential.inputMethod === "secure-input" ||
                      credential.inputMethod === "stdin",
                  )
                  .map(
                    (credential) =>
                      `tiangong-ai research setup credential set --id ${credential.id} --prompt --workspace ${workspace} --json`,
                  ),
                applyCommand: `tiangong-ai research setup apply --plan ${workspacePaths(workspace).setupPlan} --json`,
              }
            : `tiangong-ai research setup apply --plan ${workspacePaths(workspace).setupPlan} --json`,
        },
      };
    }
    const value = await applyResearchSetupPlan(workspacePaths(workspace).setupPlan, {
      environment: credentials.applyEnvironment,
    });
    return { exitCode: value.state.status === "blocked" ? 3 : 0, value };
  } finally {
    credentials.clear();
  }
}

function postClosureAuthoringRank(skillId: string): number {
  const guidance = RESEARCH_SETUP_SELECTION_GUIDANCE.pptCreation;
  if (skillId === guidance.preferredSkillId) return 0;
  if ((guidance.situationalSkillIds as readonly string[]).includes(skillId)) return 1;
  return 2;
}

async function collectSettings(
  selectedSkillIds: string[],
  prompt: ResearchSetupWizardPrompt,
): Promise<Record<string, string>> {
  const selected = new Set(selectedSkillIds);
  const settings: Record<string, string> = {};
  for (const setting of RESEARCH_SETUP_SETTINGS.filter((item) =>
    item.requiredBy.some((skillId) => selected.has(skillId)),
  )) {
    const value = await prompt.input(
      `${setting.label}${setting.required ? " (required)" : " (optional; blank to omit)"}`,
      setting.defaultValue ?? "",
    );
    if (value.trim()) settings[setting.id] = value.trim();
  }
  return settings;
}

async function collectCredentialSources(
  selectedSkillIds: string[],
  environment: NodeJS.ProcessEnv,
  stdinCredentials: Readonly<Record<string, string>>,
  prompt: ResearchSetupWizardPrompt,
): Promise<{
  environmentBindings: Record<string, string>;
  applyEnvironment: NodeJS.ProcessEnv;
  preview: Array<{
    id: string;
    inputMethod: "secure-input" | "environment" | "stdin" | "skipped";
    environmentName?: string;
    configured: boolean;
  }>;
  hasTransientValues: boolean;
  clear(): void;
}> {
  const selected = new Set(selectedSkillIds);
  const preloadedStdinCredentials = { ...stdinCredentials };
  const definitions = RESEARCH_SETUP_CREDENTIALS.filter((item) =>
    item.requiredBy.some((skillId) => selected.has(skillId)),
  );
  const selectedCredentialIds = new Set(definitions.map((credential) => credential.id));
  const unexpectedStdinIds = Object.keys(preloadedStdinCredentials).filter(
    (id) => !selectedCredentialIds.has(id),
  );
  if (unexpectedStdinIds.length) {
    throw wizardStdinError(
      `Preloaded stdin credentials were not selected in this plan: ${unexpectedStdinIds.join(", ")}.`,
    );
  }
  const environmentBindings: Record<string, string> = {};
  const applyEnvironment: NodeJS.ProcessEnv = { ...environment };
  const transientEnvironmentNames: string[] = [];
  const preview: Array<{
    id: string;
    inputMethod: "secure-input" | "environment" | "stdin" | "skipped";
    environmentName?: string;
    configured: boolean;
  }> = [];
  for (const credential of definitions) {
    const defaultEnvironmentName = DEFAULT_CREDENTIAL_ENVIRONMENT[credential.id]!;
    const present =
      Buffer.byteLength(environment[defaultEnvironmentName] ?? "", "utf8") >=
      credential.minimumUtf8Bytes;
    prompt.note(
      `${credential.provider}\n  credential: ${credential.id}\n  obtain/configure: ${credential.obtainAt}\n  default environment: ${defaultEnvironmentName} (${present ? "present" : "not present"})`,
      present ? "info" : "warning",
    );
    for (;;) {
      const inputMethod = await prompt.select(
        `Credential source for ${credential.id}`,
        [
          { value: "secure-input", label: "Enter securely now (recommended)" },
          { value: "environment", label: "Read from an environment variable" },
          { value: "stdin", label: "Read from stdin / password manager" },
          { value: "skipped", label: "Skip for now" },
        ] as const,
        credential.required ? "secure-input" : "skipped",
      );
      if (inputMethod === "skipped") {
        preview.push({ id: credential.id, inputMethod, configured: false });
        break;
      }
      if (inputMethod === "environment") {
        const environmentName = (
          await prompt.input(
            `Environment variable name for ${credential.id} (never the secret value)`,
            defaultEnvironmentName,
          )
        ).trim();
        const value = environment[environmentName];
        if (
          !environmentName ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(environmentName) ||
          Buffer.byteLength(value ?? "", "utf8") < credential.minimumUtf8Bytes
        ) {
          prompt.note(
            "The named environment variable is absent or does not meet the provider minimum. Choose another source or skip explicitly.",
            "warning",
          );
          continue;
        }
        environmentBindings[credential.id] = environmentName;
        preview.push({
          id: credential.id,
          inputMethod,
          environmentName,
          configured: true,
        });
        break;
      }
      const value =
        inputMethod === "secure-input"
          ? await prompt.secret(`Secure value for ${credential.id} (input hidden)`)
          : preloadedStdinCredentials[credential.id];
      if (inputMethod === "stdin" && value === undefined) {
        prompt.note(
          `No stdin value was preloaded for ${credential.id}. Restart with --credential-stdin ${credential.id} and pipe one value line, or choose secure input.`,
          "warning",
        );
        continue;
      }
      if (Buffer.byteLength(value ?? "", "utf8") < credential.minimumUtf8Bytes) {
        prompt.note(
          "The credential is absent or does not meet the selected provider minimum; no part of it was retained or displayed.",
          "warning",
        );
        continue;
      }
      const transientName = transientCredentialEnvironmentName(credential.id, inputMethod);
      environmentBindings[credential.id] = transientName;
      applyEnvironment[transientName] = value;
      transientEnvironmentNames.push(transientName);
      preview.push({ id: credential.id, inputMethod, configured: true });
      break;
    }
  }
  return {
    environmentBindings,
    applyEnvironment,
    preview,
    hasTransientValues: transientEnvironmentNames.length > 0,
    clear: () => {
      for (const name of transientEnvironmentNames) {
        applyEnvironment[name] = "";
        delete applyEnvironment[name];
      }
      clearCredentialRecord(preloadedStdinCredentials);
    },
  };
}

function transientCredentialEnvironmentName(
  credentialId: string,
  inputMethod: "secure-input" | "stdin",
): string {
  const logical = credentialId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  const source = inputMethod === "secure-input" ? "SECURE_INPUT" : "STDIN";
  return `TIANGONG_RESEARCH_SETUP_${source}_${logical}`.slice(0, 128);
}

async function collectLicenseAcceptances(
  selectedSkillIds: string[],
  prompt: ResearchSetupWizardPrompt,
): Promise<string[]> {
  const selected = resolveSetupSkills(selectedSkillIds);
  const groups = new Map<
    string,
    { label: string; url: string; notice: string; skillIds: string[] }
  >();
  for (const skill of selected) {
    const group = groups.get(skill.license.id) ?? {
      label: skill.license.label,
      url: skill.license.url,
      notice: skill.license.notice,
      skillIds: [],
    };
    group.skillIds.push(skill.id);
    groups.set(skill.license.id, group);
  }
  const accepted: string[] = [];
  for (const [licenseId, group] of groups) {
    prompt.note(
      `License review\n  Skills: ${group.skillIds.join(", ")}\n  License: ${group.label}\n  URL: ${group.url}\n  Notice: ${group.notice}`,
      "section",
    );
    if (
      !(await prompt.confirm(`I reviewed and accept ${licenseId} for these selected Skills`, false))
    ) {
      throw wizardCancelled("license");
    }
    accepted.push(licenseId);
  }
  return accepted;
}

async function collectAgentRoutes(
  prompt: ResearchSetupWizardPrompt,
  producerAgent: "codex" | "claude",
): Promise<Partial<ResearchSetupAgentRoutePlan>> {
  const reviewerAgent = producerAgent === "codex" ? "claude" : "codex";
  if (!(await prompt.confirm("Configure exact native-producer/reviewer model IDs now?", false))) {
    return { producerAgent, reviewerAgent };
  }
  const producerModel = (await prompt.input("Producer model ID (blank to defer)", "")).trim();
  const reviewerModel = (await prompt.input("Reviewer model ID (blank to defer)", "")).trim();
  let producerPricing: AgentPricing | undefined;
  let reviewerPricing: AgentPricing | undefined;
  if (await prompt.confirm("Record reviewed per-million-token prices now?", false)) {
    producerPricing = await collectPricing("Producer", prompt);
    reviewerPricing = await collectPricing("Reviewer", prompt);
  }
  return {
    producerAgent,
    reviewerAgent,
    ...(producerModel ? { producerModel } : {}),
    ...(reviewerModel ? { reviewerModel } : {}),
    ...(producerPricing ? { producerPricing } : {}),
    ...(reviewerPricing ? { reviewerPricing } : {}),
  };
}

async function collectPricing(
  label: string,
  prompt: ResearchSetupWizardPrompt,
): Promise<AgentPricing> {
  const raw = await prompt.input(
    `${label} prices as input,cached-input,output USD per million tokens`,
  );
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw wizardError("Pricing requires exactly three finite non-negative numbers.", "agent-route");
  }
  return {
    inputUsdPerMillionTokens: values[0]!,
    cachedInputUsdPerMillionTokens: values[1]!,
    outputUsdPerMillionTokens: values[2]!,
  };
}

function evidenceProfileSkillIds(profile: ResearchSetupEvidenceProfile): string[] {
  if (profile === "none") return [];
  if (profile === EXTERNAL_SKILL_PROFILE) return ["brave.web-search", "brave.news-search"];
  if (profile === EXTERNAL_SKILL_CONTEXT_PROFILE) {
    return ["brave.web-search", "brave.news-search", "brave.llm-context"];
  }
  return [
    "brave.web-search",
    "brave.news-search",
    "brave.llm-context",
    "brave.images-search",
    "brave.videos-search",
  ];
}

function requiredCredentialIds(selectedSkillIds: string[]): string[] {
  const selected = new Set(selectedSkillIds);
  return RESEARCH_SETUP_CREDENTIALS.filter(
    (credential) =>
      credential.required && credential.requiredBy.some((skillId) => selected.has(skillId)),
  ).map((credential) => credential.id);
}

class ResearchSetupReadlineOutput extends Writable {
  readonly isTTY = true;
  readonly columns = 80;
  muted = false;

  constructor(readonly target: Output) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) write(this.target, chunk.toString());
    callback();
  }
}

class TextResearchSetupWizardPrompt implements ResearchSetupWizardPrompt {
  readonly #readline: Interface;
  readonly #readlineOutput: ResearchSetupReadlineOutput;
  readonly #output: Output;
  readonly #theme: ResearchSetupWizardTheme;

  constructor(input: NodeJS.ReadableStream, output: Output, theme: ResearchSetupWizardTheme) {
    this.#output = output;
    this.#theme = theme;
    this.#readlineOutput = new ResearchSetupReadlineOutput(output);
    this.#readline = createInterface({
      input,
      output: this.#readlineOutput,
      terminal: true,
    });
  }

  note(message: string, tone: ResearchSetupWizardNoteTone = "info"): void {
    write(this.#output, formatResearchSetupWizardNote(message, tone, this.#theme));
  }

  async input(message: string, defaultValue = ""): Promise<string> {
    const suffix = defaultValue ? this.#theme.muted(` [${defaultValue}]`) : "";
    const question = `${this.#theme.accent("?")} ${this.#theme.heading(message)}${suffix}: `;
    const answer = (await this.#readline.question(question)).trim();
    return answer || defaultValue;
  }

  async secret(message: string): Promise<string> {
    const question = `${this.#theme.accent("?")} ${this.#theme.heading(message)}: `;
    write(this.#output, question);
    this.#readlineOutput.muted = true;
    try {
      return (await this.#readline.question("")).trim();
    } finally {
      this.#readlineOutput.muted = false;
      write(this.#output, "\n");
    }
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    const suffix = this.#theme.muted(defaultValue ? " [Y/n]" : " [y/N]");
    for (;;) {
      const question = `${this.#theme.accent("?")} ${this.#theme.heading(message)}${suffix}: `;
      const answer = (await this.#readline.question(question)).trim().toLowerCase();
      if (!answer) return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      this.note("Enter y or n.", "warning");
    }
  }

  async select<T extends string>(
    message: string,
    choices: ReadonlyArray<{ value: T; label: string }>,
    defaultValue: T,
  ): Promise<T> {
    this.note(
      `${message}:\n${choices
        .map(
          (choice, index) =>
            `  ${this.#theme.accent(`${index + 1}.`)} ${choice.label}${
              choice.value === defaultValue ? this.#theme.success(" [default]") : ""
            }`,
        )
        .join("\n")}`,
      "section",
    );
    for (;;) {
      const answer = await this.input("Choose one", "");
      if (!answer) return defaultValue;
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && choices[index]) return choices[index]!.value;
      const byValue = choices.find((choice) => choice.value === answer);
      if (byValue) return byValue.value;
      this.note("Enter one displayed number or exact value.", "warning");
    }
  }

  async multiSelect<T extends string>(
    message: string,
    choices: ReadonlyArray<{ value: T; label: string }>,
    defaultValues: readonly T[],
  ): Promise<T[]> {
    this.note(
      `${message}:\n${choices
        .map(
          (choice, index) =>
            `  ${this.#theme.accent(`${index + 1}.`)} ${choice.label}${
              defaultValues.includes(choice.value) ? this.#theme.success(" [default]") : ""
            }`,
        )
        .join("\n")}`,
      "section",
    );
    for (;;) {
      const answer = await this.input(
        "Choose comma-separated numbers; enter none for an empty selection",
        "",
      );
      if (!answer) return [...defaultValues];
      if (answer.toLowerCase() === "none") return [];
      const indexes = answer.split(",").map((value) => Number(value.trim()) - 1);
      if (
        indexes.every((index) => Number.isInteger(index) && choices[index]) &&
        new Set(indexes).size === indexes.length
      ) {
        return indexes.map((index) => choices[index]!.value);
      }
      this.note("Enter unique displayed numbers separated by commas, or none.", "warning");
    }
  }

  close(): void {
    this.#readline.close();
  }
}

function wizardCancelled(step: string): CliError {
  return new CliError("Research setup was cancelled without applying unreviewed changes.", {
    code: "RESEARCH_SETUP_CANCELLED",
    exitCode: 3,
    details: {
      step,
      minimumAction: "Restart the Wizard when you are ready, or use setup plan for automation.",
    },
  });
}

function wizardError(message: string, step: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_SETUP_WIZARD_INVALID",
    exitCode: 2,
    details: { step, minimumAction: "Correct the displayed value and restart the Wizard." },
  });
}

function wizardStdinError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_SETUP_CREDENTIAL_STDIN_INVALID",
    exitCode: 2,
    details: {
      step: "credentials",
      minimumAction:
        "Use secure Wizard input, a named owner environment variable, or pipe one bounded line per explicitly listed logical credential ID.",
    },
  });
}
