import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadDotenv(env: NodeJS.ProcessEnv): void {
  const cwd = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(process.cwd(), ".env"), resolve(cwd, "../.env")];
  for (const candidate of candidates) {
    const content = readEnvFile(candidate);
    if (!content) continue;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rawValue] = trimmed.replace(/^export\s+/, "").split("=");
      const key = rawKey?.trim();
      if (!key || env[key]) continue;
      env[key] = rawValue
        .join("=")
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
}

export function firstEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function readEnvFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
