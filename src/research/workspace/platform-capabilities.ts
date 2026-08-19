import { posix, win32 } from "node:path";

export type ResearchPathFlavor = "posix" | "win32";
export type NativeIsolationProvider = "sandbox-exec" | "bubblewrap";
export type ResearchSetupMode = "native" | "configuration-smoke";
export type PlatformPathRelation = "same" | "inside" | "outside";

export interface PlatformPathAlias {
  alias: string;
  canonical: string;
}

export interface ResearchPlatformCapabilities {
  platform: NodeJS.Platform;
  pathFlavor: ResearchPathFlavor;
  pathCaseSensitive: boolean;
  pathAliases: PlatformPathAlias[];
  nativeIsolationProvider: NativeIsolationProvider | null;
  nativeReviewerExecution: boolean;
  reviewerSidecarExecution: boolean;
  setupMode: ResearchSetupMode;
  productionResearch: boolean;
}

export function researchPlatformCapabilities(
  platform: NodeJS.Platform = process.platform,
): ResearchPlatformCapabilities {
  if (platform === "darwin") {
    return {
      platform,
      pathFlavor: "posix",
      pathCaseSensitive: true,
      pathAliases: [{ alias: "/var", canonical: "/private/var" }],
      nativeIsolationProvider: "sandbox-exec",
      nativeReviewerExecution: true,
      reviewerSidecarExecution: true,
      setupMode: "native",
      productionResearch: true,
    };
  }
  if (platform === "linux") {
    return {
      platform,
      pathFlavor: "posix",
      pathCaseSensitive: true,
      pathAliases: [],
      nativeIsolationProvider: "bubblewrap",
      nativeReviewerExecution: true,
      reviewerSidecarExecution: true,
      setupMode: "native",
      productionResearch: true,
    };
  }
  if (platform === "win32") {
    return {
      platform,
      pathFlavor: "win32",
      pathCaseSensitive: false,
      pathAliases: [],
      nativeIsolationProvider: null,
      nativeReviewerExecution: false,
      reviewerSidecarExecution: false,
      setupMode: "configuration-smoke",
      productionResearch: false,
    };
  }
  return {
    platform,
    pathFlavor: "posix",
    pathCaseSensitive: true,
    pathAliases: [],
    nativeIsolationProvider: null,
    nativeReviewerExecution: false,
    reviewerSidecarExecution: false,
    setupMode: "configuration-smoke",
    productionResearch: false,
  };
}

export function classifyPlatformPathRelation(input: {
  platform: NodeJS.Platform;
  root: string;
  candidate: string;
}): PlatformPathRelation {
  const capabilities = researchPlatformCapabilities(input.platform);
  const pathApi = capabilities.pathFlavor === "win32" ? win32 : posix;
  let root = applyPathAliases(pathApi.normalize(input.root), capabilities);
  let candidate = applyPathAliases(pathApi.normalize(input.candidate), capabilities);
  if (!pathApi.isAbsolute(root) || !pathApi.isAbsolute(candidate)) return "outside";
  if (!capabilities.pathCaseSensitive) {
    root = root.toLowerCase();
    candidate = candidate.toLowerCase();
  }
  const relation = pathApi.relative(root, candidate);
  if (relation === "") return "same";
  if (
    relation === ".." ||
    relation.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relation)
  ) {
    return "outside";
  }
  return "inside";
}

function applyPathAliases(value: string, capabilities: ResearchPlatformCapabilities): string {
  const pathApi = capabilities.pathFlavor === "win32" ? win32 : posix;
  for (const mapping of capabilities.pathAliases) {
    const alias = pathApi.normalize(mapping.alias);
    if (value === alias) return pathApi.normalize(mapping.canonical);
    if (value.startsWith(`${alias}${pathApi.sep}`)) {
      return pathApi.normalize(`${mapping.canonical}${value.slice(alias.length)}`);
    }
  }
  return value;
}
