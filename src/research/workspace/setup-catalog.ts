import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { CliError } from "../../errors.js";
import { EXTERNAL_SKILLS_CLI_VERSION } from "./external-skills.js";
import { sanitizeResearchText } from "./sanitization.js";
import { hashRegularTree, pathExists } from "./storage.js";

export type ResearchSetupScope = "project" | "global";
export type ResearchSetupAgent = "codex" | "claude-code";
export type ResearchSetupTier = "baseline" | "enhanced" | "conditional" | "authoring";
export type ResearchSetupRole =
  | "evidence-capability"
  | "input-preprocessor"
  | "acquisition-adapter"
  | "post-closure-authoring";

export interface ResearchSetupSource {
  id: string;
  repository: string;
  locator: string;
  immutableRef: string;
  bundled: false;
  userInitiatedOnly: true;
}

export interface ResearchSetupLicense {
  id: string;
  label: string;
  url: string;
  notice: string;
  requiresExplicitAcceptance: true;
}

export interface ResearchSetupDependency {
  id: string;
  kind: "command" | "python-package" | "manual";
  requirement: string;
  requiredFor: string;
  automaticInstall: false;
  minimumAction: string;
}

export interface ResearchSetupSkill {
  id: string;
  skillName: string;
  sourceId: string;
  sourceRelativePath: string;
  expectedTreeSha256: string;
  tier: ResearchSetupTier;
  role: ResearchSetupRole;
  purpose: string;
  recommendedFor: string[];
  defaultSelected: boolean;
  credentialIds: string[];
  settingIds: string[];
  dependencies: ResearchSetupDependency[];
  license: ResearchSetupLicense;
  conflictGroup: string | null;
  capabilityKind: "brave-public-internet" | "tiangong-sci" | null;
  bundled: false;
  userInitiatedOnly: true;
}

export interface ResearchSetupCredential {
  id: string;
  provider: string;
  requiredBy: string[];
  required: boolean;
  storage: "broker" | "adapter";
  adapterEnvironmentName: string | null;
  obtainAt: string;
  minimumUtf8Bytes: number;
  liveCheck: "capability" | "semantic-scholar" | "unstructure" | null;
}

export interface ResearchSetupSetting {
  id: string;
  label: string;
  requiredBy: string[];
  required: boolean;
  secret: false;
  defaultValue: string | null;
  validation: "https-url" | "email" | "identifier";
}

export const RESEARCH_SETUP_SELECTION_GUIDANCE = {
  pptCreation: {
    preferredSkillId: "hugohe3.ppt-master",
    situationalSkillIds: ["anthropic.pptx"],
    maySelectTogether: true,
    automaticSelection: false,
    guidance:
      "Prefer PPT Master for creating PPT presentations; use Anthropic PPTX when its workflow better fits the task. Both remain explicit post-closure choices.",
  },
} as const;

const BRAVE_COMMIT = "3e088af66eb61f1c207c22b2be0278ca8744d1d1";
const TIANGONG_SKILLS_COMMIT = "c371dbc464dc51ac1d8b0d0d59b318942418cc7b";
const ANTHROPIC_SKILLS_COMMIT = "f17010c9bb483898c1d9c9f42dde2b3a98889434";
const PPT_MASTER_COMMIT = "4343bd8bfc91e79dfb9680681a378476cc38a280";

export const RESEARCH_SETUP_INSTALLER = {
  package: "skills",
  version: EXTERNAL_SKILLS_CLI_VERSION,
  npmIntegrity:
    "sha512-cHiLjwZEawWFvudIqeeMZlvZayTLbRouydMbblyrdiyH7ZLbqUrSrEEr+Tg+X265iztRlVMsyOYRwpD5JxBsvg==",
  npmShasum: "ec0a7897ba2ef06e01f3b41007886f3a92cf4d05",
  gitHead: "a4d243c3d4f86cdf9385dd1b6a0733f6937e70b5",
  runtimeInstall: false,
} as const;

export const RESEARCH_SETUP_SOURCES: readonly ResearchSetupSource[] = [
  {
    id: "brave-search-skills",
    repository: "brave/brave-search-skills",
    locator: "https://github.com/brave/brave-search-skills.git",
    immutableRef: BRAVE_COMMIT,
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "tiangong-ai-skills",
    repository: "tiangong-ai/skills",
    locator: "https://github.com/tiangong-ai/skills.git",
    immutableRef: TIANGONG_SKILLS_COMMIT,
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "anthropic-skills",
    repository: "anthropics/skills",
    locator: "https://github.com/anthropics/skills.git",
    immutableRef: ANTHROPIC_SKILLS_COMMIT,
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "ppt-master",
    repository: "hugohe3/ppt-master",
    locator: "https://github.com/hugohe3/ppt-master.git",
    immutableRef: PPT_MASTER_COMMIT,
    bundled: false,
    userInitiatedOnly: true,
  },
] as const;

const MIT_BRAVE: ResearchSetupLicense = {
  id: "brave-search-skills:MIT",
  label: "MIT",
  url: `https://github.com/brave/brave-search-skills/blob/${BRAVE_COMMIT}/LICENSE`,
  notice: "Brave Search Skills are separately sourced under the MIT license.",
  requiresExplicitAcceptance: true,
};

const MIT_TIANGONG: ResearchSetupLicense = {
  id: "tiangong-ai-skills:MIT",
  label: "MIT",
  url: `https://github.com/tiangong-ai/skills/blob/${TIANGONG_SKILLS_COMMIT}/LICENSE`,
  notice: "Tiangong Skills are separately sourced under the MIT license.",
  requiresExplicitAcceptance: true,
};

const ANTHROPIC_EXAMPLE: ResearchSetupLicense = {
  id: "anthropic-skills:doc-coauthoring:NOASSERTION",
  label: "NOASSERTION",
  url: `https://github.com/anthropics/skills/blob/${ANTHROPIC_SKILLS_COMMIT}/README.md`,
  notice:
    "The pinned doc-coauthoring tree has no per-Skill license file. The upstream README describes many examples as Apache-2.0, but this catalog does not infer a license; review the pinned source before choosing it.",
  requiresExplicitAcceptance: true,
};

const ANTHROPIC_DOCUMENT_TERMS: ResearchSetupLicense = {
  id: "anthropic-skills:document-terms",
  label: "Anthropic source-available document Skill terms",
  url: `https://github.com/anthropics/skills/blob/${ANTHROPIC_SKILLS_COMMIT}/skills/docx/LICENSE.txt`,
  notice:
    "The upstream document Skills are source-available, not open source, and contain additional restrictions. They are never bundled or selected automatically.",
  requiresExplicitAcceptance: true,
};

const MIT_PPT_MASTER: ResearchSetupLicense = {
  id: "ppt-master:MIT",
  label: "MIT",
  url: `https://github.com/hugohe3/ppt-master/blob/${PPT_MASTER_COMMIT}/skills/ppt-master/LICENSE`,
  notice: "PPT Master is separately sourced under the MIT license.",
  requiresExplicitAcceptance: true,
};

const PYTHON_310: ResearchSetupDependency = {
  id: "python-3.10",
  kind: "command",
  requirement: "python3 >= 3.10",
  requiredFor: "Python Skill scripts",
  automaticInstall: false,
  minimumAction: "Install a compatible Python runtime outside this CLI, then rerun setup doctor.",
};

const PYPDF_LOCK: ResearchSetupDependency = {
  id: "academic-paper-download:pypdf",
  kind: "python-package",
  requirement: "pypdf==6.14.2 from requirements.txt",
  requiredFor: "academic-paper-download structural PDF validation",
  automaticInstall: false,
  minimumAction:
    "Create an isolated Python environment and install the Skill's pinned requirements.txt; do not install CloakBrowser unless that optional handoff is explicitly selected later.",
};

const PPT_MASTER_LOCK_REQUIRED: ResearchSetupDependency = {
  id: "ppt-master:python-lock",
  kind: "manual",
  requirement: "A user-reviewed exact Python lock derived from upstream requirements.txt",
  requiredFor: "PPT Master helper scripts",
  automaticInstall: false,
  minimumAction:
    "Review and pin the upstream >= constraints in an isolated environment before enabling PPT Master helpers; setup will not resolve or install floating Python dependencies.",
};

export const RESEARCH_SETUP_SKILLS: readonly ResearchSetupSkill[] = [
  {
    id: "brave.web-search",
    skillName: "web-search",
    sourceId: "brave-search-skills",
    sourceRelativePath: "skills/web-search",
    expectedTreeSha256: "0432f4eb084766046a2feeb146f0b3917850d138eb4182c23fc000a058fbe123",
    tier: "baseline",
    role: "evidence-capability",
    purpose: "Broad public-internet evidence discovery.",
    recommendedFor: ["production-research"],
    defaultSelected: true,
    credentialIds: ["brave.search.api-key"],
    settingIds: [],
    dependencies: [],
    license: MIT_BRAVE,
    conflictGroup: null,
    capabilityKind: "brave-public-internet",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "brave.news-search",
    skillName: "news-search",
    sourceId: "brave-search-skills",
    sourceRelativePath: "skills/news-search",
    expectedTreeSha256: "80f8dcb7c78209cce5315e507f0aba21e3f654f42f6a414c177de644bcd07773",
    tier: "baseline",
    role: "evidence-capability",
    purpose: "Date-sensitive public news discovery.",
    recommendedFor: ["production-research"],
    defaultSelected: true,
    credentialIds: ["brave.search.api-key"],
    settingIds: [],
    dependencies: [],
    license: MIT_BRAVE,
    conflictGroup: null,
    capabilityKind: "brave-public-internet",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "brave.llm-context",
    skillName: "llm-context",
    sourceId: "brave-search-skills",
    sourceRelativePath: "skills/llm-context",
    expectedTreeSha256: "5abba551d0498a80eba4e64207f483974f5a312cda5b263c1cc2b7f99d81c4a3",
    tier: "enhanced",
    role: "evidence-capability",
    purpose: "Plan-dependent bounded extracted web context.",
    recommendedFor: ["full-text-web-grounding"],
    defaultSelected: false,
    credentialIds: ["brave.search.api-key"],
    settingIds: [],
    dependencies: [],
    license: MIT_BRAVE,
    conflictGroup: null,
    capabilityKind: "brave-public-internet",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "brave.images-search",
    skillName: "images-search",
    sourceId: "brave-search-skills",
    sourceRelativePath: "skills/images-search",
    expectedTreeSha256: "467a9afae0e959b482cb6b2236a57a327959b28985871f88c202dc70b10a7c84",
    tier: "conditional",
    role: "evidence-capability",
    purpose: "Image-source discovery when visual evidence is material.",
    recommendedFor: ["visual-evidence"],
    defaultSelected: false,
    credentialIds: ["brave.search.api-key"],
    settingIds: [],
    dependencies: [],
    license: MIT_BRAVE,
    conflictGroup: null,
    capabilityKind: "brave-public-internet",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "brave.videos-search",
    skillName: "videos-search",
    sourceId: "brave-search-skills",
    sourceRelativePath: "skills/videos-search",
    expectedTreeSha256: "ff3a2e2291efc27f3f09847b7e0b20e77d229f6a44a1a64e562964c820eb9719",
    tier: "conditional",
    role: "evidence-capability",
    purpose: "Video-source discovery when audiovisual evidence is material.",
    recommendedFor: ["audiovisual-evidence"],
    defaultSelected: false,
    credentialIds: ["brave.search.api-key"],
    settingIds: [],
    dependencies: [],
    license: MIT_BRAVE,
    conflictGroup: null,
    capabilityKind: "brave-public-internet",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "tiangong.kb-sci-search",
    skillName: "tiangong-kb-sci-search",
    sourceId: "tiangong-ai-skills",
    sourceRelativePath: "tiangong-kb-sci-search",
    expectedTreeSha256: "835e2fa1ce94e035ca64dedf08ca734e409285e563545f334c196b39f4d4170f",
    tier: "enhanced",
    role: "evidence-capability",
    purpose: "Owner-authorized Tiangong SCI database discovery through a bounded JSON POST broker.",
    recommendedFor: ["academic-research", "owner-whitelisted-database"],
    defaultSelected: false,
    credentialIds: ["tiangong.sci.api-key"],
    settingIds: ["tiangong.sci.endpoint", "tiangong.sci.region"],
    dependencies: [],
    license: MIT_TIANGONG,
    conflictGroup: null,
    capabilityKind: "tiangong-sci",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "tiangong.document-granular-decompose",
    skillName: "document-granular-decompose",
    sourceId: "tiangong-ai-skills",
    sourceRelativePath: "document-granular-decompose",
    expectedTreeSha256: "d02b7d8eea7c29c2fac20601d9d44f1ed00183f2180d0392b30631b6068e14ff",
    tier: "enhanced",
    role: "input-preprocessor",
    purpose: "Hash-bound local-document preprocessing before immutable input admission.",
    recommendedFor: ["pdf", "office-documents", "scanned-documents"],
    defaultSelected: false,
    credentialIds: ["tiangong.unstructure.auth-token"],
    settingIds: [
      "tiangong.unstructure.base-url",
      "tiangong.unstructure.provider",
      "tiangong.unstructure.model",
    ],
    dependencies: [PYTHON_310],
    license: MIT_TIANGONG,
    conflictGroup: null,
    capabilityKind: null,
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "tiangong.academic-paper-download",
    skillName: "academic-paper-download",
    sourceId: "tiangong-ai-skills",
    sourceRelativePath: "academic-paper-download",
    expectedTreeSha256: "f863ab2c53ceee3403a71fc7db8e60fab17499ca62aea3e5ba32dffe3689329f",
    tier: "enhanced",
    role: "acquisition-adapter",
    purpose:
      "Deterministic OA paper acquisition with verified PDF provenance; browser handoff remains explicit and user-authorized.",
    recommendedFor: ["academic-research", "full-text-papers"],
    defaultSelected: false,
    credentialIds: ["semantic-scholar.api-key"],
    settingIds: ["unpaywall.contact-email"],
    dependencies: [PYTHON_310, PYPDF_LOCK],
    license: MIT_TIANGONG,
    conflictGroup: null,
    capabilityKind: null,
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "anthropic.doc-coauthoring",
    skillName: "doc-coauthoring",
    sourceId: "anthropic-skills",
    sourceRelativePath: "skills/doc-coauthoring",
    expectedTreeSha256: "ac77dcfcbc3363ea52f96fdb9874aa651a06406ac2496b9e7cc93c1e543b8cb6",
    tier: "authoring",
    role: "post-closure-authoring",
    purpose: "Optional structured co-authoring after research closure.",
    recommendedFor: ["reports", "proposals", "specifications"],
    defaultSelected: false,
    credentialIds: [],
    settingIds: [],
    dependencies: [],
    license: ANTHROPIC_EXAMPLE,
    conflictGroup: null,
    capabilityKind: null,
    bundled: false,
    userInitiatedOnly: true,
  },
  ...[
    ["docx", "6141692f73af101fa316a1c1626a455876bd3b70c8ee84136eedff35d73bac1b"],
    ["pdf", "8d433d894adfa21cb6e3679ec2591324d700c68cf1c3d6fcea75618817a792b0"],
    ["pptx", "c098dad12f4aecd650186c543fad4b5be83feea04321804e82ca2dd063bd5754"],
    ["xlsx", "1508b6d8e64bd71d0f3f2c0ad8a1fb4bb3d932c9071e31c92a2f4a2cee4db157"],
  ].map(([skillName, expectedTreeSha256]) => ({
    id: `anthropic.${skillName}`,
    skillName: skillName!,
    sourceId: "anthropic-skills",
    sourceRelativePath: `skills/${skillName}`,
    expectedTreeSha256: expectedTreeSha256!,
    tier: "authoring" as const,
    role: "post-closure-authoring" as const,
    purpose:
      skillName === "pptx"
        ? "Situational PPTX reading, editing, or alternative authoring after mechanical research closure."
        : `Optional ${skillName} artifact work after mechanical research closure.`,
    recommendedFor:
      skillName === "pptx"
        ? ["pptx-reading", "pptx-editing", "situational-presentation-authoring"]
        : [`${skillName}-artifacts`],
    defaultSelected: false,
    credentialIds: [],
    settingIds: [],
    dependencies: [],
    license: ANTHROPIC_DOCUMENT_TERMS,
    conflictGroup: null,
    capabilityKind: null,
    bundled: false as const,
    userInitiatedOnly: true as const,
  })),
  {
    id: "hugohe3.ppt-master",
    skillName: "ppt-master",
    sourceId: "ppt-master",
    sourceRelativePath: "skills/ppt-master",
    expectedTreeSha256: "a430995ca9f5e53402dbf8e8b66b27c13e5abeec7e1af4727696213bc4df5732",
    tier: "authoring",
    role: "post-closure-authoring",
    purpose: "Preferred for creating PPT presentations after research closure.",
    recommendedFor: ["ppt-creation", "presentation-artifacts"],
    defaultSelected: false,
    credentialIds: [],
    settingIds: [],
    dependencies: [PYTHON_310, PPT_MASTER_LOCK_REQUIRED],
    license: MIT_PPT_MASTER,
    conflictGroup: null,
    capabilityKind: null,
    bundled: false,
    userInitiatedOnly: true,
  },
] as const;

export const RESEARCH_SETUP_CREDENTIALS: readonly ResearchSetupCredential[] = [
  {
    id: "brave.search.api-key",
    provider: "Brave Search API",
    requiredBy: RESEARCH_SETUP_SKILLS.filter(
      (skill) => skill.sourceId === "brave-search-skills",
    ).map((skill) => skill.id),
    required: true,
    storage: "broker",
    adapterEnvironmentName: null,
    obtainAt: "https://api.search.brave.com/app/keys",
    minimumUtf8Bytes: 8,
    liveCheck: "capability",
  },
  {
    id: "tiangong.sci.api-key",
    provider: "Tiangong SCI Search",
    requiredBy: ["tiangong.kb-sci-search"],
    required: true,
    storage: "broker",
    adapterEnvironmentName: null,
    obtainAt: "Ask the owner of the selected Tiangong SCI deployment.",
    minimumUtf8Bytes: 8,
    liveCheck: "capability",
  },
  {
    id: "tiangong.unstructure.auth-token",
    provider: "Tiangong Unstructure",
    requiredBy: ["tiangong.document-granular-decompose"],
    required: true,
    storage: "adapter",
    adapterEnvironmentName: "UNSTRUCTURED_AUTH_TOKEN",
    obtainAt: "Ask the owner of the selected Unstructure deployment.",
    minimumUtf8Bytes: 8,
    liveCheck: "unstructure",
  },
  {
    id: "semantic-scholar.api-key",
    provider: "Semantic Scholar Academic Graph API",
    requiredBy: ["tiangong.academic-paper-download"],
    required: false,
    storage: "adapter",
    adapterEnvironmentName: "SEMANTIC_SCHOLAR_API_KEY",
    obtainAt: "https://www.semanticscholar.org/product/api",
    minimumUtf8Bytes: 8,
    liveCheck: "semantic-scholar",
  },
] as const;

export const RESEARCH_SETUP_SETTINGS: readonly ResearchSetupSetting[] = [
  {
    id: "tiangong.sci.endpoint",
    label: "Tiangong SCI exact endpoint",
    requiredBy: ["tiangong.kb-sci-search"],
    required: true,
    secret: false,
    defaultValue: "https://qyyqlnwqwgvzxnccnbgm.supabase.co/functions/v1/sci_search",
    validation: "https-url",
  },
  {
    id: "tiangong.sci.region",
    label: "Tiangong SCI region header",
    requiredBy: ["tiangong.kb-sci-search"],
    required: false,
    secret: false,
    defaultValue: "us-east-1",
    validation: "identifier",
  },
  {
    id: "tiangong.unstructure.base-url",
    label: "Tiangong Unstructure HTTPS base URL",
    requiredBy: ["tiangong.document-granular-decompose"],
    required: true,
    secret: false,
    defaultValue: null,
    validation: "https-url",
  },
  {
    id: "tiangong.unstructure.provider",
    label: "Optional Unstructure provider",
    requiredBy: ["tiangong.document-granular-decompose"],
    required: false,
    secret: false,
    defaultValue: null,
    validation: "identifier",
  },
  {
    id: "tiangong.unstructure.model",
    label: "Optional Unstructure model",
    requiredBy: ["tiangong.document-granular-decompose"],
    required: false,
    secret: false,
    defaultValue: null,
    validation: "identifier",
  },
  {
    id: "unpaywall.contact-email",
    label: "Unpaywall contact email",
    requiredBy: ["tiangong.academic-paper-download"],
    required: false,
    secret: false,
    defaultValue: null,
    validation: "email",
  },
] as const;

export function setupSource(sourceId: string): ResearchSetupSource {
  const source = RESEARCH_SETUP_SOURCES.find((candidate) => candidate.id === sourceId);
  if (!source) throw setupCatalogError(`Unknown setup source: ${sourceId}`);
  return source;
}

export function setupSkill(skillIdOrName: string): ResearchSetupSkill {
  const skill = RESEARCH_SETUP_SKILLS.find(
    (candidate) => candidate.id === skillIdOrName || candidate.skillName === skillIdOrName,
  );
  if (!skill) throw setupCatalogError(`Unknown recommended Skill: ${skillIdOrName}`);
  return skill;
}

export function resolveSetupSkills(values: readonly string[]): ResearchSetupSkill[] {
  const resolved = values.map(setupSkill);
  const ids = resolved.map((skill) => skill.id);
  if (new Set(ids).size !== ids.length) throw setupCatalogError("Selected Skills are duplicated.");
  return resolved.sort((left, right) => left.id.localeCompare(right.id));
}

export function setupTargetRoot(input: {
  workspace: string;
  scope: ResearchSetupScope;
  agent: ResearchSetupAgent;
  environment?: NodeJS.ProcessEnv;
}): string {
  if (input.scope === "project") {
    return input.agent === "codex"
      ? join(resolve(input.workspace), ".agents", "skills")
      : join(resolve(input.workspace), ".claude", "skills");
  }
  if (input.agent === "codex") {
    const configuredHome = input.environment?.HOME?.trim();
    const home = configuredHome && isAbsolute(configuredHome) ? resolve(configuredHome) : homedir();
    return join(home, ".agents", "skills");
  }
  const configured = input.environment?.CLAUDE_CONFIG_DIR?.trim();
  return join(
    configured && isAbsolute(configured) ? resolve(configured) : join(homedir(), ".claude"),
    "skills",
  );
}

export async function inspectResearchSetupCatalog(input: {
  selectedPath: string;
  scope?: ResearchSetupScope;
  agents?: ResearchSetupAgent[];
  environment?: NodeJS.ProcessEnv;
}) {
  const workspace = resolve(input.selectedPath);
  const scope = input.scope ?? "project";
  const agents = input.agents?.length ? [...new Set(input.agents)] : ["codex" as const];
  const entries = [];
  for (const skill of RESEARCH_SETUP_SKILLS) {
    const installations = [];
    for (const agent of agents) {
      const root = setupTargetRoot({
        workspace,
        scope,
        agent,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      });
      const path = join(root, skill.skillName);
      installations.push({ agent, root, path, ...(await inspectInstalledSkill(path, skill)) });
    }
    entries.push({ ...skill, source: setupSource(skill.sourceId), installations });
  }
  return {
    schemaVersion: 1 as const,
    catalog: "tiangong-research-setup-ecosystem",
    policy: {
      bundledSkills: false,
      userInitiatedOnly: true,
      runtimeInstall: false,
      defaultScope: "project",
      defaultInstallMode: "copy",
      floatingUpdates: false,
      automaticSystemPackageInstall: false,
      automaticPythonPackageInstall: false,
    },
    installer: RESEARCH_SETUP_INSTALLER,
    workspace,
    scope,
    agents,
    sources: RESEARCH_SETUP_SOURCES,
    entries,
    credentials: RESEARCH_SETUP_CREDENTIALS,
    settings: RESEARCH_SETUP_SETTINGS,
    conflictGroups: [],
    selectionGuidance: RESEARCH_SETUP_SELECTION_GUIDANCE,
    roles: {
      evidenceCapabilities: RESEARCH_SETUP_SKILLS.filter(
        (skill) => skill.role === "evidence-capability",
      ).map((skill) => skill.id),
      inputPreprocessors: RESEARCH_SETUP_SKILLS.filter(
        (skill) => skill.role === "input-preprocessor",
      ).map((skill) => skill.id),
      acquisitionAdapters: RESEARCH_SETUP_SKILLS.filter(
        (skill) => skill.role === "acquisition-adapter",
      ).map((skill) => skill.id),
      postClosureAuthoring: RESEARCH_SETUP_SKILLS.filter(
        (skill) => skill.role === "post-closure-authoring",
      ).map((skill) => skill.id),
    },
  };
}

async function inspectInstalledSkill(
  path: string,
  skill: ResearchSetupSkill,
): Promise<{
  status: "missing" | "installed" | "drifted" | "blocked";
  observedTreeSha256: string | null;
  detail: string;
}> {
  if (!(await pathExists(path))) {
    return { status: "missing", observedTreeSha256: null, detail: "Skill is not installed." };
  }
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return {
        status: "blocked",
        observedTreeSha256: null,
        detail: "Install destination must be a regular non-symlink directory.",
      };
    }
    const observedTreeSha256 = await hashRegularTree(path);
    return observedTreeSha256 === skill.expectedTreeSha256
      ? {
          status: "installed",
          observedTreeSha256,
          detail: "Installed bytes match the reviewed tree hash.",
        }
      : {
          status: "drifted",
          observedTreeSha256,
          detail: "Installed bytes do not match the reviewed tree hash.",
        };
  } catch (error) {
    return {
      status: "blocked",
      observedTreeSha256: null,
      detail: sanitizeResearchText(error instanceof Error ? error.message : String(error)),
    };
  }
}

function setupCatalogError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_SETUP_SELECTION_INVALID",
    exitCode: 2,
    details: {
      step: "selection",
      reason: message,
      minimumAction: "Choose IDs reported by research setup catalog.",
      retryCommand: "tiangong-ai research setup catalog --json",
    },
  });
}
