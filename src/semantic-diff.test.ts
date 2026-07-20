import { describe, expect, test } from "bun:test";

import type { PredicateExpression } from "./ir";
import { classifySemanticChange, renderSemanticDiff } from "./semantic-diff";

const baseline: PredicateExpression = {
  kind: "all",
  conditions: [
    { kind: "equals", property: ["status"], value: "active" },
    { kind: "equals", property: ["deletedAt"], value: null },
    { kind: "present", property: ["email"] },
  ],
};

describe("semantic diff", () => {
  test("keeps an unchanged predicate compatible after unrelated schema additions", () => {
    const diff = classifySemanticChange({ previous: baseline, candidate: baseline });
    expect(diff.classification).toBe("compatible");
    expect(diff.summary).toBe("The Predicate IR is unchanged.");
    expect(diff.leafChanges.every((change) => change.changes.length === 0)).toBe(true);
  });

  test("classifies field renames as representation-compatible", () => {
    const candidate: PredicateExpression = {
      kind: "all",
      conditions: [
        { kind: "equals", property: ["lifecycle"], value: "active" },
        { kind: "equals", property: ["removedAt"], value: null },
        { kind: "present", property: ["contactAddress"] },
      ],
    };
    const diff = classifySemanticChange({ previous: baseline, candidate });
    expect(diff.classification).toBe("compatible");
    expect(diff.logicalShapeChanged).toBe(false);
    expect(diff.leafChanges.filter((change) => change.changes.includes("property"))).toHaveLength(3);
  });

  test("classifies literal-union to boolean representation changes as compatible", () => {
    const candidate: PredicateExpression = {
      kind: "all",
      conditions: [
        { kind: "equals", property: ["enabled"], value: true },
        { kind: "equals", property: ["deletedAt"], value: null },
        { kind: "present", property: ["email"] },
      ],
    };
    const diff = classifySemanticChange({ previous: baseline, candidate });
    expect(diff.classification).toBe("compatible");
    expect(diff.leafChanges.some((change) => change.changes.includes("value"))).toBe(true);
  });

  test("keeps present semantics compatible across nullable-to-optional type changes", () => {
    const diff = classifySemanticChange({ previous: baseline, candidate: baseline });
    expect(diff.classification).toBe("compatible");
    expect(diff.logicalShapeChanged).toBe(false);
  });

  test("marks a removed semantic condition as breaking", () => {
    const candidate: PredicateExpression = {
      kind: "all",
      conditions: baseline.kind === "all" ? baseline.conditions.slice(0, 2) : [],
    };
    const diff = classifySemanticChange({ previous: baseline, candidate });
    expect(diff.classification).toBe("breaking");
    expect(diff.logicalShapeChanged).toBe(true);
    expect(diff.leafChanges.some((change) => change.changes.includes("removed"))).toBe(true);
  });

  test("keeps an ambiguous schema unresolved and non-approvable", () => {
    const diff = classifySemanticChange({
      previous: baseline,
      candidate: null,
      diagnostics: ["schema roles are ambiguous"],
      validationPassed: false,
    });
    expect(diff.classification).toBe("unresolved");
    expect(renderSemanticDiff(diff)).toContain("Semantic change: UNRESOLVED");
    expect(diff.diagnostics).toEqual(["schema roles are ambiguous"]);
  });

  test("keeps a type-equivalent null exclusion compatible", () => {
    const previous: PredicateExpression = {
      kind: "all",
      conditions: [
        { kind: "equals", property: ["reviewStatus"], value: "approved" },
        { kind: "equals", property: ["retiredAt"], value: null },
      ],
    };
    const candidate: PredicateExpression = {
      kind: "all",
      conditions: [
        { kind: "equals", property: ["reviewStatus"], value: "approved" },
        {
          kind: "not",
          condition: { kind: "present", property: ["retiredAt"] },
        },
      ],
    };
    const diff = classifySemanticChange({
      previous,
      candidate,
      typeSchema: {
        kind: "object",
        properties: [
          {
            name: "reviewStatus",
            optional: false,
            type: {
              kind: "union",
              types: [
                { kind: "literal", value: "approved" },
                { kind: "literal", value: "draft" },
              ],
            },
          },
          {
            name: "retiredAt",
            optional: false,
            type: {
              kind: "union",
              types: [{ kind: "string" }, { kind: "null" }],
            },
          },
        ],
      },
    });
    expect(diff.classification).toBe("compatible");
    expect(diff.logicalShapeChanged).toBe(false);
    expect(diff.diagnostics).toEqual([
      expect.stringContaining("NOT PRESENT normalized to EQUALS null"),
    ]);
  });
});
