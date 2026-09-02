import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { forecastRoleEligibility } from "../src/research/workspace/acquisition-forecast.js";
import {
  computeRoleCoverage,
  declaredSourceTypes,
  sourceTypeRequirementGaps,
  type EvidenceRoleRequirement,
} from "../src/research/workspace/evidence-role-coverage.js";

describe("shared evidence-role coverage", () => {
  it("does not turn same-dimension metadata or binary-only sources into potential atoms", () => {
    const roles: EvidenceRoleRequirement[] = [
      {
        id: "mitigation",
        required: true,
        minimumFullText: 1,
        minimumIndependentSources: 1,
        minimumDatedSources: 1,
        coverageDimensionIds: ["water"],
        sourceTypeRequirements: ["paper", "patent"],
      },
    ];
    const sources = [
      {
        id: "readable-paper",
        sourceType: "paper",
        fullTextAvailable: true,
        producerContextLevel: "bounded-text-artifact",
        artifactIds: ["paper-text"],
        producerVisibleArtifactIds: ["paper-text"],
        publicationDate: "2026-01-01",
        coverageDimensions: ["water"],
      },
      {
        id: "metadata-patent",
        sourceType: "patent",
        fullTextAvailable: false,
        producerContextLevel: "metadata-only",
        artifactIds: [],
        producerVisibleArtifactIds: [],
        publicationDate: "2026-01-01",
        coverageDimensions: ["water"],
      },
      {
        id: "binary-patent",
        sourceType: "patent",
        fullTextAvailable: false,
        producerContextLevel: "metadata-only",
        artifactIds: ["unread-pdf"],
        producerVisibleArtifactIds: [],
        publicationDate: "2026-01-01",
        coverageDimensions: ["water"],
      },
    ];
    const forecast = forecastRoleEligibility(roles, sources)[0]!;
    assert.equal(forecast.eligibility, "insufficient");
    assert.deepEqual(forecast.sourceIds, ["readable-paper"]);
    assert.deepEqual(forecast.gaps, ["evidence role mitigation lacks source type patent"]);
    const restored = {
      ...sources[1],
      fullTextAvailable: true,
      producerContextLevel: "bounded-text-artifact",
      artifactIds: ["patent-text"],
      producerVisibleArtifactIds: ["patent-text"],
    };
    assert.equal(
      forecastRoleEligibility(roles, [sources[0]!, restored])[0]!.eligibility,
      "potentially-sufficient",
    );
  });

  it("retains flat all-of and evaluates combined groups using distinct source types", () => {
    assert.deepEqual(sourceTypeRequirementGaps(["paper", "government"], ["paper"]), [
      "lacks source type government",
    ]);
    const groups = {
      allOf: ["paper"],
      anyOf: ["government", "industry"],
      atLeast: { count: 2, from: ["paper", "government", "industry"] },
    };
    assert.deepEqual(declaredSourceTypes(groups), ["government", "industry", "paper"]);
    assert.deepEqual(sourceTypeRequirementGaps(groups, ["paper", "industry"]), []);
    assert.equal(sourceTypeRequirementGaps(groups, ["paper", "paper"]).length, 2);
    assert.deepEqual(sourceTypeRequirementGaps(groups, ["government", "industry"]), [
      "lacks source type paper",
    ]);
  });

  it("forecasts the same role deficits without treating possible metadata assignments as actual atoms", () => {
    const roles: EvidenceRoleRequirement[] = [
      {
        id: "central",
        required: true,
        minimumFullText: 1,
        minimumIndependentSources: 2,
        minimumDatedSources: 1,
        coverageDimensionIds: ["water"],
        sourceTypeRequirements: ["paper", "government"],
      },
    ];
    const sources = [
      {
        id: "paper-1",
        sourceType: "paper",
        publicationDate: "2025-01-01",
        fullTextAvailable: true,
        coverageDimensions: ["water"],
      },
      {
        id: "paper-2",
        sourceType: "paper",
        publicationDate: null,
        fullTextAvailable: true,
        coverageDimensions: ["water"],
      },
      {
        id: "unrelated",
        sourceType: "government",
        publicationDate: "2025-01-01",
        fullTextAvailable: true,
        coverageDimensions: ["electricity"],
      },
    ];
    const forecast = forecastRoleEligibility(roles, sources)[0]!;
    assert.equal(forecast.eligibility, "insufficient");
    assert.deepEqual(forecast.sourceIds, ["paper-1", "paper-2"]);
    assert.deepEqual(forecast.gaps, ["evidence role central lacks source type government"]);
    const atoms = sources.slice(0, 2).map((source) => ({
      sourceId: source.id,
      evidenceRoleIds: ["central"],
      coverageDimensionIds: ["water"],
    }));
    assert.deepEqual(computeRoleCoverage(roles, sources, atoms)[0]!.gaps, forecast.gaps);
    roles[0]!.sourceTypeRequirements = { anyOf: ["paper", "government"] };
    assert.equal(forecastRoleEligibility(roles, sources)[0]!.eligibility, "potentially-sufficient");
    assert.equal(computeRoleCoverage(roles, sources, [])[0]!.decision, "insufficient");
    assert.equal(computeRoleCoverage(roles, sources, [...atoms, ...atoms])[0]!.sourceIds.length, 2);
  });
});
