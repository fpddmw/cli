/** Flat arrays retain their original all-of meaning. Present groups are conjunctive. */
export type SourceTypeRequirements =
  | string[]
  | {
      allOf?: string[];
      anyOf?: string[];
      atLeast?: { count: number; from: string[] };
    };

export interface EvidenceRoleRequirement {
  id: string;
  required: boolean;
  minimumFullText: number;
  minimumIndependentSources: number;
  minimumDatedSources: number;
  coverageDimensionIds: string[];
  sourceTypeRequirements: SourceTypeRequirements;
}

export function declaredSourceTypes(requirements: SourceTypeRequirements): string[] {
  return unique(
    Array.isArray(requirements)
      ? requirements
      : [
          ...(requirements.allOf ?? []),
          ...(requirements.anyOf ?? []),
          ...(requirements.atLeast?.from ?? []),
        ],
  );
}

export function sourceTypeRequirementGaps(
  requirements: SourceTypeRequirements,
  observed: Iterable<string>,
): string[] {
  const present = new Set(observed);
  const groups = Array.isArray(requirements) ? { allOf: requirements } : requirements;
  const gaps = (groups.allOf ?? [])
    .filter((type) => !present.has(type))
    .map((type) => `lacks source type ${type}`);
  if (groups.anyOf && !groups.anyOf.some((type) => present.has(type))) {
    gaps.push(`requires any source type from [${groups.anyOf.join(", ")}]`);
  }
  if (groups.atLeast) {
    const found = unique(groups.atLeast.from).filter((type) => present.has(type)).length;
    if (found < groups.atLeast.count) {
      gaps.push(
        `requires at least ${groups.atLeast.count} distinct source types from [${groups.atLeast.from.join(", ")}], found ${found}`,
      );
    }
  }
  return gaps;
}

/** One indexed pass over atoms; no filesystem or persisted trust cache. */
export function computeRoleCoverage(
  roles: EvidenceRoleRequirement[],
  sources: Array<Record<string, unknown>>,
  atoms: Array<{ sourceId: string; evidenceRoleIds: string[]; coverageDimensionIds: string[] }>,
) {
  const sourcesById = new Map(sources.map((source) => [String(source.id), source]));
  const byRole = new Map<string, typeof atoms>();
  for (const atom of atoms) {
    if (!sourcesById.has(atom.sourceId)) continue;
    for (const roleId of new Set(atom.evidenceRoleIds)) {
      const values = byRole.get(roleId) ?? [];
      values.push(atom);
      byRole.set(roleId, values);
    }
  }
  return roles
    .filter((role) => role.required)
    .map((role) => {
      const roleAtoms = byRole.get(role.id) ?? [];
      const sourceIds = unique(roleAtoms.map((atom) => atom.sourceId));
      const fullTextSourceIds = sourceIds.filter(
        (id) => sourcesById.get(id)?.fullTextAvailable === true,
      );
      const datedSourceIds = sourceIds.filter(
        (id) => typeof sourcesById.get(id)?.publicationDate === "string",
      );
      const coverageDimensionIds = unique(roleAtoms.flatMap((atom) => atom.coverageDimensionIds));
      const sourceTypes = unique(
        sourceIds.flatMap((id) => {
          const type = sourcesById.get(id)?.sourceType;
          return typeof type === "string" ? [type] : [];
        }),
      );
      const gaps: string[] = [];
      for (const [label, required, found] of [
        ["independent", role.minimumIndependentSources, sourceIds.length],
        ["full-text", role.minimumFullText, fullTextSourceIds.length],
        ["dated", role.minimumDatedSources, datedSourceIds.length],
      ] as const) {
        if (found < required)
          gaps.push(
            `evidence role ${role.id} requires ${required} ${label} source(s), found ${found}`,
          );
      }
      for (const dimension of role.coverageDimensionIds) {
        if (!coverageDimensionIds.includes(dimension))
          gaps.push(`evidence role ${role.id} lacks atom coverage for dimension ${dimension}`);
      }
      gaps.push(
        ...sourceTypeRequirementGaps(role.sourceTypeRequirements, sourceTypes).map(
          (gap) => `evidence role ${role.id} ${gap}`,
        ),
      );
      return {
        roleId: role.id,
        sourceIds,
        fullTextSourceIds,
        datedSourceIds,
        coverageDimensionIds,
        sourceTypes,
        decision: (gaps.length ? "insufficient" : "pass") as "pass" | "insufficient",
        gaps,
      };
    });
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
