import { isObject } from "./storage.js";

/** Mode consistency, not a claim that the declared computation was executed. */
export function isConsistentAnalysisRunMetadata(value: unknown): boolean {
  if (!isObject(value)) return false;
  const implementations = value.implementationSha256s;
  const environments = value.environmentSha256s;
  const inputs = value.inputArtifactSha256s;
  if (
    ![implementations, environments, inputs].every(
      (items) =>
        Array.isArray(items) &&
        items.every((item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)),
    )
  )
    return false;
  if (value.mode === "qualitative") {
    return (
      value.status === "not-applicable" &&
      value.command === null &&
      value.randomSeed === null &&
      (implementations as string[]).length === 0 &&
      (environments as string[]).length === 0
    );
  }
  return (
    (value.mode === "computational" || value.mode === "mixed") &&
    value.status === "reproduced" &&
    typeof value.command === "string" &&
    value.command.trim().length > 0 &&
    typeof value.randomSeed === "string" &&
    value.randomSeed.trim().length > 0 &&
    (implementations as string[]).length > 0 &&
    (environments as string[]).length > 0
  );
}
