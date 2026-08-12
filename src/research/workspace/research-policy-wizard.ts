import { resolve } from "node:path";

import { CliError } from "../../errors.js";
import type { CliIO, Output } from "../../io.js";
import { stringifyJson, write } from "../../io.js";
import {
  createResearchSetupWizardTheme,
  shouldUseResearchSetupWizardColor,
  TextResearchSetupWizardPrompt,
  type ResearchSetupWizardNoteTone,
} from "./setup-wizard.js";
import { resolveVerifiedResearchSetupSkillDirectory } from "./setup.js";
import {
  approveResearchPolicy,
  completeResearchExactJournalPolicy,
  completeResearchPublicationBrief,
  initializeResearchPolicy,
  inspectResearchPolicyCatalog,
  inspectResearchPolicyStatus,
  type ResearchPolicyStatus,
} from "./research-policy.js";

const ORCHESTRATOR_SKILL_ID = "tiangong.auto-research";

export interface ResearchPolicyWizardPrompt {
  note(message: string, tone?: ResearchSetupWizardNoteTone): void;
  input(message: string, defaultValue?: string): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  select<T extends string>(
    message: string,
    choices: ReadonlyArray<{ value: T; label: string }>,
    defaultValue: T,
  ): Promise<T>;
  close(): void;
}

export interface ResearchPolicyWizardResult {
  schemaVersion: 1;
  projectId: string;
  sourceRoot: string;
  defaultsInUse: boolean;
  approved: boolean;
  status: ResearchPolicyStatus;
  next: {
    action: "customize-and-approve" | "initialize-top-journal-project";
    minimumAction: string;
    retryCommand: string;
  };
}

export async function resolveInstalledResearchPolicySource(
  rootInput: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const root = resolve(rootInput);
  try {
    return await resolveVerifiedResearchSetupSkillDirectory(
      root,
      ORCHESTRATOR_SKILL_ID,
      environment,
    );
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "RESEARCH_POLICY_SOURCE_REQUIRED";
    throw new CliError(
      "A verified project-installed tiangong-auto-research orchestrator is required for Research Policy defaults.",
      {
        code: "RESEARCH_POLICY_SOURCE_REQUIRED",
        exitCode: code === "RESEARCH_SETUP_CLI_DRIFT" ? 3 : 2,
        details: {
          reasonCode: code,
          minimumAction:
            "Run research setup, select the tiangong.auto-research orchestrator for project scope, apply the reviewed plan, and reach READY.",
          retryCommand: `tiangong-ai research setup --workspace ${root}`,
        },
      },
    );
  }
}

export async function executeResearchPolicyWizard(input: {
  root: string;
  projectId: string;
  prompt: ResearchPolicyWizardPrompt;
  sourceRoot?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<ResearchPolicyWizardResult> {
  const root = resolve(input.root);
  const sourceRoot =
    input.sourceRoot ??
    (await resolveInstalledResearchPolicySource(root, input.environment ?? process.env));
  const catalog = await inspectResearchPolicyCatalog(sourceRoot);
  input.prompt.note("Top-journal Research Policy", "brand");
  input.prompt.note(
    "The bundled policies are generic defaults, not evidence of target-journal fit or acceptance. Review and customize them for the field, article type, and current official journal guidance.",
    "warning",
  );
  const articleType = await selectCatalogValue(
    input.prompt,
    "Article type",
    catalog.categories.articleTypes,
  );
  const field = await selectCatalogValue(input.prompt, "Research field", catalog.categories.fields);
  const journalClass = await selectCatalogValue(
    input.prompt,
    "Target journal class",
    catalog.categories.journalClasses,
  );
  const includeExactJournal = await input.prompt.confirm(
    "Add and fully customize an exact target-journal policy now?",
    false,
  );
  await initializeResearchPolicy({
    root,
    projectId: input.projectId,
    sourceRoot,
    articleType,
    field,
    journalClass,
    includeExactJournalTemplate: includeExactJournal,
  });

  const centralQuestion = await requiredPolicyInput(input.prompt, "Central research question", 8);
  const centralClaim = await requiredPolicyInput(input.prompt, "Central claim", 8);
  const centralOutcome = await requiredPolicyInput(input.prompt, "Central outcome", 3);
  const contributionType = await requiredPolicyInput(input.prompt, "Contribution type", 3);
  let targetJournal: string | null = null;
  if (includeExactJournal) {
    targetJournal = await requiredPolicyInput(input.prompt, "Exact target journal", 2);
    const officialGuidelinesUrl = await requiredPolicyInput(
      input.prompt,
      "Official journal guidelines HTTPS URL",
      10,
    );
    const officialGuidelinesRetrievedAt = await requiredPolicyInput(
      input.prompt,
      "Official guidelines retrieval date (YYYY-MM-DD)",
      10,
      new Date().toISOString().slice(0, 10),
    );
    await completeResearchExactJournalPolicy(root, input.projectId, {
      journalName: targetJournal,
      officialGuidelinesUrl,
      officialGuidelinesRetrievedAt,
      scope: await requiredPolicyInput(input.prompt, "Journal scope and audience", 12),
      editorialSignificance: await requiredPolicyInput(
        input.prompt,
        "Journal editorial significance threshold",
        12,
      ),
      evidenceExpectations: await requiredPolicyInput(
        input.prompt,
        "Journal evidence expectations",
        12,
      ),
      methodsAndValidation: await requiredPolicyInput(
        input.prompt,
        "Journal methods and validation requirements",
        12,
      ),
      reproducibility: await requiredPolicyInput(
        input.prompt,
        "Journal reproducibility requirements",
        12,
      ),
      deskRejectTriggers: await requiredPolicyInput(
        input.prompt,
        "Journal desk-reject triggers",
        12,
      ),
      requiredReviewerQuestions: await requiredPolicyInput(
        input.prompt,
        "Journal-specific reviewer questions",
        12,
      ),
      permittedPivots: await requiredPolicyInput(
        input.prompt,
        "Permitted research or journal pivots",
        12,
      ),
    });
  }
  let status = await completeResearchPublicationBrief(root, input.projectId, {
    centralQuestion,
    centralClaim,
    centralOutcome,
    contributionType,
    targetJournal,
  });
  input.prompt.note(
    `Draft created at ${status.policyDirectory}. Review every policy document before approval.`,
    "summary",
  );

  let approved = false;
  const acknowledgeDefaults = await input.prompt.confirm(
    "I acknowledge that the remaining bundled defaults are generic and do not establish journal acceptance",
    false,
  );
  if (acknowledgeDefaults) {
    approved = await input.prompt.confirm(
      "Approve this exact Research Policy hash for top-journal execution?",
      false,
    );
  }
  if (approved) {
    status = await approveResearchPolicy(root, input.projectId, {
      confirm: true,
      acknowledgeDefaults: true,
    });
    input.prompt.note(
      `Approved exact policy hash ${status.resolvedPolicySha256}. Any later edit invalidates this approval.`,
      "success",
    );
  } else {
    status = await inspectResearchPolicyStatus(root, input.projectId);
    input.prompt.note(
      "Policy remains a draft. Customize it, then approve the exact changed hash before project initialization.",
      "warning",
    );
  }
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    sourceRoot,
    defaultsInUse: status.defaultDocuments > 0,
    approved,
    status,
    next: approved
      ? {
          action: "initialize-top-journal-project",
          minimumAction:
            "Initialize the project with --goal top-journal and this policy project ID.",
          retryCommand: `tiangong-ai research project init ${input.projectId} --question <research-question> --goal top-journal --workspace ${root} --help`,
        }
      : {
          action: "customize-and-approve",
          minimumAction: "Review the policy directory and approve the exact resulting hash.",
          retryCommand: `tiangong-ai research policy approve ${input.projectId} --confirm --acknowledge-defaults --workspace ${root}`,
        },
  };
}

export async function runInteractiveResearchPolicyWizard(input: {
  root: string;
  projectId: string;
  io: CliIO;
  json: boolean;
}): Promise<number> {
  const sourceRoot = await resolveInstalledResearchPolicySource(input.root, input.io.env);
  if (!input.io.stdin?.isTTY) {
    throw new CliError("Interactive Research Policy setup requires a TTY.", {
      code: "RESEARCH_POLICY_TTY_REQUIRED",
      exitCode: 2,
      details: {
        minimumAction:
          "Run the Policy Wizard in a terminal, or use policy catalog/init/status/approve for automation.",
        retryCommand: "tiangong-ai research policy wizard --help",
      },
    });
  }
  const prompt = new TextResearchSetupWizardPrompt(
    input.io.stdin,
    input.io.stderr,
    createResearchSetupWizardTheme(
      shouldUseResearchSetupWizardColor({
        outputIsTTY: Boolean((input.io.stderr as Output & { isTTY?: boolean }).isTTY),
        json: input.json,
        environment: input.io.env,
      }),
    ),
  );
  try {
    const result = await executeResearchPolicyWizard({
      root: input.root,
      projectId: input.projectId,
      prompt,
      sourceRoot,
      environment: input.io.env,
    });
    write(input.io.stdout, stringifyJson(result, input.json));
    return 0;
  } finally {
    prompt.close();
  }
}

async function selectCatalogValue(
  prompt: ResearchPolicyWizardPrompt,
  label: string,
  values: string[],
): Promise<string> {
  if (!values.length) {
    throw new CliError(`Research Policy catalog has no ${label.toLowerCase()} options.`, {
      code: "RESEARCH_POLICY_SOURCE_INVALID",
      exitCode: 2,
    });
  }
  return prompt.select(
    label,
    values.map((value) => ({ value, label: value })),
    values[0]!,
  );
}

async function requiredPolicyInput(
  prompt: ResearchPolicyWizardPrompt,
  label: string,
  minimumBytes: number,
  defaultValue = "",
): Promise<string> {
  const value = (await prompt.input(label, defaultValue)).trim();
  if (Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new CliError(`${label} is required and must be explicit.`, {
      code: "RESEARCH_POLICY_INVALID",
      exitCode: 2,
      details: { field: label },
    });
  }
  return value;
}
