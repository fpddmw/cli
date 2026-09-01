import type { DataCredentialDeclaration, DataDoctorCheck } from "../contracts.js";
import { DataRuntimeError } from "./errors.js";

export interface ResolvedDataCredentials {
  values: Map<string, string>;
  checks: DataDoctorCheck[];
}

export function resolveDataCredentials(
  declarations: readonly DataCredentialDeclaration[],
  environment: NodeJS.ProcessEnv,
): ResolvedDataCredentials {
  const values = new Map<string, string>();
  const checks: DataDoctorCheck[] = [];
  for (const declaration of declarations) {
    const value = environment[declaration.environmentVariable] ?? "";
    const configured = value.trim().length > 0;
    if (configured) values.set(declaration.credentialId, value);
    checks.push({
      checkId: `credential:${declaration.credentialId}`,
      status: configured ? "pass" : declaration.required ? "fail" : "warn",
      message: configured
        ? `Logical credential ${declaration.credentialId} is configured.`
        : declaration.required
          ? `Required logical credential ${declaration.credentialId} is not configured.`
          : `Optional logical credential ${declaration.credentialId} is not configured.`,
      details: {
        credentialId: declaration.credentialId,
        environmentVariable: declaration.environmentVariable,
        configured,
        required: declaration.required,
      },
    });
  }
  return { values, checks };
}

export function requiredCredentialsPresent(
  declarations: readonly DataCredentialDeclaration[],
  values: ReadonlyMap<string, string>,
): boolean {
  return declarations.every(
    (declaration) => !declaration.required || values.has(declaration.credentialId),
  );
}

export function injectLogicalCredential(input: {
  declaration: DataCredentialDeclaration;
  value: string | undefined;
  endpointId: string;
  headers: Headers;
  path: string;
}): string {
  if (!input.declaration.endpointIds.includes(input.endpointId)) {
    throw new DataRuntimeError(
      "endpoint-policy-blocked",
      "The logical credential is not authorized for the selected endpoint.",
      {
        details: {
          credentialId: input.declaration.credentialId,
          endpointId: input.endpointId,
        },
      },
    );
  }
  if (!input.value) {
    throw new DataRuntimeError(
      "credential-missing",
      `Required logical credential ${input.declaration.credentialId} is not configured.`,
      {
        userActionRequired: true,
        details: {
          credentialId: input.declaration.credentialId,
          environmentVariable: input.declaration.environmentVariable,
        },
      },
    );
  }
  if (input.declaration.injection.kind === "header") {
    input.headers.set(
      input.declaration.injection.name,
      `${input.declaration.injection.prefix}${input.value}`,
    );
    return input.path;
  }
  const placeholder = input.declaration.injection.placeholder;
  const segments = input.path.split("/");
  if (segments.filter((segment) => segment === placeholder).length !== 1) {
    throw new DataRuntimeError(
      "endpoint-policy-blocked",
      "A path-segment credential placeholder must occur exactly once as a complete path segment.",
      {
        details: {
          credentialId: input.declaration.credentialId,
          endpointId: input.endpointId,
        },
      },
    );
  }
  return segments
    .map((segment) =>
      segment === placeholder ? encodeURIComponent(input.value as string) : segment,
    )
    .join("/");
}
