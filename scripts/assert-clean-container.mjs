#!/usr/bin/env node

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

assert.equal(process.env.CI_CLEAN_CONTAINER, "1", "clean-container marker is required");
assert.equal(process.cwd(), "/app", "tests must run from the image-owned source tree");
assert.equal(process.env.HOME, "/home/node", "tests must use the isolated container HOME");
assert.notEqual(process.getuid?.(), 0, "tests must not run as root");
assert.equal(await exists("/.dockerenv"), true, "tests must run inside Docker");
assert.equal(await exists("/app/.git"), false, "host Git metadata must not enter the image");
assert.equal(
  await exists(join(process.env.HOME, ".agents")),
  false,
  "host/global Skills must not enter the image",
);
assert.equal(await executableOnPath("tiangong-ai"), null, "no global Tiangong CLI may exist");

process.stdout.write("clean-container isolation contract passed\n");

async function exists(path) {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

async function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory && (await exists(join(directory, name)))) return join(directory, name);
  }
  return null;
}
