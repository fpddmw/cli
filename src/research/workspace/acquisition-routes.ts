import { CliError } from "../../errors.js";
import type { ScientificDesignContract } from "./scientific-design.js";
import { loadScientificFulfillmentView } from "./scientific-fulfillment.js";
import type { ProjectState } from "./types.js";

export type ScientificAcquisitionRoute =
  ScientificDesignContract["acquisitionPlan"]["routes"][number];

export async function loadBoundAcquisitionDesign(
  root: string,
  project: ProjectState,
): Promise<ScientificDesignContract> {
  if (!project.scientificDesign) {
    throw new CliError("Evidence acquisition requires a frozen scientific design.", {
      code: "RESEARCH_EVIDENCE_ACCESS_PLAN_REQUIRED",
      exitCode: 3,
    });
  }
  return (await loadScientificFulfillmentView(root, project)).contract;
}

export async function resolveAgentAcquisitionRoute(input: {
  root: string;
  project: ProjectState;
  routeId: unknown;
  routeClasses: ScientificAcquisitionRoute["routeClass"][];
  capabilityId?: string;
  activityKind?: ScientificAcquisitionRoute["activityKind"];
  activityChannel?: string;
  downloadBackend?: ScientificAcquisitionRoute["downloadBackends"][number];
}): Promise<ScientificAcquisitionRoute | null> {
  if (!input.project.scientificDesign) {
    if (input.routeId !== undefined && input.routeId !== null) throw invalidRoute();
    return null;
  }
  if (typeof input.routeId !== "string") throw invalidRoute();
  const design = await loadBoundAcquisitionDesign(input.root, input.project);
  const route = design.acquisitionPlan.routes.find((candidate) => candidate.id === input.routeId);
  if (
    !route ||
    route.executor !== "agent" ||
    !input.routeClasses.includes(route.routeClass) ||
    (input.capabilityId !== undefined && route.capabilityId !== input.capabilityId) ||
    (input.activityKind !== undefined && route.activityKind !== input.activityKind) ||
    (input.activityChannel !== undefined && route.activityChannel !== input.activityChannel) ||
    (input.downloadBackend !== undefined && !route.downloadBackends.includes(input.downloadBackend))
  ) {
    throw invalidRoute();
  }
  return route;
}

function invalidRoute(): CliError {
  return new CliError(
    "The evidence activity does not bind one exact agent acquisition route from the frozen scientific design.",
    { code: "RESEARCH_EVIDENCE_ACQUISITION_ROUTE_INVALID", exitCode: 3 },
  );
}
