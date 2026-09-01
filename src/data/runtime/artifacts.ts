import { randomUUID } from "node:crypto";
import { link, lstat, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { DataArtifactRecord, DataArtifactSink } from "../contracts.js";
import { sha256Bytes } from "./canonical-json.js";
import { DataRuntimeError } from "./errors.js";

const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;

interface StagedArtifact extends DataArtifactRecord {
  temporaryPath: string;
  finalPath: string;
}

export interface DataArtifactSession extends DataArtifactSink {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export async function createDataArtifactSession(directory: string): Promise<DataArtifactSession> {
  if (!isAbsolute(directory)) {
    throw new DataRuntimeError(
      "invalid-request",
      "The artifact output directory must be an absolute path.",
    );
  }
  let root: string;
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not-directory");
    root = await realpath(directory);
  } catch {
    throw new DataRuntimeError(
      "invalid-request",
      "The artifact output directory must be an existing non-symbolic-link directory.",
    );
  }

  const staged = new Map<string, StagedArtifact>();
  let settled = false;

  const assertAvailable = async (relativePath: string): Promise<void> => {
    assertArtifactName(relativePath);
    if (settled) throw new DataRuntimeError("internal-error", "The artifact session is closed.");
    if (staged.has(relativePath) || (await pathExists(join(root, relativePath)))) {
      throw new DataRuntimeError(
        "invalid-request",
        "The artifact output directory already contains a requested output file.",
        { details: { relativePath } },
      );
    }
  };

  return {
    assertAvailable,
    stage: async (relativePath, bytes) => {
      await assertAvailable(relativePath);
      const temporaryPath = join(root, `.tiangong-${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      } catch {
        await unlink(temporaryPath).catch(() => undefined);
        throw new DataRuntimeError("internal-error", "The artifact could not be staged safely.");
      }
      const record: StagedArtifact = {
        relativePath,
        sha256: sha256Bytes(bytes),
        byteSize: bytes.byteLength,
        temporaryPath,
        finalPath: join(root, relativePath),
      };
      staged.set(relativePath, record);
      return publicRecord(record);
    },
    commit: async () => {
      if (settled) throw new DataRuntimeError("internal-error", "The artifact session is closed.");
      const committed: StagedArtifact[] = [];
      try {
        for (const artifact of staged.values()) {
          await link(artifact.temporaryPath, artifact.finalPath);
          committed.push(artifact);
        }
      } catch (error) {
        await Promise.allSettled(committed.map((artifact) => unlink(artifact.finalPath)));
        throw new DataRuntimeError(
          "invalid-request",
          "The artifact outputs could not be committed without overwriting existing files.",
          { details: { reason: error instanceof Error ? error.name : "unknown" } },
        );
      } finally {
        await Promise.allSettled(
          [...staged.values()].map((artifact) => unlink(artifact.temporaryPath)),
        );
        settled = true;
      }
    },
    rollback: async () => {
      if (settled) return;
      await Promise.allSettled(
        [...staged.values()].map((artifact) => unlink(artifact.temporaryPath)),
      );
      settled = true;
    },
  };
}

function assertArtifactName(relativePath: string): void {
  if (!SAFE_ARTIFACT_NAME.test(relativePath)) {
    throw new DataRuntimeError(
      "invalid-request",
      "Artifact filenames must be safe single-segment relative names.",
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new DataRuntimeError(
      "internal-error",
      "Artifact output availability could not be checked.",
    );
  }
}

function publicRecord(record: StagedArtifact): DataArtifactRecord {
  return {
    relativePath: record.relativePath,
    sha256: record.sha256,
    byteSize: record.byteSize,
  };
}
