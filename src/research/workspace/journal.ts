import { appendFile, readFile } from "node:fs/promises";

import { CliError } from "../../errors.js";
import { sanitizeResearchRecord } from "./sanitization.js";
import { canonicalJson, pathExists, sha256Text } from "./storage.js";
import type { JournalEvent } from "./types.js";

const GENESIS_HASH = "0".repeat(64);
const journalQueues = new Map<string, Promise<void>>();

export async function appendJournalEvent(
  journalPath: string,
  type: string,
  scope: string,
  payload: Record<string, unknown>,
): Promise<JournalEvent> {
  const previousWrite = journalQueues.get(journalPath) ?? Promise.resolve();
  let releaseWrite = (): void => undefined;
  const currentWrite = new Promise<void>((resolvePromise) => {
    releaseWrite = resolvePromise;
  });
  const queuedWrite = previousWrite.catch(() => undefined).then(() => currentWrite);
  journalQueues.set(journalPath, queuedWrite);
  await previousWrite.catch(() => undefined);
  try {
    return await appendJournalEventNow(journalPath, type, scope, payload);
  } finally {
    releaseWrite();
    if (journalQueues.get(journalPath) === queuedWrite) journalQueues.delete(journalPath);
  }
}

async function appendJournalEventNow(
  journalPath: string,
  type: string,
  scope: string,
  payload: Record<string, unknown>,
): Promise<JournalEvent> {
  const events = await readJournal(journalPath);
  verifyJournalEvents(events);
  const previous = events.at(-1);
  const unsigned = {
    schemaVersion: 1 as const,
    sequence: events.length + 1,
    timestamp: new Date().toISOString(),
    type,
    scope,
    payload: sanitizeResearchRecord(payload),
    previousHash: previous?.hash ?? GENESIS_HASH,
  };
  const event: JournalEvent = { ...unsigned, hash: sha256Text(canonicalJson(unsigned)) };
  await appendFile(journalPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  return event;
}

export async function readJournal(journalPath: string): Promise<JournalEvent[]> {
  if (!(await pathExists(journalPath))) return [];
  const content = await readFile(journalPath, "utf8");
  if (!content.trim()) return [];
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as JournalEvent;
      } catch (error) {
        throw new CliError(`Research journal line ${index + 1} is invalid JSON.`, {
          code: "RESEARCH_JOURNAL_INVALID",
          exitCode: 2,
          details: { error: String(error) },
        });
      }
    });
}

export async function verifyJournal(
  journalPath: string,
): Promise<{ events: number; head: string }> {
  const events = await readJournal(journalPath);
  verifyJournalEvents(events);
  return { events: events.length, head: events.at(-1)?.hash ?? GENESIS_HASH };
}

/** Verify and return the same byte snapshot, without a second unverified read. */
export async function readVerifiedJournal(journalPath: string): Promise<JournalEvent[]> {
  const events = await readJournal(journalPath);
  verifyJournalEvents(events);
  return events;
}

function verifyJournalEvents(events: JournalEvent[]): void {
  let previousHash = GENESIS_HASH;
  for (const [index, event] of events.entries()) {
    if (
      event.schemaVersion !== 1 ||
      event.sequence !== index + 1 ||
      event.previousHash !== previousHash ||
      typeof event.timestamp !== "string" ||
      typeof event.type !== "string" ||
      typeof event.scope !== "string" ||
      !event.payload ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    ) {
      throw new CliError(`Research journal event ${index + 1} is malformed.`, {
        code: "RESEARCH_JOURNAL_INVALID",
        exitCode: 2,
      });
    }
    const unsigned = {
      schemaVersion: event.schemaVersion,
      sequence: event.sequence,
      timestamp: event.timestamp,
      type: event.type,
      scope: event.scope,
      payload: event.payload,
      previousHash: event.previousHash,
    };
    const expected = sha256Text(canonicalJson(unsigned));
    if (event.hash !== expected) {
      throw new CliError(`Research journal event ${event.sequence} failed its hash check.`, {
        code: "RESEARCH_JOURNAL_TAMPERED",
        exitCode: 2,
      });
    }
    previousHash = event.hash;
  }
}
