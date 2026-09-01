import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

function workflow(path: string): Record<string, any> {
  return parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function stepByName(workflowValue: Record<string, any>, name: string): Record<string, any> {
  const steps = workflowValue.jobs["quality-gate"].steps as Array<Record<string, any>>;
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing workflow step: ${name}`);
  return step;
}

describe("GitHub CI workflow contract", () => {
  it("cancels obsolete PR runs without canceling main pushes", () => {
    const quality = workflow(".github/workflows/quality-gate.yml");
    const docs = workflow(".github/workflows/ai-doc-lint.yml");

    assert.match(String(quality.concurrency.group), /pull_request\.number.*github\.ref/);
    assert.equal(
      quality.concurrency["cancel-in-progress"],
      "${{ github.event_name == 'pull_request' }}",
    );
    assert.match(String(docs.concurrency.group), /pull_request\.number.*github\.ref/);
    assert.equal(docs.concurrency["cancel-in-progress"], true);
  });

  it("runs one full suite per platform, Linux-only coverage, and targeted platform contracts", () => {
    const quality = workflow(".github/workflows/quality-gate.yml");
    const fullSuite = stepByName(quality, "Full test suite");
    const typecheck = stepByName(quality, "Typecheck");
    const platformSuite = stepByName(quality, "Platform contract suite");
    const coverage = stepByName(quality, "Coverage gate");

    assert.equal(typecheck.run, "npm run typecheck");
    assert.equal(fullSuite.run, "npm test");
    assert.match(String(fullSuite.if), /runner\.os != 'Linux'/);
    assert.match(String(fullSuite.if), /matrix\.arch != 'x64'/);
    assert.equal(platformSuite.run, "npm run test:platform");
    assert.match(String(platformSuite.if), /runner\.os == 'Windows'/);
    assert.match(String(platformSuite.if), /runner\.os == 'macOS'/);
    assert.equal(coverage.run, "npm run test:coverage");
    assert.match(String(coverage.if), /runner\.os == 'Linux'/);
    assert.match(String(coverage.if), /matrix\.arch == 'x64'/);

    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.equal(
      packageJson.scripts["test:platform"],
      "npm run build && node --import tsx --test test/research-platform-contract.test.ts",
    );
  });

  it("pins the repository docpact workflow to 0.1.9", () => {
    const docs = workflow(".github/workflows/ai-doc-lint.yml");
    const install = (docs.jobs["ai-doc-lint"].steps as Array<Record<string, any>>).find(
      (step) => step.name === "Install docpact",
    );
    assert.ok(install);
    assert.equal(install.run, "cargo install docpact --version 0.1.9 --force");
  });
});
