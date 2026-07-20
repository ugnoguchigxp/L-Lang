import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import type { PredicateExpression } from "./ir";
import { resolveWithSemanticConsensus } from "./semantic-consensus";
import type { SemanticResolution } from "./semantic-compiler";
import { scanSemanticSource } from "./semantic-source";

const sourcePath = resolve(
  import.meta.dir,
  "../examples/active-customer/semantic.ts",
);

describe("live semantic consensus", () => {
  test("selects a type-aware two-of-three majority and starts samples concurrently", async () => {
    const source = await scanSemanticSource(sourcePath);
    const bodies: PredicateExpression[] = [
      bodyWithDeletedAtNull(),
      bodyWithDeletedAtNotPresent(),
      { kind: "equals", property: ["status"], value: "suspended" },
    ];
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const resultPromise = resolveWithSemanticConsensus({
      source,
      samples: 3,
      quorum: 2,
      resolve: async () => {
        const index = started;
        started += 1;
        if (started === 3) release();
        await gate;
        return resolved(bodies[index]!);
      },
    });
    await gate;
    expect(started).toBe(3);
    const result = await resultPromise;
    expect(result.reached).toBe(true);
    expect(result.selectedOutcome).toBe("resolved");
    expect(result.supportingSamples).toEqual([1, 2]);
    expect(result.votes[1]?.rewrites).toHaveLength(1);
  });

  test("returns unresolved when three eligible votes disagree", async () => {
    const source = await scanSemanticSource(sourcePath);
    const resolutions = [
      resolved(bodyWithDeletedAtNull()),
      unresolved(),
      resolved({ kind: "equals", property: ["status"], value: "suspended" }),
    ];
    let index = 0;
    const result = await resolveWithSemanticConsensus({
      source,
      samples: 3,
      quorum: 2,
      resolve: async () => resolutions[index++]!,
    });
    expect(result.reached).toBe(false);
    expect(result.resolution.elaboration.outcome).toBe("unresolved");
    expect(result.resolution.elaboration.diagnostics[0]).toContain("consensus not reached");
  });
});

function bodyWithDeletedAtNull(): PredicateExpression {
  return {
    kind: "all",
    conditions: [
      { kind: "equals", property: ["status"], value: "active" },
      { kind: "equals", property: ["deletedAt"], value: null },
      { kind: "present", property: ["email"] },
    ],
  };
}

function bodyWithDeletedAtNotPresent(): PredicateExpression {
  return {
    kind: "all",
    conditions: [
      { kind: "present", property: ["email"] },
      { kind: "not", condition: { kind: "present", property: ["deletedAt"] } },
      { kind: "equals", property: ["status"], value: "active" },
    ],
  };
}

function resolved(body: PredicateExpression): SemanticResolution {
  return {
    elaboration: { outcome: "resolved", body, diagnostics: [] },
    response: null,
    rawOutput: { outcome: "resolved", body },
  };
}

function unresolved(): SemanticResolution {
  return {
    elaboration: { outcome: "unresolved", body: null, diagnostics: ["ambiguous"] },
    response: null,
    rawOutput: { outcome: "unresolved" },
  };
}
