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

export type StaticJudgmentLockEntry = {
  fingerprint: string;
  source: string;
  judgment: string;
  conceptId: string;
  conceptHash: string;
  valueHash: string;
  promptHash: string;
  provider: string;
  model: string;
  resolvedValue: boolean;
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
  judgments?: Record<string, StaticJudgmentLockEntry>;
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

export function findStaticJudgmentReplayEntry(
  lock: SemanticLock,
  match: Pick<
    StaticJudgmentLockEntry,
    | "source"
    | "judgment"
    | "conceptId"
    | "conceptHash"
    | "valueHash"
    | "promptHash"
  >,
): StaticJudgmentLockEntry | undefined {
  return Object.values(lock.judgments ?? {})
    .filter(
      (entry) =>
        entry.source === match.source &&
        entry.judgment === match.judgment &&
        entry.conceptId === match.conceptId &&
        entry.conceptHash === match.conceptHash &&
        entry.valueHash === match.valueHash &&
        entry.promptHash === match.promptHash,
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export function findLatestPredicateEntry(
  lock: SemanticLock,
  match: Pick<SemanticLockEntry, "source" | "predicate">,
): SemanticLockEntry | undefined {
  return newestEntry(
    Object.values(lock.entries).filter(
      (entry) =>
        entry.source === match.source && entry.predicate === match.predicate,
    ),
  );
}

export function findLatestStaticJudgmentEntry(
  lock: SemanticLock,
  match: Pick<StaticJudgmentLockEntry, "source" | "judgment">,
): StaticJudgmentLockEntry | undefined {
  return newestEntry(
    Object.values(lock.judgments ?? {}).filter(
      (entry) =>
        entry.source === match.source && entry.judgment === match.judgment,
    ),
  );
}

function newestEntry<T extends { createdAt: string }>(entries: T[]): T | undefined {
  return entries.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0];
}

function parseSemanticLock(input: unknown): SemanticLock {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("semantic.lock must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || typeof value.entries !== "object" || value.entries === null) {
    throw new Error("semantic.lock must have version 1 and entries");
  }
  if (
    value.judgments !== undefined &&
    (typeof value.judgments !== "object" || value.judgments === null || Array.isArray(value.judgments))
  ) {
    throw new Error("semantic.lock judgments must be an object when present");
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
