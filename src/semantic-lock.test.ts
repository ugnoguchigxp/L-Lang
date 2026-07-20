import { describe, expect, test } from "bun:test";

import { findReplayEntry, type SemanticLockEntry } from "./semantic-lock";

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
});
