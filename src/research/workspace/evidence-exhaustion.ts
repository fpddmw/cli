import { CliError } from "../../errors.js";
import { loadBoundAcquisitionDesign } from "./acquisition-routes.js";
import { evidenceLedgerPath, verifyEvidenceLedger } from "./evidence-ledger.js";
import { readJournal, verifyJournal } from "./journal.js";
import { loadProject } from "./projects.js";
import type { ScientificDesignContract } from "./scientific-design.js";
import { isObject, workspacePaths } from "./storage.js";
import type {
  JournalEvent,
  ProjectState,
  ResearchAccessRequest,
  ResearchEvidenceExhaustion,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SENSITIVE_QUERY_KEY =
  /^(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|awsaccesskeyid|code|cookie|credential|key|password|secret|session(?:[_-]?id)?|sig|signature|token|x[_-]amz[_-](?:credential|security[_-]?token|signature)|x[_-]goog[_-](?:credential|signature))$/i;
const TRACKING_QUERY_KEY = /^(?:utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i;

type TerminalClassification =
  | "completed-insufficient"
  | "access-blocked"
  | "deterministic-unavailable";

interface TerminalRouteEvent {
  hash: string;
  type: string;
  timestamp: string;
  classification: TerminalClassification;
  journal: "workspace" | "evidence-ledger";
}

export interface EvidenceAccessRouteStatus {
  id: string;
  evidenceRoleIds: string[];
  routeClass: ScientificDesignContract["acquisitionPlan"]["routes"][number]["routeClass"];
  executor: ScientificDesignContract["acquisitionPlan"]["routes"][number]["executor"];
  required: boolean;
  accessMode: ScientificDesignContract["acquisitionPlan"]["routes"][number]["accessMode"];
  terminalEventHashes: string[];
  terminalEvents: TerminalRouteEvent[];
  exhausted: boolean;
}

export interface EvidenceAccessStatus {
  schemaVersion: 1;
  projectId: string;
  designSha256: string;
  requiredEvidenceRoleIds: string[];
  routes: EvidenceAccessRouteStatus[];
  untriedRequiredAgentRouteIds: string[];
  allRequiredAgentRoutesExhausted: boolean;
  recommendedAction: "continue-plan-bound-agent-routes" | "assess-required-evidence-role-coverage";
  ifEvidenceStillInsufficient: "request-reviewed-access-handoff" | "scope-pivot-required" | null;
}

export interface ParsedEvidenceExhaustionHandoff {
  exhaustion: ResearchEvidenceExhaustion;
  accessRequests: ResearchAccessRequest[];
}

export async function inspectEvidenceAccessStatus(
  root: string,
  projectId: string,
): Promise<EvidenceAccessStatus> {
  const project = await loadProject(root, projectId);
  const design = await loadBoundAcquisitionDesign(root, project);
  const paths = workspacePaths(root);
  const ledgerPath = evidenceLedgerPath(root, project.id);
  await Promise.all([verifyJournal(paths.journal), verifyEvidenceLedger(root, project.id)]);
  const [workspaceEvents, ledgerEvents] = await Promise.all([
    readJournal(paths.journal),
    readJournal(ledgerPath),
  ]);
  const routes = design.acquisitionPlan.routes.map((route) => {
    const terminalEvents = terminalEventsForRoute(project.id, route, workspaceEvents, ledgerEvents);
    return {
      id: route.id,
      evidenceRoleIds: [...route.evidenceRoleIds],
      routeClass: route.routeClass,
      executor: route.executor,
      required: route.required,
      accessMode: route.accessMode,
      terminalEventHashes: terminalEvents.map((event) => event.hash),
      terminalEvents,
      exhausted: terminalEvents.length > 0,
    };
  });
  const untriedRequiredAgentRouteIds = routes
    .filter((route) => route.required && route.executor === "agent" && !route.exhausted)
    .map((route) => route.id);
  const nonAgentRoutes = routes.filter((route) => route.required && route.executor !== "agent");
  return {
    schemaVersion: 1,
    projectId: project.id,
    designSha256: project.scientificDesign!.designSha256,
    requiredEvidenceRoleIds: design.evidenceRoles
      .filter((role) => role.required)
      .map((role) => role.id),
    routes,
    untriedRequiredAgentRouteIds,
    allRequiredAgentRoutesExhausted: untriedRequiredAgentRouteIds.length === 0,
    recommendedAction:
      untriedRequiredAgentRouteIds.length > 0
        ? "continue-plan-bound-agent-routes"
        : "assess-required-evidence-role-coverage",
    ifEvidenceStillInsufficient:
      untriedRequiredAgentRouteIds.length > 0
        ? null
        : nonAgentRoutes.length > 0
          ? "request-reviewed-access-handoff"
          : "scope-pivot-required",
  };
}

export function parseEvidenceExhaustionHandoff(
  exhaustionValue: unknown,
  accessRequestsValue: unknown,
): ParsedEvidenceExhaustionHandoff {
  if (!isObject(exhaustionValue)) throw invalidHandoff();
  assertExactKeys(exhaustionValue, [
    "missingEvidenceRoleIds",
    "routeAttempts",
    "remainingRouteIds",
  ]);
  const missingEvidenceRoleIds = stringSet(
    exhaustionValue.missingEvidenceRoleIds,
    1,
    100,
    IDENTIFIER,
  );
  const remainingRouteIds = stringSet(exhaustionValue.remainingRouteIds, 0, 100, IDENTIFIER);
  if (!Array.isArray(exhaustionValue.routeAttempts) || exhaustionValue.routeAttempts.length < 1) {
    throw invalidHandoff();
  }
  const routeAttempts = exhaustionValue.routeAttempts.map((attempt) => {
    if (!isObject(attempt)) throw invalidHandoff();
    assertExactKeys(attempt, ["routeId", "terminalEventHashes", "outcome"]);
    if (
      typeof attempt.routeId !== "string" ||
      !IDENTIFIER.test(attempt.routeId) ||
      !["completed-insufficient", "access-blocked", "deterministic-unavailable"].includes(
        String(attempt.outcome),
      )
    ) {
      throw invalidHandoff();
    }
    return {
      routeId: attempt.routeId,
      terminalEventHashes: stringSet(attempt.terminalEventHashes, 1, 100, SHA256),
      outcome: attempt.outcome as TerminalClassification,
    };
  });
  if (new Set(routeAttempts.map((attempt) => attempt.routeId)).size !== routeAttempts.length) {
    throw invalidHandoff();
  }
  if (!Array.isArray(accessRequestsValue) || accessRequestsValue.length > 100) {
    throw invalidHandoff();
  }
  const accessRequests = accessRequestsValue.map(parseAccessRequest);
  if (new Set(accessRequests.map((request) => request.id)).size !== accessRequests.length) {
    throw invalidHandoff();
  }
  return {
    exhaustion: { missingEvidenceRoleIds, routeAttempts, remainingRouteIds },
    accessRequests,
  };
}

export async function validateEvidenceExhaustionHandoff(input: {
  root: string;
  project: ProjectState;
  state: "user-action-required" | "external-response-required";
  value: ParsedEvidenceExhaustionHandoff;
}): Promise<ParsedEvidenceExhaustionHandoff> {
  const status = await inspectEvidenceAccessStatus(input.root, input.project.id);
  const routeById = new Map(status.routes.map((route) => [route.id, route]));
  const requiredRoles = new Set(status.requiredEvidenceRoleIds);
  const missingRoles = new Set(input.value.exhaustion.missingEvidenceRoleIds);
  if ([...missingRoles].some((roleId) => !requiredRoles.has(roleId))) throw unproven();

  const relevantAgentRoutes = status.routes.filter(
    (route) =>
      route.required &&
      route.executor === "agent" &&
      route.evidenceRoleIds.some((roleId) => missingRoles.has(roleId)),
  );
  const attemptByRoute = new Map(
    input.value.exhaustion.routeAttempts.map((attempt) => [attempt.routeId, attempt]),
  );
  if (
    attemptByRoute.size !== relevantAgentRoutes.length ||
    relevantAgentRoutes.some((route) => !attemptByRoute.has(route.id))
  ) {
    throw unproven();
  }
  for (const route of relevantAgentRoutes) {
    const attempt = attemptByRoute.get(route.id)!;
    const terminalByHash = new Map(route.terminalEvents.map((event) => [event.hash, event]));
    if (
      attempt.terminalEventHashes.some(
        (hash) => terminalByHash.get(hash)?.classification !== attempt.outcome,
      )
    ) {
      throw unproven();
    }
  }

  const relevantNonAgentRoutes = status.routes.filter(
    (route) =>
      route.required &&
      route.executor !== "agent" &&
      route.evidenceRoleIds.some((roleId) => missingRoles.has(roleId)),
  );
  const remainingRoutes = input.value.exhaustion.remainingRouteIds.map((routeId) =>
    routeById.get(routeId),
  );
  const expectedExecutor = input.state === "user-action-required" ? "user" : "external-party";
  if (
    remainingRoutes.some(
      (route) =>
        !route ||
        !route.required ||
        route.executor !== expectedExecutor ||
        !route.evidenceRoleIds.some((roleId) => missingRoles.has(roleId)),
    ) ||
    (remainingRoutes.length === 0
      ? relevantNonAgentRoutes.length > 0 || input.state !== "user-action-required"
      : [...missingRoles].some(
          (roleId) => !remainingRoutes.some((route) => route?.evidenceRoleIds.includes(roleId)),
        ))
  ) {
    throw unproven();
  }

  const requestByRoute = new Map(
    input.value.accessRequests.map((request) => [request.routeId, request]),
  );
  if (
    requestByRoute.size !== remainingRoutes.length ||
    input.value.exhaustion.remainingRouteIds.some((routeId) => !requestByRoute.has(routeId))
  ) {
    throw invalidHandoff();
  }
  const triedRouteIds = new Set(
    input.value.exhaustion.routeAttempts.map((attempt) => attempt.routeId),
  );
  const coveredRoles = new Set<string>();
  for (const route of remainingRoutes) {
    const request = requestByRoute.get(route!.id)!;
    if (
      request.evidenceRoleIds.some(
        (roleId) => !missingRoles.has(roleId) || !route!.evidenceRoleIds.includes(roleId),
      ) ||
      request.alternativesTriedRouteIds.length !== triedRouteIds.size ||
      request.alternativesTriedRouteIds.some((routeId) => !triedRouteIds.has(routeId)) ||
      !resourceTypeMatchesRoute(request.resourceType, route!.routeClass)
    ) {
      throw invalidHandoff();
    }
    request.evidenceRoleIds.forEach((roleId) => coveredRoles.add(roleId));
  }
  if (remainingRoutes.length > 0 && [...missingRoles].some((roleId) => !coveredRoles.has(roleId))) {
    throw invalidHandoff();
  }
  return input.value;
}

function terminalEventsForRoute(
  projectId: string,
  route: ScientificDesignContract["acquisitionPlan"]["routes"][number],
  workspaceEvents: JournalEvent[],
  ledgerEvents: JournalEvent[],
): TerminalRouteEvent[] {
  const events: TerminalRouteEvent[] = [];
  for (const event of workspaceEvents) {
    if (event.scope !== projectId || event.payload.projectId !== projectId) continue;
    const classification = workspaceTerminalClassification(route, event);
    if (classification) {
      events.push({
        hash: event.hash,
        type: event.type,
        timestamp: event.timestamp,
        classification,
        journal: "workspace",
      });
    }
  }
  for (const event of ledgerEvents) {
    if (event.scope !== projectId || event.payload.projectId !== projectId) continue;
    const classification = ledgerTerminalClassification(route, event);
    if (classification) {
      events.push({
        hash: event.hash,
        type: event.type,
        timestamp: event.timestamp,
        classification,
        journal: "evidence-ledger",
      });
    }
  }
  return events.sort(
    (left, right) =>
      left.timestamp.localeCompare(right.timestamp) || left.hash.localeCompare(right.hash),
  );
}

function workspaceTerminalClassification(
  route: ScientificDesignContract["acquisitionPlan"]["routes"][number],
  event: JournalEvent,
): TerminalClassification | null {
  if (
    route.routeClass !== "broker-capability" ||
    event.payload.acquisitionRouteId !== route.id ||
    event.payload.capabilityId !== route.capabilityId
  ) {
    return null;
  }
  if (["capability.fetch.completed", "capability.fetch.reused"].includes(event.type)) {
    return "completed-insufficient";
  }
  if (event.type !== "capability.fetch.failed") return null;
  const failureKind = String(event.payload.failureKind);
  if (failureKind === "authentication") return "access-blocked";
  return null;
}

function ledgerTerminalClassification(
  route: ScientificDesignContract["acquisitionPlan"]["routes"][number],
  event: JournalEvent,
): TerminalClassification | null {
  if (route.routeClass === "native-discovery") {
    if (
      event.type !== "activity.recorded" ||
      event.payload.acquisitionRouteId !== route.id ||
      event.payload.kind !== route.activityKind ||
      event.payload.channel !== route.activityChannel
    ) {
      return null;
    }
    if (event.payload.status === "completed") return "completed-insufficient";
    return null;
  }
  if (!["open-access-download", "authorized-browser"].includes(route.routeClass)) return null;
  if (event.payload.acquisitionRouteId !== route.id) return null;
  const backend = event.payload.backend as (typeof route.downloadBackends)[number];
  if (!route.downloadBackends.includes(backend)) return null;
  if (event.type === "download.bound") return "completed-insufficient";
  if (event.type !== "download.failed" || event.payload.status === "cancelled") return null;
  const failureCode = String(event.payload.failureCode ?? "");
  if (
    /not-found|unsupported|invalid-content|no-open-access|oa-exhausted|unavailable/i.test(
      failureCode,
    )
  ) {
    return "deterministic-unavailable";
  }
  return null;
}

function parseAccessRequest(value: unknown): ResearchAccessRequest {
  if (!isObject(value)) throw invalidHandoff();
  assertExactKeys(value, [
    "id",
    "routeId",
    "resourceType",
    "resourceName",
    "officialLocator",
    "evidenceRoleIds",
    "rationale",
    "alternativesTriedRouteIds",
    "requestedAction",
    "resumeCriteria",
    "costStatus",
  ]);
  const resourceTypes: ResearchAccessRequest["resourceType"][] = [
    "database-subscription",
    "article-purchase",
    "institutional-access",
    "licensed-dataset",
    "owner-provided-material",
    "external-data-request",
    "field-data-collection",
  ];
  if (
    typeof value.id !== "string" ||
    !IDENTIFIER.test(value.id) ||
    typeof value.routeId !== "string" ||
    !IDENTIFIER.test(value.routeId) ||
    !resourceTypes.includes(value.resourceType as ResearchAccessRequest["resourceType"]) ||
    !boundedString(value.resourceName, 3, 500) ||
    !boundedString(value.rationale, 8, 2_000) ||
    !boundedString(value.requestedAction, 8, 1_000) ||
    !boundedString(value.resumeCriteria, 8, 1_000) ||
    !["unknown", "provider-quote-required"].includes(String(value.costStatus))
  ) {
    throw invalidHandoff();
  }
  const resourceType = value.resourceType as ResearchAccessRequest["resourceType"];
  const officialLocator = safeOfficialLocator(value.officialLocator);
  if (
    [
      "database-subscription",
      "article-purchase",
      "institutional-access",
      "licensed-dataset",
    ].includes(resourceType) &&
    !officialLocator
  ) {
    throw invalidHandoff();
  }
  return {
    id: value.id,
    routeId: value.routeId,
    resourceType,
    resourceName: value.resourceName.trim(),
    officialLocator,
    evidenceRoleIds: stringSet(value.evidenceRoleIds, 1, 100, IDENTIFIER),
    rationale: value.rationale.trim(),
    alternativesTriedRouteIds: stringSet(value.alternativesTriedRouteIds, 1, 100, IDENTIFIER),
    requestedAction: value.requestedAction.trim(),
    resumeCriteria: value.resumeCriteria.trim(),
    costStatus: value.costStatus as ResearchAccessRequest["costStatus"],
  };
}

function safeOfficialLocator(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2_000) throw invalidHandoff();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidHandoff();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw invalidHandoff();
  if ([...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))) {
    throw invalidHandoff();
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_QUERY_KEY.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function resourceTypeMatchesRoute(
  resourceType: ResearchAccessRequest["resourceType"],
  routeClass: EvidenceAccessRouteStatus["routeClass"],
): boolean {
  if (routeClass === "licensed-resource") {
    return [
      "database-subscription",
      "article-purchase",
      "institutional-access",
      "licensed-dataset",
    ].includes(resourceType);
  }
  if (routeClass === "owner-provided-resource") return resourceType === "owner-provided-material";
  if (routeClass === "external-data-request") return resourceType === "external-data-request";
  return routeClass === "field-data-collection" && resourceType === "field-data-collection";
}

function stringSet(value: unknown, minimum: number, maximum: number, pattern: RegExp): string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    value.some((item) => typeof item !== "string" || !pattern.test(item)) ||
    new Set(value).size !== value.length
  ) {
    throw invalidHandoff();
  }
  return value as string[];
}

function assertExactKeys(value: Record<string, unknown>, keys: string[]): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key))) throw invalidHandoff();
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.trim().length >= minimum && value.length <= maximum;
}

function invalidHandoff(): CliError {
  return new CliError("Handoff request failed validation.", {
    code: "RESEARCH_PROJECT_HANDOFF_INVALID",
    exitCode: 2,
  });
}

function unproven(): CliError {
  return new CliError(
    "Evidence exhaustion is not proven by every required plan-bound terminal event.",
    { code: "RESEARCH_EVIDENCE_EXHAUSTION_UNPROVEN", exitCode: 3 },
  );
}
