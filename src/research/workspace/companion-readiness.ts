import { RESEARCH_SETUP_SKILLS } from "./setup-catalog.js";
import { isObject, readJsonFile, workspacePaths } from "./storage.js";

export async function evaluateRequiredResearchCompanions(
  workspace: string,
  requiredCompanionIds: readonly string[],
): Promise<{
  ready: boolean;
  required: string[];
  gaps: string[];
  components: Array<{
    id: string;
    role: "input-preprocessor" | "acquisition-adapter" | "post-closure-authoring";
    readiness: "READY" | "BLOCKED";
    failedChecks: string[];
  }>;
}> {
  const required = [...new Set(requiredCompanionIds)].sort();
  if (required.length === 0) return { ready: true, required, gaps: [], components: [] };
  const paths = workspacePaths(workspace);
  const [plan, report] = await Promise.all([
    readJsonFile<unknown>(paths.setupPlan, "Research setup plan").catch(() => null),
    readJsonFile<unknown>(paths.setupReport, "Research setup doctor report").catch(() => null),
  ]);
  const gaps: string[] = [];
  const planSelection = isObject(plan) && isObject(plan.selection) ? plan.selection : null;
  const planCurrent =
    isObject(plan) &&
    planSelection !== null &&
    Array.isArray(planSelection.skillIds) &&
    typeof plan.planSha256 === "string";
  const reportChecksValue = isObject(report) ? report.checks : null;
  const reportCurrent =
    planCurrent &&
    isObject(report) &&
    report.planSha256 === plan.planSha256 &&
    Array.isArray(reportChecksValue);
  if (!reportCurrent) gaps.push("required-companion-doctor-report-missing-or-stale");
  const selectedIds = planCurrent
    ? (planSelection!.skillIds as unknown[]).filter(
        (id: unknown): id is string => typeof id === "string",
      )
    : [];
  const reportChecks = reportCurrent
    ? (reportChecksValue as unknown[]).filter((check: unknown): check is Record<string, unknown> =>
        isObject(check),
      )
    : [];
  const components = required.map((id) => {
    const skill = RESEARCH_SETUP_SKILLS.find((candidate) => candidate.id === id);
    if (
      !skill ||
      (skill.role !== "input-preprocessor" &&
        skill.role !== "acquisition-adapter" &&
        skill.role !== "post-closure-authoring")
    ) {
      gaps.push(`required-companion-invalid:${id}`);
      return {
        id,
        role: "acquisition-adapter" as const,
        readiness: "BLOCKED" as const,
        failedChecks: ["catalog"],
      };
    }
    if (!selectedIds.includes(id)) gaps.push(`required-companion-not-selected:${id}`);
    const componentChecks = reportChecks.filter(
      (check) =>
        Array.isArray(check.componentIds) &&
        check.componentIds.includes(id) &&
        check.componentGate !== false,
    );
    const failedChecks = componentChecks
      .filter((check) => check.status !== "pass")
      .map((check) => String(check.id))
      .sort();
    if (!componentChecks.some((check) => String(check.id).startsWith("skill."))) {
      failedChecks.push("skill-installation-not-attested");
    }
    if (
      skill.role === "input-preprocessor" &&
      !componentChecks.some(
        (check) => check.id === "live.tiangong-unstructure" && check.status === "pass",
      )
    ) {
      failedChecks.push("preprocessor-live-check-not-passed");
    }
    if (!selectedIds.includes(id) || failedChecks.length > 0) {
      gaps.push(`required-companion-not-ready:${id}`);
    }
    return {
      id,
      role: skill.role,
      readiness:
        selectedIds.includes(id) && failedChecks.length === 0
          ? ("READY" as const)
          : ("BLOCKED" as const),
      failedChecks: [...new Set(failedChecks)].sort(),
    };
  });
  return { ready: gaps.length === 0, required, gaps: [...new Set(gaps)].sort(), components };
}
