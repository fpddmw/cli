import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";

const [root, point] = process.argv.slice(2);
const targetRoot = join(root, ".tiangong-research", "projects", "target");
const sourcePath = join(root, ".tiangong-research", "projects", "source", "project.json");
const journalPath = join(root, ".tiangong-research", "journal.jsonl");

async function mark() {
  await fs.writeFile(join(root, "fault-point.txt"), point);
}

async function crash() {
  await mark();
  process.kill(process.pid, "SIGKILL");
  await new Promise(() => {});
}

const rename = fs.rename;
fs.rename = async (source, destination) => {
  const result = await rename(source, destination);
  const path = resolve(String(destination));
  if (
    (point === "target-state" && path === resolve(targetRoot, "project.json")) ||
    (["source-state", "retry-state"].includes(point) && path === resolve(sourcePath))
  ) {
    await crash();
  }
  return result;
};

const mkdir = fs.mkdir;
fs.mkdir = async (path, options) => {
  const result = await mkdir(path, options);
  if (point === "target-directory" && resolve(String(path)) === resolve(targetRoot)) {
    await crash();
  }
  return result;
};

const appendFile = fs.appendFile;
fs.appendFile = async (path, data, options) => {
  if (
    point === "retry-committed" &&
    resolve(String(path)) === resolve(journalPath) &&
    String(data).includes('"type":"project.retry.requested"')
  ) {
    const result = await appendFile(path, data, options);
    await crash();
    return result;
  }
  if (
    resolve(String(path)) === resolve(journalPath) &&
    String(data).includes('"type":"project.forked"')
  ) {
    if (point === "before-commit") {
      await mark();
      throw new Error("Synthetic fork commit failure");
    }
    const result = await appendFile(path, data, options);
    if (point === "committed") await crash();
    return result;
  }
  return appendFile(path, data, options);
};

syncBuiltinESMExports();
const { forkProject, retryProjectPackage } =
  await import("../../../src/research/workspace/projects.ts");
try {
  if (point.startsWith("retry-")) await retryProjectPackage(root, "source", "synthesize");
  else await forkProject(root, "source", "target");
  throw new Error("Expected fork fault was not reached");
} catch (error) {
  if (point !== "before-commit" || error.message !== "Synthetic fork commit failure") throw error;
}
