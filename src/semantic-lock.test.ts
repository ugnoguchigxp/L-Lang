import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  findLatestPredicateEntry,
  findLatestStaticJudgmentEntry,
  findReplayEntry,
  findStaticJudgmentReplayEntry,
  readSemanticLock,
  type SemanticLock,
  type SemanticLockEntry,
  type StaticJudgmentLockEntry,
} from "./semantic-lock";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

const entry: SemanticLockEntry = {
  fingerprint: "fingerprint",
  source: "example/semantic.ts",
  concept: "Example",
  conceptId: "example.ready",
  conceptHash: "concept",
  conceptSource: "concepts/example.ts",
  predicate: "isExample",
  provider: "fixture",
  model: "gpt-5.4-mini",
  sourceHash: "source",
  typeHash: "type",
  testHash: "test",
  promptHash: "prompt",
  resolvedIr: { kind: "equals", property: ["state"], value: "ready" },
  generatedCodeHash: "code",
  response: null,
  createdAt: "2026-07-20T00:00:00.000Z",
};

const judgment: StaticJudgmentLockEntry = {
  fingerprint: "judgment-fingerprint",
  source: "example/static.semantic.ts",
  judgment: "mikeIsCat",
  conceptId: "animal.cat",
  conceptHash: "cat-concept",
  valueHash: "static-value",
  promptHash: "judgment-prompt",
  provider: "fixture",
  model: "gpt-5.4-mini",
  resolvedValue: true,
  generatedCodeHash: "judgment-code",
  response: null,
  createdAt: "2026-07-20T01:00:00.000Z",
};

describe("semantic lock", () => {
  test("replays by semantic inputs independent of provider and model", () => {
    expect(
      findReplayEntry(
        { version: 1, entries: { [entry.fingerprint]: entry } },
        {
          source: entry.source,
          predicate: entry.predicate,
          conceptId: required(entry.conceptId),
          conceptHash: required(entry.conceptHash),
          sourceHash: entry.sourceHash,
          typeHash: entry.typeHash,
          testHash: entry.testHash,
          promptHash: entry.promptHash,
        },
      ),
    ).toEqual(entry);
  });

  test("keeps Predicate and Static Judgment replay namespaces independent", () => {
    const lock = {
      version: 1 as const,
      entries: { [entry.fingerprint]: entry },
      judgments: { [judgment.fingerprint]: judgment },
    };

    expect(
      findStaticJudgmentReplayEntry(lock, {
        source: judgment.source,
        judgment: judgment.judgment,
        conceptId: judgment.conceptId,
        conceptHash: judgment.conceptHash,
        valueHash: judgment.valueHash,
        promptHash: judgment.promptHash,
      }),
    ).toEqual(judgment);
    expect(
      findStaticJudgmentReplayEntry(lock, {
        source: judgment.source,
        judgment: judgment.judgment,
        conceptId: judgment.conceptId,
        conceptHash: judgment.conceptHash,
        valueHash: "changed",
        promptHash: judgment.promptHash,
      }),
    ).toBeUndefined();
    expect(lock.entries[entry.fingerprint]).toEqual(entry);
  });

  test("finds the latest historical entry within each namespace", () => {
    const olderEntry = { ...entry, fingerprint: "older", createdAt: "2026-07-19T00:00:00.000Z" };
    const newerEntry = { ...entry, fingerprint: "newer", createdAt: "2026-07-21T00:00:00.000Z" };
    const olderJudgment = {
      ...judgment,
      fingerprint: "older-judgment",
      createdAt: "2026-07-19T00:00:00.000Z",
    };
    const newerJudgment = {
      ...judgment,
      fingerprint: "newer-judgment",
      createdAt: "2026-07-21T00:00:00.000Z",
    };
    const lock = {
      version: 1 as const,
      entries: { older: olderEntry, newer: newerEntry },
      judgments: {
        older: olderJudgment,
        newer: newerJudgment,
      },
    };

    expect(
      findLatestPredicateEntry(lock, {
        source: entry.source,
        predicate: entry.predicate,
      }),
    ).toEqual(newerEntry);
    expect(
      findLatestStaticJudgmentEntry(lock, {
        source: judgment.source,
        judgment: judgment.judgment,
      }),
    ).toEqual(newerJudgment);
  });

  test("strictly parses valid Predicate and Static Judgment entries", async () => {
    const lock = validLock();
    const path = await writeTemporaryLock(lock);

    expect(await readSemanticLock(path)).toEqual(lock);
  });

  test("keeps legacy version 1 entries readable without promotion provenance", async () => {
    const lock = validLock();
    delete required(Object.values(lock.entries)[0]).promotion;
    const judgments = required(lock.judgments);
    delete required(Object.values(judgments)[0]).promotion;
    const path = await writeTemporaryLock(lock);

    expect(await readSemanticLock(path)).toEqual(lock);
  });

  test("rejects malformed entries instead of trusting the TypeScript cast", async () => {
    const cases: Array<{
      label: string;
      mutate: (lock: Record<string, unknown>) => void;
    }> = [
      {
        label: "root unknown field",
        mutate: (lock) => {
          lock.extra = true;
        },
      },
      {
        label: "map key",
        mutate: (lock) => {
          firstEntry(lock.entries).fingerprint = "0".repeat(64);
        },
      },
      {
        label: "entry unknown field",
        mutate: (lock) => {
          firstEntry(lock.entries).extra = true;
        },
      },
      {
        label: "Predicate IR",
        mutate: (lock) => {
          firstEntry(lock.entries).resolvedIr = { kind: "execute" };
        },
      },
      {
        label: "Predicate IR unknown field",
        mutate: (lock) => {
          recordAt(firstEntry(lock.entries), "resolvedIr").extra = true;
        },
      },
      {
        label: "Static Judgment boolean",
        mutate: (lock) => {
          firstEntry(lock.judgments).resolvedValue = "true";
        },
      },
      {
        label: "hash",
        mutate: (lock) => {
          firstEntry(lock.judgments).valueHash = "not-a-hash";
        },
      },
      {
        label: "timestamp",
        mutate: (lock) => {
          firstEntry(lock.entries).createdAt = "yesterday";
        },
      },
      {
        label: "invalid calendar timestamp",
        mutate: (lock) => {
          firstEntry(lock.entries).createdAt = "2026-02-30T00:00:00.000Z";
        },
      },
      {
        label: "response usage",
        mutate: (lock) => {
          firstEntry(lock.entries).response = {
            id: "response",
            model: "model",
            usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 },
          };
        },
      },
      {
        label: "response usage unknown field",
        mutate: (lock) => {
          firstEntry(lock.entries).response = {
            id: "response",
            model: "model",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              extra: true,
            },
          };
        },
      },
      {
        label: "promotion mode",
        mutate: (lock) => {
          recordAt(firstEntry(lock.entries), "promotion").mode = "automatic";
        },
      },
      {
        label: "auto candidate metadata",
        mutate: (lock) => {
          recordAt(firstEntry(lock.entries), "promotion").candidateId = "candidate";
        },
      },
      {
        label: "reviewed reviewer",
        mutate: (lock) => {
          recordAt(firstEntry(lock.judgments), "promotion").reviewer = " ";
        },
      },
      {
        label: "promotion timestamp",
        mutate: (lock) => {
          recordAt(firstEntry(lock.entries), "promotion").promotedAt =
            "2026-02-30T00:00:00.000Z";
        },
      },
      {
        label: "non-canonical promotion timestamp",
        mutate: (lock) => {
          recordAt(firstEntry(lock.entries), "promotion").promotedAt =
            "2026-07-20T00:00:00Z";
        },
      },
      {
        label: "promotion validation",
        mutate: (lock) => {
          recordAt(recordAt(firstEntry(lock.entries), "promotion"), "validation")
            .fullTest = "skipped";
        },
      },
      {
        label: "promotion validation unknown field",
        mutate: (lock) => {
          recordAt(recordAt(firstEntry(lock.entries), "promotion"), "validation")
            .extra = true;
        },
      },
      {
        label: "Static Judgment Semantic Test",
        mutate: (lock) => {
          recordAt(recordAt(firstEntry(lock.judgments), "promotion"), "validation")
            .semanticTest = "passed";
        },
      },
    ];

    for (const testCase of cases) {
      const lock = structuredClone(validLock()) as unknown as Record<
        string,
        unknown
      >;
      testCase.mutate(lock);
      const path = await writeTemporaryLock(lock);
      await expect(readSemanticLock(path)).rejects.toThrow();
    }
  });
});

function validLock(): SemanticLock {
  const predicateEntry: SemanticLockEntry = {
    ...entry,
    fingerprint: "1".repeat(64),
    conceptHash: "2".repeat(64),
    sourceHash: "3".repeat(64),
    typeHash: "4".repeat(64),
    testHash: "5".repeat(64),
    promptHash: "6".repeat(64),
    generatedCodeHash: "7".repeat(64),
    promotion: {
      mode: "auto",
      promotedAt: "2026-07-20T00:00:00.000Z",
      validation: {
        candidateTypecheck: "passed",
        projectTypecheck: "passed",
        semanticTest: "passed",
        fullTest: "passed",
      },
    },
  };
  const judgmentEntry: StaticJudgmentLockEntry = {
    ...judgment,
    fingerprint: "8".repeat(64),
    conceptHash: "9".repeat(64),
    valueHash: "a".repeat(64),
    promptHash: "b".repeat(64),
    generatedCodeHash: "c".repeat(64),
    promotion: {
      mode: "reviewed",
      promotedAt: "2026-07-20T01:00:00.000Z",
      candidateId: "20260720010000-12345678",
      reviewer: "test-reviewer",
      validation: {
        candidateTypecheck: "passed",
        projectTypecheck: "passed",
        semanticTest: "not-applicable",
        fullTest: "passed",
      },
    },
  };
  return {
    version: 1,
    entries: { [predicateEntry.fingerprint]: predicateEntry },
    judgments: { [judgmentEntry.fingerprint]: judgmentEntry },
  };
}

async function writeTemporaryLock(lock: unknown): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "semantic-lock-test-"));
  temporaryRoots.push(root);
  const path = resolve(root, "semantic.lock");
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return path;
}

function firstEntry(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("expected entry record");
  }
  const entry = Object.values(input)[0];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("expected first entry");
  }
  return entry as Record<string, unknown>;
}

function recordAt(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = input[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${key} to be a record`);
  }
  return value as Record<string, unknown>;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required test fixture is missing");
  return value;
}
