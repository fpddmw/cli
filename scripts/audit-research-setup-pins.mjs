import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  RESEARCH_SETUP_INSTALLER,
  RESEARCH_SETUP_SKILLS,
  RESEARCH_SETUP_SOURCES,
  verifyResearchSetupRuntimeContract,
} from "../dist/research/workspace/setup-catalog.js";
import { hashRegularTree } from "../dist/research/workspace/storage.js";

const run = promisify(execFile);
const exactStableSemver = /^\d+\.\d+\.\d+$/;
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const auditRoot = await mkdtemp(resolve(tmpdir(), "tiangong-research-pin-audit."));

try {
  if (!exactStableSemver.test(packageJson.version)) {
    throw new Error("Package version is not an exact stable semantic version.");
  }
  if (!exactStableSemver.test(RESEARCH_SETUP_INSTALLER.version)) {
    throw new Error("Setup installer version is not an exact stable semantic version.");
  }
  const orchestrator = RESEARCH_SETUP_SKILLS.find((skill) => skill.id === "tiangong.auto-research");
  if (!orchestrator?.runtimeContract || orchestrator.standaloneTestedCliVersion) {
    throw new Error("Auto Research must declare only the workspace-lock runtime contract.");
  }
  for (const skillId of [
    "tiangong.kb-sci-search",
    "tiangong.kb-report-search",
    "tiangong.kb-patent-search",
  ]) {
    const skill = RESEARCH_SETUP_SKILLS.find((candidate) => candidate.id === skillId);
    if (!skill || !exactStableSemver.test(skill.standaloneTestedCliVersion ?? "")) {
      throw new Error(`${skillId} must declare an exact standalone tested CLI version.`);
    }
  }

  for (const source of RESEARCH_SETUP_SOURCES) {
    if (!/^[0-9a-f]{40}$/.test(source.immutableRef)) {
      throw new Error(`Setup source ${source.id} is not pinned to an exact Git commit.`);
    }
    const checkout = resolve(auditRoot, source.id);
    await mkdir(checkout);
    await git(["init", "--quiet", checkout]);
    await git(["-C", checkout, "remote", "add", "origin", source.locator]);
    await git(["-C", checkout, "config", "--local", "core.autocrlf", "false"]);
    await git(["-C", checkout, "config", "--local", "core.eol", "lf"]);
    await git(["-C", checkout, "fetch", "--quiet", "--depth", "1", "origin", source.immutableRef]);
    await git(["-C", checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const { stdout } = await git(["-C", checkout, "rev-parse", "HEAD"]);
    if (stdout.trim().toLowerCase() !== source.immutableRef) {
      throw new Error(`Setup source ${source.id} resolved to a different commit.`);
    }
    for (const skill of RESEARCH_SETUP_SKILLS.filter(
      (candidate) => candidate.sourceId === source.id,
    )) {
      const skillPath = resolve(checkout, skill.sourceRelativePath);
      if (!skillPath.startsWith(`${checkout}${sep}`)) {
        throw new Error(`Setup Skill ${skill.id} escapes its immutable source checkout.`);
      }
      const observed = await hashRegularTree(skillPath);
      if (observed !== skill.expectedTreeSha256) {
        throw new Error(
          `Setup Skill ${skill.id} tree hash mismatch (${observed} != ${skill.expectedTreeSha256}).`,
        );
      }
      await verifyResearchSetupRuntimeContract(skillPath, skill);
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      packageVersion: packageJson.version,
      installerVersion: RESEARCH_SETUP_INSTALLER.version,
      sources: RESEARCH_SETUP_SOURCES.length,
      skills: RESEARCH_SETUP_SKILLS.length,
    })}\n`,
  );
} finally {
  await rm(auditRoot, { recursive: true, force: true });
}

async function git(args) {
  return run("git", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}
