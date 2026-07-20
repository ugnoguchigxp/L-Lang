import { describe, expect, test } from "bun:test";

import {
  findReplayEntry,
  findStaticJudgmentReplayEntry,
  type SemanticLockEntry,
  type StaticJudgmentLockEntry,
} from "./semantic-lock";

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
          conceptId: entry.conceptId!,
          conceptHash: entry.conceptHash!,
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
});
