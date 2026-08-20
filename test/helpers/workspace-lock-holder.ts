import { acquireFileLock, workspacePaths } from "../../src/research/workspace/storage.js";
import { withWorkspaceLock } from "../../src/research/workspace/workspace.js";

const root = process.argv[2];
if (!root) throw new Error("Workspace lock holder requires a workspace root.");
const kind = process.argv[3] ?? "workspace";

if (kind === "setup") {
  const release = await acquireFileLock(workspacePaths(root).setupLock, {
    operation: "research.setup",
  });
  try {
    process.stdout.write("LOCK_ACQUIRED\n");
    await holdProcess();
  } finally {
    await release();
  }
} else if (kind === "workspace") {
  await withWorkspaceLock(root, "test.crash-consistency.holder", async () => {
    process.stdout.write("LOCK_ACQUIRED\n");
    await holdProcess();
  });
} else {
  throw new Error("Unknown lock holder kind.");
}

async function holdProcess(): Promise<void> {
  await new Promise<void>(() => {
    setInterval(() => undefined, 60_000);
  });
}
