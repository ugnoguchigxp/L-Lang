import { readFile } from "node:fs/promises";

import { atomicWriteText } from "./atomic-file";
import { type PredicateExpression, parsePredicateExpression } from "./ir";
import type { OpenAIResult } from "./openai";
import type { ProjectContextSummary } from "./project-context";
import { sha256 } from "./semantic-fingerprint";
import {
  assertKnownKeys,
  assertTextByteLength,
  parseBoundedJsonText,
  SEMANTIC_LIMITS,
} from "./semantic-limits";

export type PromotionValidation = {
  candidateTypecheck: "passed";
  projectTypecheck: "passed";
  semanticTest: "passed" | "not-applicable";
  fullTest: "passed";
};

export type PromotionProvenance =
  | {
      mode: "auto";
      promotedAt: string;
      validation: PromotionValidation;
    }
  | {
      mode: "reviewed";
      promotedAt: string;
      candidateId: string;
      reviewer: string;
      validation: PromotionValidation;
    };

export type SemanticLockEntry = {
  fingerprint: string;
  source: string;
  concept: string;
  conceptId?: string;
  conceptHash?: string;
  conceptSource?: string;
  predicate: string;
  targetTypeName?: string;
  provider: string;
  model: string;
  sourceHash: string;
  typeHash: string;
  testHash: string;
  promptHash: string;
  contextVersion?: 1;
  contextHash?: string;
  contextSummary?: ProjectContextSummary;
  resolvedIr: PredicateExpression;
  generatedCodeHash: string;
  response: {
    id: string;
    model: string;
    usage: OpenAIResult["usage"];
  } | null;
  createdAt: string;
  promotion?: PromotionProvenance;
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
  promotion?: PromotionProvenance;
};

export type SemanticLock = {
  version: 1;
  entries: Record<string, SemanticLockEntry>;
  judgments?: Record<string, StaticJudgmentLockEntry>;
};

export async function readSemanticLock(path: string): Promise<SemanticLock> {
  return (await readSemanticLockSnapshot(path)).lock;
}

export async function readSemanticLockSnapshot(path: string): Promise<{
  lock: SemanticLock;
  revision: string | null;
}> {
  try {
    const data = await readFile(path);
    if (data.byteLength > SEMANTIC_LIMITS.lockBytes) {
      throw new Error(
        `semantic.lock exceeds ${SEMANTIC_LIMITS.lockBytes} bytes`,
      );
    }
    return {
      lock: parseSemanticLock(
        parseBoundedJsonText(
          data.toString("utf8"),
          "semantic.lock",
          SEMANTIC_LIMITS.lockBytes,
        ),
      ),
      revision: sha256(data),
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { lock: { version: 1, entries: {} }, revision: null };
    }
    throw error;
  }
}

export async function writeSemanticLock(
  path: string,
  lock: SemanticLock,
): Promise<void> {
  const serialized = serializeSemanticLock(lock);
  assertTextByteLength(serialized, SEMANTIC_LIMITS.lockBytes, "semantic.lock");
  await atomicWriteText(path, serialized);
}

export function serializeSemanticLock(lock: SemanticLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function semanticLockRevision(lock: SemanticLock): string {
  return sha256(serializeSemanticLock(lock));
}

export function findReplayEntry(
  lock: SemanticLock,
  match: Pick<
    SemanticLockEntry,
    | "source"
    | "predicate"
    | "sourceHash"
    | "typeHash"
    | "testHash"
    | "promptHash"
  > & { conceptId: string; conceptHash: string; contextHash?: string },
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
        entry.promptHash === match.promptHash &&
        (match.contextHash === undefined ||
          entry.contextHash === match.contextHash),
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

function newestEntry<T extends { createdAt: string }>(
  entries: T[],
): T | undefined {
  return entries.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0];
}

function parseSemanticLock(input: unknown): SemanticLock {
  const value = objectValue(input, "semantic.lock");
  assertKnownKeys(value, ["version", "entries", "judgments"], "semantic.lock");
  if (value.version !== 1) {
    throw new Error("semantic.lock.version must be 1");
  }
  const entries = parseEntryRecord(
    value.entries,
    "semantic.lock.entries",
    parsePredicateEntry,
  );
  const judgments =
    value.judgments === undefined
      ? undefined
      : parseEntryRecord(
          value.judgments,
          "semantic.lock.judgments",
          parseStaticJudgmentEntry,
        );
  return {
    version: 1,
    entries,
    ...(judgments === undefined ? {} : { judgments }),
  };
}

function parseEntryRecord<T extends { fingerprint: string }>(
  input: unknown,
  path: string,
  parseEntry: (input: unknown, path: string) => T,
): Record<string, T> {
  const value = objectValue(input, path);
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      const entry = parseEntry(entryValue, `${path}.${key}`);
      if (entry.fingerprint !== key) {
        throw new Error(`${path}.${key}.fingerprint must match its map key`);
      }
      return [key, entry];
    }),
  );
}

function parsePredicateEntry(input: unknown, path: string): SemanticLockEntry {
  const value = objectValue(input, path);
  assertKnownKeys(
    value,
    [
      "fingerprint",
      "source",
      "concept",
      "conceptId",
      "conceptHash",
      "conceptSource",
      "predicate",
      "targetTypeName",
      "provider",
      "model",
      "sourceHash",
      "typeHash",
      "testHash",
      "promptHash",
      "contextVersion",
      "contextHash",
      "contextSummary",
      "resolvedIr",
      "generatedCodeHash",
      "response",
      "createdAt",
      "promotion",
    ],
    path,
  );
  const contextFields = [
    value.targetTypeName,
    value.contextVersion,
    value.contextHash,
    value.contextSummary,
  ];
  const presentContextFields = contextFields.filter(
    (field) => field !== undefined,
  ).length;
  if (
    presentContextFields !== 0 &&
    presentContextFields !== contextFields.length
  ) {
    throw new Error(
      `${path} must include all Project Context metadata or none for a legacy entry`,
    );
  }
  return {
    fingerprint: hashValue(value.fingerprint, `${path}.fingerprint`),
    source: stringValue(value.source, `${path}.source`),
    concept: stringValue(value.concept, `${path}.concept`),
    ...(value.conceptId === undefined
      ? {}
      : { conceptId: stringValue(value.conceptId, `${path}.conceptId`) }),
    ...(value.conceptHash === undefined
      ? {}
      : { conceptHash: hashValue(value.conceptHash, `${path}.conceptHash`) }),
    ...(value.conceptSource === undefined
      ? {}
      : {
          conceptSource: stringValue(
            value.conceptSource,
            `${path}.conceptSource`,
          ),
        }),
    predicate: stringValue(value.predicate, `${path}.predicate`),
    ...(value.targetTypeName === undefined
      ? {}
      : {
          targetTypeName: stringValue(
            value.targetTypeName,
            `${path}.targetTypeName`,
          ),
        }),
    provider: stringValue(value.provider, `${path}.provider`),
    model: stringValue(value.model, `${path}.model`),
    sourceHash: hashValue(value.sourceHash, `${path}.sourceHash`),
    typeHash: hashValue(value.typeHash, `${path}.typeHash`),
    testHash: hashValue(value.testHash, `${path}.testHash`),
    promptHash: hashValue(value.promptHash, `${path}.promptHash`),
    ...(value.contextVersion === undefined
      ? {}
      : {
          contextVersion: versionOne(
            value.contextVersion,
            `${path}.contextVersion`,
          ),
        }),
    ...(value.contextHash === undefined
      ? {}
      : { contextHash: hashValue(value.contextHash, `${path}.contextHash`) }),
    ...(value.contextSummary === undefined
      ? {}
      : {
          contextSummary: projectContextSummaryValue(
            value.contextSummary,
            `${path}.contextSummary`,
          ),
        }),
    resolvedIr: parsePredicateExpression(
      value.resolvedIr,
      `${path}.resolvedIr`,
    ),
    generatedCodeHash: hashValue(
      value.generatedCodeHash,
      `${path}.generatedCodeHash`,
    ),
    response: responseValue(value.response, `${path}.response`),
    createdAt: dateValue(value.createdAt, `${path}.createdAt`),
    ...(value.promotion === undefined
      ? {}
      : {
          promotion: promotionValue(
            value.promotion,
            `${path}.promotion`,
            "predicate",
          ),
        }),
  };
}

function parseStaticJudgmentEntry(
  input: unknown,
  path: string,
): StaticJudgmentLockEntry {
  const value = objectValue(input, path);
  assertKnownKeys(
    value,
    [
      "fingerprint",
      "source",
      "judgment",
      "conceptId",
      "conceptHash",
      "valueHash",
      "promptHash",
      "provider",
      "model",
      "resolvedValue",
      "generatedCodeHash",
      "response",
      "createdAt",
      "promotion",
    ],
    path,
  );
  if (typeof value.resolvedValue !== "boolean") {
    throw new Error(`${path}.resolvedValue must be a boolean`);
  }
  return {
    fingerprint: hashValue(value.fingerprint, `${path}.fingerprint`),
    source: stringValue(value.source, `${path}.source`),
    judgment: stringValue(value.judgment, `${path}.judgment`),
    conceptId: stringValue(value.conceptId, `${path}.conceptId`),
    conceptHash: hashValue(value.conceptHash, `${path}.conceptHash`),
    valueHash: hashValue(value.valueHash, `${path}.valueHash`),
    promptHash: hashValue(value.promptHash, `${path}.promptHash`),
    provider: stringValue(value.provider, `${path}.provider`),
    model: stringValue(value.model, `${path}.model`),
    resolvedValue: value.resolvedValue,
    generatedCodeHash: hashValue(
      value.generatedCodeHash,
      `${path}.generatedCodeHash`,
    ),
    response: responseValue(value.response, `${path}.response`),
    createdAt: dateValue(value.createdAt, `${path}.createdAt`),
    ...(value.promotion === undefined
      ? {}
      : {
          promotion: promotionValue(
            value.promotion,
            `${path}.promotion`,
            "static-judgment",
          ),
        }),
  };
}

function promotionValue(
  input: unknown,
  path: string,
  kind: "predicate" | "static-judgment",
): PromotionProvenance {
  const value = objectValue(input, path);
  assertKnownKeys(
    value,
    ["mode", "promotedAt", "candidateId", "reviewer", "validation"],
    path,
  );
  if (value.mode !== "auto" && value.mode !== "reviewed") {
    throw new Error(`${path}.mode must be auto or reviewed`);
  }
  const validation = promotionValidationValue(
    value.validation,
    `${path}.validation`,
    kind,
  );
  const promotedAt = canonicalDateValue(value.promotedAt, `${path}.promotedAt`);

  if (value.mode === "auto") {
    if (value.candidateId !== undefined || value.reviewer !== undefined) {
      throw new Error(
        `${path} auto promotion must not include candidateId or reviewer`,
      );
    }
    return { mode: "auto", promotedAt, validation };
  }

  return {
    mode: "reviewed",
    promotedAt,
    candidateId: trimmedStringValue(value.candidateId, `${path}.candidateId`),
    reviewer: trimmedStringValue(value.reviewer, `${path}.reviewer`),
    validation,
  };
}

function promotionValidationValue(
  input: unknown,
  path: string,
  kind: "predicate" | "static-judgment",
): PromotionValidation {
  const value = objectValue(input, path);
  assertKnownKeys(
    value,
    ["candidateTypecheck", "projectTypecheck", "semanticTest", "fullTest"],
    path,
  );
  if (value.candidateTypecheck !== "passed") {
    throw new Error(`${path}.candidateTypecheck must be passed`);
  }
  if (value.projectTypecheck !== "passed") {
    throw new Error(`${path}.projectTypecheck must be passed`);
  }
  if (value.fullTest !== "passed") {
    throw new Error(`${path}.fullTest must be passed`);
  }
  if (kind === "predicate" && value.semanticTest !== "passed") {
    throw new Error(
      `${path}.semanticTest must be passed for Predicate entries`,
    );
  }
  if (kind === "static-judgment" && value.semanticTest !== "not-applicable") {
    throw new Error(
      `${path}.semanticTest must be not-applicable for Static Judgment entries`,
    );
  }
  return {
    candidateTypecheck: "passed",
    projectTypecheck: "passed",
    semanticTest: value.semanticTest,
    fullTest: "passed",
  } as PromotionValidation;
}

function responseValue(
  input: unknown,
  path: string,
): SemanticLockEntry["response"] {
  if (input === null) return null;
  const value = objectValue(input, path);
  assertKnownKeys(value, ["id", "model", "usage"], path);
  return {
    id: stringValue(value.id, `${path}.id`),
    model: stringValue(value.model, `${path}.model`),
    usage:
      value.usage === null ? null : usageValue(value.usage, `${path}.usage`),
  };
}

function usageValue(
  input: unknown,
  path: string,
): NonNullable<OpenAIResult["usage"]> {
  const value = objectValue(input, path);
  assertKnownKeys(value, ["inputTokens", "outputTokens", "totalTokens"], path);
  return {
    inputTokens: nonNegativeInteger(value.inputTokens, `${path}.inputTokens`),
    outputTokens: nonNegativeInteger(
      value.outputTokens,
      `${path}.outputTokens`,
    ),
    totalTokens: nonNegativeInteger(value.totalTokens, `${path}.totalTokens`),
  };
}

function objectValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return input;
}

function trimmedStringValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (value.trim() !== value || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return value;
}

function hashValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function versionOne(input: unknown, path: string): 1 {
  if (input !== 1) throw new Error(`${path} must be 1`);
  return 1;
}

function projectContextSummaryValue(
  input: unknown,
  path: string,
): ProjectContextSummary {
  const value = objectValue(input, path);
  assertKnownKeys(
    value,
    ["version", "targetSource", "relatedTypeSources", "verifiedBindingSources"],
    path,
  );
  return {
    version: versionOne(value.version, `${path}.version`),
    targetSource: stringValue(value.targetSource, `${path}.targetSource`),
    relatedTypeSources: stringArray(
      value.relatedTypeSources,
      `${path}.relatedTypeSources`,
    ),
    verifiedBindingSources: stringArray(
      value.verifiedBindingSources,
      `${path}.verifiedBindingSources`,
    ),
  };
}

function stringArray(input: unknown, path: string): string[] {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array`);
  return input.map((value, index) => stringValue(value, `${path}[${index}]`));
}

function dateValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error(`${path} must be an ISO-8601 UTC timestamp`);
  }
  const timestamp = Date.parse(value);
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (
    Number.isNaN(timestamp) ||
    new Date(timestamp).toISOString() !== canonical
  ) {
    throw new Error(`${path} must be a valid timestamp`);
  }
  return value;
}

function canonicalDateValue(input: unknown, path: string): string {
  const value = dateValue(input, path);
  if (new Date(value).toISOString() !== value) {
    throw new Error(`${path} must be a canonical ISO-8601 UTC timestamp`);
  }
  return value;
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return input;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
