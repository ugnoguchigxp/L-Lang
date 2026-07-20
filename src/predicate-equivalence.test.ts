import { describe, expect, test } from "bun:test";

import type { PredicateExpression } from "./ir";
import {
  comparePredicatesOnType,
  predicateSemanticSignature,
} from "./predicate-equivalence";
import type { TypeSchema } from "./semantic-source";

const equalsNull: PredicateExpression = {
  kind: "equals",
  property: ["retiredAt"],
  value: null,
};
const notPresent: PredicateExpression = {
  kind: "not",
  condition: { kind: "present", property: ["retiredAt"] },
};

describe("type-aware Predicate IR equivalence", () => {
  test("equates null with not-present for a required nullable property", () => {
    const result = comparePredicatesOnType(
      equalsNull,
      notPresent,
      objectProperty(false, { kind: "union", types: [{ kind: "string" }, { kind: "null" }] }),
    );
    expect(result.relation).toBe("equivalent");
    expect(result.rewrites).toEqual([
      expect.stringContaining("NOT PRESENT normalized to EQUALS null"),
    ]);
  });

  test("does not equate them when an optional property can be undefined", () => {
    const result = comparePredicatesOnType(
      equalsNull,
      notPresent,
      objectProperty(true, {
        kind: "union",
        types: [{ kind: "string" }, { kind: "null" }, { kind: "undefined" }],
      }),
    );
    expect(result.relation).toBe("different");
    expect(result.rewrites).toEqual([]);
  });

  test("does not equate them for an explicit undefined union", () => {
    const result = comparePredicatesOnType(
      equalsNull,
      notPresent,
      objectProperty(false, {
        kind: "union",
        types: [{ kind: "string" }, { kind: "null" }, { kind: "undefined" }],
      }),
    );
    expect(result.relation).toBe("different");
  });

  test("normalizes commutative condition order as exact", () => {
    const left: PredicateExpression = {
      kind: "all",
      conditions: [equalsNull, { kind: "present", property: ["title"] }],
    };
    const right: PredicateExpression = {
      kind: "all",
      conditions: [...left.conditions].reverse(),
    };
    const schema: TypeSchema = {
      kind: "object",
      properties: [
        {
          name: "retiredAt",
          optional: false,
          type: { kind: "union", types: [{ kind: "string" }, { kind: "null" }] },
        },
        { name: "title", optional: false, type: { kind: "string" } },
      ],
    };
    expect(comparePredicatesOnType(left, right, schema).relation).toBe("exact");
    expect(predicateSemanticSignature(left, schema).signature).toBe(
      predicateSemanticSignature(right, schema).signature,
    );
  });
});

function objectProperty(optional: boolean, type: TypeSchema): TypeSchema {
  return {
    kind: "object",
    properties: [{ name: "retiredAt", optional, type }],
  };
}
