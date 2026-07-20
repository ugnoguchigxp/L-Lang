import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

import type { PredicateExpression } from "./ir";
import type { OpenAIResult } from "./openai";

export type SemanticLockEntry = {
  fingerprint: string;
  source: string;
  concept: string;
  conceptId?: string;
  conceptHash?: string;
  conceptSource?: string;
  predicate: string;
  provider: string;
  model: string;
  sourceHash: string;
  typeHash: string;
  testHash: string;
  promptHash: string;
  resolvedIr: PredicateExpression;
  generatedCodeHash: string;
  response: {
    id: string;
    model: string;
    usage: OpenAIResult["usage"];
  } | null;
  createdAt: string;
};

export type SemanticLock = {
  version: 1;
  entries: Record<string, SemanticLockEntry>;
};

export async function readSemanticLock(path: string): Promise<SemanticLock> {
  try {
    return parseSemanticLock(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isNotFound(error)) return { version: 1, entries: {} };
    throw error;
  }
}

export async function writeSemanticLock(
  path: string,
  lock: SemanticLock,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function findReplayEntry(
  lock: SemanticLock,
  match: Pick<
    SemanticLockEntry,
    "source" | "predicate" | "sourceHash" | "typeHash" | "testHash" | "promptHash"
  > & { conceptId: string; conceptHash: string },
): SemanticLockEntry | undefined {
  return Object.values(lock.entries)
    .filter(
      (entry) =>
        entry.source === match.source &&
        entry.predicate === match.predicate &&
        entry.conceptId === match.conceptId &&
        entry.conceptHash === match.conceptHash &&
        entry.sourceHash === match.sourceHash &&
        entry.typeHash === match.typeHash &&
        entry.testHash === match.testHash &&
        entry.promptHash === match.promptHash,
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function parseSemanticLock(input: unknown): SemanticLock {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("semantic.lock must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || typeof value.entries !== "object" || value.entries === null) {
    throw new Error("semantic.lock must have version 1 and entries");
  }
  return input as SemanticLock;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
