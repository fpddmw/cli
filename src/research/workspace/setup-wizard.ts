import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";

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
  type ResearchSetupAgentRoutePlan,
  type ResearchSetupEvidenceProfile,
} from "./setup.js";
import { pathExists, workspacePaths } from "./storage.js";
import type { AgentPricing, ResearchMode } from "./types.js";

export interface ResearchSetupWizardPrompt {
  note(message: string): void;
  input(message: string, defaultValue?: string): Promise<string>;
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

const DEFAULT_CREDENTIAL_ENVIRONMENT: Record<string, string> = {
  "brave.search.api-key": "BRAVE_API_KEY",
  "tiangong.sci.api-key": "TIANGONG_SCI_APIKEY",
  "tiangong.unstructure.auth-token": "UNSTRUCTURED_AUTH_TOKEN",
  "semantic-scholar.api-key": "SEMANTIC_SCHOLAR_API_KEY",
};

export async function runResearchSetupWizard(argv: string[], io: CliIO): Promise<number> {
  const args = parseStrictArgs(
    argv,
    { help: "boolean", json: "boolean", workspace: "string" },
    "research setup wizard",
  );
  if (strictBoolean(args, "help")) {
    write(io.stdout, "Usage: tiangong-ai research setup [--workspace <absolute-path>] [--json]\n");
    return 0;
  }
  if (args.positionals.length) {
    throw new CliError("research setup Wizard does not accept positional arguments.", {
      code: "INVALID_ARGS",
      exitCode: 2,
    });
  }
  if (!io.stdin?.isTTY) {
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
  const prompt = new TextResearchSetupWizardPrompt(io.stdin, io.stderr);
  try {
    const workspace = strictString(args, "workspace");
    const result = await executeResearchSetupWizard({
      ...(workspace === undefined ? {} : { workspace }),
      environment: io.env,
      prompt,
    });
    write(io.stdout, stringifyJson(result.value, strictBoolean(args, "json")));
    return result.exitCode;
  } finally {
    prompt.close();
  }
}

export async function executeResearchSetupWizard(input: {
  workspace?: string;
  environment: NodeJS.ProcessEnv;
  prompt: ResearchSetupWizardPrompt;
}): Promise<{ exitCode: number; value: unknown }> {
  const { prompt } = input;
  prompt.note(
    [
      "Tiangong Auto Research setup",
      "No Skill is bundled or installed until you review the exact plan and confirm it.",
      "Credentials are read only from owner environment variables; their values are never displayed.",
    ].join("\n"),
  );

  const defaultWorkspace = resolve(input.workspace ?? process.cwd());
  const workspaceInput = await prompt.input("Absolute workspace directory", defaultWorkspace);
  if (!isAbsolute(workspaceInput)) {
    throw wizardError("Workspace must be an absolute path.", "workspace");
  }
  const workspace = resolve(workspaceInput);
  const existingInfo = await lstat(workspace).catch(() => undefined);
  let createWorkspaceDirectory = false;
  if (!existingInfo) {
    createWorkspaceDirectory = await prompt.confirm(
      `Directory does not exist. Create exactly ${workspace}?`,
      false,
    );
    if (!createWorkspaceDirectory) throw wizardCancelled("workspace");
  } else if (!existingInfo.isDirectory() || existingInfo.isSymbolicLink()) {
    throw wizardError("Workspace must be a regular non-symlink directory.", "workspace");
  }

  if (existingInfo && (await pathExists(workspacePaths(workspace).setupPlan))) {
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
  const evidenceChoices: Array<{ value: ResearchSetupEvidenceProfile; label: string }> = [
    {
      value: EXTERNAL_SKILL_CONTEXT_PROFILE,
      label: "Brave web + news + bounded full-text context (recommended)",
    },
    { value: EXTERNAL_SKILL_PROFILE, label: "Brave web + news" },
    {
      value: EXTERNAL_SKILL_MEDIA_PROFILE,
      label: "Brave context + image/video discovery",
    },
  ];
  if (mode === "smoke-test") {
    evidenceChoices.push({ value: "none", label: "No public internet (smoke test only)" });
  }
  const evidenceProfile = await prompt.select(
    "Independent public-internet evidence profile",
    evidenceChoices,
    EXTERNAL_SKILL_CONTEXT_PROFILE,
  );

  const companionChoices = RESEARCH_SETUP_SKILLS.filter(
    (skill) => skill.sourceId === "tiangong-ai-skills" && skill.role !== "post-closure-authoring",
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
    const choices = RESEARCH_SETUP_SKILLS.filter(
      (skill) => skill.role === "post-closure-authoring",
    ).map((skill) => ({ value: skill.id, label: `${skill.skillName} — ${skill.purpose}` }));
    authoringIds = await prompt.multiSelect("Post-closure authoring Skills", choices, []);
  }
  const explicitSkillIds = [...new Set([...companionIds, ...authoringIds])];
  const profileSkillIds = evidenceProfileSkillIds(evidenceProfile);
  const selected = resolveSetupSkills([...profileSkillIds, ...explicitSkillIds]);

  const evidenceSelected = selected.some((skill) => skill.role === "evidence-capability");
  const agentChoice = await prompt.select(
    "Install targets",
    evidenceSelected
      ? [
          { value: "codex", label: "Codex only (.agents/skills)" },
          { value: "both", label: "Codex and Claude Code (two copied trees)" },
        ]
      : [
          { value: "codex", label: "Codex only (.agents/skills)" },
          { value: "claude-code", label: "Claude Code only (.claude/skills)" },
          { value: "both", label: "Codex and Claude Code" },
        ],
    "codex",
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
    );
    confirmGlobalMutation = await prompt.confirm(
      "I understand this writes outside the workspace",
      false,
    );
    if (!confirmGlobalMutation) throw wizardCancelled("global-confirmation");
  }

  const settings = await collectSettings(
    selected.map((skill) => skill.id),
    prompt,
  );
  const credentialEnvironment = await collectCredentialSources(
    selected.map((skill) => skill.id),
    input.environment,
    prompt,
  );
  const acceptedLicenseIds = await collectLicenseAcceptances(
    selected.map((skill) => skill.id),
    prompt,
  );
  const agentRoutes = await collectAgentRoutes(prompt);

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
    "Run producer/reviewer agent smoke checks after installation? This may consume paid model quota.",
    false,
  );
  const confirmAgentSmokeCost = agentSmoke
    ? await prompt.confirm("I explicitly authorize the agent smoke-check cost", false)
    : false;
  if (agentSmoke && !confirmAgentSmokeCost) throw wizardCancelled("agent-smoke-confirmation");

  const missingRequiredCredentialIds = requiredCredentialIds(
    selected.map((skill) => skill.id).filter(Boolean),
  ).filter((id) => {
    const environmentName = credentialEnvironment[id];
    const definition = RESEARCH_SETUP_CREDENTIALS.find((item) => item.id === id)!;
    return (
      !environmentName ||
      Buffer.byteLength(input.environment[environmentName] ?? "", "utf8") <
        definition.minimumUtf8Bytes
    );
  });
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
    configuredCredentialEnvironmentNames: Object.entries(credentialEnvironment).map(
      ([id, environmentName]) => ({
        id,
        environmentName,
        present: Boolean(input.environment[environmentName]),
      }),
    ),
    missingRequiredCredentialIds,
    checks: { liveChecks, allowSyntheticUnstructureUpload, agentSmoke },
    networkDownloads: selected.length > 0,
  };
  prompt.note(`Reviewed setup preview:\n${JSON.stringify(preview, null, 2)}`);
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
    credentialEnvironment,
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
  prompt.note(`Plan created: ${workspacePaths(workspace).setupPlan}\nSHA-256: ${plan.planSha256}`);

  if (missingRequiredCredentialIds.length) {
    prompt.note(
      `Apply is blocked until these required owner environment variables are set: ${missingRequiredCredentialIds.join(
        ", ",
      )}`,
    );
  }
  const applyNow = await prompt.confirm(
    missingRequiredCredentialIds.length
      ? "Apply now anyway? Preflight will stop before downloads because required credentials are absent."
      : "Apply the reviewed plan now?",
    false,
  );
  if (!applyNow) {
    return {
      exitCode: 0,
      value: {
        schemaVersion: 1,
        status: "planned",
        plan,
        next: `tiangong-ai research setup apply --plan ${workspacePaths(workspace).setupPlan} --json`,
      },
    };
  }
  const value = await applyResearchSetupPlan(workspacePaths(workspace).setupPlan, {
    environment: input.environment,
  });
  return { exitCode: value.state.status === "blocked" ? 3 : 0, value };
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
  prompt: ResearchSetupWizardPrompt,
): Promise<Record<string, string>> {
  const selected = new Set(selectedSkillIds);
  const result: Record<string, string> = {};
  for (const credential of RESEARCH_SETUP_CREDENTIALS.filter((item) =>
    item.requiredBy.some((skillId) => selected.has(skillId)),
  )) {
    const defaultEnvironmentName = DEFAULT_CREDENTIAL_ENVIRONMENT[credential.id]!;
    const present =
      Buffer.byteLength(environment[defaultEnvironmentName] ?? "", "utf8") >=
      credential.minimumUtf8Bytes;
    prompt.note(
      `${credential.provider}\n  credential: ${credential.id}\n  obtain/configure: ${credential.obtainAt}\n  ${defaultEnvironmentName}: ${present ? "present" : "not present"}`,
    );
    if (!credential.required && !present) {
      const configure = await prompt.confirm(
        `Configure optional ${credential.id} from an environment variable?`,
        false,
      );
      if (!configure) continue;
    }
    const environmentName = await prompt.input(
      `Environment variable name for ${credential.id} (never the secret value)`,
      defaultEnvironmentName,
    );
    if (environmentName.trim()) result[credential.id] = environmentName.trim();
  }
  return result;
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
): Promise<Partial<ResearchSetupAgentRoutePlan>> {
  if (!(await prompt.confirm("Configure exact producer/reviewer model IDs now?", false))) return {};
  const producerModel = (await prompt.input("Producer model ID (blank to defer)", "")).trim();
  const reviewerModel = (await prompt.input("Reviewer model ID (blank to defer)", "")).trim();
  let producerPricing: AgentPricing | undefined;
  let reviewerPricing: AgentPricing | undefined;
  if (await prompt.confirm("Record reviewed per-million-token prices now?", false)) {
    producerPricing = await collectPricing("Producer", prompt);
    reviewerPricing = await collectPricing("Reviewer", prompt);
  }
  return {
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

class TextResearchSetupWizardPrompt implements ResearchSetupWizardPrompt {
  readonly #readline: Interface;
  readonly #output: Output;

  constructor(input: NodeJS.ReadableStream, output: Output) {
    this.#output = output;
    this.#readline = createInterface({
      input,
      output: output as NodeJS.WritableStream,
      terminal: true,
    });
  }

  note(message: string): void {
    write(this.#output, `\n${message}\n`);
  }

  async input(message: string, defaultValue = ""): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await this.#readline.question(`${message}${suffix}: `)).trim();
    return answer || defaultValue;
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    const suffix = defaultValue ? " [Y/n]" : " [y/N]";
    for (;;) {
      const answer = (await this.#readline.question(`${message}${suffix}: `)).trim().toLowerCase();
      if (!answer) return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      this.note("Enter y or n.");
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
            `  ${index + 1}. ${choice.label}${choice.value === defaultValue ? " [default]" : ""}`,
        )
        .join("\n")}`,
    );
    for (;;) {
      const answer = await this.input("Choose one", "");
      if (!answer) return defaultValue;
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && choices[index]) return choices[index]!.value;
      const byValue = choices.find((choice) => choice.value === answer);
      if (byValue) return byValue.value;
      this.note("Enter one displayed number or exact value.");
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
            `  ${index + 1}. ${choice.label}${defaultValues.includes(choice.value) ? " [default]" : ""}`,
        )
        .join("\n")}`,
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
      this.note("Enter unique displayed numbers separated by commas, or none.");
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
